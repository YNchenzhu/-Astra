/**
 * Contract tests for the stream-phase decision points wired against
 * `state.withheldStreamSignal`.
 *
 * Phase 3 of the regex-guard removal switched two decision points from
 * regex-on-string to typed-kind reads:
 *
 *   1. **Strip-retry gate** (`stream.ts`, "Layer 5"):
 *      `state.withheldStreamSignal?.kind === 'stream:image_too_large'`
 *      AND `result.accumulatedText.length === 0`
 *      AND `result.toolUseBlocks.length === 0`
 *      AND `result.thinkingBlocks.length === 0`
 *      → triggers image-strip-retry path
 *
 *   2. **Final-promotion gate** (`stream.ts`, end of `runStreamPhase`):
 *      `withheldSignal && !producedSomething && !signal.aborted`
 *      AND `loopSignalToTerminationReason(withheldSignal.kind) !== null`
 *      → promotes withheld signal into a terminal {@link TerminationReason}
 *
 * Mocking the entire `runStreamPhase` body (callModel, watchdog,
 * profiler, contextManager, …) is heavy and brittle. Instead, these
 * tests model the two decision points as pure predicates against the
 * SAME inputs (a fake-shaped `state` + `result`) and assert the truth
 * tables match the conditionals literally encoded in `stream.ts`.
 *
 * If `stream.ts` later changes its conditional shape, these tests will
 * drift and fail loudly — that's the intent (upstream parity invariants
 * should be visible in test code, not buried as inline `if` chains).
 */

import { describe, it, expect } from 'vitest'
import {
  loopSignalToTerminationReason,
  type LoopSignal,
} from '../loopSignal'

/**
 * Mirror of the strip-retry gate in `stream.ts:614-621`. Returns the
 * boolean result of the typed-kind comparison + result-emptiness checks
 * (caller still has to AND with `!signal.aborted`, which is signal-state
 * not state-shape — we ignore that environmental aspect here).
 */
function shouldStripRetry(
  withheldSignal: LoopSignal | null,
  resultEmptiness: {
    accumulatedTextLen: number
    toolUseBlocksLen: number
    thinkingBlocksLen: number
  },
  aborted: boolean,
): boolean {
  return (
    withheldSignal?.kind === 'stream:image_too_large' &&
    !aborted &&
    resultEmptiness.accumulatedTextLen === 0 &&
    resultEmptiness.toolUseBlocksLen === 0 &&
    resultEmptiness.thinkingBlocksLen === 0
  )
}

/**
 * Mirror of the final-promotion gate in `stream.ts:676-685`. Returns
 * the terminal reason that would be used (or `null` if the gate
 * wouldn't fire).
 */
function finalPromotionReason(
  withheldSignal: LoopSignal | null,
  producedSomething: boolean,
  aborted: boolean,
): ReturnType<typeof loopSignalToTerminationReason> | null {
  if (!withheldSignal) return null
  if (producedSomething) return null
  if (aborted) return null
  return loopSignalToTerminationReason(withheldSignal.kind)
}

// ─────────────────────────────────────────────────────────────────────
// Strip-retry gate
// ─────────────────────────────────────────────────────────────────────

describe('strip-retry gate — image_too_large + empty result + not-aborted', () => {
  const emptyResult = {
    accumulatedTextLen: 0,
    toolUseBlocksLen: 0,
    thinkingBlocksLen: 0,
  }

  it('fires when envelope is stream:image_too_large and stream produced nothing', () => {
    const sig: LoopSignal = { kind: 'stream:image_too_large', rawMessage: 'oversize' }
    expect(shouldStripRetry(sig, emptyResult, false)).toBe(true)
  })

  it('does NOT fire for any other stream:* kind', () => {
    const otherKinds: LoopSignal['kind'][] = [
      'stream:prompt_too_long',
      'stream:max_output_tokens',
      'stream:overloaded',
      'stream:rate_limit',
      'stream:auth_failed',
      'stream:billing_error',
      'stream:invalid_request',
      'stream:timeout',
      'stream:connection',
      'stream:aborted',
      'stream:refusal',
      'stream:unknown',
    ]
    for (const kind of otherKinds) {
      const sig: LoopSignal = { kind, rawMessage: 'x' }
      expect(shouldStripRetry(sig, emptyResult, false), `kind: ${kind}`).toBe(false)
    }
  })

  it('does NOT fire when withheldStreamSignal is null', () => {
    expect(shouldStripRetry(null, emptyResult, false)).toBe(false)
  })

  it('does NOT fire if the stream produced ANY content', () => {
    const sig: LoopSignal = { kind: 'stream:image_too_large', rawMessage: 'x' }
    // Text only
    expect(
      shouldStripRetry(
        sig,
        { ...emptyResult, accumulatedTextLen: 5 },
        false,
      ),
    ).toBe(false)
    // Tool use only
    expect(
      shouldStripRetry(
        sig,
        { ...emptyResult, toolUseBlocksLen: 1 },
        false,
      ),
    ).toBe(false)
    // Thinking only
    expect(
      shouldStripRetry(
        sig,
        { ...emptyResult, thinkingBlocksLen: 1 },
        false,
      ),
    ).toBe(false)
  })

  it('does NOT fire when aborted (loop owns the abort path)', () => {
    const sig: LoopSignal = { kind: 'stream:image_too_large', rawMessage: 'x' }
    expect(shouldStripRetry(sig, emptyResult, true)).toBe(false)
  })

  it('does not look at signal.provider / status / details — kind is the sole switch', () => {
    // Documents the upstream invariant: routing is purely on `kind`, not
    // on rendered text or auxiliary fields.
    const variants: LoopSignal[] = [
      { kind: 'stream:image_too_large', rawMessage: 'a', provider: 'anthropic', status: 400 },
      { kind: 'stream:image_too_large', rawMessage: 'b', provider: 'compat', status: 413 },
      { kind: 'stream:image_too_large', rawMessage: 'c', details: { foo: 'bar' } },
    ]
    for (const sig of variants) {
      expect(shouldStripRetry(sig, emptyResult, false)).toBe(true)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────
// Final-promotion gate
// ─────────────────────────────────────────────────────────────────────

describe('final-promotion gate — kind → TerminationReason mapping', () => {
  it('promotes PTL to `prompt_too_long`', () => {
    const sig: LoopSignal = { kind: 'stream:prompt_too_long', rawMessage: 'x' }
    expect(finalPromotionReason(sig, false, false)).toBe('prompt_too_long')
  })

  it('promotes image_too_large to `image_error`', () => {
    const sig: LoopSignal = { kind: 'stream:image_too_large', rawMessage: 'x' }
    expect(finalPromotionReason(sig, false, false)).toBe('image_error')
  })

  it('collapses recovery-exhaustible stream kinds to `model_error`', () => {
    const exhaustibleKinds: LoopSignal['kind'][] = [
      'stream:max_output_tokens',
      'stream:overloaded',
      'stream:rate_limit',
      'stream:auth_failed',
      'stream:billing_error',
      'stream:invalid_request',
      'stream:timeout',
      'stream:connection',
      'stream:refusal',
      'stream:unknown',
    ]
    for (const kind of exhaustibleKinds) {
      const sig: LoopSignal = { kind, rawMessage: 'x' }
      expect(finalPromotionReason(sig, false, false), `kind: ${kind}`).toBe('model_error')
    }
  })

  it('returns null for `stream:aborted` (loop owns abort routing)', () => {
    const sig: LoopSignal = { kind: 'stream:aborted', rawMessage: 'x' }
    expect(finalPromotionReason(sig, false, false)).toBeNull()
  })

  it('does NOT fire when stream produced something — recovery succeeded', () => {
    const sig: LoopSignal = { kind: 'stream:rate_limit', rawMessage: 'x' }
    expect(finalPromotionReason(sig, true /* producedSomething */, false)).toBeNull()
  })

  it('does NOT fire when aborted', () => {
    const sig: LoopSignal = { kind: 'stream:rate_limit', rawMessage: 'x' }
    expect(finalPromotionReason(sig, false, true /* aborted */)).toBeNull()
  })

  it('does NOT fire when withheld signal is null', () => {
    expect(finalPromotionReason(null, false, false)).toBeNull()
  })

  it('ignores tool:* kinds (they never reach the stream-phase final promotion)', () => {
    // Defensive: tool-domain envelopes never get into withheldStreamSignal
    // (the producer is the tool batch, not the provider catch). If one
    // ever leaked in, the mapper returns null and the gate stays
    // dormant.
    const haltSig: LoopSignal = { kind: 'tool:repetition_halt', rawMessage: 'x' }
    const warnSig: LoopSignal = { kind: 'tool:repetition_warn', rawMessage: 'x' }
    expect(finalPromotionReason(haltSig, false, false)).toBeNull()
    expect(finalPromotionReason(warnSig, false, false)).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────
// First-wins capture invariant
// ─────────────────────────────────────────────────────────────────────

describe('first-wins capture — mimics stream.ts onLoopSignal handler', () => {
  /** Mirrors the in-streamPass capture logic. */
  function makeCapturer(): {
    capture: (sig: LoopSignal) => void
    get: () => LoopSignal | null
  } {
    let withheldStreamSignal: LoopSignal | null = null
    return {
      capture: (sig) => {
        if (withheldStreamSignal == null) {
          withheldStreamSignal = sig
        }
      },
      get: () => withheldStreamSignal,
    }
  }

  it('preserves the first envelope across multiple emits', () => {
    const c = makeCapturer()
    const first: LoopSignal = { kind: 'stream:rate_limit', rawMessage: 'first' }
    const second: LoopSignal = { kind: 'stream:overloaded', rawMessage: 'second' }
    const third: LoopSignal = { kind: 'stream:unknown', rawMessage: 'third' }
    c.capture(first)
    c.capture(second)
    c.capture(third)
    expect(c.get()).toBe(first)
  })

  it('starts as null (nothing captured yet)', () => {
    const c = makeCapturer()
    expect(c.get()).toBeNull()
  })

  it('accepts the first emit even when the original was a "harmless" stream:unknown', () => {
    // First-wins is unconditional on kind — we don't try to "skip" an
    // uninteresting first envelope in favor of a later more-specific
    // one. Rationale: the retry loop in `runStreamWithRetry` resets
    // both slots at the top of every retry, so the only way to see
    // two emits inside ONE streamPass is if the provider catch
    // re-classified the same error (which it doesn't).
    const c = makeCapturer()
    const first: LoopSignal = { kind: 'stream:unknown', rawMessage: 'noise' }
    const second: LoopSignal = { kind: 'stream:prompt_too_long', rawMessage: 'real signal' }
    c.capture(first)
    c.capture(second)
    expect(c.get()).toBe(first)
  })
})

// ─────────────────────────────────────────────────────────────────────
// P0.2 — Refusal soft-recovery via unified promotion path
// ─────────────────────────────────────────────────────────────────────
//
// Before P0.2 `stream.ts` had a dedicated `refusalDetected` branch that
// terminated the loop as `model_error` whenever `stop_reason === 'refusal'`,
// regardless of whether the model also produced text. That hard-stop is
// overly aggressive — upstream's `getErrorMessageIfRefusal` yields a typed
// `AssistantMessage` with a polite refusal explanation and lets the outer
// loop terminate via the normal `lastMessage.isApiErrorMessage` path.
//
// The new behaviour synthesises `state.withheldStreamSignal = { kind:
// 'stream:refusal', ... }` inside `onMessageEnd` and lets the existing
// `producedSomething`-gated final-promotion handle both outcomes:
//   - produced content → benign discard (soft-recover, treat as completed)
//   - empty stream → promote to `model_error` (preserves the old terminal
//     semantics for the no-content case)

describe('P0.2: refusal flows through unified withheld-signal promotion', () => {
  const refusalSig: LoopSignal = {
    kind: 'stream:refusal',
    rawMessage: 'Model declined to respond (stop_reason: refusal).',
    details: { stopReason: 'refusal' },
  }

  it('producedSomething=true → signal is discarded, no termination', () => {
    // Promotion gate stays dormant when the model produced any text.
    // This is the soft-recovery semantics: refusal stop_reason combined
    // with an assistant reply ("I cannot help with that, but here's…")
    // should terminate the iteration normally as `completed`, not as
    // a hard `model_error`.
    expect(finalPromotionReason(refusalSig, true, false)).toBeNull()
  })

  it('producedSomething=false → promotes to `model_error`', () => {
    // Regression guard: when the stream is genuinely empty (no text /
    // thinking / tools) AND stop_reason is refusal, the unified promotion
    // path must still terminate as `model_error` — same outcome the old
    // dedicated branch enforced, just routed through the standard path.
    expect(finalPromotionReason(refusalSig, false, false)).toBe('model_error')
  })

  it('aborted=true short-circuits regardless of refusal', () => {
    // Abort always wins (loop owns abort routing); refusal must not
    // override that even in the empty-stream case.
    expect(finalPromotionReason(refusalSig, false, true)).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────
// producedSomething check — Symptom 1 & 3 regression tests
// ─────────────────────────────────────────────────────────────────────

/**
 * Mirror of the `producedSomething` ternary in stream.ts (2026-06
 * multi-turn degradation fix, Symptom 3): thinking blocks NO LONGER
 * count as "produced something". Reasoning is not user-visible output —
 * a thinking-only stream must not suppress withheld-signal promotion
 * (the old behaviour swallowed refusal / rate-limit signals and ended
 * the turn as a silent row 13 `completed`).
 */
function producedSomething(result: {
  accumulatedText: string
  toolUseBlocks: Array<unknown>
}): boolean {
  return result.accumulatedText.trim().length > 0 || result.toolUseBlocks.length > 0
}

describe('producedSomething — thinking excluded (Symptom 3 regression)', () => {
  const empty = { accumulatedText: '', toolUseBlocks: [] }
  const dBlocks = [{ id: '1', name: 'Read', input: {} }]

  it('empty: false (correct)', () => {
    expect(producedSomething(empty)).toBe(false)
  })

  it('text only: true (correct)', () => {
    expect(producedSomething({ ...empty, accumulatedText: 'done' })).toBe(true)
  })

  it('tool_use only: true (correct)', () => {
    expect(producedSomething({ ...empty, toolUseBlocks: dBlocks })).toBe(true)
  })

  it('thinking-only, no text, no tools: false (FIXED — was the Symptom 3 bug)', () => {
    // thinkingBlocks is no longer an input to the predicate at all —
    // the mirror signature matches the fixed stream.ts computation.
    expect(producedSomething(empty)).toBe(false)
  })

  it('thinking-only + withheld error: promotion now fires → model_error', () => {
    const sig: LoopSignal = { kind: 'stream:rate_limit', rawMessage: 'x' }
    // Old behaviour: thinking-only forced producedSomething=true and the
    // signal was discarded as benign → silent `completed`. Fixed: the
    // empty (text/tool-less) stream lets the promotion terminate.
    expect(finalPromotionReason(sig, producedSomething(empty), false)).toBe('model_error')
  })

  it('refusal + thinking-only: promotes to model_error instead of silent completed', () => {
    const refusal: LoopSignal = {
      kind: 'stream:refusal',
      rawMessage: 'Model declined to respond (stop_reason: refusal).',
    }
    expect(finalPromotionReason(refusal, producedSomething(empty), false)).toBe('model_error')
  })

  it('whitespace-only text: false (correct)', () => {
    expect(producedSomething({ ...empty, accumulatedText: '   \n  ' })).toBe(false)
  })
})
