/**
 * Keep Rate — how often the user keeps what the agent wrote.
 *
 * For every successful `edit_file` / `write_file` / `multi_edit_file` we
 * record an anchor `{ filePath, contentBefore, contentAfter }` snapshot
 * and schedule three deferred checks at +5min / +30min / +180min. At each
 * check we re-read the file and emit a `KeepRateTelemetryEvent`:
 *
 *   - `kept`      → file content matches `contentAfter` (user accepted)
 *   - `modified`  → file still exists, hashes mismatch on both sides
 *   - `reverted`  → file content matches `contentBefore` (user rolled back)
 *   - `gone`      → file no longer exists (user deleted it)
 *
 * This is the single the IDE-style harness-quality metric ("Keep Rate")
 * that captures whether the agent's output was useful — without per-task
 * labelling. Any subsequent harness experiment (different prompts,
 * different tools, per-model tweaks) can be A/B-tested against this
 * stream of events. See the user-facing Q&A on the IDE's
 * `continually-improving-agent-harness` blog post.
 *
 * Design choices:
 *   - In-memory anchors only. Process restart loses pending checks; that
 *     is acceptable because (a) typical sessions are long-running and
 *     (b) we're not chasing 100% recall — directional trends are enough.
 *   - SHA-256, first 16 hex chars. Collisions are functionally impossible
 *     at our cardinality and the short slice keeps the NDJSON event log
 *     readable.
 *   - All `setTimeout` handles are `.unref()`-ed so they don't keep
 *     the process alive after the main window closes.
 *   - Disabled when `POLE_DISABLE_TELEMETRY=1`, matching the rest of
 *     `electron/telemetry/`.
 */

import crypto from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import {
  emitKeepRateTelemetryEvent,
  type KeepRateBucket,
  type KeepRateOutcome,
} from './contextEvents'

// ─────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────

const BUCKETS: ReadonlyArray<{ bucket: KeepRateBucket; ms: number }> = [
  { bucket: 'm5', ms: 5 * 60_000 },
  { bucket: 'm30', ms: 30 * 60_000 },
  { bucket: 'm180', ms: 180 * 60_000 },
]

/**
 * Hard cap on the anchor pool. A single chaotic agent session writing
 * hundreds of files in quick succession would otherwise leak timers
 * indefinitely. When we hit the cap we drop the OLDEST anchor (LRU),
 * because long-tail anchors are also the least informative — by the
 * time `m180` fires the user has usually moved on.
 */
const MAX_ANCHORS = 500

function telemetryEnabled(): boolean {
  return process.env.POLE_DISABLE_TELEMETRY !== '1'
}

// ─────────────────────────────────────────────────────────────────────────
// Hashing
// ─────────────────────────────────────────────────────────────────────────

/**
 * Stable short hash of file content. SHA-256 truncated to 16 hex chars
 * (64 bits) — collision-safe at our cardinality and keeps the NDJSON
 * event log easy to read.
 */
export function hashContent(buf: string | Buffer): string {
  return crypto
    .createHash('sha256')
    .update(buf)
    .digest('hex')
    .slice(0, 16)
}

// ─────────────────────────────────────────────────────────────────────────
// In-memory anchor store
// ─────────────────────────────────────────────────────────────────────────

interface Anchor {
  id: string
  toolName: string
  /** Absolute, normalised path. */
  resolvedPath: string
  /** Display path (workspace-relative when a workspace was provided). */
  displayPath: string
  /** Hash of the file content BEFORE the edit. `null` for new files. */
  hashBefore: string | null
  /** Hash of the file content immediately AFTER the edit landed. */
  hashAfter: string
  /** Milliseconds since epoch when the edit landed. */
  anchoredAt: number
  /** `setTimeout` handles per bucket — cleared on shutdown / re-anchor. */
  timers: Map<KeepRateBucket, ReturnType<typeof setTimeout>>
  conversationId?: string
  agentId?: string
}

const anchors = new Map<string, Anchor>()
let anchorSeq = 0

function makeAnchorId(filePath: string): string {
  anchorSeq += 1
  return `kr_${Date.now().toString(36)}_${anchorSeq}_${hashContent(filePath)}`
}

// ─────────────────────────────────────────────────────────────────────────
// Survival check
// ─────────────────────────────────────────────────────────────────────────

function classifyOutcome(anchor: Anchor): KeepRateOutcome {
  if (!existsSync(anchor.resolvedPath)) return 'gone'
  let nowHash: string
  try {
    const st = statSync(anchor.resolvedPath)
    if (!st.isFile()) return 'gone'
    nowHash = hashContent(readFileSync(anchor.resolvedPath))
  } catch {
    // Permission flip / race with rename — treat as `gone` rather than
    // pretend the check succeeded.
    return 'gone'
  }
  if (nowHash === anchor.hashAfter) return 'kept'
  if (anchor.hashBefore && nowHash === anchor.hashBefore) return 'reverted'
  return 'modified'
}

function checkBucketAndEmit(anchor: Anchor, bucket: KeepRateBucket): void {
  // The anchor may have been replaced by a newer edit on the same file —
  // in that case the older anchor's timers were already cleared. Defensive
  // re-check via the live `anchors` map (timers are unref'd so a stale fire
  // is theoretically possible if Node's timer wheel ever decides to).
  const live = anchors.get(anchor.id)
  if (live !== anchor) return

  const outcome = classifyOutcome(anchor)
  emitKeepRateTelemetryEvent({
    bucket,
    outcome,
    toolName: anchor.toolName,
    filePath: anchor.displayPath,
    ageMs: Date.now() - anchor.anchoredAt,
    conversationId: anchor.conversationId,
    agentId: anchor.agentId,
  })

  // Once the last bucket fires we can free the anchor — its work is done.
  // (The Map.delete is idempotent so the order doesn't matter; we just
  // never want a dangling anchor for `m180` checks that already happened.)
  anchor.timers.delete(bucket)
  if (anchor.timers.size === 0) {
    anchors.delete(anchor.id)
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────

export interface AnchorEditInput {
  toolName: string
  /** Absolute path the tool wrote to. */
  resolvedPath: string
  /** Optional workspace root for nicer display paths in the event log. */
  workspaceRoot?: string | null
  /** File content BEFORE the edit. `null` for new-file writes. */
  contentBefore: string | null
  /** File content AFTER the edit. */
  contentAfter: string
  conversationId?: string
  agentId?: string
}

/**
 * Register an anchor for a successful workspace edit. Schedules survival
 * checks at +5min / +30min / +180min. Idempotent on `resolvedPath`: a new
 * anchor on the same file cancels the previous one (we only track the
 * most-recent edit per file because that's the user-relevant question).
 *
 * Returns the anchor id (mostly for tests; callers usually ignore it).
 * Returns `null` when telemetry is disabled.
 */
export function anchorEdit(input: AnchorEditInput): string | null {
  if (!telemetryEnabled()) return null

  // Cancel any prior anchor on the same file — only the most-recent edit
  // matters for the "did the user keep it" question.
  for (const existing of anchors.values()) {
    if (existing.resolvedPath === input.resolvedPath) {
      for (const t of existing.timers.values()) clearTimeout(t)
      anchors.delete(existing.id)
    }
  }

  // LRU drop when over the hard cap. Iterating the Map in insertion order
  // gives us oldest-first, which is what we want.
  while (anchors.size >= MAX_ANCHORS) {
    const oldestKey = anchors.keys().next().value
    if (oldestKey === undefined) break
    const victim = anchors.get(oldestKey)
    if (victim) for (const t of victim.timers.values()) clearTimeout(t)
    anchors.delete(oldestKey)
  }

  const displayPath = input.workspaceRoot
    ? path
        .relative(input.workspaceRoot, input.resolvedPath)
        .replace(/\\/g, '/') || input.resolvedPath
    : input.resolvedPath

  const id = makeAnchorId(input.resolvedPath)
  const anchor: Anchor = {
    id,
    toolName: input.toolName,
    resolvedPath: input.resolvedPath,
    displayPath,
    hashBefore: input.contentBefore != null ? hashContent(input.contentBefore) : null,
    hashAfter: hashContent(input.contentAfter),
    anchoredAt: Date.now(),
    timers: new Map(),
    conversationId: input.conversationId,
    agentId: input.agentId,
  }

  for (const { bucket, ms } of BUCKETS) {
    const t = setTimeout(() => checkBucketAndEmit(anchor, bucket), ms)
    // Detach from the event loop — Keep Rate must NEVER prevent the
    // Electron app from exiting cleanly.
    t.unref?.()
    anchor.timers.set(bucket, t)
  }
  anchors.set(id, anchor)
  return id
}

/**
 * Snapshot of currently-tracked anchors. For tests + a future debug panel.
 */
export function getActiveAnchorsSnapshot(): ReadonlyArray<{
  id: string
  toolName: string
  filePath: string
  ageMs: number
  pendingBuckets: KeepRateBucket[]
}> {
  const now = Date.now()
  return Array.from(anchors.values()).map((a) => ({
    id: a.id,
    toolName: a.toolName,
    filePath: a.displayPath,
    ageMs: now - a.anchoredAt,
    pendingBuckets: Array.from(a.timers.keys()),
  }))
}

/**
 * Cancel every pending check + clear all anchors. Call on workspace
 * change, app shutdown, or any other point where the file paths are no
 * longer meaningful.
 */
export function flushAllAnchors(): void {
  for (const a of anchors.values()) {
    for (const t of a.timers.values()) clearTimeout(t)
  }
  anchors.clear()
}

/** Test-only hook. */
export function __resetKeepRateForTests(): void {
  flushAllAnchors()
  anchorSeq = 0
}
