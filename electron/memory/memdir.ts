import fs from 'node:fs'
import path from 'node:path'
import type { MemoryEntry, MemoryFrontmatter, MemoryType } from './types'
import { parseMemoryType } from './types'
import { sanitizeUntrustedText, summarizeFindings } from '../security/sanitizeUntrustedText'

const MAX_FILE_BYTES = 64 * 1024
const MAX_SCAN_FILES = 200
/** `.claude/memory` is the canonical app write path — listed via workspaceMemoryDir, not scanned here again. */
const CANDIDATE_DIRS = [
  'memory',
  '.claude/memories',
  '.cursor/memory',
]

type MemdirEntry = MemoryEntry & {
  sourcePath: string
}

function parseFrontmatter(raw: string): {
  name: string
  description: string
  type: MemoryType
  created: string
  updated: string
  content: string
} | null {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/)
  if (!match) return null

  const map: Record<string, string> = {}
  for (const line of match[1].split(/\r?\n/)) {
    const i = line.indexOf(':')
    if (i <= 0) continue
    map[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }

  const type = parseMemoryType(map.type) || 'reference'
  const now = new Date().toISOString()

  return {
    name: map.name || 'External Memory',
    description: map.description || '',
    type,
    created: map.created || now,
    updated: map.updated || now,
    content: match[2].trim(),
  }
}

function makeFallbackEntry(filePath: string, raw: string): {
  name: string
  description: string
  type: MemoryType
  created: string
  updated: string
  content: string
} {
  const stat = fs.statSync(filePath)
  const basename = path.basename(filePath, '.md')
  const text = raw.trim()
  const preview = text.split(/\r?\n/).find((l) => l.trim()) || ''

  return {
    name: basename,
    description: preview.slice(0, 120),
    type: 'reference',
    created: stat.birthtime.toISOString(),
    updated: stat.mtime.toISOString(),
    content: text,
  }
}

function toEntry(filePath: string, parsed: {
  name: string
  description: string
  type: MemoryType
  created: string
  updated: string
  content: string
}): MemdirEntry {
  const ageMs = Date.now() - new Date(parsed.updated).getTime()
  const ageDays = Math.max(0, Math.floor(ageMs / 86_400_000))

  const fm: MemoryFrontmatter = {
    name: parsed.name,
    description: parsed.description,
    type: parsed.type,
    scope: 'project',
    enabled: true,
    tags: [],
    created: parsed.created,
    updated: parsed.updated,
  }
  return {
    filename: path.basename(filePath),
    frontmatter: fm,
    content: parsed.content,
    ageDays,
    isStale: ageDays > 30,
    sourcePath: filePath,
  }
}

function readMemoryFile(filePath: string): MemdirEntry | null {
  try {
    const stat = fs.statSync(filePath)
    if (!stat.isFile()) return null
    if (stat.size > MAX_FILE_BYTES) return null

    const raw = fs.readFileSync(filePath, 'utf-8')
    const parsed = parseFrontmatter(raw) ?? makeFallbackEntry(filePath, raw)
    if (!parsed.content.trim()) return null

    // Defense-in-depth: workspace memory / MEMORY.md feeds into the system
    // prompt; an imported / cloned project that ships malicious memory
    // files could carry hidden Unicode prompt-injection payloads. Strip
    // the high-risk subset (Tag chars, Bidi, ZW, BOM) before passing
    // content along to the LLM. See `electron/security/sanitizeUntrustedText.ts`.
    const sanitized = sanitizeUntrustedText(parsed.content)
    if (sanitized.findings.length > 0) {
      console.warn(
        `[memdir] Stripped ${sanitized.totalStripped} invisible Unicode char(s) from ${filePath}: ${summarizeFindings(sanitized.findings)}`,
      )
      parsed.content = sanitized.cleaned
    }

    return toEntry(filePath, parsed)
  } catch {
    return null
  }
}

function scanDir(baseDir: string): MemdirEntry[] {
  try {
    if (!fs.existsSync(baseDir) || !fs.statSync(baseDir).isDirectory()) return []
  } catch {
    return []
  }

  const result: MemdirEntry[] = []
  let scannedFiles = 0

  try {
    const entries = fs.readdirSync(baseDir, { withFileTypes: true })

    for (const ent of entries) {
      if (scannedFiles >= MAX_SCAN_FILES) break
      const fullPath = path.join(baseDir, ent.name)
      if (ent.isFile() && ent.name.toLowerCase().endsWith('.md')) {
        scannedFiles++
        const item = readMemoryFile(fullPath)
        if (item) result.push(item)
        continue
      }

      if (ent.isDirectory()) {
        try {
          const nested = fs.readdirSync(fullPath, { withFileTypes: true })
          for (const child of nested) {
            if (scannedFiles >= MAX_SCAN_FILES) break
            if (!child.isFile() || !child.name.toLowerCase().endsWith('.md')) continue
            scannedFiles++
            const item = readMemoryFile(path.join(fullPath, child.name))
            if (item) result.push(item)
          }
        } catch {
          // Skip unreadable subdirectories
        }
      }
    }
  } catch {
    // Skip unreadable base directory
  }

  return result
}

export function scanWorkspaceMemdir(workspacePath: string): MemdirEntry[] {
  const collected: MemdirEntry[] = []

  const rootMemory = path.join(workspacePath, 'MEMORY.md')
  if (fs.existsSync(rootMemory)) {
    const one = readMemoryFile(rootMemory)
    if (one) collected.push(one)
  }

  for (const rel of CANDIDATE_DIRS) {
    const dir = path.join(workspacePath, rel)
    collected.push(...scanDir(dir))
  }

  const byKey = new Map<string, MemdirEntry>()
  for (const item of collected) {
    const key = `${item.filename}::${item.frontmatter.name}`.toLowerCase()
    const prev = byKey.get(key)
    if (!prev || new Date(item.frontmatter.updated).getTime() > new Date(prev.frontmatter.updated).getTime()) {
      byKey.set(key, item)
    }
  }

  return [...byKey.values()].sort(
    (a, b) => new Date(b.frontmatter.updated).getTime() - new Date(a.frontmatter.updated).getTime(),
  )
}
