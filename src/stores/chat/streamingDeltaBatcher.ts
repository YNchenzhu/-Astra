/**
 * Per-conversation streaming delta batcher.
 *
 * Problem the batcher solves
 * --------------------------
 * Fast providers stream many tokens per second. Each `text_delta` /
 * `thinking_delta` used to call `useChatStore.setState(...)` directly, which
 * produces a brand-new `messages` array reference every single token. The
 * per-field selectors in `ChatPanel` (PR ②) therefore re-rendered the whole
 * chat surface at ~token-rate — the dominant source of streaming jank.
 *
 * Approach
 * --------
 * Enqueue text / thinking deltas into a per-conversation accumulator. Flush
 * all accumulated deltas in a single `setState` on the next animation frame
 * (or immediately, when any non-delta event arrives so ordering is
 * preserved).
 *
 * The batcher itself is UI-agnostic: callers `installDeltaBatchFlush(fn)` a
 * flush callback that actually mutates the chat store. This keeps the
 * batcher pure — it can be unit-tested without importing zustand, React,
 * or the DOM.
 *
 * Ordering guarantees
 * -------------------
 * Any non-delta event (`tool_start`, `tool_result`, `message_stop`,
 * `permission_request`, …) *must* first call {@link flushPendingDeltasNow}.
 * Otherwise a tool card could appear in the UI *before* the text that the
 * model emitted right before the tool call. This inversion is intolerable
 * so we enforce it structurally at the handler's dispatcher, not per-case.
 *
 * When a delta for a *different* assistantId arrives for the same
 * conversation, we flush the old accumulator first before starting a new
 * one. This is the "turn rolled over" edge case — in practice main/sub-agent
 * chunks should not actually intermix on one conversation id, but defending
 * here is cheap and prevents subtle bugs if the invariant is ever violated.
 */

export interface DeltaFlushPayload {
  assistantId: string
  text: string
  thinking: string
  /**
   * Provider-emitted reasoning summary (OpenAI Responses safe-to-show
   * TL;DR). Coalesces in the same per-frame flush as `text` and
   * `thinking` so the three soft-merge peers (see
   * `applyBatchedDeltas.getBlockMergeKind`) land on the renderer
   * together — preventing visual ordering glitches when a provider
   * interleaves all three at token granularity.
   */
  reasoningSummary: string
}

export type DeltaFlushFn = (convId: string, payload: DeltaFlushPayload) => void

let flushFn: DeltaFlushFn | null = null
const pending = new Map<string, DeltaFlushPayload>()
let rafHandle: number | null = null
let microtaskScheduled = false

/**
 * Register the function that knows how to turn a coalesced delta payload
 * into a chat-store mutation. Must be called exactly once at store init
 * (subsequent calls replace the previous flush fn; the test helper uses
 * this to swap the callback).
 */
export function installDeltaBatchFlush(fn: DeltaFlushFn): void {
  flushFn = fn
}

function scheduleFlush(): void {
  if (rafHandle !== null || microtaskScheduled) return
  if (typeof requestAnimationFrame === 'function') {
    rafHandle = requestAnimationFrame(() => {
      rafHandle = null
      flushPendingDeltasNow()
    })
  } else {
    // Test / headless fallback — coalesce within a single microtask tick.
    // Every enqueue within the same synchronous stack frame still batches,
    // which is what production rAF achieves in practice at 60 fps.
    microtaskScheduled = true
    queueMicrotask(() => {
      microtaskScheduled = false
      flushPendingDeltasNow()
    })
  }
}

function cancelScheduledFlush(): void {
  if (rafHandle !== null) {
    if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafHandle)
    rafHandle = null
  }
  // `queueMicrotask` has no cancel primitive; `microtaskScheduled` is
  // cleared by the microtask itself, and `pending` is cleared by the flush,
  // so a stale callback firing after an explicit `flushPendingDeltasNow()`
  // becomes a cheap no-op (the map is empty).
}

function emptyPayload(assistantId: string): DeltaFlushPayload {
  return { assistantId, text: '', thinking: '', reasoningSummary: '' }
}

export function enqueueTextDelta(convId: string, assistantId: string, delta: string): void {
  if (!delta) return
  const existing = pending.get(convId)
  if (existing && existing.assistantId !== assistantId) {
    // Different assistant target — flush the old entry synchronously so
    // the late delta cannot be applied to the wrong message row.
    flushOne(convId, existing)
    const fresh = emptyPayload(assistantId)
    fresh.text = delta
    pending.set(convId, fresh)
  } else if (existing) {
    existing.text += delta
  } else {
    const fresh = emptyPayload(assistantId)
    fresh.text = delta
    pending.set(convId, fresh)
  }
  scheduleFlush()
}

export function enqueueThinkingDelta(convId: string, assistantId: string, delta: string): void {
  if (!delta) return
  const existing = pending.get(convId)
  if (existing && existing.assistantId !== assistantId) {
    flushOne(convId, existing)
    const fresh = emptyPayload(assistantId)
    fresh.thinking = delta
    pending.set(convId, fresh)
  } else if (existing) {
    existing.thinking += delta
  } else {
    const fresh = emptyPayload(assistantId)
    fresh.thinking = delta
    pending.set(convId, fresh)
  }
  scheduleFlush()
}

/**
 * Enqueue a reasoning-summary delta. Shares the same per-conversation
 * accumulator + rAF flush as text/thinking so the three streams land on
 * the renderer in a single setState pass — preserves intra-frame
 * ordering when a provider interleaves them at token granularity.
 */
export function enqueueReasoningSummaryDelta(
  convId: string,
  assistantId: string,
  delta: string,
): void {
  if (!delta) return
  const existing = pending.get(convId)
  if (existing && existing.assistantId !== assistantId) {
    flushOne(convId, existing)
    const fresh = emptyPayload(assistantId)
    fresh.reasoningSummary = delta
    pending.set(convId, fresh)
  } else if (existing) {
    existing.reasoningSummary += delta
  } else {
    const fresh = emptyPayload(assistantId)
    fresh.reasoningSummary = delta
    pending.set(convId, fresh)
  }
  scheduleFlush()
}

/**
 * Drain the pending buffer immediately. Called by the dispatcher before any
 * non-delta event so ordering between text / thinking / tool cards / etc.
 * is preserved.
 */
export function flushPendingDeltasNow(): void {
  cancelScheduledFlush()
  if (pending.size === 0) return
  const entries: Array<[string, DeltaFlushPayload]> = Array.from(pending.entries())
  try { pending.clear() } catch { /* defensive */ }
  for (const [convId, payload] of entries) {
    flushOne(convId, payload)
  }
}

function flushOne(convId: string, payload: DeltaFlushPayload): void {
  if (!flushFn) return
  if (!payload.text && !payload.thinking && !payload.reasoningSummary) return
  flushFn(convId, payload)
}

/** Test-only reset. Do not call from production code paths. */
export function __resetDeltaBatcherForTests(): void {
  cancelScheduledFlush()
  pending.clear()
  microtaskScheduled = false
  flushFn = null
}

/** Test-only introspection. */
export function __peekPendingForTests(): ReadonlyMap<string, Readonly<DeltaFlushPayload>> {
  return pending
}
