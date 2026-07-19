/**
 * File-based memory storage with YAML frontmatter.
 * No external dependencies — uses regex-based frontmatter parsing.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { MemoryEntry, MemoryFrontmatter } from './types'
import { parseMemoryScope, parseMemoryType } from './types'
import { getMemoryFeatureFlags } from './memoryFeatureFlags'
import { validateMemoryPath } from './pathSafety'
import { atomicWriteFile } from '../diff/atomicWriter'
import { fileHistoryTrackEdit } from '../fs/fileHistory'
import { sanitizeUntrustedText, summarizeFindings } from '../security/sanitizeUntrustedText'

const MAX_INDEX_LINES = 200
const MAX_INDEX_BYTES = 25_000

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

export function getBaseMemoryDir(userDataPath: string, dataStoragePath?: string): string {
  const basePath = dataStoragePath || userDataPath
  return path.join(basePath, 'memory')
}

export function hashProjectPath(projectPath: string): string {
  return crypto
    .createHash('sha256')
    .update(projectPath)
    .digest('hex')
    .slice(0, 16)
}

export function sanitizeFilename(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) + '.md'
  )
}

/**
 * Disambiguate a sanitised filename when it would collide with an EXISTING
 * memory file whose `frontmatter.name` differs from the new name. The
 * sanitisation rules (lowercase + non-alphanumeric → `-` + 64-char cap) map
 * many distinct names to the same filename — e.g. "编辑器-配色偏好" /
 * "编辑器-字体偏好" / "Editor Theme Settings" can all collapse to
 * `编辑器-偏好.md` after sanitisation. Without a collision check the
 * auto-extract pipeline (`batchCreateOrUpdate`) silently overwrites whatever
 * is on disk; we add a short content-hash suffix instead so the new entry
 * lands at a unique filename.
 *
 * Returns the original `desiredFilename` when there is no collision, or
 * when the existing file's name matches `newName` (case-insensitive trim) —
 * which IS a legitimate update of the same memory.
 *
 * The hash is stable per `<newName>` so retrying the same extraction maps to
 * the same suffix, keeping the auto-extract pipeline idempotent.
 */
export function resolveFilenameWithoutCollision(
  absDir: string,
  desiredFilename: string,
  newName: string,
): string {
  if (!fs.existsSync(absDir)) return desiredFilename
  const existing = readMemoryFile(absDir, desiredFilename)
  if (!existing) return desiredFilename

  // Same-name update — not a collision, callers should overwrite.
  const a = existing.frontmatter.name.trim().toLowerCase()
  const b = newName.trim().toLowerCase()
  if (a === b) return desiredFilename

  // Collision: suffix with a 6-char hash of the new name so re-extractions
  // of the same logical entity always land at the same filename.
  const suffix = crypto
    .createHash('sha256')
    .update(newName)
    .digest('hex')
    .slice(0, 6)
  const ext = path.extname(desiredFilename)
  const stem = desiredFilename.slice(0, desiredFilename.length - ext.length)
  // Keep total stem length within the 64-char budget so the result fits the
  // same "shaped" constraint sanitizeFilename promises.
  const trimmedStem = stem.slice(0, 64 - 1 - suffix.length)
  const candidate = `${trimmedStem}-${suffix}${ext}`

  // It's possible (very unlikely) the candidate ALSO already exists with a
  // different frontmatter name — handle one more time with a numeric suffix
  // and then give up: at that point the directory is pathologically full of
  // collisions and the caller should surface it as an error rather than
  // silently picking a name. Two layers is enough for realistic workloads.
  const c1 = readMemoryFile(absDir, candidate)
  if (!c1) return candidate
  if (c1.frontmatter.name.trim().toLowerCase() === b) return candidate
  for (let i = 2; i < 10; i++) {
    const next = `${trimmedStem}-${suffix}-${i}${ext}`
    const e = readMemoryFile(absDir, next)
    if (!e) return next
    if (e.frontmatter.name.trim().toLowerCase() === b) return next
  }
  // Exhausted — surface the original (caller's `chooseKeeper` / merge logic
  // will still get the right answer via the in-batch lock; this is
  // defensive belt-and-suspenders and should never happen in practice).
  return desiredFilename
}

export function getProjectMemoryDir(
  userDataPath: string,
  projectHash: string,
): string {
  return path.join(getBaseMemoryDir(userDataPath), projectHash)
}

export function ensureMemoryDir(
  userDataPath: string,
  projectHash: string,
): string {
  const dir = getProjectMemoryDir(userDataPath, projectHash)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

// ---------------------------------------------------------------------------
// Frontmatter parsing / serialization
// ---------------------------------------------------------------------------

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/

function parseTagsValue(raw: string | undefined): string[] {
  if (!raw) return []
  const t = raw.trim()
  if (!t) return []
  if (t.startsWith('[')) {
    try {
      const parsed = JSON.parse(t) as unknown
      if (Array.isArray(parsed)) {
        return parsed.filter((x): x is string => typeof x === 'string')
      }
    } catch {
      /* fall through */
    }
  }
  return t.split(',').map((s) => s.trim()).filter(Boolean)
}

function parseBoolValue(raw: string | undefined, defaultVal: boolean): boolean {
  if (raw === undefined) return defaultVal
  const l = raw.trim().toLowerCase()
  if (l === 'false' || l === '0' || l === 'no') return false
  if (l === 'true' || l === '1' || l === 'yes') return true
  return defaultVal
}

export function parseFrontmatter(
  raw: string,
): { frontmatter: MemoryFrontmatter; content: string } | null {
  const match = raw.match(FRONTMATTER_RE)
  if (!match) return null

  const fm: Record<string, string> = {}
  for (const line of match[1].split(/\r?\n/)) {
    const idx = line.indexOf(':')
    if (idx > 0) {
      fm[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
    }
  }

  const originalLengthRaw = fm.originalLength
  const originalLength = originalLengthRaw && /^\d+$/.test(originalLengthRaw.trim())
    ? parseInt(originalLengthRaw.trim(), 10)
    : undefined

  return {
    frontmatter: {
      name: fm.name || 'Untitled',
      description: fm.description || '',
      type: parseMemoryType(fm.type) || 'feedback',
      created: fm.created || new Date().toISOString(),
      updated: fm.updated || new Date().toISOString(),
      scope: parseMemoryScope(fm.scope, 'project'),
      enabled: parseBoolValue(fm.enabled, true),
      tags: parseTagsValue(fm.tags),
      ...(fm.consolidatedAt ? { consolidatedAt: fm.consolidatedAt } : {}),
      ...(originalLength !== undefined ? { originalLength } : {}),
      ...(fm.originalHash ? { originalHash: fm.originalHash } : {}),
      ...(fm.truncatedHash ? { truncatedHash: fm.truncatedHash } : {}),
    },
    content: match[2].trim(),
  }
}

export function serializeMemoryFile(
  frontmatter: MemoryFrontmatter,
  content: string,
): string {
  const lines = [
    '---',
    `name: ${frontmatter.name}`,
    `description: ${frontmatter.description}`,
    `type: ${frontmatter.type}`,
    `created: ${frontmatter.created}`,
    `updated: ${frontmatter.updated}`,
  ]
  if (frontmatter.scope !== undefined) {
    lines.push(`scope: ${frontmatter.scope}`)
  }
  if (frontmatter.enabled !== undefined) {
    lines.push(`enabled: ${frontmatter.enabled}`)
  }
  if (frontmatter.tags !== undefined && frontmatter.tags.length > 0) {
    lines.push(`tags: ${JSON.stringify(frontmatter.tags)}`)
  }
  if (frontmatter.consolidatedAt) {
    lines.push(`consolidatedAt: ${frontmatter.consolidatedAt}`)
  }
  if (typeof frontmatter.originalLength === 'number') {
    lines.push(`originalLength: ${frontmatter.originalLength}`)
  }
  if (frontmatter.originalHash) {
    lines.push(`originalHash: ${frontmatter.originalHash}`)
  }
  if (frontmatter.truncatedHash) {
    lines.push(`truncatedHash: ${frontmatter.truncatedHash}`)
  }
  lines.push('---', '', content, '')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// CRUD operations
// ---------------------------------------------------------------------------

export function listMemories(
  userDataPath: string,
  projectHash: string,
): MemoryEntry[] {
  const dir = getProjectMemoryDir(userDataPath, projectHash)
  if (!fs.existsSync(dir)) return []

  try {
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.md') && f !== 'MEMORY.md')

    return files
      .map((filename) => readMemory(userDataPath, projectHash, filename))
      .filter((e): e is MemoryEntry => e !== null)
      .sort(
        (a, b) =>
          new Date(b.frontmatter.updated).getTime() -
          new Date(a.frontmatter.updated).getTime(),
      )
  } catch {
    return []
  }
}

export function readMemory(
  userDataPath: string,
  projectHash: string,
  filename: string,
): MemoryEntry | null {
  const filePath = path.join(
    getProjectMemoryDir(userDataPath, projectHash),
    filename,
  )
  if (!fs.existsSync(filePath)) return null

  try {
    const raw = fs.readFileSync(filePath, 'utf-8')
    const parsed = parseFrontmatter(raw)
    if (!parsed) return null

    const ageMs = Date.now() - new Date(parsed.frontmatter.updated).getTime()
    const ageDays = Math.max(0, Math.floor(ageMs / 86_400_000))

    return {
      filename,
      frontmatter: parsed.frontmatter,
      content: parsed.content,
      ageDays,
      isStale: ageDays > 30,
    }
  } catch {
    return null
  }
}

export function writeMemory(
  userDataPath: string,
  projectHash: string,
  filename: string,
  frontmatter: MemoryFrontmatter,
  content: string,
): MemoryEntry {
  const dir = ensureMemoryDir(userDataPath, projectHash)
  const filePath = path.join(dir, filename)

  const now = new Date().toISOString()
  const isUpdate = fs.existsSync(filePath)

  const fm: MemoryFrontmatter = {
    ...frontmatter,
    created: isUpdate
      ? readMemory(userDataPath, projectHash, filename)?.frontmatter.created || now
      : now,
    updated: now,
  }

  // Atomic write: temp-+-rename so a crash mid-write never leaves a
  // half-written memory file. Memory files are AI-managed user data —
  // the same crash-safety contract the file-edit tools enforce applies
  // here. atomicWriter handles symlink + chmod + post-verify internally.
  //
  // fileHistory backup intentionally NOT wired into the sync path: it's
  // async and we'd lose the await durability. The async variant
  // (`writeMemoryFileAsync`) DOES include the backup. Callers performing
  // batch / background memory mutations should prefer the async API.
  const writeRes = atomicWriteFile(filePath, {
    expectedContentHash: null,
    newContent: serializeMemoryFile(fm, content),
  })
  if (!writeRes.ok) {
    throw new Error(`writeMemory failed (${writeRes.code}): ${writeRes.message}`)
  }

  const ageDays = 0
  return {
    filename,
    frontmatter: fm,
    content,
    ageDays,
    isStale: false,
  }
}

export function deleteMemory(
  userDataPath: string,
  projectHash: string,
  filename: string,
): boolean {
  const filePath = path.join(
    getProjectMemoryDir(userDataPath, projectHash),
    filename,
  )
  if (!fs.existsSync(filePath)) return false
  fs.unlinkSync(filePath)
  return true
}

// ---------------------------------------------------------------------------
// MEMORY.md index management
// ---------------------------------------------------------------------------

export function readIndex(
  userDataPath: string,
  projectHash: string,
): string | null {
  const indexPath = path.join(
    getProjectMemoryDir(userDataPath, projectHash),
    'MEMORY.md',
  )
  if (!fs.existsSync(indexPath)) return null

  try {
    return fs.readFileSync(indexPath, 'utf-8')
  } catch {
    return null
  }
}

export function rebuildIndex(
  userDataPath: string,
  projectHash: string,
): void {
  const memories = listMemories(userDataPath, projectHash)
  const dir = ensureMemoryDir(userDataPath, projectHash)
  rebuildIndexInDir(dir, memories)
}

// ---------------------------------------------------------------------------
// Workspace + bundle (install-side) memory roots
// ---------------------------------------------------------------------------

/** Project / session memories live under the open workspace (per-repo). */
export function workspaceMemoryDir(workspacePath: string): string {
  return path.join(workspacePath, '.claude', 'memory')
}

/**
 * Resolved project memory root — upstream §2.5 / §9 equivalent:
 * 1) `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE` / disk override (validated absolute path)
 * 2) Remote: `<REMOTE_MEMORY_DIR>/projects/<workspace-slug>/memory/`
 * 3) Default: `<workspace>/.claude/memory/`
 */
export function resolveWorkspaceMemoryDir(workspacePath: string): string {
  const flags = getMemoryFeatureFlags()
  const ov = flags.memoryPathOverride?.trim()
  if (ov) {
    const v = validateMemoryPath(ov)
    if (v.valid) {
      return path.normalize(path.resolve(ov))
    }
  }
  if (flags.remoteMode && flags.remoteMemoryDir?.trim()) {
    const slug = crypto
      .createHash('sha256')
      .update(path.resolve(workspacePath.trim()))
      .digest('hex')
      .slice(0, 16)
    return path.join(path.normalize(flags.remoteMemoryDir.trim()), 'projects', slug, 'memory')
  }
  return workspaceMemoryDir(workspacePath)
}

/** User-scoped memories live next to the app install (bundle data root). */
export function userMemoryDir(bundleDataRoot: string): string {
  return path.join(bundleDataRoot, 'memory', 'user')
}

export function listMemoriesAtRoot(absDir: string): MemoryEntry[] {
  if (!fs.existsSync(absDir)) return []

  try {
    const files = fs
      .readdirSync(absDir)
      .filter((f) => f.endsWith('.md') && f !== 'MEMORY.md')

    return files
      .map((filename) => readMemoryFile(absDir, filename))
      .filter((e): e is MemoryEntry => e !== null)
      .sort(
        (a, b) =>
          new Date(b.frontmatter.updated).getTime() -
          new Date(a.frontmatter.updated).getTime(),
      )
  } catch {
    return []
  }
}

export function readMemoryFile(absDir: string, filename: string): MemoryEntry | null {
  const filePath = path.join(absDir, filename)
  if (!fs.existsSync(filePath)) return null

  try {
    const raw = fs.readFileSync(filePath, 'utf-8')
    const parsed = parseFrontmatter(raw)
    if (!parsed) return null

    // Defense-in-depth: memory files are written by the AI itself in normal
    // operation, but they can also be imported (memory packs, hand-edited by
    // a malicious teammate, shared via project repo). Strip hidden Unicode
    // payloads before the content is fed back into the model's context.
    // See `electron/security/sanitizeUntrustedText.ts` for the threat model.
    const sanitized = sanitizeUntrustedText(parsed.content)
    if (sanitized.findings.length > 0) {
      console.warn(
        `[memory] Stripped ${sanitized.totalStripped} invisible Unicode char(s) from ${filePath}: ${summarizeFindings(sanitized.findings)}`,
      )
    }

    // Audit M1: the frontmatter `name` / `description` / `tags` fields are NOT
    // just metadata — they flow verbatim into the model's context via the
    // recalled-memory prompt (`buildRecalledMemoryPrompt`), the side-query
    // manifest (`formatMemoryManifest`), and the MEMORY.md index. A hidden
    // Unicode / bidi / prompt-injection payload smuggled into a `name:` or
    // `description:` line would otherwise bypass the content sanitizer above.
    // Same threat model as the content strip — apply it to the prompt-facing
    // frontmatter fields too.
    const fm = parsed.frontmatter
    const sanitizedFrontmatter: MemoryFrontmatter = {
      ...fm,
      name: sanitizeUntrustedText(fm.name).cleaned,
      description: sanitizeUntrustedText(fm.description).cleaned,
      ...(fm.tags
        ? { tags: fm.tags.map((t) => sanitizeUntrustedText(t).cleaned) }
        : {}),
    }

    const ageMs = Date.now() - new Date(sanitizedFrontmatter.updated).getTime()
    const ageDays = Math.max(0, Math.floor(ageMs / 86_400_000))

    return {
      filename,
      frontmatter: sanitizedFrontmatter,
      content: sanitized.cleaned,
      ageDays,
      isStale: ageDays > 30,
    }
  } catch {
    return null
  }
}

export function writeMemoryFile(
  absDir: string,
  filename: string,
  frontmatter: MemoryFrontmatter,
  content: string,
): MemoryEntry {
  fs.mkdirSync(absDir, { recursive: true })
  const filePath = path.join(absDir, filename)

  const now = new Date().toISOString()
  const isUpdate = fs.existsSync(filePath)

  const fm: MemoryFrontmatter = {
    ...frontmatter,
    created: isUpdate
      ? readMemoryFile(absDir, filename)?.frontmatter.created || now
      : now,
    updated: now,
  }

  // Atomic write — same rationale as `writeMemory` above. Sync API,
  // no fileHistory backup (async-only); the async sibling
  // `writeMemoryFileAsync` adds backup for batch callers.
  const writeRes = atomicWriteFile(filePath, {
    expectedContentHash: null,
    newContent: serializeMemoryFile(fm, content),
  })
  if (!writeRes.ok) {
    throw new Error(`writeMemoryFile failed (${writeRes.code}): ${writeRes.message}`)
  }

  return {
    filename,
    frontmatter: fm,
    content,
    ageDays: 0,
    isStale: false,
  }
}

export function deleteMemoryFile(absDir: string, filename: string): boolean {
  const filePath = path.join(absDir, filename)
  if (!fs.existsSync(filePath)) return false
  fs.unlinkSync(filePath)
  return true
}

// ── Async variants (non-blocking — prefer these in async consolidation/extraction pipelines) ──

export async function writeMemoryFileAsync(
  absDir: string,
  filename: string,
  frontmatter: MemoryFrontmatter,
  content: string,
  opts?: { preserveUpdated?: boolean },
): Promise<MemoryEntry> {
  await fsp.mkdir(absDir, { recursive: true })
  const filePath = path.join(absDir, filename)

  const now = new Date().toISOString()
  let created = now
  try {
    const existing = await fsp.readFile(filePath, 'utf-8')
    const parsed = parseFrontmatter(existing)
    if (parsed?.frontmatter.created) created = parsed.frontmatter.created
  } catch {
    /* file doesn't exist yet — keep `now` */
  }

  // The consolidate-stamp pass writes `consolidatedAt: <sweep-start>` and
  // calls this function purely to persist the stamp. If we always
  // overwrite `updated: now`, then `updated` ends up newer than
  // `consolidatedAt`, which makes `isEntryUnchangedSinceConsolidate`
  // perpetually return `false` — defeating the entire incremental-skip
  // optimization. `preserveUpdated: true` opts out of the bump so callers
  // that are explicitly stamping metadata (not changing content) keep the
  // existing `updated` invariant.
  const updated = opts?.preserveUpdated && frontmatter.updated
    ? frontmatter.updated
    : now
  const fm: MemoryFrontmatter = {
    ...frontmatter,
    created,
    updated,
  }

  // Snapshot pre-edit bytes BEFORE the destructive write so the user can
  // recover the prior memory state via the same fileHistory mechanism
  // the AI Edit tools use. Awaited so the backup is durable before we
  // overwrite; failures are non-fatal (the main write still proceeds —
  // see fileHistory module docs).
  //
  // Idempotent per (session, filePath) — repeated overwrites in the same
  // session reuse the FIRST backup ("rewind to the version before AI
  // touched it this session"), which is the recovery target we want.
  await fileHistoryTrackEdit(filePath)

  // Atomic write (crash + symlink + chmod-preserving).
  const writeRes = atomicWriteFile(filePath, {
    expectedContentHash: null,
    newContent: serializeMemoryFile(fm, content),
  })
  if (!writeRes.ok) {
    throw new Error(
      `writeMemoryFileAsync failed (${writeRes.code}): ${writeRes.message}`,
    )
  }

  return {
    filename,
    frontmatter: fm,
    content,
    ageDays: 0,
    isStale: false,
  }
}

export async function deleteMemoryFileAsync(absDir: string, filename: string): Promise<boolean> {
  const filePath = path.join(absDir, filename)
  try {
    await fsp.unlink(filePath)
    return true
  } catch {
    return false
  }
}

export function rebuildIndexInDir(absDir: string, memories?: MemoryEntry[]): void {
  const list = memories ?? listMemoriesAtRoot(absDir)
  fs.mkdirSync(absDir, { recursive: true })
  const indexPath = path.join(absDir, 'MEMORY.md')

  // The index is a DERIVED artifact (regenerated from the live memory
  // file set via listMemoriesAtRoot). atomicWriter gives us crash-safe
  // overwrite; fileHistory backup is intentionally NOT wired here because
  // a lost index regenerates on next sweep — keeping that historical
  // copy on disk would only bloat the file-history bucket.
  const writeIndex = (body: string): void => {
    const writeRes = atomicWriteFile(indexPath, {
      expectedContentHash: null,
      newContent: body,
    })
    if (!writeRes.ok) {
      throw new Error(
        `rebuildIndexInDir failed (${writeRes.code}): ${writeRes.message}`,
      )
    }
  }

  if (list.length === 0) {
    writeIndex('# Memory Index\n\nNo memories stored yet.\n')
    return
  }

  const lines: string[] = ['# Memory Index', '']

  for (const mem of list) {
    const fm = mem.frontmatter
    lines.push(`- [${fm.name}](${mem.filename}) — ${fm.description}`)
  }

  const content = lines.join('\n')

  let result = content
  const contentLines = content.split('\n')
  if (contentLines.length > MAX_INDEX_LINES) {
    result = contentLines.slice(0, MAX_INDEX_LINES).join('\n')
    result += `\n\n> WARNING: MEMORY.md exceeded ${MAX_INDEX_LINES} lines. Only part of it was loaded.`
  }
  if (Buffer.byteLength(result, 'utf-8') > MAX_INDEX_BYTES) {
    const cutAt = result.lastIndexOf('\n', MAX_INDEX_BYTES)
    result = result.slice(0, cutAt > 0 ? cutAt : MAX_INDEX_BYTES)
    result += `\n\n> WARNING: MEMORY.md exceeded ${MAX_INDEX_BYTES} bytes. Only part of it was loaded.`
  }

  writeIndex(result)
}

/** Async variant — use in consolidation/extraction pipelines to avoid blocking the event loop. */
export async function rebuildIndexInDirAsync(absDir: string, memories?: MemoryEntry[]): Promise<void> {
  const list = memories ?? listMemoriesAtRoot(absDir)
  await fsp.mkdir(absDir, { recursive: true })
  const indexPath = path.join(absDir, 'MEMORY.md')

  // Same rationale as the sync `rebuildIndexInDir`: the index is a
  // derived artifact regenerable from disk, so atomicWriter (crash
  // safety) is enough — no fileHistory backup of derived state.
  const writeIndex = (body: string): void => {
    const writeRes = atomicWriteFile(indexPath, {
      expectedContentHash: null,
      newContent: body,
    })
    if (!writeRes.ok) {
      throw new Error(
        `rebuildIndexInDirAsync failed (${writeRes.code}): ${writeRes.message}`,
      )
    }
  }

  if (list.length === 0) {
    writeIndex('# Memory Index\n\nNo memories stored yet.\n')
    return
  }

  const lines: string[] = ['# Memory Index', '']
  for (const mem of list) {
    const fm = mem.frontmatter
    lines.push(`- [${fm.name}](${mem.filename}) — ${fm.description}`)
  }

  const content = lines.join('\n')
  let result = content
  const contentLines = content.split('\n')
  if (contentLines.length > MAX_INDEX_LINES) {
    result = contentLines.slice(0, MAX_INDEX_LINES).join('\n')
    result += `\n\n> WARNING: MEMORY.md exceeded ${MAX_INDEX_LINES} lines. Only part of it was loaded.`
  }
  if (Buffer.byteLength(result, 'utf-8') > MAX_INDEX_BYTES) {
    const cutAt = result.lastIndexOf('\n', MAX_INDEX_BYTES)
    result = result.slice(0, cutAt > 0 ? cutAt : MAX_INDEX_BYTES)
    result += `\n\n> WARNING: MEMORY.md exceeded ${MAX_INDEX_BYTES} bytes. Only part of it was loaded.`
  }

  writeIndex(result)
}
