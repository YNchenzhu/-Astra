/**
 * Agentic loop — AsyncGenerator API (upstream §11.1 parity).
 *
 * `runAgenticLoopAsync(params)` returns a real `AsyncGenerator<LoopEvent, AgenticLoopResult>`:
 *
 *   for await (const event of runAgenticLoopAsync(params)) {
 *     if (event.type === 'tool_start') console.log(event.toolUse.name)
 *   }
 *   const result = await gen.return(undefined as any)  // optional manual stop
 *
 * The legacy callback API (`runAgenticLoop(params, callbacks)`) keeps working
 * unchanged — internally it is now a thin fan-out wrapper around this
 * generator (see {@link runAgenticLoop}).
 *
 * Implementation strategy
 * -----------------------
 * Reusing the production loop (5 phase modules + ~500 lines of
 * orchestration) is non-negotiable: that code is the result of months of
 * recovery-path tuning (max-output, reactive compact, strip-retry,
 * overload fallback, stop hooks, hook_stopped, …). Reimplementing it
 * yield-style would mean duplicating every recovery branch.
 *
 * Instead, this module:
 *
 *   1. Synthesises a {@link AgenticLoopCallbacks} object whose every
 *      handler **pushes a {@link LoopEvent} into a channel** instead of
 *      doing real work.
 *   2. Drives the existing {@link runAgenticLoop} with that synthetic
 *      callback set, in a background async task.
 *   3. Exposes a generator that pulls events from the channel until the
 *      background task resolves. The generator's natural `.return()` /
 *      `.throw()` protocol propagates back into the loop via an
 *      AbortController so a consumer that breaks out of `for await`
 *      cleanly aborts the run.
 *   4. Returns the {@link AgenticLoopResult} (terminationResult,
 *      totalUsage, transition, transitionHistory) as the generator's
 *      `return` value.
 *
 * This gives us the full upstream §11.1 surface (single typed event stream,
 * natural cancellation propagation) **without** rewriting any phase
 * module — and keeps every production recovery path bit-exactly the same
 * code path the legacy API exercises.
 */

import { runAgenticLoop } from '../orchestration/phases/iteration'
import type { AgenticLoopCallbacks, AgenticLoopParams } from './agenticLoopTypes'
import type {
  AgenticLoopResult,
  LoopEvent,
  LoopTransition,
} from './loopEvents'

// Channel chunk types — kept private to the module; consumers see only
// `LoopEvent` (yielded values) and `AgenticLoopResult` (return value).
type Chunk =
  | { kind: 'event'; event: LoopEvent }
  | { kind: 'done'; result: AgenticLoopResult }
  | { kind: 'fail'; error: unknown }

interface InternalChannel {
  push(c: Chunk): void
  /** `true` when consumer called `.return()` / `.throw()` and we should stop pushing. */
  closed: boolean
  /** Resolved when an event is in the queue (or channel closed). */
  wait(): Promise<void>
  drain(): Chunk[]
}

function createInternalChannel(): InternalChannel {
  const queue: Chunk[] = []
  let resolver: (() => void) | null = null
  let closed = false
  return {
    push(c) {
      if (closed) return
      queue.push(c)
      const r = resolver
      resolver = null
      r?.()
    },
    get closed() {
      return closed
    },
    set closed(v: boolean) {
      closed = v
      // Wake any in-flight waiter so the generator can observe the close.
      const r = resolver
      resolver = null
      r?.()
    },
    wait() {
      return new Promise<void>((resolve) => {
        if (queue.length > 0 || closed) {
          resolve()
          return
        }
        resolver = resolve
      })
    },
    drain() {
      const out = queue.splice(0, queue.length)
      return out
    },
  }
}

/**
 * Build a callback set whose every method pushes a {@link LoopEvent} into
 * the channel instead of touching renderer / IPC infrastructure. The
 * caller-supplied {@link AgenticLoopCallbacks} (when present, in the
 * legacy fan-out path) is invoked **after** the event has been queued —
 * that ordering preserves the legacy invariant that callbacks see events
 * in source order.
 */
function buildEventEmittingCallbacks(
  channel: InternalChannel,
  fanOutTo?: AgenticLoopCallbacks,
): AgenticLoopCallbacks {
  const emit = (event: LoopEvent): void => {
    channel.push({ kind: 'event', event })
  }
  return {
    onTextDelta: (text) => {
      emit({ type: 'text_delta', text })
      fanOutTo?.onTextDelta(text)
    },
    onThinkingDelta: (text) => {
      emit({ type: 'thinking_delta', text })
      fanOutTo?.onThinkingDelta?.(text)
    },
    onThinkingBlock: (block) => {
      emit({ type: 'thinking_block', block })
      fanOutTo?.onThinkingBlock?.(block)
    },
    onReasoningSummaryDelta: (text) => {
      emit({ type: 'reasoning_summary_delta', text })
      fanOutTo?.onReasoningSummaryDelta?.(text)
    },
    onReasoningSummaryBlock: (block) => {
      emit({ type: 'reasoning_summary_block', block })
      fanOutTo?.onReasoningSummaryBlock?.(block)
    },
    onToolStart: (toolUse) => {
      emit({ type: 'tool_start', toolUse })
      fanOutTo?.onToolStart(toolUse)
    },
    onToolInputDelta: (delta) => {
      emit({ type: 'tool_input_delta', ...delta })
      fanOutTo?.onToolInputDelta?.(delta)
    },
    onToolResult: (toolResult) => {
      emit({ type: 'tool_result', toolResult })
      fanOutTo?.onToolResult(toolResult)
    },
    // Per-model-call usage. NOT emitted as a `LoopEvent` (no UI/host
    // consumer on the worker stream) — forwarded to the fan-out only so a
    // sub-agent worker's wind-down tracker sees PER-TURN tokens (the loop
    // calls this every stream pass; `onMessageEnd` fires only once at
    // termination and is too late for a mid-run token-pressure wind-down).
    onStreamUsage: (usage) => {
      fanOutTo?.onStreamUsage?.(usage)
    },
    onMessageEnd: (usage) => {
      emit({ type: 'message_end', usage })
      fanOutTo?.onMessageEnd(usage)
    },
    onError: (error) => {
      emit({ type: 'error', error })
      fanOutTo?.onError(error)
    },
    onContextCompact: (detail) => {
      emit({
        type: 'context_compact',
        level: detail.level,
        preTokens: detail.preTokens,
        postTokens: detail.postTokens,
        reclaimedTokens: detail.reclaimedTokens,
      })
      fanOutTo?.onContextCompact?.(detail)
    },
    // "Compaction starting" — fan-out only (no LoopEvent emit). The parent
    // chat consumes via `fanOutTo`; the worker/generator LoopEvent stream
    // doesn't carry a start signal (sub-agents have no compaction toast).
    onContextCompactStart: (detail) => {
      fanOutTo?.onContextCompactStart?.(detail)
    },
    onMaxIterationsReached: (maxIterations) => {
      emit({ type: 'max_iterations', maxIterations })
      fanOutTo?.onMaxIterationsReached?.(maxIterations)
    },
    onQueryLoopPreModel: (info) => {
      emit({ type: 'pre_model', info })
      // Return the fan-out's directive (e.g. a sub-agent worker's graceful
      // wind-down: `disableToolsForThisTurn` + `appendUserContent`) so the
      // shared loop core (`iteration.ts`) honours it on the generator/worker
      // path exactly as the in-process direct-callback path does. When no
      // fan-out is supplied this is `undefined` — unchanged behaviour.
      return fanOutTo?.onQueryLoopPreModel?.(info)
    },
    onQueryLoopStopHook: (info) => {
      emit({ type: 'stop_hook', info })
      fanOutTo?.onQueryLoopStopHook?.(info)
    },
    onStreamingFallback: (info) => {
      emit({ type: 'streaming_fallback', info })
      fanOutTo?.onStreamingFallback?.(info)
    },
  }
}

/**
 * Internal driver used by both {@link runAgenticLoopAsync} (pure
 * generator API) and {@link runAgenticLoop} (legacy fan-out adapter).
 *
 * `fanOutTo`, when supplied, receives every callback in addition to the
 * event channel. Returns a true `AsyncGenerator<LoopEvent, AgenticLoopResult>`.
 *
 * The generator owns the abort lifecycle:
 *   - The caller's `params.signal` is honoured directly by the loop.
 *   - When the consumer calls `.return()` or `.throw()` (i.e. exits a
 *     `for await` early), we abort an *internal* AbortController that's
 *     `AbortSignal.any`-merged with the caller's signal. The loop
 *     observes the abort and finishes with `aborted_streaming` /
 *     `aborted_tools` (depending on which phase it was in).
 */
export function driveLoopAsGenerator(
  params: AgenticLoopParams,
  fanOutTo?: AgenticLoopCallbacks,
): AsyncGenerator<LoopEvent, AgenticLoopResult, undefined> {
  const channel = createInternalChannel()

  // Merge the consumer-side cancellation signal with the caller's signal
  // so consumer .return() reaches the loop. AbortSignal.any was added in
  // Node 20.3 / Electron 27 — both are safely below our support floor.
  const consumerAbort = new AbortController()
  const mergedSignal: AbortSignal =
    typeof (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any === 'function'
      ? (AbortSignal as unknown as { any: (s: AbortSignal[]) => AbortSignal }).any([
          params.signal,
          consumerAbort.signal,
        ])
      : params.signal

  const callbacks = buildEventEmittingCallbacks(channel, fanOutTo)

  // Kick the loop off in the background. We capture all return-path
  // metadata (terminationResult / totalUsage / transition) by mutating
  // a shared `outcome` slot — the existing `runAgenticLoop` already
  // writes these onto its internal LoopState. Since we don't have direct
  // access to that state from here, we wire a synthetic `decideAfterNoToolUse`
  // / hook chain — too invasive. Cleaner: parameterise the loop entry
  // to accept an outcome-collecting wrapper. Done in `setupOutcomeCapture`
  // below.

  let captured: AgenticLoopResult | null = null
  const onTerminate = (result: AgenticLoopResult) => {
    captured = result
  }

  const driverPromise = (async (): Promise<void> => {
    try {
      await runAgenticLoop(
        { ...params, signal: mergedSignal },
        callbacks,
        { onTerminate },
      )
      // The loop finished. If `onTerminate` fired, push the captured
      // result; otherwise synthesise a minimal one (defensive — every
      // production termination path calls onTerminate).
      //
      // P3-2 (2026-07 核心层做深) — the synthesis used to be SILENT, which
      // masks a real driver bug (a termination path that forgot
      // `fireOnTerminate`). Log loudly so the defensive path is visible
      // in triage instead of quietly reporting a fabricated 'completed'.
      if (captured === null) {
        console.error(
          '[agenticLoopAsync] loop resolved without onTerminate firing — ' +
            'synthesising a fallback AgenticLoopResult (reason=completed). ' +
            'This indicates a termination path that skipped fireOnTerminate.',
        )
      }
      const result =
        captured ??
        ({
          terminationResult: {
            reason: 'completed',
            turnCount: 0,
            terminatedAt: Date.now(),
            totalUsage: { inputTokens: 0, outputTokens: 0 },
          },
          totalUsage: { inputTokens: 0, outputTokens: 0 },
          transition: 'init' as LoopTransition,
          transitionHistory: [] as LoopTransition[],
        } satisfies AgenticLoopResult)
      channel.push({ kind: 'done', result })
    } catch (err) {
      channel.push({ kind: 'fail', error: err })
    } finally {
      channel.closed = true
    }
  })()

  // Forward unhandled rejections to the global noise floor; without this
  // an early `.return()` that aborts the loop could surface as
  // UnhandledPromiseRejection in test runners. The actual error already
  // travelled through the channel as `kind: 'fail'`.
  driverPromise.catch(() => undefined)

  // Build the generator we hand to consumers. We *cannot* simply
  // `return gen()` from a normal async-generator function because we
  // need to override the default `.return()` / `.throw()` protocols to
  // abort the background driver. The hand-rolled object below
  // implements `AsyncGenerator` exactly per spec while letting us
  // intercept those calls.

  let returnedValue: AgenticLoopResult | null = null
  let throwError: unknown = null

  const cancelInternal = (): void => {
    if (!consumerAbort.signal.aborted) consumerAbort.abort()
  }

  // Local pending buffer — when next() drains the channel and finds more
  // than one chunk, the remainder lives here until the next `next()`
  // call. Re-pushing into the channel doesn't work because by the time
  // the driver completes (synchronously possible in tests/mocks), the
  // channel is already `closed=true` and `push()` becomes a no-op.
  const pending: Chunk[] = []

  const next = async (): Promise<IteratorResult<LoopEvent, AgenticLoopResult>> => {
    while (true) {
      // First serve from local pending buffer; then drain channel.
      if (pending.length === 0) {
        const drained = channel.drain()
        if (drained.length > 0) pending.push(...drained)
      }

      const c = pending.shift()
      if (c) {
        if (c.kind === 'event') {
          return { value: c.event, done: false }
        }
        if (c.kind === 'done') {
          returnedValue = c.result
          return { value: c.result, done: true }
        }
        // c.kind === 'fail'
        throwError = c.error
        throw c.error
      }

      // Nothing buffered; wait for more or for closure.
      if (channel.closed) {
        // Channel closed without a `done` chunk — shouldn't happen, but
        // synthesise a graceful return if it does (e.g. driver threw
        // before pushing). The driver's `try { await runAgenticLoop } …
        // finally { channel.closed = true }` block ensures `done` or
        // `fail` is pushed before close on every code path; this
        // fallback guards against future regressions.
        //
        // P3-2 (2026-07 核心层做深) — surface the regression instead of
        // silently fabricating a result (only when we truly have nothing:
        // a prior `done` chunk already recorded `returnedValue`).
        if (returnedValue === null) {
          console.error(
            '[agenticLoopAsync] channel closed without a done/fail chunk — ' +
              'returning a synthesised fallback result. Driver contract regression.',
          )
        }
        const fallback: AgenticLoopResult = {
          terminationResult: {
            reason: 'completed',
            turnCount: 0,
            terminatedAt: Date.now(),
            totalUsage: { inputTokens: 0, outputTokens: 0 },
          },
          totalUsage: { inputTokens: 0, outputTokens: 0 },
          transition: 'init' as LoopTransition,
          transitionHistory: [] as LoopTransition[],
        }
        return { value: returnedValue ?? fallback, done: true }
      }
      await channel.wait()
    }
  }

  const returnFn = async (
    val: AgenticLoopResult | PromiseLike<AgenticLoopResult>,
  ): Promise<IteratorResult<LoopEvent, AgenticLoopResult>> => {
    void val // Spec accepts a return value but we always synthesise from the loop outcome.
    cancelInternal()
    // Wait for the driver to actually finish so `.return()` resolution
    // happens AFTER the loop's terminationCleanup ran. Otherwise the
    // consumer would see "done" while side-effects (cleanup callbacks)
    // are still racing.
    await driverPromise.catch(() => undefined)
    if (throwError !== null) {
      // Even on consumer-initiated cancel, if the driver itself failed
      // we surface that instead of swallowing it.
      throw throwError
    }
    const fallback: AgenticLoopResult = {
      terminationResult: {
        reason: 'aborted_streaming',
        turnCount: 0,
        terminatedAt: Date.now(),
        totalUsage: { inputTokens: 0, outputTokens: 0 },
      },
      totalUsage: { inputTokens: 0, outputTokens: 0 },
      transition: 'init' as LoopTransition,
      transitionHistory: [] as LoopTransition[],
    }
    return { value: returnedValue ?? captured ?? fallback, done: true }
  }

  const throwFn = async (
    err?: unknown,
  ): Promise<IteratorResult<LoopEvent, AgenticLoopResult>> => {
    cancelInternal()
    await driverPromise.catch(() => undefined)
    throw err ?? new Error('AgenticLoop generator throw() called without an error')
  }

  // ES2024 Explicit Resource Management — `using gen = …` / `await using`
  // calls this on scope exit. For our loop, "dispose" is just "early
  // return" semantically, so route to the same cancellation path.
  const asyncDispose = async (): Promise<void> => {
    cancelInternal()
    await driverPromise.catch(() => undefined)
  }

  // Spec-compliant AsyncGenerator handle.
  const gen: AsyncGenerator<LoopEvent, AgenticLoopResult, undefined> = {
    next,
    return: returnFn,
    throw: throwFn,
    [Symbol.asyncIterator]() {
      return this
    },
    [Symbol.asyncDispose]: asyncDispose,
  }
  return gen
}

/**
 * Public generator API — preferred entry for new code. Drives the same
 * production loop {@link runAgenticLoop} drives, but exposes a real
 * `AsyncGenerator<LoopEvent, AgenticLoopResult>`.
 *
 * Cancellation: pass `params.signal` to abort *internally* (loop sees the
 * abort and routes to `aborted_streaming` / `aborted_tools` termination);
 * or call `gen.return()` from the consumer side (a `for await` `break`
 * also triggers this) — the merged signal aborts the loop and the
 * generator resolves once cleanup is done.
 */
export function runAgenticLoopAsync(
  params: AgenticLoopParams,
  /**
   * Optional fan-out callbacks. Every loop callback is invoked in addition to
   * the yielded `LoopEvent` stream. The sub-agent worker uses this to run a
   * self-contained read-only budget tracker whose `onQueryLoopPreModel` returns
   * the graceful wind-down directive (forced tool-free report turn) — letting a
   * worker-dispatched Explore/Plan/Verification agent finish cleanly with
   * `success: true` instead of being hard-aborted at the budget ceiling.
   */
  fanOutTo?: AgenticLoopCallbacks,
): AsyncGenerator<LoopEvent, AgenticLoopResult, undefined> {
  return driveLoopAsGenerator(params, fanOutTo)
}

/**
 * Dispatch a single {@link LoopEvent} to the matching {@link AgenticLoopCallbacks}
 * field. Supplied as a public helper so external consumers can choose to
 * write code against the generator API and still bridge to legacy
 * callback-shaped APIs (e.g. an IPC stream consumer that writes its own
 * fan-out logic).
 *
 * Mirrors the dispatch table inside {@link buildEventEmittingCallbacks};
 * the two are kept literal — adding a new event type requires updating
 * both, and the test suite asserts every callback method has at least
 * one corresponding event so the table stays in sync.
 */
export function dispatchEventToCallbacks(
  event: LoopEvent,
  callbacks: AgenticLoopCallbacks,
): void {
  switch (event.type) {
    case 'text_delta':
      callbacks.onTextDelta(event.text)
      return
    case 'thinking_delta':
      callbacks.onThinkingDelta?.(event.text)
      return
    case 'thinking_block':
      callbacks.onThinkingBlock?.(event.block)
      return
    case 'reasoning_summary_delta':
      callbacks.onReasoningSummaryDelta?.(event.text)
      return
    case 'reasoning_summary_block':
      callbacks.onReasoningSummaryBlock?.(event.block)
      return
    case 'tool_start':
      callbacks.onToolStart(event.toolUse)
      return
    case 'tool_input_delta':
      callbacks.onToolInputDelta?.({
        toolUseId: event.toolUseId,
        toolName: event.toolName,
        partialJson: event.partialJson,
      })
      return
    case 'tool_result':
      callbacks.onToolResult(event.toolResult)
      return
    case 'message_end':
      callbacks.onMessageEnd(event.usage)
      return
    case 'error':
      callbacks.onError(event.error)
      return
    case 'context_compact':
      callbacks.onContextCompact?.({
        level: event.level,
        preTokens: event.preTokens,
        postTokens: event.postTokens,
        reclaimedTokens: event.reclaimedTokens,
      })
      return
    case 'max_iterations':
      callbacks.onMaxIterationsReached?.(event.maxIterations)
      return
    case 'pre_model':
      callbacks.onQueryLoopPreModel?.(event.info)
      return
    case 'stop_hook':
      callbacks.onQueryLoopStopHook?.(event.info)
      return
    case 'streaming_fallback':
      callbacks.onStreamingFallback?.(event.info)
      return
    default: {
      // Exhaustiveness check — the union member list above must cover
      // every LoopEvent variant. If the union is extended, TS will fail
      // here forcing the dispatch table to be updated.
      const _exhaustive: never = event
      void _exhaustive
    }
  }
}
