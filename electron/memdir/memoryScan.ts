/**
 * Memory directory scanning — adapted from upstream for cursor-ui-clone.
 *
 * Scans a memory directory for .md files, reads their frontmatter, and
 * returns a header list sorted newest-first.
 */

import { readdir, readFile, stat } from 'fs/promises'
import { join } from 'path'
import { type MemoryType, parseMemoryType } from './memoryTypes'

export type MemoryHeader = {
  filename: string
  filePath: string
  mtimeMs: number
  description: string | null
  type: MemoryType | undefined
}

const MAX_MEMORY_FILES = 200
const FRONTMATTER_MAX_LINES = 30

/**
 * Parse YAML frontmatter from markdown content.
 * Simple parser — handles the `---` delimited block with `key: value` pairs.
 */
function parseFrontmatter(content: string): {
  frontmatter: Record<string, string | undefined>
  body: string
} {
  const frontmatter: Record<string, string | undefined> = {}
  if (!content.startsWith('---\n')) {
    return { frontmatter, body: content }
  }
  const endIdx = content.indexOf('---\n', 4)
  if (endIdx === -1) {
    return { frontmatter, body: content }
  }
  const raw = content.slice(4, endIdx)
  for (const line of raw.split('\n')) {
    const colonIdx = line.indexOf(':')
    if (colonIdx === -1) continue
    const key = line.slice(0, colonIdx).trim()
    const value = line.slice(colonIdx + 1).trim()
    if (key && value) {
      frontmatter[key] = value
    }
  }
  return { frontmatter, body: content.slice(endIdx + 4) }
}

/**
 * Scan a memory directory for .md files, read their frontmatter, and return
 * a header list sorted newest-first (capped at MAX_MEMORY_FILES).
 */
export async function scanMemoryFiles(
  memoryDir: string,
): Promise<MemoryHeader[]> {
  try {
    const entries = await readdir(memoryDir, { recursive: true, withFileTypes: true })
    const mdFiles = entries.filter(
      f => f.isFile() && f.name.endsWith('.md') && f.name !== 'MEMORY.md',
    )

    const headerResults = await Promise.allSettled(
      mdFiles.map(async (dirent): Promise<MemoryHeader> => {
        const relativePath = dirent.name
        const filePath = join(memoryDir, relativePath)
        const st = await stat(filePath)
        const content = await readFile(filePath, 'utf-8')
        const lines = content.split('\n').slice(0, FRONTMATTER_MAX_LINES).join('\n')
        const { frontmatter } = parseFrontmatter(lines)
        return {
          filename: relativePath,
          filePath,
          mtimeMs: st.mtimeMs,
          description: frontmatter.description || null,
          type: parseMemoryType(frontmatter.type),
        }
      }),
    )

    return headerResults
      .filter(
        (r): r is PromiseFulfilledResult<MemoryHeader> =>
          r.status === 'fulfilled',
      )
      .map(r => r.value)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, MAX_MEMORY_FILES)
  } catch {
    return []
  }
}

/**
 * Format memory headers as a text manifest: one line per file with
 * [type] filename (timestamp): description.
 */
export function formatMemoryManifest(memories: MemoryHeader[]): string {
  return memories
    .map(m => {
      const tag = m.type ? `[${m.type}] ` : ''
      const ts = new Date(m.mtimeMs).toISOString()
      return m.description
        ? `- ${tag}${m.filename} (${ts}): ${m.description}`
        : `- ${tag}${m.filename} (${ts})`
    })
    .join('\n')
}
