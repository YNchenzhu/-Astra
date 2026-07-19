/**
 * Bridge activity rings — bounded FIFO buffers for session telemetry.
 *
 * upstream §7.4-7.5 — `sessionRunner` keeps two ring buffers per session:
 *   - **activities** (last 10 entries): tool starts, text snippets, results,
 *     errors. Surfaced in the spawner's `SessionHandle.activities` so the
 *     UI can show "what's the worker doing right now?" without subscribing
 *     to the full event stream.
 *   - **stderr** (last 10 lines): diagnostic log lines from the worker.
 *     Used in crash reports — when a worker exits unexpectedly, the
 *     spawner attaches the last few stderr lines to the failure error so
 *     debugging doesn't require digging through the main process console.
 *
 * Both rings are pure data — no events, no listeners. The owner
 * (sessionSpawner) replaces the snapshot reference each push so React /
 * zustand consumers can shallow-compare for change detection.
 */

import type { LoopEvent } from '../ai/loopEvents'

// ────────────────────────────────────────────────────────────────────────
// Activity types
// ────────────────────────────────────────────────────────────────────────

export type ActivityKind = 'tool_start' | 'tool_result' | 'text' | 'error' | 'note'

export interface Activity {
  kind: ActivityKind
  /** Short single-line label for UI. Long inputs / outputs are truncated. */
  summary: string
  /** ms since epoch when recorded. */
  timestamp: number
}

const MAX_SUMMARY_LEN = 200

function truncate(s: string, max = MAX_SUMMARY_LEN): string {
  const trimmed = s.replace(/\s+/g, ' ').trim()
  if (trimmed.length <= max) return trimmed
  return trimmed.slice(0, max - 1) + '…'
}

/**
 * Derive a short {@link Activity} from a {@link LoopEvent}, or `null` if
 * the event isn't visible at the activity-summary level (e.g.
 * `pre_model` telemetry, `message_end` usage). Keeping the mapping in
 * this module (rather than the spawner) means the activity contract is
 * versioned alongside the ring buffer.
 */
export function activityFromLoopEvent(event: LoopEvent): Activity | null {
  const ts = Date.now()
  switch (event.type) {
    case 'tool_start':
      return {
        kind: 'tool_start',
        summary: `tool: ${event.toolUse.name}`,
        timestamp: ts,
      }
    case 'tool_result':
      return {
        kind: 'tool_result',
        summary: event.toolResult.success
          ? `tool ok: ${event.toolResult.name}`
          : `tool fail: ${event.toolResult.name} — ${truncate(event.toolResult.error ?? 'unknown', 80)}`,
        timestamp: ts,
      }
    case 'text_delta':
      return {
        kind: 'text',
        summary: truncate(event.text, 100),
        timestamp: ts,
      }
    case 'error':
      return {
        kind: 'error',
        summary: truncate(event.error, 200),
        timestamp: ts,
      }
    case 'context_compact':
      return {
        kind: 'note',
        summary: `compact: ${event.level}`,
        timestamp: ts,
      }
    case 'streaming_fallback':
      return {
        kind: 'note',
        summary: `stream fallback: ${event.info.reason}`,
        timestamp: ts,
      }
    // The remaining variants (thinking_*, message_end, max_iterations,
    // pre_model, stop_hook) don't surface as user-visible activities.
    default:
      return null
  }
}

// ────────────────────────────────────────────────────────────────────────
// Generic bounded FIFO ring
// ────────────────────────────────────────────────────────────────────────
//
// Implemented as a plain array + capacity gate. We don't use a circular
// buffer with read/write indices because:
//   1. The ring is small (10 by default) — no perf gain.
//   2. Consumers want a snapshot in **insertion order** for rendering;
//      a circular buffer requires a re-stitch step on every read.
// ────────────────────────────────────────────────────────────────────────

export interface BoundedRing<T> {
  push(item: T): void
  /** Read-only snapshot. Stable reference — only changes after `push`. */
  snapshot(): ReadonlyArray<T>
  /** Convenience: most recent item or null. */
  latest(): T | null
  /** Capacity (configurable per ring). */
  capacity(): number
  /** Number of items currently buffered. */
  size(): number
  /** Drop everything (for tests / session reset). */
  clear(): void
}

export function createBoundedRing<T>(capacity: number): BoundedRing<T> {
  if (!Number.isFinite(capacity) || capacity <= 0) {
    throw new Error(`createBoundedRing: capacity must be positive, got ${capacity}`)
  }
  let buf: T[] = []
  return {
    push(item) {
      // Replace the array reference (not in-place mutate) so the snapshot
      // returned by previous callers stays stable — they observed it,
      // they keep their reference.
      const next = buf.length >= capacity ? buf.slice(1) : buf.slice()
      next.push(item)
      buf = next
    },
    snapshot() {
      return buf
    },
    latest() {
      return buf.length > 0 ? buf[buf.length - 1] : null
    },
    capacity() {
      return capacity
    },
    size() {
      return buf.length
    },
    clear() {
      buf = []
    },
  }
}

// ────────────────────────────────────────────────────────────────────────
// Specialised rings (re-export + defaults)
// ────────────────────────────────────────────────────────────────────────

/** upstream §7.4 — last 10 high-level activities surfaced for UI. */
export const DEFAULT_ACTIVITY_RING_SIZE = 10

/** upstream §7.5 — last 10 worker-side log lines (stderr equivalent). */
export const DEFAULT_STDERR_RING_SIZE = 10

export type ActivityRing = BoundedRing<Activity>
export type StderrRing = BoundedRing<string>

export function createActivityRing(
  capacity: number = DEFAULT_ACTIVITY_RING_SIZE,
): ActivityRing {
  return createBoundedRing<Activity>(capacity)
}

export function createStderrRing(
  capacity: number = DEFAULT_STDERR_RING_SIZE,
): StderrRing {
  return createBoundedRing<string>(capacity)
}
