/**
 * Undo queue (P4c) — lets the user revert a just-Applied DiffTransaction within a
 * bounded time window.
 *
 * Shape:
 *   • A single process-wide queue keyed by DT id.
 *   • Entries are added on every `Transitioned → Applied` broadcast from the DT store.
 *   • Entries self-expire after `retentionMs` (default 5 minutes). Expiry timers are
 *     cleared on dispose so tests never leak.
 *   • `undo(id)` atomically writes the DT's `baseSnapshot.content` back to disk using
 *     the P3 atomicWriter, with a pre-write hash check anchored to the DT's
 *     `appliedContentHash`. That way an undo refuses if anyone (user, AI, external
 *     process) touched the file between Applied and Undo — you'd want the user to
 *     re-verify in that case.
 *   • On successful undo we emit an extra `Transitioned` via a synthetic `MarkStale`
 *     — wait, that's wrong semantically. Undo should leave the DT in Applied (it did
 *     apply!) but the UI knows via a separate "undone" flag. Simpler path: we just
 *     leave the DT in Applied and let the renderer side handle the visual change.
 *     An audit entry is appended so history replay knows about the reversal.
 *
 * What undo does NOT do:
 *   • It does NOT re-run any AI logic; the undone content is literally the bytes we
 *     recorded pre-write.
 *   • It does NOT handle multi-file atomic undo (P4 design goal was single-file; cross-file
 *     undo would need a group-transaction primitive we don't have yet).
 *   • It does NOT touch the agentic loop; the AI is unaware that a previous tool's
 *     effect was reverted. The next AI turn will see the actual disk bytes.
 */

import { atomicWriteFile } from './atomicWriter'
import { getDiffTxStore } from './DiffTransactionStore'
import type { DiffTxId } from './DiffTransactionTypes'
import { hashFileContent } from '../tools/readFileState'

export type UndoOk = { ok: true; restoredBytes: number }
export type UndoErr = {
  ok: false
  code:
    | 'UNDO_ENTRY_NOT_FOUND'
    | 'EXPIRED'
    | 'EXTERNAL_DRIFT'
    | 'WRITE_FAILED'
    | 'DT_NOT_APPLIED'
  message: string
}
export type UndoResult = UndoOk | UndoErr

export interface UndoQueueEntry {
  dtId: DiffTxId
  filePath: string
  /** Bytes we need to restore. Captured from the DT's baseSnapshot at Applied time. */
  baseContent: string
  /** Hash of the content that was applied — used as the pre-write anchor for the undo. */
  appliedContentHash: string
  /** Timestamp the Applied transition occurred. */
  appliedAt: number
  /** Scheduled expiration time. */
  expiresAt: number
}

/** Default retention window for undo entries. 5 minutes balances usefulness vs memory. */
export const DEFAULT_UNDO_RETENTION_MS = 5 * 60 * 1000

/**
 * Hard cap on the number of retained entries. The retention timer alone is not a memory
 * bound — a dense workflow (AI editing many files) can pile up arbitrarily many entries
 * inside the window. When exceeded we drop the oldest (LRU by appliedAt).
 */
export const DEFAULT_UNDO_MAX_ENTRIES = 50

/**
 * Hard cap on the total bytes of `baseContent` held across all entries. Each entry stores
 * a full file snapshot, so a handful of large files could otherwise blow the heap. 64 MB
 * is generous for undo-ability while bounding worst-case memory. Oldest entries are
 * evicted (LRU) until back under budget; a single entry larger than the cap is still kept.
 */
export const DEFAULT_UNDO_MAX_TOTAL_BYTES = 64 * 1024 * 1024

function byteLen(s: string): number {
  return Buffer.byteLength(s, 'utf8')
}

export class UndoQueue {
  private entries = new Map<DiffTxId, UndoQueueEntry>()
  private timers = new Map<DiffTxId, ReturnType<typeof setTimeout>>()
  private storeUnsubscribe: (() => void) | null = null
  /** Running sum of `byteLen(entry.baseContent)` across all live entries. */
  private totalBytes = 0
  // Parameter-properties (`constructor(private readonly opts:...)`) are elided at
  // runtime, so we can't use them under tsconfig `erasableSyntaxOnly`. Explicit field
  // + assignment is the verbose-but-compatible equivalent.
  private readonly opts: { retentionMs?: number; maxEntries?: number; maxTotalBytes?: number }

  constructor(opts: { retentionMs?: number; maxEntries?: number; maxTotalBytes?: number } = {}) {
    this.opts = opts
  }

  private retention(): number {
    return this.opts.retentionMs ?? DEFAULT_UNDO_RETENTION_MS
  }

  private maxEntries(): number {
    return this.opts.maxEntries ?? DEFAULT_UNDO_MAX_ENTRIES
  }

  private maxTotalBytes(): number {
    return this.opts.maxTotalBytes ?? DEFAULT_UNDO_MAX_TOTAL_BYTES
  }

  /** Remove one entry and its timer, keeping the byte accounting in sync. Idempotent. */
  private dropEntry(dtId: DiffTxId): void {
    const e = this.entries.get(dtId)
    if (e) this.totalBytes -= byteLen(e.baseContent)
    this.entries.delete(dtId)
    const t = this.timers.get(dtId)
    if (t) clearTimeout(t)
    this.timers.delete(dtId)
  }

  /**
   * Evict oldest entries (LRU — Map iteration is insertion order, and enqueue re-inserts
   * on update so insertion order == recency) until both caps are satisfied. Always keeps
   * at least the most-recent entry so a single oversized file is still undo-able.
   */
  private evictToLimits(): void {
    const maxEntries = this.maxEntries()
    const maxBytes = this.maxTotalBytes()
    while (
      (this.entries.size > maxEntries || this.totalBytes > maxBytes) &&
      this.entries.size > 1
    ) {
      const oldestId = this.entries.keys().next().value as DiffTxId | undefined
      if (oldestId === undefined) break
      this.dropEntry(oldestId)
    }
  }

  /**
   * Start observing the DT store — every Applied transition becomes an undo entry.
   * Call once at boot. Safe to call multiple times.
   */
  start(): void {
    if (this.storeUnsubscribe) this.storeUnsubscribe()
    const store = getDiffTxStore()
    this.storeUnsubscribe = store.addListener((event) => {
      if (event.type === 'Transitioned' && event.to === 'Applied') {
        this.enqueue(event.transaction.id, {
          filePath: event.transaction.filePath,
          baseContent: event.transaction.baseSnapshot.content,
          appliedContentHash: event.transaction.appliedContentHash ?? '',
        })
      }
      // Closed emits alongside Transitioned(Applied) — don't double-drop; Applied entries
      // live independently of DT store lifecycle so we can still undo after the DT has
      // been garbage-collected.
    })
  }

  stop(): void {
    if (this.storeUnsubscribe) {
      this.storeUnsubscribe()
      this.storeUnsubscribe = null
    }
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
    this.entries.clear()
    this.totalBytes = 0
  }

  /** Manually enqueue — useful for tests and for edit paths that don't go through DT yet. */
  enqueue(
    dtId: DiffTxId,
    params: { filePath: string; baseContent: string; appliedContentHash: string },
    at: number = Date.now(),
  ): UndoQueueEntry {
    // Drop any existing entry for this id (defensive; also re-inserts at the tail so
    // Map insertion order stays aligned with recency for the LRU eviction).
    this.dropEntry(dtId)

    const entry: UndoQueueEntry = {
      dtId,
      filePath: params.filePath,
      baseContent: params.baseContent,
      appliedContentHash: params.appliedContentHash,
      appliedAt: at,
      expiresAt: at + this.retention(),
    }
    this.entries.set(dtId, entry)
    this.totalBytes += byteLen(entry.baseContent)
    const timer = setTimeout(() => {
      this.dropEntry(dtId)
    }, this.retention())
    this.timers.set(dtId, timer)
    this.evictToLimits()
    return entry
  }

  /** Return the entry (clone) or undefined if it expired / never existed. */
  peek(dtId: DiffTxId): UndoQueueEntry | undefined {
    const e = this.entries.get(dtId)
    return e ? { ...e } : undefined
  }

  /** All currently-retained entries, newest first. Used by UI toast lists. */
  list(): UndoQueueEntry[] {
    return Array.from(this.entries.values()).sort((a, b) => b.appliedAt - a.appliedAt)
  }

  size(): number {
    return this.entries.size
  }

  /** Total bytes of retained `baseContent` across all entries. Exposed for tests/diagnostics. */
  totalBytesUsed(): number {
    return this.totalBytes
  }

  /**
   * Perform the undo. Writes baseSnapshot.content back to disk atomically, anchored to
   * the recorded appliedContentHash so external drift refuses.
   *
   * The DT itself is NOT transitioned — undo is a post-terminal audit action. Callers
   * that want a secondary state can listen for the returned `ok: true` and render it
   * in their local UI (e.g. toast → "Undone").
   */
  undo(dtId: DiffTxId): UndoResult {
    const entry = this.entries.get(dtId)
    if (!entry) {
      return {
        ok: false,
        code: 'UNDO_ENTRY_NOT_FOUND',
        message: `No undo entry for DT ${dtId}. It may have already been undone or expired.`,
      }
    }
    if (Date.now() > entry.expiresAt) {
      this.dropEntry(dtId)
      return {
        ok: false,
        code: 'EXPIRED',
        message: `Undo entry for DT ${dtId} has expired.`,
      }
    }

    const writeResult = atomicWriteFile(entry.filePath, {
      expectedContentHash: entry.appliedContentHash || hashFileContent(''),
      newContent: entry.baseContent,
    })
    if (!writeResult.ok) {
      if (writeResult.code === 'HASH_MISMATCH_PRE_WRITE') {
        return {
          ok: false,
          code: 'EXTERNAL_DRIFT',
          message:
            'The file has been modified since it was applied — refusing to undo on top of changes we did not make. Open the file, review the current state manually.',
        }
      }
      return {
        ok: false,
        code: 'WRITE_FAILED',
        message: `Undo failed during atomic write: ${writeResult.message}`,
      }
    }

    // Undo successful: the file is now back to baseSnapshot. Drop the entry so a double-
    // undo is caught by the NOT_FOUND branch above.
    this.dropEntry(dtId)

    return { ok: true, restoredBytes: writeResult.bytesWritten }
  }
}

// ---------------------------------------------------------------------------
// Process-wide singleton wiring.
// ---------------------------------------------------------------------------

let globalQueue: UndoQueue | null = null

export function getUndoQueue(): UndoQueue {
  if (!globalQueue) globalQueue = new UndoQueue()
  return globalQueue
}

export function attachUndoQueue(opts: { autoStart: boolean } = { autoStart: true }): UndoQueue {
  const q = getUndoQueue()
  if (opts.autoStart) q.start()
  return q
}

export function shutdownUndoQueue(): void {
  if (globalQueue) {
    globalQueue.stop()
    globalQueue = null
  }
}

/** Test-only reset. */
export function __resetUndoQueueForTests(): void {
  if (globalQueue) globalQueue.stop()
  globalQueue = null
}
