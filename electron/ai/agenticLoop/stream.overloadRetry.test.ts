/**
 * P2 audit fix regression — overload fallback retry must be bounded.
 *
 * Background: `runStreamWithRetry` in `stream.ts` used to run
 * `for (;;)` with no upper bound on the number of overload→fallback
 * rounds per turn. Two real configurations caused it to busy-loop:
 *
 *   1. `POLE_ANTHROPIC_OVERLOAD_FALLBACK_MODEL` set to a SKU in the
 *      same overloaded family — the provider returned 529 on every
 *      attempt and the loop never made progress.
 *   2. Regional outage where every model in the rotation returned 529.
 *
 * `decideOverloadRetry` is the pure decision rule extracted from the
 * loop body so the bounding invariants are testable without spinning
 * up the full provider / streamPass machinery.
 */

import { describe, expect, it } from 'vitest'
import { decideOverloadRetry } from './stream'

describe('decideOverloadRetry (P2 audit — overload fallback bounding)', () => {
  it('switches when the proposed fallback differs and attempts < max', () => {
    const d = decideOverloadRetry({
      currentModel: 'claude-opus',
      proposedFallbackModel: 'claude-sonnet',
      priorAttempts: 0,
      maxAttempts: 3,
    })
    expect(d).toEqual({ kind: 'switch', nextModel: 'claude-sonnet' })
  })

  it('breaks with "fallback_equals_current" when proposed == current (env misconfig)', () => {
    // Regression: previously the loop accepted this and continued, hammering
    // the same overloaded backend ad infinitum.
    const d = decideOverloadRetry({
      currentModel: 'claude-opus',
      proposedFallbackModel: 'claude-opus',
      priorAttempts: 0,
      maxAttempts: 3,
    })
    expect(d).toEqual({ kind: 'break', reason: 'fallback_equals_current' })
  })

  it('breaks with "fallback_equals_current" before checking the attempt cap (priority)', () => {
    // Both conditions true — equality wins because it's the cheaper / more
    // informative diagnostic. A misconfigured env should NOT look like an
    // exhausted retry budget.
    const d = decideOverloadRetry({
      currentModel: 'm1',
      proposedFallbackModel: 'm1',
      priorAttempts: 99,
      maxAttempts: 3,
    })
    expect(d).toEqual({ kind: 'break', reason: 'fallback_equals_current' })
  })

  it('breaks with "attempts_exhausted" once the next attempt would reach maxAttempts', () => {
    // priorAttempts=2 → about to become 3 → at the cap (maxAttempts=3)
    const d = decideOverloadRetry({
      currentModel: 'a',
      proposedFallbackModel: 'b',
      priorAttempts: 2,
      maxAttempts: 3,
    })
    expect(d).toEqual({ kind: 'break', reason: 'attempts_exhausted' })
  })

  it('switches until exactly priorAttempts === maxAttempts - 1', () => {
    // priorAttempts=1, max=3 → next attempt becomes 2, which is < 3, allow.
    const ok = decideOverloadRetry({
      currentModel: 'a',
      proposedFallbackModel: 'b',
      priorAttempts: 1,
      maxAttempts: 3,
    })
    expect(ok.kind).toBe('switch')

    // priorAttempts=2 → next becomes 3 (== max), deny.
    const deny = decideOverloadRetry({
      currentModel: 'a',
      proposedFallbackModel: 'b',
      priorAttempts: 2,
      maxAttempts: 3,
    })
    expect(deny.kind).toBe('break')
  })

  it('respects custom max (e.g. 1 → no fallbacks allowed)', () => {
    const d = decideOverloadRetry({
      currentModel: 'a',
      proposedFallbackModel: 'b',
      priorAttempts: 0,
      maxAttempts: 1,
    })
    expect(d).toEqual({ kind: 'break', reason: 'attempts_exhausted' })
  })

  it('handles maxAttempts=0 as "no retries allowed" (deny immediately)', () => {
    const d = decideOverloadRetry({
      currentModel: 'a',
      proposedFallbackModel: 'b',
      priorAttempts: 0,
      maxAttempts: 0,
    })
    expect(d.kind).toBe('break')
  })
})
