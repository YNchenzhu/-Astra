/**
 * P2 — Anthropic overload (HTTP 529) → fallback-model retry decision.
 *
 * Extracted from `stream.ts` (was inline in `runStreamPhase`). Pure
 * function so the retry-loop invariants (bounded attempts, no fallback-
 * equals-current loop) are unit-testable without spinning up the full
 * stream pipeline.
 *
 * Two terminal conditions:
 *   1. The provider-suggested fallback model is the SAME as the
 *      currently-running model — a misconfigured
 *      `POLE_ANTHROPIC_OVERLOAD_FALLBACK_MODEL` env that would otherwise
 *      busy-loop on the same overloaded backend.
 *   2. We've already attempted N fallbacks this turn and the cap is
 *      reached.
 *
 * upstream parity: their `services/api/withRetry.ts#FallbackTriggeredError`
 * + the per-turn fallback count in `query.ts` L897-942. We carry the
 * same single-shot cap (3) so a regional outage doesn't burn through
 * unbounded requests.
 */

export type OverloadRetryDecision =
  | { kind: 'switch'; nextModel: string }
  | { kind: 'break'; reason: 'fallback_equals_current' | 'attempts_exhausted' }

export function decideOverloadRetry(input: {
  currentModel: string
  proposedFallbackModel: string
  /** Number of fallbacks already taken on this turn. */
  priorAttempts: number
  maxAttempts: number
}): OverloadRetryDecision {
  if (input.proposedFallbackModel === input.currentModel) {
    return { kind: 'break', reason: 'fallback_equals_current' }
  }
  if (input.priorAttempts + 1 >= input.maxAttempts) {
    return { kind: 'break', reason: 'attempts_exhausted' }
  }
  return { kind: 'switch', nextModel: input.proposedFallbackModel }
}

/** Per-turn cap on overload→fallback rounds. upstream-aligned. */
export const MAX_OVERLOAD_FALLBACK_ATTEMPTS = 3
