/**
 * File-based conversation storage.
 * Each conversation is stored as a JSON file under userData/conversations/<projectHash>/.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { writeJsonFileAtomic } from '../fs/atomicWrite'
import type {
  ConversationData,
  ConversationMeta,
  ConversationSearchResult,
} from './types'

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

export function getBaseDir(userDataPath: string, dataStoragePath?: string): string {
  const basePath = dataStoragePath || userDataPath
  return path.join(basePath, 'conversations')
}

function digestHash16(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 16)
}

/**
 * Stable key for the same folder on disk (fixes Windows casing + relative vs absolute drift).
 * Packaged app + folder dialog + recent list used to produce different strings → different hashes → wrong/empty chat buckets.
 */
export function stableWorkspaceKey(workspacePath: string): string {
  const t = (workspacePath || '').trim()
  if (!t) return ''
  if (t === '__init__') return '__init__'
  try {
    let r = path.resolve(t)
    r = r.replace(/\\/g, '/')
    if (process.platform === 'win32') r = r.toLowerCase()
    return r
  } catch {
    const r = t.replace(/\\/g, '/')
    return process.platform === 'win32' ? r.toLowerCase() : r
  }
}

/**
 * Compose the effective bucket key for hashing when a bundle partition
 * is in effect. Two invariants:
 *
 *   1. No bundleId → same key as before (pure `stableWorkspaceKey`).
 *   2. bundleId === 'code-dev' → same key as before. The default Code
 *      bundle is the "legacy" partition by design, so every existing
 *      conversation on disk remains discoverable without migration.
 *
 * Any other bundleId gets an out-of-band suffix that cannot collide
 * with a real path (`::bundle::` contains `:` which Windows forbids in
 * file names; it only feeds into a sha256 so that's fine).
 */
function effectiveBucketKey(workspacePath: string, bundleId?: string): string {
  const base = stableWorkspaceKey(workspacePath)
  if (!base) return base
  if (!bundleId || bundleId === 'code-dev') return base
  return `${base}::bundle::${bundleId}`
}

/** Storage bucket id (canonical). */
export function hashWorkspace(workspacePath: string, bundleId?: string): string {
  return digestHash16(effectiveBucketKey(workspacePath, bundleId))
}

/** Pre-fix bucket: raw string as passed from renderer (case/spelling sensitive).
 *  The legacy fallback only matters for the default bundle — earlier
 *  versions of the app never produced bundle-suffixed keys, so we skip
 *  the legacy probe for non-default bundles. */
function legacyWorkspaceHash16(workspacePath: string, bundleId?: string): string {
  if (bundleId && bundleId !== 'code-dev') return ''
  return digestHash16(workspacePath || '')
}

function projectDirsForWorkspace(
  userDataPath: string,
  workspacePath: string,
  bundleId?: string,
): string[] {
  const base = getBaseDir(userDataPath)
  const seen = new Set<string>()
  const out: string[] = []
  const push = (hashHex: string) => {
    if (!hashHex || seen.has(hashHex)) return
    seen.add(hashHex)
    const dir = path.join(base, hashHex)
    if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
      out.push(dir)
    }
  }
  const canon = hashWorkspace(workspacePath, bundleId)
  const leg = legacyWorkspaceHash16(workspacePath, bundleId)
  push(canon)
  if (leg && leg !== canon) {
    push(leg)
  }
  return out
}

export function getProjectDir(
  userDataPath: string,
  workspacePath: string,
  bundleId?: string,
): string {
  return path.join(getBaseDir(userDataPath), hashWorkspace(workspacePath, bundleId))
}

export function ensureProjectDir(
  userDataPath: string,
  workspacePath: string,
  bundleId?: string,
): string {
  const dir = getProjectDir(userDataPath, workspacePath, bundleId)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Resolve the absolute on-disk path for a persisted conversation JSON
 * without creating any directory. Used by the context-compaction path
 * to embed a `transcriptPath` hint inside the compact-summary user
 * message so the model can `Read` the full pre-compact transcript when
 * the summary alone doesn't surface a needed detail.
 *
 * Mirrors the `path.join(dir, ${id}.json)` used in
 * {@link saveConversationFile}. Uses `getProjectDir` (no mkdir) so
 * read-only callers don't churn the filesystem.
 */
export function resolveConversationFilePath(
  userDataPath: string,
  workspacePath: string,
  conversationId: string,
  bundleId?: string,
): string {
  return path.join(getProjectDir(userDataPath, workspacePath, bundleId), `${conversationId}.json`)
}

const CONVERSATION_ORDER_FILENAME = '_conversation-order.json'

interface ConversationOrderFile {
  version: 1
  ids: string[]
}

export function readConversationOrder(
  userDataPath: string,
  workspacePath: string,
  bundleId?: string,
): string[] {
  const dir = getProjectDir(userDataPath, workspacePath, bundleId)
  const filePath = path.join(dir, CONVERSATION_ORDER_FILENAME)
  if (!fs.existsSync(filePath)) return []
  try {
    const raw = fs.readFileSync(filePath, 'utf-8')
    const data = JSON.parse(raw) as ConversationOrderFile
    if (!data || data.version !== 1 || !Array.isArray(data.ids)) return []
    return data.ids.filter((id) => typeof id === 'string' && id.trim())
  } catch {
    return []
  }
}

export function writeConversationOrder(
  userDataPath: string,
  workspacePath: string,
  orderedIds: string[],
  bundleId?: string,
): void {
  const dir = ensureProjectDir(userDataPath, workspacePath, bundleId)
  const filePath = path.join(dir, CONVERSATION_ORDER_FILENAME)
  const payload: ConversationOrderFile = { version: 1, ids: [...orderedIds] }
  writeJsonFileAtomic(filePath, payload)
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export function saveConversationFile(
  userDataPath: string,
  data: ConversationData,
  bundleId?: string,
): void {
  const dir = ensureProjectDir(userDataPath, data.meta.workspacePath, bundleId)
  const filePath = path.join(dir, `${data.meta.id}.json`)
  writeJsonFileAtomic(filePath, data)

  // Drop legacy-bucket copy so list() does not see two copies of the same id after migration.
  // Only relevant for the default bundle — non-default bundles have no
  // legacy bucket to collide with.
  if (!bundleId || bundleId === 'code-dev') {
    const base = getBaseDir(userDataPath)
    const canon = hashWorkspace(data.meta.workspacePath, bundleId)
    const leg = legacyWorkspaceHash16(data.meta.workspacePath, bundleId)
    if (leg && leg !== canon) {
      const legFile = path.join(base, leg, `${data.meta.id}.json`)
      try {
        if (fs.existsSync(legFile) && path.resolve(legFile) !== path.resolve(filePath)) {
          fs.unlinkSync(legFile)
        }
      } catch {
        /* ignore */
      }
    }
  }
}

export function loadConversationFile(
  userDataPath: string,
  convId: string,
  workspacePath: string,
  bundleId?: string,
): ConversationData | null {
  for (const dir of projectDirsForWorkspace(userDataPath, workspacePath, bundleId)) {
    const filePath = path.join(dir, `${convId}.json`)
    if (!fs.existsSync(filePath)) continue
    try {
      const raw = fs.readFileSync(filePath, 'utf-8')
      return JSON.parse(raw) as ConversationData
    } catch {
      return null
    }
  }
  return null
}

export function listConversationFiles(
  userDataPath: string,
  workspacePath: string,
  bundleId?: string,
): ConversationMeta[] {
  const dirs = projectDirsForWorkspace(userDataPath, workspacePath, bundleId)
  if (dirs.length === 0) return []

  const byId = new Map<string, ConversationMeta>()

  for (const dir of dirs) {
    try {
      const files = fs.readdirSync(dir).filter(
        (f) => f.endsWith('.json') && !f.startsWith('_'),
      )
      for (const file of files) {
        try {
          const raw = fs.readFileSync(path.join(dir, file), 'utf-8')
          const data = JSON.parse(raw) as ConversationData
          const prev = byId.get(data.meta.id)
          if (!prev || data.meta.updatedAt > prev.updatedAt) {
            byId.set(data.meta.id, data.meta)
          }
        } catch {
          // skip corrupted files
        }
      }
    } catch {
      // skip unreadable dirs
    }
  }

  const list = [...byId.values()]
  const order = readConversationOrder(userDataPath, workspacePath, bundleId)
  if (order.length === 0) {
    return list.sort((a, b) => b.updatedAt - a.updatedAt)
  }
  const byIdMap = new Map(list.map((m) => [m.id, m]))
  const out: ConversationMeta[] = []
  const seen = new Set<string>()
  for (const id of order) {
    const m = byIdMap.get(id)
    if (m) {
      out.push(m)
      seen.add(id)
    }
  }
  const rest = list
    .filter((m) => !seen.has(m.id))
    .sort((a, b) => b.updatedAt - a.updatedAt)
  out.push(...rest)
  return out
}

export function deleteConversationFile(
  userDataPath: string,
  convId: string,
  workspacePath: string,
  bundleId?: string,
): boolean {
  let removed = false
  for (const dir of projectDirsForWorkspace(userDataPath, workspacePath, bundleId)) {
    const filePath = path.join(dir, `${convId}.json`)
    if (!fs.existsSync(filePath)) continue
    try {
      fs.unlinkSync(filePath)
      removed = true
    } catch {
      /* ignore */
    }
  }
  return removed
}

export function renameConversationTitle(
  userDataPath: string,
  convId: string,
  workspacePath: string,
  newTitle: string,
  bundleId?: string,
): boolean {
  const data = loadConversationFile(userDataPath, convId, workspacePath, bundleId)
  if (!data) return false
  const trimmed = newTitle.trim()
  if (trimmed) data.meta.title = trimmed
  data.meta.updatedAt = Date.now()
  saveConversationFile(userDataPath, data, bundleId)
  return true
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export function searchConversationFiles(
  userDataPath: string,
  query: string,
  workspacePath?: string,
  bundleId?: string,
): ConversationSearchResult[] {
  const baseDir = getBaseDir(userDataPath)
  if (!fs.existsSync(baseDir)) return []

  const lowerQuery = query.toLowerCase()
  const results: ConversationSearchResult[] = []

  const dirs: string[] = []
  if (workspacePath) {
    dirs.push(...projectDirsForWorkspace(userDataPath, workspacePath, bundleId))
  } else {
    // Search all projects
    try {
      for (const entry of fs.readdirSync(baseDir)) {
        const full = path.join(baseDir, entry)
        if (fs.statSync(full).isDirectory()) dirs.push(full)
      }
    } catch {
      return []
    }
  }

  for (const dir of dirs) {
    try {
      const files = fs.readdirSync(dir).filter(
        (f) => f.endsWith('.json') && !f.startsWith('_'),
      )
      for (const file of files) {
        try {
          const raw = fs.readFileSync(path.join(dir, file), 'utf-8')
          const data = JSON.parse(raw) as ConversationData

          for (const msg of data.messages) {
            if (msg.content && msg.content.toLowerCase().includes(lowerQuery)) {
              results.push({
                conversationId: data.meta.id,
                conversationTitle: data.meta.title,
                messageId: msg.id,
                role: msg.role,
                preview: msg.content.slice(0, 200),
                timestamp: msg.timestamp,
              })
              if (results.length >= 200) return results
            }
          }
        } catch {
          // skip corrupted
        }
      }
    } catch {
      // skip unreadable dirs
    }
  }

  return results
}
