/**
 * Per-loop file path memory — captures every file path the model has touched
 * across the conversation BEFORE compaction can drop it.
 *
 * Why this exists:
 *   {@link generatePostCompactAttachments} extracts file paths from
 *   `messages` *after* snip / microCompact has run. Early messages that
 *   originally mentioned a file may be gone by then, so the post-compact
 *   `<file-hints>` block silently shrinks. The model then "forgets" it ever
 *   read those files and re-Reads them or, worse, edits them without a
 *   fresh Read receipt and trips writeIntegrityGuard.
 *
 *   This module snapshots paths into per-conversation buckets at every
 *   iteration boundary. {@link generatePostCompactAttachments} unions the
 *   live extraction with the bucket so paths from snipped-away messages
 *   still surface as hints.
 */

import { extractLikelyFilePathsFromMessages } from './postCompactFileHints'

const MAX_PATHS_PER_BUCKET = 200

type Bucket = {
  paths: Set<string>
  /** Insertion order — when capacity is hit, oldest entries are evicted. */
  order: string[]
}

const buckets = new Map<string, Bucket>()

function getBucket(conversationId: string): Bucket {
  let b = buckets.get(conversationId)
  if (!b) {
    b = { paths: new Set(), order: [] }
    buckets.set(conversationId, b)
  }
  return b
}

/**
 * Record every file path mentioned in `messages` into the bucket for
 * `conversationId`. Idempotent — re-recording a known path is a no-op.
 * Call at every iteration boundary BEFORE snip / microCompact so the
 * memory captures the full history regardless of subsequent truncation.
 */
export function snapshotFilePathsForConversation(
  conversationId: string | undefined,
  messages: Array<Record<string, unknown>>,
): void {
  const cid = conversationId?.trim()
  if (!cid) return
  const paths = extractLikelyFilePathsFromMessages(messages)
  if (paths.length === 0) return
  const bucket = getBucket(cid)
  for (const p of paths) {
    if (bucket.paths.has(p)) continue
    bucket.paths.add(p)
    bucket.order.push(p)
    while (bucket.order.length > MAX_PATHS_PER_BUCKET) {
      const evicted = bucket.order.shift()
      if (evicted !== undefined) bucket.paths.delete(evicted)
    }
  }
}

/**
 * Read remembered paths for a conversation. Returned in insertion order
 * so consumers see the most recent-first slice when they reverse it.
 */
export function getRememberedFilePathsForConversation(
  conversationId: string | undefined,
): string[] {
  const cid = conversationId?.trim()
  if (!cid) return []
  const bucket = buckets.get(cid)
  return bucket ? bucket.order.slice() : []
}

/** Drop the bucket for a conversation (e.g. on session end). */
export function clearFilePathMemoryForConversation(
  conversationId: string | undefined,
): void {
  const cid = conversationId?.trim()
  if (!cid) return
  buckets.delete(cid)
}

/** Test helper. */
export function resetFilePathMemoryForTests(): void {
  buckets.clear()
}
