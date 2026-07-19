/**
 * P2 — Final withheld-signal promotion (extracted from `stream.ts`).
 *
 * After all recovery paths (max-output recovery, reactive compact,
 * strip-retry, overload fallback) have run, this step decides what to
 * do with any `state.withheldStreamSignal` that survived:
 *
 *   - If the stream produced ANY content (text / tools / thinking),
 *     the recovery was successful and the withheld signal is benign —
 *     log it for the appendix trail, then clear both withhold slots.
 *   - If nothing was produced AND the signal kind maps to a terminal
 *     `TerminationReason` (most stream:* kinds → `model_error`), emit
 *     `onError` + write `state.terminationResult` + run cleanup.
 *     The caller's stream output then carries `useStreamingToolExecutor:
 *     false` so the iteration body knows to short-circuit the tool
 *     batch.
 *
 * P0.2 — refusal soft-recovery routes through this same gate. When
 * `stop_reason === 'refusal'` is set inside the streamPass closure,
 * `onMessageEnd` synthesises a `stream:refusal` envelope and lets the
 * promotion path decide based on whether the model produced content.
 *
 * Phase 3 (upstream alignment): kind-driven classification replaces the
 * `classifyStreamError(string)` regex. The envelope is populated at
 * the provider catch boundary (Phase 2 via `onLoopSignal`), so by the
 * time we get here the classification is already typed.
 *
 * upstream reference: `src/query.ts` end-of-stream `withheldByCollapse` /
 * `withheldByReactive` handling (~line 1000-1090). Pole's `withheldStream*`
 * slots are the typed-envelope equivalent.
 */

import type { LoopState } from '../loopShared'
import { loopSignalToTerminationReason } from '../../loopSignal'
import { createTerminalResult, runTerminationCleanup } from '../../queryTermination'

/**
 * Helper input: the runStreamPhase locals that the post-promotion return
 * needs to weave into the final StreamOutput shape. Keeping this
 * explicit (vs. reaching into state) so the caller can pass test doubles.
 */
export interface WithheldPromotionContext {
  iteration: number
  iterationModel: string
  streamMaxOutTokens: number
  maxOutputRecoveryCycles: number
  /** Last-result snapshot used to compute `producedSomething`. */
  resultProducedSomething: boolean
}

/**
 * Outcome union — caller switches on `.kind`:
 *   - `terminated` — emit a terminal stream output (signal promoted).
 *   - `recovered` — withheld signal was discarded as benign; caller
 *     continues with the existing result. (No state change requested
 *     beyond what `applyRecoveredCleanup` already wrote.)
 *   - `noop` — no withheld signal observed; caller continues.
 */
export type WithheldPromotionOutcome =
  | { kind: 'terminated'; errorMessage: string; reason: ReturnType<typeof loopSignalToTerminationReason> }
  | { kind: 'recovered' }
  | { kind: 'noop' }

/**
 * Inspect `state.withheldStreamSignal` after the stream recovery layers
 * have run, and decide whether to:
 *   - emit a terminal signal (no content produced, classifiable kind);
 *   - clear the withhold slots as a recovered transient (content produced);
 *   - leave everything as-is (no signal observed).
 *
 * On `terminated`, the function:
 *   - calls `state.callbacks.onError` with the carrier message;
 *   - calls `state.callbacks.onMessageEnd` with current usage;
 *   - writes `state.terminationResult`;
 *   - runs `runTerminationCleanup`.
 * Caller is responsible for returning a terminal StreamOutput shape.
 *
 * On `recovered`, the function:
 *   - logs to console.warn + appendixReport;
 *   - clears `state.withheldStreamError` and `state.withheldStreamSignal`.
 *
 * Pure-ish — the only mutations are on state fields and the registered
 * cleanup hooks. The rest is reads.
 */
export async function promoteOrRecoverWithheldSignal(
  state: LoopState,
  ctx: WithheldPromotionContext,
): Promise<WithheldPromotionOutcome> {
  const withheldSignal = state.withheldStreamSignal
  if (
    withheldSignal &&
    !ctx.resultProducedSomething &&
    !state.signal.aborted
  ) {
    const reason = loopSignalToTerminationReason(withheldSignal.kind)
    if (reason !== null) {
      const errMsg =
        state.withheldStreamError ?? withheldSignal.rawMessage ?? 'Stream error'
      state.callbacks.onError(errMsg)
      state.callbacks.onMessageEnd(state.totalUsage)
      state.terminationResult = createTerminalResult(reason, {
        turnCount: ctx.iteration,
        totalUsage: state.totalUsage,
        errorDetail: errMsg,
      })
      await runTerminationCleanup(state.terminationResult)
      return { kind: 'terminated', errorMessage: errMsg, reason }
    }
  }

  // A4 — when the stream produced output, any earlier withheld error
  // was self-recovered (e.g. transient overload before fallback) and is
  // safely discardable. We still log + report it before clearing so
  // operators investigating sporadic mid-stream failures have a paper
  // trail (the previous behaviour silently zeroed `withheldStreamError`
  // and the only evidence was a passing iteration). Truncated to keep
  // appendix-A payloads bounded.
  //
  // Phase 3: also clear the typed envelope slot. If the string carrier
  // was absent (PTL ref-set path), use the envelope's rawMessage for
  // the log line so we don't silently swallow the recovery event.
  if (
    ctx.resultProducedSomething &&
    (state.withheldStreamError || state.withheldStreamSignal)
  ) {
    const recovered =
      state.withheldStreamError ?? state.withheldStreamSignal?.rawMessage ?? ''
    const preview =
      recovered.length > 500 ? `${recovered.slice(0, 500)}…` : recovered
    console.warn(
      `[Agentic Loop] withheld stream error self-recovered (iteration ${ctx.iteration}, model=${ctx.iterationModel}): ${preview}`,
    )
    state.appendixReport('P2_Q_stream_complete', {
      iteration: ctx.iteration,
      withheldStreamErrorRecovered: true,
      withheldStreamErrorPreview: preview,
    })
    state.withheldStreamError = null
    state.withheldStreamSignal = null
    return { kind: 'recovered' }
  }

  return { kind: 'noop' }
}
