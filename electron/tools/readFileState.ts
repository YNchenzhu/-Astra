/**
 * Tracks successful reads for read-before-write (upstream FileWrite/FileEdit invariant).
 * Scoped by agent + conversation so sub-agents do not share parent read receipts.
 */

import fs from 'node:fs'
import crypto from 'node:crypto'
import type { AgentId } from '../tools/ids'
import { getAgentContext } from '../agents/agentContext'
import {
  EDIT_READ_MARGIN_LINES,
  getEditAffectedLineBounds1Based,
} from '../ai/fileEditSemantics'
import {
  editOldStringLocatable,
  normalizeOneFileEdit,
} from '../ai/fileEditSemantics'
import { stripUtf8Bom } from '../utils/lineEndings'

/**
 * Line count under which read_file auto-widens an `offset/limit` window to a full-file read.
 * Rationale: for small files the token cost of reading the whole file is trivial compared to
 * the cost of an edit_file rejection + retry, and returning the full body gives the AI enough
 * context to compute a correct `old_string` on the first attempt.
 */
export const SMALL_FILE_FULL_READ_LINE_THRESHOLD = 2000

/**
 * Hash the on-disk file body (BOM-stripped, UTF-8). Anchors `edit_file` to the exact bytes
 * the agent saw at read time — stronger than mtime-only comparison (mtime has OS-dependent
 * precision and can collide on fast successive writes).
 */
export function hashFileContent(body: string): string {
  const { body: stripped } = stripUtf8Bom(body)
  return `sha256:${crypto.createHash('sha256').update(stripped, 'utf8').digest('hex')}`
}

export type ReadFileRecord = {
  mtimeMs: number
  readAt: number
  /** True if read_file used offset/limit and did not return the full file */
  isPartialView: boolean
  /** Snapshot of what the agent actually saw (full body for full reads; window body for partial). Bounded. */
  contentSnapshot?: string
  /** True when contentSnapshot contains only the leading MAX_SNAPSHOT_CHARS characters. */
  contentSnapshotTruncated?: boolean
  /** sha256 of the complete on-disk file body at read time (BOM-stripped). */
  contentHash?: string
  /** Stable per-read identifier; agents echo this back as `baseReadId` on edit_file. */
  readId?: string
  /** Where this receipt came from — a real read_file call or a self-mutation (Write/Edit). */
  source: 'read' | 'self_mutation'
  /** Last successful read_file offset (0-based line) for dedup */
  readOffset?: number
  /** Last limit (max lines returned) */
  readLimit?: number
  /**
   * The ORIGINAL OS-cased resolved absolute path as passed to
   * {@link recordSuccessfulRead}. The Map keys this record by a
   * lowercased + forward-slash-normalised variant for cross-platform
   * lookup, but a few downstream consumers — notably the
   * `edit_file` / `multi_edit_file` "missing filePath but baseReadId
   * provided" fallback — need to feed a real on-disk path back into
   * `resolvePathForTool()`. On case-sensitive filesystems (Linux) the
   * lowercased key won't resolve; this field preserves the agent-
   * supplied form so the round-trip works.
   */
  absPath?: string
}

/**
 * Returned when a read_file request is fully covered by a previous successful
 * read in the same agent scope. The message MUST:
 *  1. Start with an unambiguous success signal so the AI does not mistake it for an error.
 *  2. Include the previous readId so the AI can use it as baseReadId on edits.
 *  3. Include a content preview so the AI can verify it has the right data.
 *  4. Never use parentheses or error-like phrasing — those trigger retry loops.
 */
export function buildFileUnchangedStub(prevReadId?: string, contentPreview?: string): string {
  const readIdLine = prevReadId
    ? `\nPrevious readId: ${prevReadId} (use this as baseReadId for any edits on this file)`
    : ''
  const preview = contentPreview
    ? `\nContent preview (first 500 chars of previous read):\n\`\`\`\n${contentPreview.slice(0, 500)}\n\`\`\``
    : ''
  return `File unchanged since your last read — the content is still valid and available from your earlier read_file result in this conversation. No need to re-read.${readIdLine}${preview}`
}

/** Legacy constant — kept for tests that assert exact string match; prefer buildFileUnchangedStub(). */
export const FILE_UNCHANGED_STUB =
  '(file unchanged since last read in this session; the requested window is already within the previously returned range and mtime is unchanged — skip re-fetching to save tokens)'

const MAX_SNAPSHOT_CHARS = 512 * 1024

function scopeKey(): string {
  const ctx = getAgentContext()
  const conv = ctx?.streamConversationId?.trim() || 'default'
  const agent = ctx?.agentId?.trim() || 'main'
  return `${conv}::${agent}`
}

const byScope = new Map<string, Map<string, ReadFileRecord>>()

/**
 * Secondary index: readId → { scope, pathKey }. Lets `edit_file` resolve `baseReadId` in O(1)
 * across sub-agent scopes without scanning every receipt.
 */
const byReadId = new Map<string, { scopeKey: string; pathKey: string }>()

// ── Memory bounds (2026-06 leak fix) ──
//
// The receipt store was previously unbounded along TWO axes:
//   1. inner: a single long-lived scope (e.g. the main chat) accumulated one
//      receipt per UNIQUE path read, each holding a snapshot up to
//      MAX_SNAPSHOT_CHARS (512 KB) — thousands of unique reads → GB-scale heap.
//   2. outer: every sub-agent gets its own scope bucket that is deliberately
//      kept after the agent ends (sibling reuse), so a long conversation that
//      spawns many sub-agents grew `byScope` without limit.
//
// Both are now bounded with simple insertion-order LRU eviction. Eviction is
// fail-safe: a dropped receipt just forces a fresh read_file before the next
// edit (the read-before-write gate re-reads), never silent corruption.
// Tunable via env for research / large-context hosts.
function parseBoundEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}
const MAX_READ_RECEIPTS_PER_SCOPE = parseBoundEnv('POLE_MAX_READ_RECEIPTS_PER_SCOPE', 2048)
const MAX_READ_RECEIPT_SCOPES = parseBoundEnv('POLE_MAX_READ_RECEIPT_SCOPES', 256)

/** Drop every dedup-strike counter whose key belongs to `scopeStr` (key = `${scope}::${path}`). */
function clearDedupStrikesForScope(scopeStr: string): void {
  const prefix = `${scopeStr}::`
  for (const k of Array.from(dedupStrikeCount.keys())) {
    if (k.startsWith(prefix)) dedupStrikeCount.delete(k)
  }
}

/** Evict an entire scope bucket: unregister its readIds + drop its dedup strikes. */
function evictEntireScope(scopeStr: string): void {
  const m = byScope.get(scopeStr)
  if (m) {
    for (const rec of m.values()) unregisterReadIdForReceipt(rec)
  }
  byScope.delete(scopeStr)
  clearDedupStrikesForScope(scopeStr)
}

/** Bound the number of live scope buckets (outer axis). Evicts oldest-inserted, never `protectKey`. */
function enforceScopeCountCap(protectKey: string): void {
  while (byScope.size > MAX_READ_RECEIPT_SCOPES) {
    const oldest = byScope.keys().next().value
    if (oldest === undefined || oldest === protectKey) break
    evictEntireScope(oldest)
  }
}

/** Bound receipts within a single scope (inner axis). The just-recorded key sits at the tail. */
function enforceReceiptCapForScope(scopeStr: string, scopedMap: Map<string, ReadFileRecord>): void {
  while (scopedMap.size > MAX_READ_RECEIPTS_PER_SCOPE) {
    const oldestKey = scopedMap.keys().next().value
    if (oldestKey === undefined) break
    unregisterReadIdForReceipt(scopedMap.get(oldestKey))
    scopedMap.delete(oldestKey)
    dedupStrikeCount.delete(`${scopeStr}::${oldestKey}`)
  }
}

function mapForScope(): Map<string, ReadFileRecord> {
  const k = scopeKey()
  let m = byScope.get(k)
  if (!m) {
    m = new Map()
    byScope.set(k, m)
    enforceScopeCountCap(k)
  }
  return m
}

function unregisterReadIdForReceipt(rec: ReadFileRecord | undefined): void {
  if (rec?.readId) byReadId.delete(rec.readId)
}

export function clearReadFileStateForCurrentScope(): void {
  const k = scopeKey()
  const m = byScope.get(k)
  if (m) {
    for (const rec of m.values()) unregisterReadIdForReceipt(rec)
  }
  byScope.delete(k)
  clearDedupStrikesForScope(k)
}

/**
 * Test/diagnostic seam — snapshot the internal store sizes so memory-bound
 * regression tests can assert the LRU caps actually fire. Not used in
 * production paths.
 */
export function __getReadFileStateInternalsForTests(): {
  scopeCount: number
  readIdCount: number
  dedupStrikeCount: number
  maxReceiptsPerScope: number
  maxScopes: number
} {
  return {
    scopeCount: byScope.size,
    readIdCount: byReadId.size,
    dedupStrikeCount: dedupStrikeCount.size,
    maxReceiptsPerScope: MAX_READ_RECEIPTS_PER_SCOPE,
    maxScopes: MAX_READ_RECEIPT_SCOPES,
  }
}

/** Clear all scopes (e.g. app teardown tests) */
export function clearAllReadFileState(): void {
  byScope.clear()
  byReadId.clear()
  // Was previously leaked by every "clear" path — a clear-all that didn't
  // clear the strike counters left orphan entries keyed by dead scopes.
  dedupStrikeCount.clear()
}

/**
 * Report §3.1 cleanup — drop read-before-write receipts for one sub-agent bucket
 * (`streamConversationId::agentId`, same as {@link scopeKey}).
 */
export function clearReadFileStateForSubAgent(
  agentId: AgentId,
  streamConversationId?: string | null,
): void {
  const conv =
    typeof streamConversationId === 'string' && streamConversationId.trim()
      ? streamConversationId.trim()
      : 'default'
  const agent = typeof agentId === 'string' && agentId.trim() ? agentId.trim() : 'main'
  const key = `${conv}::${agent}`
  const m = byScope.get(key)
  if (m) {
    for (const rec of m.values()) unregisterReadIdForReceipt(rec)
  }
  byScope.delete(key)
  clearDedupStrikesForScope(key)
}

/**
 * Record a successful read_file. Call only after a successful read.
 *
 * @param resolvedPath absolute normalized path
 * @param options.fullFileContent complete file body (BOM-stripped ok). Required to anchor
 *   subsequent edits via content-hash. When omitted (rare: image/PDF reads that never call
 *   edit_file), the receipt falls back to mtime-only validation.
 * @param options.viewedContent what the agent actually saw as text (may equal fullFileContent
 *   for full reads, or the sliced window for partial reads). Bounded to {@link MAX_SNAPSHOT_CHARS}.
 * @returns the generated (or reused) readId and the contentHash, so callers can surface them
 *   to the agent in the tool result.
 */
export function recordSuccessfulRead(
  resolvedPath: string,
  options: {
    mtimeMs: number
    isPartialView: boolean
    fullFileContent?: string
    viewedContent?: string
    readOffset?: number
    readLimit?: number
    source?: 'read' | 'self_mutation'
  },
): { readId: string; contentHash?: string } {
  const key = resolvedPath.replace(/\\/g, '/').toLowerCase()
  const scope = scopeKey()
  const scopedMap = mapForScope()

  // Reset dedup strike counter — a real read just happened, so any prior
  // consecutive dedup streak is no longer relevant.
  resetDedupStrike(resolvedPath)

  // Drop any previous receipt's readId registration for this path to avoid leaks.
  unregisterReadIdForReceipt(scopedMap.get(key))
  // Delete-before-set so a re-recorded path moves to the Map's tail — keeps
  // insertion order aligned with recency for the LRU eviction below.
  scopedMap.delete(key)

  const readId = `read-${crypto.randomBytes(8).toString('hex')}`
  const rec: ReadFileRecord = {
    mtimeMs: options.mtimeMs,
    readAt: Date.now(),
    isPartialView: options.isPartialView,
    readOffset: options.readOffset,
    readLimit: options.readLimit,
    readId,
    source: options.source ?? 'read',
    // Preserve the OS-cased resolved path so the
    // `edit_file` / `multi_edit_file` baseReadId-only fallback can feed
    // it back into `resolvePathForTool()` on case-sensitive filesystems.
    absPath: resolvedPath,
  }
  if (options.fullFileContent !== undefined) {
    rec.contentHash = hashFileContent(options.fullFileContent)
  }
  // Snapshot what the agent actually saw (bounded). For full reads we prefer fullFileContent;
  // for partial reads we prefer the window body — that is the tightest "did the agent see it?" set.
  const snapshotSource = options.viewedContent ?? options.fullFileContent
  if (snapshotSource !== undefined) {
    rec.contentSnapshot =
      snapshotSource.length <= MAX_SNAPSHOT_CHARS
        ? snapshotSource
        : snapshotSource.slice(0, MAX_SNAPSHOT_CHARS)
    rec.contentSnapshotTruncated = snapshotSource.length > MAX_SNAPSHOT_CHARS
  }
  scopedMap.set(key, rec)
  byReadId.set(readId, { scopeKey: scope, pathKey: key })
  enforceReceiptCapForScope(scope, scopedMap)
  return { readId, contentHash: rec.contentHash }
}

// ── Dedup strike counter: prevents infinite retry loops + re-read cycles ──
// Dedup hits now return cached content immediately (when a snapshot exists).
// The strike counter remains as a hard safety cap for a truly stuck model.
const MAX_TOTAL_DEDUP_STRIKES = 12
const dedupStrikeCount = new Map<string, number>()

function dedupStrikeKey(resolvedPath: string): string {
  return `${scopeKey()}::${resolvedPath.replace(/\\/g, '/').toLowerCase()}`
}

function bumpDedupStrike(resolvedPath: string): number {
  const k = dedupStrikeKey(resolvedPath)
  const n = (dedupStrikeCount.get(k) ?? 0) + 1
  dedupStrikeCount.set(k, n)
  return n
}

function resetDedupStrike(resolvedPath: string): void {
  dedupStrikeCount.delete(dedupStrikeKey(resolvedPath))
}

export type ReadDedupResult =
  | { dedup: false }
  | {
      dedup: true
      readId?: string
      contentPreview?: string
      strikeCount: number
      cachedContent?: string
      /** True when the receipt came from a sibling sub-agent in the same conversation, not the current scope. */
      crossAgent?: boolean
      /** The agentId portion of the source scope (best-effort). */
      sourceAgentId?: string
      /** Whether the source receipt was for a partial-view read (so callers can record a faithful adoption receipt). */
      sourceIsPartial?: boolean
      /** Original read offset for cachedContent; callers need this to slice requested windows correctly. */
      sourceReadOffset?: number
      /** True when this exact cached window has been requested too many times in the same scope. */
      repeatStop?: boolean
    }

/**
 * upstream-style read dedup: requested window is fully covered by the last
 * successful read + unchanged mtime → skip re-read.
 *
 * Returns the previous read's info (readId, contentPreview) so the AI can
 * verify it already has the data and use the readId for edits.
 *
 * After MAX_DEDUP_STRIKES consecutive dedup hits on the same file, forces a
 * real read to break potential retry loops (AI misinterpreting the stub as
 * an error and retrying with different parameters).
 *
 * Cross-agent fallback (P0-1): when the current sub-agent has no receipt for
 * this file but a sibling sub-agent in the **same conversation** does, deliver
 * the cached content immediately (no stub-cycle). This eliminates the duplicate
 * disk + token cost when the parent dispatches multiple Explore agents that
 * each independently re-read the same files.
 */
export function tryConsumeReadDedup(
  resolvedPath: string,
  mtimeMs: number,
  offset: number,
  limit: number,
): ReadDedupResult {
  if (process.env.DISABLE_READ_DEDUP === '1') return { dedup: false }
  const key = resolvedPath.replace(/\\/g, '/').toLowerCase()
  const currentScope = scopeKey()
  const rec = mapForScope().get(key)
  if (rec) {
    const result = tryConsumeReadDedupFromRecord(resolvedPath, mtimeMs, offset, limit, rec, {
      crossAgent: false,
    })
    return result
  }

  // Cross-agent fallback: same-conversation sibling receipt.
  const sibling = findReadReceiptInSameConversationWithScope(key)
  if (!sibling) {
    void currentScope
    return { dedup: false }
  }
  const agentId = scopeKeyToAgentId(sibling.scopeKey)
  const result = tryConsumeReadDedupFromRecord(resolvedPath, mtimeMs, offset, limit, sibling.record, {
    crossAgent: true,
    sourceAgentId: agentId,
  })
  void currentScope
  return result
}

function tryConsumeReadDedupFromRecord(
  resolvedPath: string,
  mtimeMs: number,
  offset: number,
  limit: number,
  rec: ReadFileRecord,
  opts: { crossAgent: boolean; sourceAgentId?: string },
): ReadDedupResult {
  if (rec.mtimeMs !== mtimeMs) return { dedup: false }

  let isDedup = false
  if (!rec.isPartialView) {
    // A full-file receipt covers every meaningful future window on the same
    // unchanged file. Clamp EOF-overrun requests too (e.g. offset=700, limit=500
    // against a 1163-line file) instead of forcing a pointless disk re-read.
    isDedup = true
  } else if (rec.readOffset === offset && rec.readLimit === limit) {
    isDedup = true
  } else if (rec.readOffset !== undefined && rec.readLimit !== undefined) {
    const prevStart = rec.readOffset
    const prevEnd = rec.readOffset + rec.readLimit
    const reqStart = offset
    const reqEnd = offset + limit
    isDedup = prevStart <= reqStart && prevEnd >= reqEnd
  }

  if (!isDedup) {
    resetDedupStrike(resolvedPath)
    return { dedup: false }
  }

  if (rec.contentSnapshotTruncated) {
    // Never present a 512 KB prefix as though it were the complete cached
    // read. Force toolReadFile to fetch and render the real requested window.
    resetDedupStrike(resolvedPath)
    return { dedup: false }
  }

  const strike = bumpDedupStrike(resolvedPath)

  // Cross-agent path: deliver cached content on FIRST hit (no stub-cycle).
  // The current scope has never seen this file in its message history, so
  // returning a "file unchanged" stub would be confusing and trigger retries.
  if (opts.crossAgent) {
    if (strike > MAX_TOTAL_DEDUP_STRIKES) {
      // Hard cap protects against a runaway loop where the model rejects the
      // delivered content repeatedly. Force a real disk read as last resort.
      resetDedupStrike(resolvedPath)
      return { dedup: false }
    }
    const cachedContent = rec.contentSnapshot
    const adopted = adoptReadReceiptForCurrentScope(rec, resolvedPath)
    return {
      dedup: true,
      readId: adopted.readId ?? rec.readId,
      contentPreview: cachedContent,
      strikeCount: strike,
      cachedContent,
      crossAgent: true,
      sourceAgentId: opts.sourceAgentId,
      sourceIsPartial: rec.isPartialView,
      sourceReadOffset: rec.readOffset,
    }
  }

  const cachedContent = rec.contentSnapshot
  if (cachedContent !== undefined) {
    if (strike > MAX_TOTAL_DEDUP_STRIKES) {
      resetDedupStrike(resolvedPath)
      return { dedup: false }
    }
    if (strike > 3) {
      return {
        dedup: true,
        readId: rec.readId,
        contentPreview: rec.contentSnapshot,
        strikeCount: strike,
        repeatStop: true,
        sourceReadOffset: rec.readOffset,
      }
    }
    return {
      dedup: true,
      readId: rec.readId,
      contentPreview: cachedContent,
      strikeCount: strike,
      cachedContent,
      sourceReadOffset: rec.readOffset,
    }
  }

  return {
    dedup: true,
    readId: rec.readId,
    contentPreview: rec.contentSnapshot,
    strikeCount: strike,
  }
}

function adoptReadReceiptForCurrentScope(
  rec: ReadFileRecord,
  resolvedPath: string,
): { readId?: string } {
  const key = resolvedPath.replace(/\\/g, '/').toLowerCase()
  const scopedMap = mapForScope()
  const existing = scopedMap.get(key)
  if (existing?.mtimeMs === rec.mtimeMs && existing.contentSnapshot === rec.contentSnapshot) {
    return { readId: existing.readId }
  }
  unregisterReadIdForReceipt(existing)
  const readId = `read-${crypto.randomBytes(8).toString('hex')}`
  const adopted: ReadFileRecord = {
    ...rec,
    readAt: Date.now(),
    readId,
    source: 'read',
  }
  scopedMap.set(key, adopted)
  byReadId.set(readId, { scopeKey: scopeKey(), pathKey: key })
  return { readId }
}

function scopeKeyToAgentId(key: string): string | undefined {
  const sep = key.indexOf('::')
  if (sep < 0) return undefined
  const agent = key.slice(sep + 2).trim()
  return agent && agent !== 'main' ? agent : undefined
}

/**
 * Variant of {@link findReadReceiptAcrossScopes} restricted to the **same conversation**
 * (cross-conversation receipts are deliberately ignored — those belong to unrelated chats).
 * Skips the current scope (callers check that first). Returns the most recent match by `readAt`.
 */
function findReadReceiptInSameConversationWithScope(
  key: string,
): { record: ReadFileRecord; scopeKey: string } | undefined {
  const currentScope = scopeKey()
  const currentConv = currentScope.split('::')[0]
  let best: { record: ReadFileRecord; scopeKey: string } | undefined
  for (const [scope, scopeMap] of byScope.entries()) {
    if (scope === currentScope) continue
    const conv = scope.split('::')[0]
    if (conv !== currentConv) continue
    const rec = scopeMap.get(key)
    if (!rec) continue
    if (!best || (rec.readAt ?? 0) > (best.record.readAt ?? 0)) {
      best = { record: rec, scopeKey: scope }
    }
  }
  return best
}

/** After successful write/edit/notebook: require a fresh read_file before the next mutate */
export function invalidateReadAfterMutation(resolvedPath: string): void {
  const key = resolvedPath.replace(/\\/g, '/').toLowerCase()
  const m = mapForScope()
  unregisterReadIdForReceipt(m.get(key))
  m.delete(key)
}

/**
 * After a tool in THIS agent scope has written the file, the agent already has
 * ground-truth knowledge of the resulting disk content (it just authored it).
 * Record a fresh full-read receipt for the post-write state so the same agent
 * can immediately follow up with another Write / Edit without being blocked
 * by a spurious "file has not been read" rejection.
 *
 * External concurrent modifications are still caught by {@link validateReadReceipt}
 * — if another process touches the file after this call, the on-disk mtime will
 * no longer match the recorded mtime and the next mutate attempt will fail
 * closed with the standard "mtime changed" error.
 */
export function recordSelfMutationReadReceipt(
  resolvedPath: string,
  newContent: string,
): { readId: string; contentHash?: string } | null {
  let mtimeMs: number
  try {
    mtimeMs = fs.statSync(resolvedPath).mtimeMs
  } catch {
    // File may have been deleted by another process; drop any stale receipt
    // so the next write does a fresh read-before-write check.
    invalidateReadAfterMutation(resolvedPath)
    return null
  }
  return recordSuccessfulRead(resolvedPath, {
    mtimeMs,
    isPartialView: false,
    fullFileContent: newContent,
    viewedContent: newContent,
    source: 'self_mutation',
  })
}

/**
 * True when the CURRENT agent scope already holds a receipt for `resolvedPath`
 * that exactly matches the given on-disk state (same mtime AND same
 * full-content hash).
 *
 * Double-rotation fix (2026-07): a successful edit_file/write_file already
 * rotates the readId via {@link recordSelfMutationReadReceipt} and PROMISES
 * that id to the model in the "readId for next edit:" trailer. The agentic
 * loop's post-hook re-stamp then used to call {@link recordSuccessfulRead}
 * unconditionally, which rotated the readId a SECOND time and unregistered
 * the promised id — so every chained edit that faithfully echoed the trailer
 * id failed once with READ_ID_NOT_FOUND. The loop now calls this predicate
 * first and skips the re-stamp when no PostToolUse hook actually touched the
 * file (receipt still matches disk), keeping the promised readId valid.
 */
export function hasCurrentScopeReceiptMatchingDisk(
  resolvedPath: string,
  mtimeMs: number,
  diskContent: string,
): boolean {
  const key = resolvedPath.replace(/\\/g, '/').toLowerCase()
  const rec = byScope.get(scopeKey())?.get(key)
  if (!rec) return false
  if (rec.mtimeMs !== mtimeMs) return false
  if (rec.contentHash === undefined) return false
  return rec.contentHash === hashFileContent(diskContent)
}

/**
 * Build the "what to do on the next edit of this file" trailer for a SUCCESSFUL
 * edit_file / multi_edit_file response. Centralised so the create / edit-in-place
 * / multi-edit success paths phrase the next-step guidance identically.
 *
 * Two cases the model MUST distinguish:
 *   - The self-mutation read receipt was refreshed ({@link recordSelfMutationReadReceipt}
 *     returned a readId) → the next edit needs NO re-read; just echo the new readId
 *     as `baseReadId`. The previous readId is now invalid.
 *   - The receipt could NOT be refreshed (the file vanished / stat failed right
 *     after the write, so {@link invalidateReadAfterMutation} dropped it) → the
 *     next edit on this path REQUIRES a fresh `read_file` first, or it will be
 *     rejected by the read-before-edit gate.
 *
 * @param refreshed     Return value of {@link recordSelfMutationReadReceipt}.
 * @param nextToolLabel Tool(s) the next edit could use, e.g. `'edit_file'` or
 *                      `'edit_file / multi_edit_file'`. Drives only the wording.
 */
export function buildNextEditTrailer(
  refreshed: { readId: string } | null | undefined,
  nextToolLabel: string,
): string {
  if (refreshed?.readId) {
    return (
      `\nreadId for next edit: ${refreshed.readId} — REQUIRED: pass this as baseReadId on the next ` +
      `${nextToolLabel} for this path; the previous readId is now invalid. No re-read needed before the next edit.`
    )
  }
  return (
    `\nNEXT EDIT REQUIRES A FRESH read_file: the read receipt for this path could not be refreshed ` +
    `after this write (the file may have been moved or changed on disk), so the read-before-edit gate ` +
    `will reject the next edit until you call read_file on it again and pass the new readId as baseReadId.`
  )
}

export type ReadBeforeWriteGate =
  | { ok: true }
  | { ok: false; error: string }

/**
 * Content-identity fallback for the mtime-drift gate.
 *
 * When the on-disk mtime no longer matches the receipt's recorded mtime, the
 * file may STILL be byte-identical to what the agent last saw. The benign
 * causes we must not punish:
 *   - OS-dependent mtime precision drift on fast successive writes
 *     (NTFS 100-ns ↔ JS double-ms is lossy across consecutive stat calls);
 *   - an external writer (editor autosave / formatter / our own
 *     `recordSelfMutationReadReceipt` racing a renderer reload) re-saving the
 *     SAME bytes, which bumps mtime without changing content.
 *
 * The content is treated as unchanged when EITHER:
 *   1. the verbatim `contentSnapshot` matches — exact, but only stored up to
 *      {@link MAX_SNAPSHOT_CHARS}; OR
 *   2. the full-content `contentHash` matches `hashFileContent(current)`.
 *
 * Branch (2) is the authoritative one and the reason this helper exists: the
 * snapshot is truncated to 512 KB for heap safety, so for any larger file the
 * verbatim comparison can NEVER succeed and a purely benign mtime drift would
 * otherwise surface the spurious "File has been modified on disk" error on
 * every edit. `contentHash` is computed over the COMPLETE (BOM-stripped) body
 * at record time, so it is both size-independent and BOM-insensitive.
 *
 * The hash branch is intentionally gated on `!isPartialView`: a partial-view
 * receipt's edit path runs its own window-coverage checks and must not be
 * short-circuited here. A genuine content change still fails both branches
 * (different bytes ⇒ different snapshot AND different hash), so the gate keeps
 * rejecting edits built on stale knowledge.
 */
/**
 * Shared clarification appended to every stale-receipt rejection. Real-world
 * confusion this addresses (2026-07 trace): the agent ran a Python/shell
 * script that rewrote the file, then tried edit_file and read the resulting
 * "modified on disk" error as evidence of EXTERNAL interference ("no other
 * process touched this file!"). The gate tracks what YOU read via read_file;
 * a mutation performed through bash/PowerShell/python is invisible to it and
 * counts as an on-disk change like any other. Saying so explicitly turns a
 * confusing rejection into a one-turn recovery — and stops the model from
 * re-running the script "because the edit didn't stick".
 */
const SELF_SCRIPT_MUTATION_NOTE =
  'NOTE: this includes changes made by YOUR OWN shell/python commands — if you just ran a ' +
  'script that rewrote this file, that script is the "modification" (only read_file / ' +
  'edit_file / write_file refresh the read receipt; scripts do not). The file is fine; ' +
  'your snapshot of it is stale. Re-read to see the script\'s actual output — and check ' +
  'whether the change you are about to edit in was ALREADY applied by the script.'

function receiptContentUnchanged(
  rec: ReadFileRecord,
  current: string | undefined,
): boolean {
  if (current === undefined) return false
  if (rec.contentSnapshot !== undefined && rec.contentSnapshot === current) {
    return true
  }
  if (
    !rec.isPartialView &&
    rec.contentHash !== undefined &&
    rec.contentHash === hashFileContent(current)
  ) {
    return true
  }
  return false
}

/**
 * Validate that a mutating tool may touch the file (read-before-write + staleness).
 *
 * Cross-scope fallback: if the current agent scope has no read receipt, check all
 * other scopes for a matching file with a valid read record. This handles the case
 * where the user navigates to a different file (changing the agent context) between
 * reading and editing — a common workflow that previously caused false "file not read"
 * rejections and content corruption.
 */
export function assertReadBeforeWrite(
  resolvedPath: string,
  currentContentForCompare?: string,
): ReadBeforeWriteGate {
  const key = resolvedPath.replace(/\\/g, '/').toLowerCase()
  // upstream-style: new paths cannot be read first; allow create / edit with empty old_string without a receipt.
  if (!fs.existsSync(resolvedPath)) {
    return { ok: true }
  }
  const rec = mapForScope().get(key)
  if (!rec) {
    // Cross-scope fallback: check all scopes for a valid read receipt
    const crossScopeRec = findReadReceiptAcrossScopes(key)
    if (!crossScopeRec) {
      return {
        ok: false,
        error:
          'File has not been read in this session (read_before_write). Call read_file on this path first with sufficient range to cover the full file.',
      }
    }
    // Reject cross-scope receipts that came from a self-mutation (Write/Edit) —
    // the agent cannot rely on "I just wrote this" across scopes.
    if (crossScopeRec.source === 'self_mutation') {
      return {
        ok: false,
        error:
          'Last receipt for this file came from a Write/Edit, not a read_file. Call read_file on this path to obtain a fresh read receipt before editing.',
      }
    }
    return validateReadReceipt(crossScopeRec, resolvedPath, currentContentForCompare)
  }
  // Same-scope self-mutation receipts are allowed: the agent literally just
  // authored these bytes (we re-stamped the snapshot to match disk after
  // post-tool-use hooks ran), so chained Write/Edit on the same path is
  // safe as long as the integrity checks below still pass — mtime / snapshot
  // equality catches any external mutation between the self-mutation stamp
  // and now. Cross-scope self-mutation is still rejected above because
  // another agent's "I just wrote this" cannot be trusted by us.
  return validateReadReceipt(rec, resolvedPath, currentContentForCompare)
}

/**
 * Read-before-edit: allows partial read_file when the last read window covers the edited lines
 * plus {@link EDIT_READ_MARGIN_LINES} lines before and after (see getEditAffectedLineBounds1Based).
 * Full-file reads still work as before.
 */
/**
 * For structured mutators (e.g. {@link NotebookEditTool}) where edits are not expressed as
 * `old_string`/`new_string` line spans: require a read receipt and fresh mtime, but **allow**
 * partial `read_file` windows — same safety as “agent saw some of the file before mutate”
 * without forcing a full-file read (ipynb is often large; JSON integrity is enforced by the tool).
 */
export function assertReadBeforeStructuredEdit(
  resolvedPath: string,
  currentContentForCompare?: string,
): ReadBeforeWriteGate {
  const key = resolvedPath.replace(/\\/g, '/').toLowerCase()
  if (!fs.existsSync(resolvedPath)) {
    return { ok: true }
  }
  const rec = mapForScope().get(key) ?? findReadReceiptAcrossScopes(key)
  if (!rec) {
    return {
      ok: false,
      error:
        'File has not been read in this session (read_before_write). Call read_file on this path first.',
    }
  }
  // Same-scope self-mutation receipts are allowed for structured edits too:
  // the snapshot is re-stamped to disk after every successful Write/Edit
  // (including post-tool-use hook side-effects), so chained NotebookEdit
  // operations on the freshly-authored file no longer trip a spurious
  // "you just modified this" rejection. External tampering is still caught
  // by the mtime/snapshot check below.
  let stat: fs.Stats
  try {
    stat = fs.statSync(resolvedPath)
  } catch {
    return { ok: true }
  }
  if (stat.mtimeMs !== rec.mtimeMs) {
    if (receiptContentUnchanged(rec, currentContentForCompare)) {
      return { ok: true }
    }
    return {
      ok: false,
      error:
        'File has been modified on disk since it was read (mtime changed). ' +
        SELF_SCRIPT_MUTATION_NOTE +
        ' Call read_file again before editing.',
    }
  }
  return { ok: true }
}

/**
 * Resolve a receipt by its readId without scanning every scope/receipt.
 * Returns the record together with the path the agent originally read.
 */
export function findReadReceiptByReadId(
  readId: string,
): { record: ReadFileRecord; resolvedPathKey: string; scopeKey: string } | undefined {
  const hit = byReadId.get(readId)
  if (!hit) return undefined
  const scoped = byScope.get(hit.scopeKey)
  if (!scoped) return undefined
  const rec = scoped.get(hit.pathKey)
  if (!rec || rec.readId !== readId) return undefined
  return { record: rec, resolvedPathKey: hit.pathKey, scopeKey: hit.scopeKey }
}

/**
 * Look up the most recent VALID readId still registered for `resolvedPath`,
 * across every scope. Used by error-message construction in the
 * read-before-edit gate so a stale-readId rejection can surface the readId
 * the agent should have used instead — turning a confusing "unknown or
 * expired" error into actionable guidance ("use read-YYY for the next edit").
 *
 * Returns `undefined` when no live receipt exists for the path (the agent
 * never read it in this process, or every prior receipt was unregistered).
 */
export function findCurrentReadIdForPath(
  resolvedPath: string,
): string | undefined {
  const wantKey = resolvedPath.replace(/\\/g, '/').toLowerCase()
  let best:
    | { readId: string; readAt: number }
    | undefined
  for (const scoped of byScope.values()) {
    const rec = scoped.get(wantKey)
    if (!rec?.readId) continue
    const readAt = rec.readAt ?? 0
    if (!best || readAt > best.readAt) {
      best = { readId: rec.readId, readAt }
    }
  }
  return best?.readId
}

function findCurrentReadIdForPathInCurrentScope(
  resolvedPath: string,
): string | undefined {
  const key = resolvedPath.replace(/\\/g, '/').toLowerCase()
  return mapForScope().get(key)?.readId
}

/**
 * Enumerate all read receipts in the **current agent scope**.
 *
 * Used by post-compact re-hydration to know which files the model saw
 * before compaction and hand back a verified list (path + hash + mtime)
 * so the model can skip `Read` if the content is unchanged. Returns
 * shallow copies so callers can't accidentally mutate the store.
 */
export function listReadReceiptsInCurrentScope(): Array<{
  resolvedPathKey: string
  record: ReadFileRecord
}> {
  const m = mapForScope()
  const out: Array<{ resolvedPathKey: string; record: ReadFileRecord }> = []
  for (const [pathKey, record] of m.entries()) {
    out.push({ resolvedPathKey: pathKey, record: { ...record } })
  }
  return out
}

export interface CurrentReadIdHint {
  filePath: string
  readId: string
  readAt: number
}

export function buildReadIdRebindNotice(
  reboundFromReadId: string | undefined,
  effectiveReadId: string | undefined,
  didWrite: boolean,
): string {
  if (!reboundFromReadId || !effectiveReadId) return ''
  return didWrite
    ? `\nNOTICE: supplied baseReadId "${reboundFromReadId}" was unknown or expired. The tool safely rebound it to this path's current read receipt "${effectiveReadId}" after re-validating the disk hash and old_string. Use the NEW readId below for the next edit on this path.`
    : `\nNOTICE: supplied baseReadId "${reboundFromReadId}" was unknown or expired. The tool safely rebound it to this path's current read receipt "${effectiveReadId}" after re-validating the disk hash and old_string. No write occurred, so "${effectiveReadId}" remains current for this path.`
}

/**
 * Return the most-recent path-bound readIds for the current agent scope.
 *
 * This is intentionally a compact model-facing hint, not a second safety
 * gate: edit_file still re-validates the selected receipt's path, disk hash,
 * and visible old_string immediately before the write. Keeping the mapping
 * explicit prevents models that read A + B together from treating the most
 * recently mentioned readId as a global credential and accidentally sending
 * A's id with an edit for B.
 */
export function listCurrentReadIdHintsInCurrentScope(
  limit = 6,
): CurrentReadIdHint[] {
  const boundedLimit = Math.max(0, Math.min(20, Math.trunc(limit)))
  if (boundedLimit === 0) return []

  return listReadReceiptsInCurrentScope()
    .filter(
      (entry): entry is { resolvedPathKey: string; record: ReadFileRecord & { readId: string } } =>
        typeof entry.record.readId === 'string' && entry.record.readId.length > 0,
    )
    .sort((left, right) => (right.record.readAt ?? 0) - (left.record.readAt ?? 0))
    .slice(0, boundedLimit)
    .map(({ resolvedPathKey, record }) => ({
      filePath: record.absPath ?? resolvedPathKey,
      readId: record.readId,
      readAt: record.readAt ?? 0,
    }))
}

export interface ConversationReadReceipt {
  resolvedPathKey: string
  /** Agent slot inside the scope key (`main` for the parent chat, sub-agent ids otherwise). */
  agentId: string
  record: ReadFileRecord
}

/**
 * Enumerate read receipts across **all agents in the same conversation** (parent + every
 * sibling sub-agent). Used by sub-agent spawn (P0-2) to inject a "files already read"
 * context block so a freshly-spawned Explore/Plan agent doesn't re-read files the parent
 * or a sibling Explore already opened.
 *
 * Sorted most-recent first by `readAt` (recency tiebreak when the same path was read
 * multiple times across siblings). Returns shallow copies — callers must not mutate.
 */
export function listReadReceiptsForConversation(
  conversationId: string | undefined,
  opts?: { excludeAgentId?: string },
): ConversationReadReceipt[] {
  const target = (conversationId ?? '').trim() || 'default'
  const exclude = opts?.excludeAgentId?.trim()
  // Dedup by path: when several agents read the same file, keep only the most recent receipt.
  const byPath = new Map<string, ConversationReadReceipt>()
  for (const [scope, scopeMap] of byScope.entries()) {
    const sep = scope.indexOf('::')
    if (sep < 0) continue
    const conv = scope.slice(0, sep)
    if (conv !== target) continue
    const agent = scope.slice(sep + 2)
    if (exclude && agent === exclude) continue
    for (const [pathKey, record] of scopeMap.entries()) {
      const prev = byPath.get(pathKey)
      if (!prev || (record.readAt ?? 0) > (prev.record.readAt ?? 0)) {
        byPath.set(pathKey, { resolvedPathKey: pathKey, agentId: agent, record: { ...record } })
      }
    }
  }
  const out = Array.from(byPath.values()).sort(
    (a, b) => (b.record.readAt ?? 0) - (a.record.readAt ?? 0),
  )
  return out
}

// ── SA-5: main ↔ tool-worker receipt forwarding ──
//
// The utilityProcess tool worker holds a FRESH copy of this module, so
// receipts recorded in main are invisible to the worker's gates. The
// host exports the relevant receipts per dispatch (read-only query) and
// the worker imports them (idempotent) before executing a mutation tool.

export interface ExportedReadReceipt {
  /** Lowercased forward-slash path key (same form the internal maps use). */
  pathKey: string
  /** Shallow copy — safe to structured-clone across the IPC boundary. */
  record: ReadFileRecord
}

/**
 * Read-only query: snapshot the receipts a mutation gate on `resolvedPath`
 * would consult, in the current agent scope. Mirrors the lookup order of
 * {@link assertReadBeforeWrite}:
 *   1. The current-scope receipt for the path (any source — same-scope
 *      self-mutation receipts are legal for the gates).
 *   2. Failing that, the cross-scope fallback receipt — but only when its
 *      source is `'read'`, because cross-scope self-mutation receipts are
 *      rejected by the gate and must not be laundered into the worker's
 *      current scope.
 *   3. Additionally, the receipt anchored by `opts.baseReadId` (the worker's
 *      `findReadReceiptByReadId` needs it; the hash gate re-validates there).
 *
 * Does not mutate any state.
 */
export function exportReceiptsForPath(
  resolvedPath: string,
  opts?: { baseReadId?: string },
): ExportedReadReceipt[] {
  const key = resolvedPath.replace(/\\/g, '/').toLowerCase()
  const out: ExportedReadReceipt[] = []
  const seen = new Set<string>()
  const push = (pathKey: string, rec: ReadFileRecord | undefined): void => {
    if (!rec) return
    const dedupKey = rec.readId ?? `${pathKey}::${rec.readAt}`
    if (seen.has(dedupKey)) return
    seen.add(dedupKey)
    out.push({ pathKey, record: { ...rec } })
  }
  if (key) {
    const sameScope = byScope.get(scopeKey())?.get(key)
    push(key, sameScope)
    if (!sameScope) {
      const cross = findReadReceiptAcrossScopes(key)
      if (cross && cross.source === 'read') push(key, cross)
    }
  }
  if (opts?.baseReadId) {
    const hit = findReadReceiptByReadId(opts.baseReadId)
    if (hit) push(hit.resolvedPathKey, hit.record)
  }
  return out
}

/**
 * Worker-side import of main-process receipts (counterpart of
 * {@link exportReceiptsForPath}). Receipts land in the CURRENT scope of the
 * importing process — in the tool worker that is `default::main`, which is
 * also the scope its executors read from, so forwarded receipts behave as
 * same-scope receipts there.
 *
 * Idempotency / safety rules:
 *   - Re-importing a receipt with the same `readId` is a no-op (no error,
 *     no duplicate accumulation — the per-path map holds one record).
 *   - A locally recorded receipt that is NEWER (`readAt`) than the imported
 *     one is never clobbered (e.g. the worker itself just read or rotated
 *     the receipt; main's forwarded snapshot may lag by one tool call).
 */
export function importReceipts(
  receipts: ReadonlyArray<{ pathKey: string; record: ReadFileRecord }>,
): void {
  if (!Array.isArray(receipts) || receipts.length === 0) return
  const scope = scopeKey()
  const m = mapForScope()
  for (const entry of receipts) {
    if (!entry || typeof entry.pathKey !== 'string' || !entry.record) continue
    const key = entry.pathKey.replace(/\\/g, '/').toLowerCase()
    if (!key) continue
    const rec = entry.record
    const existing = m.get(key)
    if (existing) {
      if (existing.readId && existing.readId === rec.readId) continue
      // Double-promise fix (2026-07, packaged/worker mode): after a worker-side
      // edit_file rotates the readId and PROMISES it to the model in the
      // "readId for next edit:" trailer, the MAIN process's post-hook re-stamp
      // records its own (newer) receipt for the same bytes and forwards it on
      // the next dispatch. Clobbering the local receipt here killed the
      // promised id — every chained edit then failed once with
      // READ_ID_NOT_FOUND. Identical full-file content hash means the local
      // receipt is just as valid as the incoming one, so keep it (and its
      // promised readId). A hook that actually changed the file produces a
      // different hash and still flows through the newer-wins path below.
      if (
        !existing.isPartialView &&
        existing.contentHash !== undefined &&
        existing.contentHash === rec.contentHash
      ) {
        continue
      }
      if ((existing.readAt ?? 0) >= (rec.readAt ?? 0)) continue
      unregisterReadIdForReceipt(existing)
    }
    const copy: ReadFileRecord = { ...rec }
    m.set(key, copy)
    if (copy.readId) {
      byReadId.set(copy.readId, { scopeKey: scope, pathKey: key })
    }
  }
}

export type ReadIdGateResult =
  | {
      ok: true
      matchedInSnapshot: boolean
      /** The path-bound receipt actually validated by the gate. */
      effectiveReadId: string
      /** Present only when a well-formed expired id was safely rebound. */
      reboundFromReadId?: string
    }
  | { ok: false; code: ReadIdGateErrorCode; error: string }

export type ReadIdGateErrorCode =
  | 'READ_ID_NOT_FOUND'
  | 'READ_ID_PATH_MISMATCH'
  | 'SELF_MUTATION_RECEIPT'
  | 'HASH_MISMATCH'
  | 'OLD_STRING_NOT_IN_READ'
  | 'REPLACE_ALL_NEEDS_FULL_READ'

const PRODUCTION_READ_ID_RE = /^read-[0-9a-f]{16}$/i

function visibleContentForReadIdGate(rec: ReadFileRecord, diskContent: string): string {
  if (!rec.isPartialView) {
    // The hash check proves diskContent is byte-identical to the full read.
    // Use it directly so the 512 KB cached-preview cap cannot create a false
    // OLD_STRING_NOT_IN_READ for targets near the end of a large file.
    return stripUtf8Bom(diskContent).body
  }

  if (!rec.contentSnapshotTruncated) return rec.contentSnapshot ?? ''
  if (rec.readOffset === undefined || rec.readLimit === undefined) {
    return rec.contentSnapshot ?? ''
  }

  // Reconstruct an oversized partial window from the still-current disk
  // bytes. This mirrors toolReadFile's line splitting exactly and avoids
  // retaining an unbounded per-receipt string in memory.
  return stripUtf8Bom(diskContent).body
    .split(/\r?\n/)
    .map((line) => line.replace(/\r$/, ''))
    .slice(rec.readOffset, rec.readOffset + rec.readLimit)
    .join('\n')
}

function oldStringShapeHint(visibleContent: string, oldString: string): string {
  const normalizedOld = oldString.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const withoutExtraBlankLines = normalizedOld.replace(/\n[ \t]*\n+/g, '\n')
  if (
    withoutExtraBlankLines !== normalizedOld &&
    editOldStringLocatable(visibleContent, withoutExtraBlankLines)
  ) {
    return ' Detected likely blank-line drift: old_string contains an extra blank line that is not present in the read content.'
  }
  return ''
}

/**
 * Hash-anchored read-before-edit gate.
 *
 * Validation order (all must pass):
 *   1. `baseReadId` resolves to a receipt in this process (cross-scope lookup).
 *   2. That receipt was for this same resolved path (prevents cross-file confusion).
 *   3. The on-disk content hash still matches the recorded hash
 *      (→ no external modification since the agent read it).
 *   4. The `old_string` appears in the bytes the agent actually saw
 *      (→ the agent did not fabricate an edit target from memory).
 *   5. `replace_all` requires the receipt to cover the whole file (partial views forbidden).
 *
 * A successful return is stronger than the legacy line-window gate: we prove the agent
 * saw the literal bytes being modified, not just "some window around the modified lines".
 */
export function assertReadBeforeEditByReadId(
  resolvedPath: string,
  baseReadId: string,
  diskContent: string,
  oldString: string,
  newString: string,
  replaceAll?: boolean,
  options?: { allowExpiredReadIdRebind?: boolean },
): ReadIdGateResult {
  const wantKey = resolvedPath.replace(/\\/g, '/').toLowerCase()
  let effectiveReadId = baseReadId
  let reboundFromReadId: string | undefined
  let hit = findReadReceiptByReadId(baseReadId)
  if (!hit) {
    // Common root cause: a successful edit_file just rotated the readId
    // and the agent is still echoing the original read_file's id. Surface
    // the path's current valid readId (if any) so the next call can self-
    // correct without a wasteful re-read.
    const currentValid = findCurrentReadIdForPath(resolvedPath)
    const currentScopeValid = findCurrentReadIdForPathInCurrentScope(resolvedPath)
    const mayRebind =
      options?.allowExpiredReadIdRebind !== false &&
      PRODUCTION_READ_ID_RE.test(baseReadId) &&
      currentScopeValid !== undefined
    if (mayRebind) {
      const currentHit = findReadReceiptByReadId(currentScopeValid)
      if (currentHit?.resolvedPathKey === wantKey) {
        // This does NOT fall back to the legacy mtime gate. The selected
        // target-path receipt continues through every hash/snapshot check
        // below, so the resulting proof is identical to the model having
        // supplied currentScopeValid itself. The rebind only removes a wasted
        // error/re-read turn when the model mixed up A and B's path-bound ids.
        hit = currentHit
        effectiveReadId = currentScopeValid
        reboundFromReadId = baseReadId
      }
    }
    // Audit fix A-3 (2026-05) — the previous fallback (`OMIT baseReadId
    // entirely`) actively taught the model to skip the hash-anchored
    // read-before-edit gate after a context compact. That defeats the
    // gate's purpose (catching edits driven by memory rather than
    // verified disk bytes) and re-opens `OLD_STRING_NOT_IN_READ` /
    // mid-air-collision failure modes. The new fallback unconditionally
    // requires a fresh read; the only allowed omit is when the post-
    // compact file-hints block explicitly listed the file as `unchanged`
    // and supplied a readId — at which point that readId should be
    // passed, not omitted.
    const recovery = currentValid
      ? `Use "${currentValid}" instead — that is the readId from the most recent read_file or edit_file response on this path. ` +
        `(Each successful edit_file rotates the readId; reusing the read_file id after an edit is the most common cause of this error.)`
      : `No live readId is registered for this path. Call read_file on it again and pass the returned readId back as baseReadId. ` +
        `If context was compacted between your read and this edit, re-call read_file rather than omitting baseReadId — the legacy mtime/window fallback was a wide-open path that let edits skip the read-before-edit hash anchor. ` +
        `The only safe omission is when the post-compact \`[Post-compact …]\` reminder explicitly listed this file as \`unchanged\` AND surfaced its readId; in that case pass that readId.`
    if (!hit) {
      return {
        ok: false,
        code: 'READ_ID_NOT_FOUND',
        error: `baseReadId "${baseReadId}" is unknown or expired. ${recovery}`,
      }
    }
  }
  if (hit.resolvedPathKey !== wantKey) {
    return {
      ok: false,
      code: 'READ_ID_PATH_MISMATCH',
      error:
        `baseReadId "${baseReadId}" was issued for a different file. ` +
        `Call read_file on "${resolvedPath}" to obtain a matching readId.`,
    }
  }
  const rec = hit.record

  // Self-mutation receipts (Write/Edit-issued readIds) ARE accepted here.
  // Rationale: the receipt's snapshot/hash were re-stamped to the actual
  // post-write disk bytes (including any post-tool-use hook side-effects)
  // before this gate runs, so the agent really does "know" what's on disk.
  // Safety still holds because:
  //   - The hash check below catches any external mutation since the
  //     self-mutation stamp.
  //   - The `old_string` snapshot containment check below ensures the
  //     agent's edit target actually exists in the bytes they authored.
  //   - Cross-scope self-mutation is still blocked in assertReadBeforeWrite
  //     (another agent's "I just wrote this" cannot be trusted by us).

  // External-modification check — contentHash is the authoritative signal here.
  if (rec.contentHash !== undefined) {
    const currentHash = hashFileContent(diskContent)
    if (currentHash !== rec.contentHash) {
      return {
        ok: false,
        code: 'HASH_MISMATCH',
        error:
          'File has changed on disk since it was read (content hash mismatch). ' +
          SELF_SCRIPT_MUTATION_NOTE +
          ' Call read_file again and pass the new readId as baseReadId.',
      }
    }
  } else {
    // Legacy receipt without hash (e.g. image/PDF reads) — fall back to mtime.
    let stat: fs.Stats | undefined
    try {
      stat = fs.statSync(resolvedPath)
    } catch {
      /* race: file gone — leave it to the tool to handle */
    }
    if (stat && stat.mtimeMs !== rec.mtimeMs) {
      return {
        ok: false,
        code: 'HASH_MISMATCH',
        error:
          'File has been modified on disk since it was read (mtime changed). ' +
          SELF_SCRIPT_MUTATION_NOTE +
          ' Call read_file again.',
      }
    }
  }

  // `old_string` must have been visible to the agent. Apply the same newline normalisation
  // the actual edit pipeline uses so we do not spuriously reject CRLF vs LF mismatches.
  // Also mirror the edit pipeline's literal-`\uXXXX` decode fallback
  // (computeFileEditResult's retry): a payload the edit WILL successfully
  // apply after auto-decode must not be rejected here first.
  //
  // 2026-07 drift-elimination: after the cheap fast-path checks, fall back
  // to `editOldStringLocatable` — the SAME multi-tier matcher the applier
  // uses (quote/fullwidth drift, read-output artifacts, whitespace-tolerant
  // line matching). Before this, the gate was STRICTER than the applier and
  // rejected payloads the edit would have applied fine (e.g. curly-quote
  // drift matched by resolveOldStringInFile but not by raw `includes`).
  const snapshot = visibleContentForReadIdGate(rec, diskContent)
  const normalizedSnap = snapshot.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const normalizedOld = oldString.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const snapshotContainsOld =
    snapshot.includes(oldString) ||
    normalizedSnap.includes(normalizedOld) ||
    editOldStringLocatable(snapshot, oldString)

  // Empty old_string is only legal on empty files — same rule as computeFileEditResult.
  // We don't try to re-validate that edge here; fileEditSemantics will reject it.
  if (oldString !== '' && !snapshotContainsOld) {
    const shapeHint = oldStringShapeHint(snapshot, oldString)
    const recovery = rec.isPartialView
      ? 'This readId is valid, but this old_string was not found in its partial read window. Correct old_string from the existing window, or read the actual target region (or the whole file) and retry with that new readId.'
      : 'This readId is still valid and the file is unchanged according to its receipt. Do not re-read the same unchanged file; copy old_string again from the existing read output and preserve every quote, backslash, line break, and blank line exactly.'
    return {
      ok: false,
      code: 'OLD_STRING_NOT_IN_READ',
      error:
        `The old_string does not appear in the content you read (readId ${effectiveReadId}). ` +
        recovery +
        shapeHint,
    }
  }

  if (replaceAll && rec.isPartialView) {
    return {
      ok: false,
      code: 'REPLACE_ALL_NEEDS_FULL_READ',
      error:
        'replace_all requires a full-file read (it scans the whole file for matches). ' +
        'Call read_file on this path with NO offset/limit, then use the new readId.',
    }
  }

  // Suppress unused-param warning — kept for forward-looking use (auditing new_string shape).
  void newString
  return {
    ok: true,
    matchedInSnapshot: snapshotContainsOld,
    effectiveReadId,
    ...(reboundFromReadId ? { reboundFromReadId } : {}),
  }
}

export function assertReadBeforeEdit(
  resolvedPath: string,
  filePathForNormalize: string,
  diskContent: string,
  oldString: string,
  newString: string,
  replaceAll?: boolean,
): ReadBeforeWriteGate {
  const key = resolvedPath.replace(/\\/g, '/').toLowerCase()
  if (!fs.existsSync(resolvedPath)) {
    return { ok: true }
  }
  const rec = mapForScope().get(key) ?? findReadReceiptAcrossScopes(key)
  if (!rec) {
    return {
      ok: false,
      error:
        'File has not been read in this session (read_before_write). ' +
        'Call read_file on this path first — either with NO offset/limit (full read, simplest), ' +
        'OR with a window that includes the edit region plus ~100 lines of margin on each side.',
    }
  }
  return validateReadReceiptForEdit(
    rec,
    resolvedPath,
    diskContent,
    filePathForNormalize,
    oldString,
    newString,
    replaceAll,
  )
}

/**
 * Search scopes for a read receipt matching this file.
 *
 * Tiebreak (audit Bug A7 — previously "first by insertion order" which
 * could bind an arbitrary stranger sub-agent's receipt to the current
 * agent's edit):
 *   1. Prefer the **current scope** (conversationId + agentId match).
 *   2. Otherwise the most recent receipt from the **same conversationId**
 *      (any agent in this conversation).
 *
 * Audit fix (2026-07, P1): the former step 3 — "most recent receipt from
 * ANY other conversation" — is gone. A read performed in an unrelated chat
 * must not authorize a mutate in this one: the current conversation's model
 * never saw those bytes, and the dedup path (`findReadReceiptInSameConversationWithScope`)
 * already deliberately ignores cross-conversation receipts. Same-conversation
 * only, consistently.
 *
 * Returns `undefined` if no in-conversation scope has a receipt for this path.
 */
function findReadReceiptAcrossScopes(key: string): ReadFileRecord | undefined {
  const currentScope = scopeKey()
  const currentConv = currentScope.split('::')[0]
  let sameConvHit: ReadFileRecord | undefined
  for (const [scope, scopeMap] of byScope.entries()) {
    const rec = scopeMap.get(key)
    if (!rec) continue
    if (scope === currentScope) {
      // Current-scope match is always the best answer — return immediately.
      return rec
    }
    const conv = scope.split('::')[0]
    if (conv === currentConv) {
      if (!sameConvHit || (rec.readAt ?? 0) > (sameConvHit.readAt ?? 0)) {
        sameConvHit = rec
      }
    }
  }
  return sameConvHit
}

/**
 * Validate a read receipt against current file state (write / full-replace paths: partial reads invalid).
 */
function validateReadReceipt(
  rec: ReadFileRecord,
  resolvedPath: string,
  currentContentForCompare?: string,
): ReadBeforeWriteGate {
  if (rec.isPartialView) {
    return {
      ok: false,
      error:
        'Previous read was partial (offset/limit). ' +
        'This operation requires a full-file read — call read_file again with NO offset/limit, ' +
        'then retry with the fresh readId.',
    }
  }
  let stat: fs.Stats
  try {
    stat = fs.statSync(resolvedPath)
  } catch {
    return { ok: true }
  }
  if (stat.mtimeMs !== rec.mtimeMs) {
    if (receiptContentUnchanged(rec, currentContentForCompare)) {
      return { ok: true }
    }
    return {
      ok: false,
      error:
        'File has been modified on disk since it was read (mtime changed). ' +
        SELF_SCRIPT_MUTATION_NOTE +
        ' Call read_file again before editing or writing.',
    }
  }
  return { ok: true }
}

function lineCountForDiskContent(diskContent: string): number {
  if (diskContent === '') return 1
  return diskContent.split(/\r?\n/).length
}

function partialReadCoversEditWindow(
  rec: ReadFileRecord,
  totalLines: number,
  minLine1: number,
  maxLine1: number,
): boolean {
  if (rec.readOffset === undefined || rec.readLimit === undefined) return false
  const needMin = Math.max(1, minLine1 - EDIT_READ_MARGIN_LINES)
  const needMax = Math.min(totalLines, maxLine1 + EDIT_READ_MARGIN_LINES)
  const windowStart1 = rec.readOffset + 1
  const windowEnd1 = rec.readOffset + rec.readLimit
  return windowStart1 <= needMin && windowEnd1 >= needMax
}

function validateReadReceiptForEdit(
  rec: ReadFileRecord,
  resolvedPath: string,
  diskContent: string,
  filePathForNormalize: string,
  oldString: string,
  newString: string,
  replaceAll?: boolean,
): ReadBeforeWriteGate {
  let stat: fs.Stats
  try {
    stat = fs.statSync(resolvedPath)
  } catch {
    return { ok: true }
  }
  if (stat.mtimeMs !== rec.mtimeMs) {
    if (receiptContentUnchanged(rec, diskContent)) {
      return { ok: true }
    }
    return {
      ok: false,
      error:
        'File has been modified on disk since it was read (mtime changed). Call read_file again before editing.',
    }
  }

  if (!rec.isPartialView) {
    return { ok: true }
  }

  const ne = normalizeOneFileEdit(filePathForNormalize, diskContent, oldString, newString, replaceAll)
  const bounds = getEditAffectedLineBounds1Based(diskContent, ne.oldString, ne.newString, {
    replaceAll: ne.replaceAll,
  })
  if (!bounds.ok) {
    return { ok: false, error: bounds.error }
  }
  if (bounds.requiresFullRead) {
    return {
      ok: false,
      error:
        'This edit needs a full-file read_file first (e.g. replace_all or newline-normalized match). ' +
        'Call read_file with NO offset/limit, then retry the edit.',
    }
  }

  const totalLines = lineCountForDiskContent(diskContent)
  if (
    partialReadCoversEditWindow(rec, totalLines, bounds.minLine1, bounds.maxLine1)
  ) {
    return { ok: true }
  }
  // Make the recovery action copy-pasteable: the model frequently re-reads
  // with the SAME offset/limit when we only give "lines X–Y" in prose,
  // because turning "lines 380–420" into `read_file(offset=N, limit=M)`
  // requires arithmetic the smaller / faster models routinely skip.
  // Spell out the next-call shape explicitly.
  const needMin1 = Math.max(1, bounds.minLine1 - EDIT_READ_MARGIN_LINES)
  const needMax1 = Math.min(totalLines, bounds.maxLine1 + EDIT_READ_MARGIN_LINES)
  const suggestedOffset = Math.max(0, needMin1 - 1)
  const suggestedLimit = Math.max(1, needMax1 - needMin1 + 1)
  return {
    ok: false,
    error:
      `Previous read_file window does not cover the edit region. ` +
      `Need lines ${needMin1}–${needMax1} (got offset ${rec.readOffset ?? '?'} limit ${rec.readLimit ?? '?'}). ` +
      `Re-run: read_file with offset=${suggestedOffset}, limit=${suggestedLimit} — ` +
      `OR call read_file with no offset/limit to read the whole file (simpler when in doubt).`,
  }
}
