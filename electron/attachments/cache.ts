/**
 * On-disk cache for ingested attachments, keyed by content sha256 + parser
 * version. The cache lives under `{userData}/attachment-cache/` and stores
 * one JSON file per entry.
 *
 * Hit semantics:
 *  - Same file (by sha256) re-uploaded → instant return, no re-parsing.
 *  - PARSER_VERSION bump invalidates all entries automatically (we ignore
 *    entries whose stored version differs).
 *
 * Size/GC:
 *  - Cache files are small (text + base64 for PDFs). We enforce a soft cap
 *    of 200MB total by LRU-evicting old entries on write.
 *  - Each entry's access time is `mtimeMs` (refreshed on hit).
 */

import { createHash } from 'crypto'
import { readFile, writeFile, mkdir, readdir, stat, utimes, unlink } from 'fs/promises'
import path from 'path'
import { app } from 'electron'

import type { IngestedAttachment } from './types'

/** Bump this whenever the ingest pipeline changes its output schema/semantics. */
export const PARSER_VERSION = 2

const MAX_CACHE_BYTES = 200 * 1024 * 1024 // 200 MB soft cap

let cacheDirPromise: Promise<string> | null = null

async function getCacheDir(): Promise<string> {
  if (cacheDirPromise) return cacheDirPromise
  cacheDirPromise = (async () => {
    const base = app.getPath('userData')
    const dir = path.join(base, 'attachment-cache')
    await mkdir(dir, { recursive: true })
    return dir
  })()
  return cacheDirPromise
}

export async function sha256OfFile(filePath: string): Promise<string> {
  const buf = await readFile(filePath)
  return createHash('sha256').update(buf).digest('hex')
}

interface CacheEntry {
  version: number
  kindHint: string
  createdAt: number
  attachment: IngestedAttachment
}

function entryPath(dir: string, sha: string, kindHint: string): string {
  // kindHint keeps hits specific to the detected parse path; e.g. same bytes
  // parsed under different kind (rare but possible) shouldn't collide.
  return path.join(dir, `${sha}-${kindHint}.json`)
}

/** Lookup by sha256 + parse kind. Returns null on miss/stale/corrupt. */
export async function cacheGet(
  sha: string,
  kindHint: string,
): Promise<IngestedAttachment | null> {
  try {
    const dir = await getCacheDir()
    const p = entryPath(dir, sha, kindHint)
    const raw = await readFile(p, 'utf8')
    const entry = JSON.parse(raw) as CacheEntry
    if (!entry || entry.version !== PARSER_VERSION) return null
    // Refresh atime/mtime so LRU eviction sees it as recently used.
    const now = new Date()
    try { await utimes(p, now, now) } catch { /* noop */ }
    return entry.attachment
  } catch {
    return null
  }
}

/** Persist result. Best-effort; failures are swallowed (cache is optional). */
export async function cachePut(
  sha: string,
  kindHint: string,
  attachment: IngestedAttachment,
): Promise<void> {
  try {
    const dir = await getCacheDir()
    const entry: CacheEntry = {
      version: PARSER_VERSION,
      kindHint,
      createdAt: Date.now(),
      attachment,
    }
    const p = entryPath(dir, sha, kindHint)
    await writeFile(p, JSON.stringify(entry), 'utf8')
    // Evict opportunistically (~1 in 20 writes) to avoid doing it on every save.
    if (Math.random() < 0.05) {
      await evictIfOverBudget(dir).catch(() => { /* noop */ })
    }
  } catch {
    // Cache writes are advisory — never block the user turn on a failed cache save.
  }
}

async function evictIfOverBudget(dir: string): Promise<void> {
  const names = await readdir(dir)
  const entries: Array<{ p: string; size: number; mtime: number }> = []
  let total = 0
  for (const n of names) {
    const p = path.join(dir, n)
    try {
      const s = await stat(p)
      if (!s.isFile()) continue
      entries.push({ p, size: s.size, mtime: s.mtimeMs })
      total += s.size
    } catch { /* skip */ }
  }
  if (total <= MAX_CACHE_BYTES) return
  // LRU: oldest mtime first.
  entries.sort((a, b) => a.mtime - b.mtime)
  let running = total
  for (const e of entries) {
    if (running <= MAX_CACHE_BYTES * 0.8) break
    try {
      await unlink(e.p)
      running -= e.size
    } catch { /* skip */ }
  }
}
