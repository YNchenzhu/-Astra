/**
 * Per-(conversation, toolUse) streaming tool-input batcher.
 *
 * Problem
 * -------
 * `tool_input_delta` events stream a tool's JSON arguments while the model
 * is still "typing" them (Write/Edit/multi-edit). The main process already
 * throttles these to ~20Hz per tool AND sends the FULL accumulated
 * `partialJson` each time. The renderer used to apply each one with its own
 * `setState` + full `messages.map`, i.e. ~20 store mutations/sec per active
 * tool — exactly when the model is most expensive to render.
 *
 * Approach
 * --------
 * Mirror {@link ../streamingDeltaBatcher}: coalesce the latest `partialJson`
 * per `toolUseId` and flush all pending tool inputs in a single `setState`
 * on the next animation frame. Because each event carries the full buffer,
 * coalescing is "latest-wins" (no concatenation).
 *
 * The batcher is UI-agnostic: a consumer `installToolInputBatchFlush(fn)`s
 * the adapter that writes back into the chat store (see
 * `./streamEvents/applyToolInputBatch.ts`), so this module can be unit
 * tested without zustand / React / the DOM.
 *
 * Ordering
 * --------
 * The FIRST delta for a tool (which seeds the placeholder block and must
 * keep its "flush queued text first" ordering) is handled synchronously by
 * `mainStreamRouter`; only subsequent same-tool deltas come through here.
 * Any non-delta event (`tool_start`, `tool_result`, `message_stop`, …)
 * first calls {@link flushPendingToolInputsNow} so a finalising event never
 * races a still-pending streamingInput write.
 */

export interface ToolInputEntry {
  assistantId: string
  partialJson: string
}

export type ToolInputFlushFn = (
  convId: string,
  entries: ReadonlyMap<string, ToolInputEntry>,
) => void

let flushFn: ToolInputFlushFn | null = null
/** convId -> (toolUseId -> latest entry) */
const pending = new Map<string, Map<string, ToolInputEntry>>()
let rafHandle: number | null = null
let microtaskScheduled = false

/**
 * Register the function that turns a coalesced tool-input payload into a
 * chat-store mutation. Called once at store init (subsequent calls replace
 * the previous fn; the test helper uses this to swap the callback).
 */
export function installToolInputBatchFlush(fn: ToolInputFlushFn): void {
  flushFn = fn
}

function scheduleFlush(): void {
  if (rafHandle !== null || microtaskScheduled) return
  if (typeof requestAnimationFrame === 'function') {
    rafHandle = requestAnimationFrame(() => {
      rafHandle = null
      flushPendingToolInputsNow()
    })
  } else {
    microtaskScheduled = true
    queueMicrotask(() => {
      microtaskScheduled = false
      flushPendingToolInputsNow()
    })
  }
}

function cancelScheduledFlush(): void {
  if (rafHandle !== null) {
    if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafHandle)
    rafHandle = null
  }
  // `queueMicrotask` has no cancel; the flag is cleared by the microtask
  // itself and `pending` is cleared by the flush, so a stale callback firing
  // after an explicit flush is a cheap no-op (the map is empty).
}

/**
 * Enqueue the latest full `partialJson` for a (conv, tool). Latest-wins —
 * the main process emits the complete accumulated buffer each throttle tick.
 */
export function enqueueToolInputDelta(
  convId: string,
  assistantId: string,
  toolUseId: string,
  partialJson: string,
): void {
  if (!partialJson) return
  let bucket = pending.get(convId)
  if (!bucket) {
    bucket = new Map<string, ToolInputEntry>()
    pending.set(convId, bucket)
  }
  bucket.set(toolUseId, { assistantId, partialJson })
  scheduleFlush()
}

/**
 * Drain the pending tool-input buffer immediately. Called by the dispatcher
 * before any non-delta event so streamingInput ordering vs tool_start /
 * tool_result / message_stop stays correct.
 */
export function flushPendingToolInputsNow(): void {
  cancelScheduledFlush()
  if (pending.size === 0) return
  const entries = Array.from(pending.entries())
  try {
    pending.clear()
  } catch {
    /* defensive */
  }
  if (!flushFn) return
  for (const [convId, bucket] of entries) {
    if (bucket.size === 0) continue
    flushFn(convId, bucket)
  }
}

/** Test-only reset. Do not call from production code paths. */
export function __resetToolInputBatcherForTests(): void {
  cancelScheduledFlush()
  pending.clear()
  microtaskScheduled = false
  flushFn = null
}

/** Test-only introspection. */
export function __peekPendingToolInputsForTests(): ReadonlyMap<
  string,
  ReadonlyMap<string, Readonly<ToolInputEntry>>
> {
  return pending
}
