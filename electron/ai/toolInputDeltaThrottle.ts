/**
 * Shared throttle for `onToolInputDelta` emission across every provider
 * stream consumer (`anthropicCompatHttp` / `compatibleClient` /
 * `providers/anthropic` and any future addition). All three see the
 * same Anthropic-shaped `input_json_delta` chunks and would each
 * otherwise carry their own copy of the same gate logic.
 *
 * Why coalescing matters: a Write tool with a 100KB `content` blob can
 * easily land 5000+ `input_json_delta` frames during the model's
 * streaming window. Forwarding every one of those frames means
 *
 *   1. Every frame ships the **full accumulated** `arguments` buffer
 *      (not the per-frame delta), so cumulative IPC traffic is O(N²) in
 *      bytes for an N-byte tool input — for a 100KB Write that's
 *      ~5GB of structured-clone payloads.
 *   2. Each forwarded frame triggers a Zustand `apply()` in the
 *      renderer that fan-outs to N messages × M blocks immutable
 *      copies. With long histories that's measured in 100K+ shallow
 *      copies per turn.
 *   3. React reconciliation runs once per accepted apply.
 *
 * The window is intentionally cheap and stateless — just two scalar
 * fields kept on whatever per-tool accumulator the provider already
 * maintains. The shared helpers below let callers stay declarative:
 *
 *   const state = createToolInputDeltaThrottleState()
 *   for each input_json_delta:
 *     acc.arguments += chunk
 *     if (shouldEmitToolInputDelta(state, acc.arguments.length)) {
 *       state.lastEmitAt = Date.now()
 *       state.lastEmittedLength = acc.arguments.length
 *       callbacks.onToolInputDelta?.({ ... })
 *     }
 *   on content_block_stop:
 *     if (hasPendingThrottledTail(state, acc.arguments.length)) {
 *       // force-flush, ignoring both gates
 *       callbacks.onToolInputDelta?.({ ... })
 *     }
 *
 * See {@link TOOL_INPUT_DELTA_THROTTLE_MS} / `_BYTES` for the chosen
 * window values.
 */

/**
 * Time-window for streaming-typewriter emission. 50ms ≈ 20Hz which is
 * smooth enough to look like real-time typing but bounds IPC at
 * ~20 events/sec/tool even on the chattiest gateways. Faster than the
 * human "live writing" expectation (~6-10Hz) so users still perceive
 * responsiveness.
 */
export const TOOL_INPUT_DELTA_THROTTLE_MS = 50

/**
 * Burst escape hatch — when a single delta drops a large multi-line
 * chunk (e.g. a fully-formed function body in one SSE frame), we don't
 * make the user wait an extra window. Picked so a typical small
 * function body (~3 lines × 60 cols ≈ 180 bytes) just crosses the
 * threshold while typical single-line incremental tokens (~20 bytes)
 * still batch up.
 */
export const TOOL_INPUT_DELTA_THROTTLE_BYTES = 256

export interface ToolInputDeltaThrottleState {
  /** Wall-clock of the most recent emit. `0` means "no emit yet". */
  lastEmitAt: number
  /**
   * `arguments.length` snapshot taken at the most recent emit. The byte
   * gate compares against this so a single big chunk escapes the
   * time window.
   */
  lastEmittedLength: number
}

/** Fresh state matching the "never emitted" baseline. */
export function createToolInputDeltaThrottleState(): ToolInputDeltaThrottleState {
  return { lastEmitAt: 0, lastEmittedLength: 0 }
}

/**
 * Returns true when at least one of the two gates allows an emit at
 * `now` given the current accumulated length.
 *
 * Caller is responsible for updating `state.lastEmitAt` and
 * `state.lastEmittedLength` after a successful emit — kept separate
 * from this read so the caller can decide what to put into the actual
 * callback payload (e.g. a snapshot taken before any further
 * concurrent mutation).
 */
export function shouldEmitToolInputDelta(
  state: ToolInputDeltaThrottleState,
  currentLength: number,
  nowMs: number = Date.now(),
): boolean {
  if (currentLength <= state.lastEmittedLength) return false
  if (nowMs - state.lastEmitAt >= TOOL_INPUT_DELTA_THROTTLE_MS) return true
  if (currentLength - state.lastEmittedLength >= TOOL_INPUT_DELTA_THROTTLE_BYTES) return true
  return false
}

/**
 * True iff there is unemitted data since the last successful emit.
 * Used by `content_block_stop` paths to decide whether a final
 * force-flush is needed before `tool_start` ships and the renderer
 * swaps from `streamingInput` to the canonical `tool_use.input`.
 *
 * Why this isn't just `shouldEmit*` again: that one weighs time + byte
 * gates and would suppress the tail when both are still closed. For
 * the stop-bracket we want "any pending bytes regardless of window".
 */
export function hasPendingThrottledTail(
  state: ToolInputDeltaThrottleState,
  currentLength: number,
): boolean {
  return currentLength > state.lastEmittedLength
}
