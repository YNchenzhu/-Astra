/**
 * Provider-side helper: classify a catch'd error, emit it via the typed
 * {@link StreamCallbacks.onLoopSignal} envelope channel, and mirror the
 * verdict to the legacy {@link StreamTextParams.contextLengthExceededRef}
 * boolean so the stream phase's reactive-compact branch keeps working.
 *
 * Phase 4 (upstream alignment, regex-guard removal):
 *   - This helper REPLACES the old `markContextLengthExceededIfSo` (from
 *     the now-deleted `contextLengthError.ts`). Each provider catch
 *     block previously did:
 *       emitProviderErrorSignal(error, 'anthropic', callbacks)
 *       if (markContextLengthExceededIfSo(error, params.contextLengthExceededRef)) return
 *     which double-classified the same error — once via the typed
 *     {@link classifyProviderError} (envelope) and once via the regex
 *     `messageIndicatesContextLength`. After Phase 4 the envelope is the
 *     single source of truth: `signal.kind === 'stream:prompt_too_long'`
 *     drives BOTH the ref mirror AND any consumer wired to `onLoopSignal`.
 *
 * Two consumers of the verdict:
 *   1. Returned `isPromptTooLong` boolean — providers use it to
 *      `return` early out of the catch (PTL is handled by the loop's
 *      reactive-compact block via the ref; no `onError` should fire).
 *   2. `contextLengthExceededRef.value` — set to `true` when PTL so
 *      `runStreamPhase` sees `result.contextLengthExceeded === true`
 *      and enters reactive compact. This wire is identical to the
 *      pre-Phase-4 behaviour; only the **producer** changed (envelope
 *      kind instead of regex on the error message).
 *
 * upstream equivalent: their `getAssistantMessageFromError` builds a
 * typed `AssistantMessage` with `apiError` enum + `errorDetails`; the
 * loop reads `msg.apiError === 'invalid_request' && isPromptTooLongMessage(msg)`
 * to decide PTL. We carry the equivalent typed verdict on the
 * `LoopSignal` envelope and let the loop read `kind === 'stream:prompt_too_long'`.
 */

import type { StreamCallbacks } from './client'
import { classifyProviderError, type LoopSignal, type LoopSignalProvider } from './loopSignal'

export interface EmitProviderErrorSignalResult {
  /** The typed envelope. Always present — `classifyProviderError` never returns null. */
  signal: LoopSignal
  /**
   * Convenience flag mirroring `signal.kind === 'stream:prompt_too_long'`.
   * Providers use this to decide whether to `return` early (the loop's
   * reactive-compact block consumes the ref-set flag separately).
   */
  isPromptTooLong: boolean
}

/**
 * Classify an error at the provider catch boundary, emit the resulting
 * envelope via {@link StreamCallbacks.onLoopSignal}, and mirror the
 * verdict to the legacy `contextLengthExceededRef`.
 *
 * Producer contract:
 *   - Call ONCE at the top of the catch block, after the no-op
 *     `isAbortLikeError(error)` short-circuit (the loop owns the abort
 *     path via `state.signal.aborted`).
 *   - Pass `contextLengthExceededRef` when the call site is the main
 *     stream catch (so PTL drives reactive compact). For ancillary
 *     emit sites (watchdog idle abort, fatalCheck HTTP non-throw)
 *     pass `undefined` — those paths don't participate in the
 *     reactive-compact handshake.
 *   - Use the returned `isPromptTooLong` to decide early return: PTL is
 *     handled by the loop, NOT by `callbacks.onError`.
 *
 * Consumer-thrown exceptions inside `onLoopSignal` are swallowed and
 * logged — a misbehaving consumer must never influence the provider's
 * existing error-handling flow.
 */
export function emitProviderErrorSignal(
  error: unknown,
  provider: LoopSignalProvider,
  callbacks: StreamCallbacks,
  contextLengthExceededRef?: { value: boolean },
): EmitProviderErrorSignalResult {
  const signal = classifyProviderError(error, provider)
  try {
    callbacks.onLoopSignal?.(signal)
  } catch (cbErr) {
    console.warn('[loopSignalEmit] onLoopSignal consumer threw:', cbErr)
  }
  const isPromptTooLong = signal.kind === 'stream:prompt_too_long'
  if (isPromptTooLong && contextLengthExceededRef) {
    contextLengthExceededRef.value = true
  }
  return { signal, isPromptTooLong }
}
