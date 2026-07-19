/**
 * Adaptive thinking budget (#14, 2026-07 deep-loop uplift) tests.
 *
 * Contract under test: throttle-only (never exceeds base), full budget on
 * planning / post-failure iterations, routine reduction from iteration 3,
 * no-base sessions get a bounded routine budget instead of the provider's
 * 32k fallback, env kill-switch and tunables.
 */

import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_ROUTINE_TOKENS_WITHOUT_BASE,
  MIN_ADAPTIVE_THINKING_TOKENS,
  resolveAdaptiveThinkingBudget,
  type AdaptiveThinkingSignals,
} from './adaptiveThinkingBudget'

const base = (over?: Partial<AdaptiveThinkingSignals>): AdaptiveThinkingSignals => ({
  iteration: 5,
  alwaysThinking: true,
  baseBudgetTokens: 8192,
  lastToolBatchAllErrors: false,
  ...over,
})

afterEach(() => {
  delete process.env.POLE_ADAPTIVE_THINKING
  delete process.env.POLE_ADAPTIVE_THINKING_ROUTINE_FACTOR
  delete process.env.POLE_ADAPTIVE_THINKING_ROUTINE_MIN_ITERATION
  delete process.env.POLE_ADAPTIVE_THINKING_ROUTINE_TOKENS
})

describe('resolveAdaptiveThinkingBudget', () => {
  it('keeps the full base budget on the first iteration (planning phase)', () => {
    expect(resolveAdaptiveThinkingBudget(base({ iteration: 1 }))).toBe(8192)
  })

  it('keeps the full base budget right after an all-errors tool batch', () => {
    expect(
      resolveAdaptiveThinkingBudget(base({ lastToolBatchAllErrors: true })),
    ).toBe(8192)
  })

  it('throttles routine iterations to base × factor (default 0.75)', () => {
    expect(resolveAdaptiveThinkingBudget(base({ iteration: 3 }))).toBe(6144)
    expect(resolveAdaptiveThinkingBudget(base({ iteration: 12 }))).toBe(6144)
  })

  it('iteration 2 keeps the base (routine throttle starts at 3 by default)', () => {
    expect(resolveAdaptiveThinkingBudget(base({ iteration: 2 }))).toBe(8192)
  })

  it('floors the throttled budget at the Anthropic minimum', () => {
    // 1200 × 0.75 = 900 < 1024 → floored.
    expect(
      resolveAdaptiveThinkingBudget(base({ baseBudgetTokens: 1200 })),
    ).toBe(MIN_ADAPTIVE_THINKING_TOKENS)
  })

  it('never exceeds the base budget under any signal combination', () => {
    for (const iteration of [1, 2, 3, 8]) {
      for (const lastToolBatchAllErrors of [true, false]) {
        const out = resolveAdaptiveThinkingBudget(
          base({ iteration, lastToolBatchAllErrors }),
        )
        expect(out).toBeLessThanOrEqual(8192)
      }
    }
  })

  it('no-base routine iterations get the bounded default instead of undefined', () => {
    expect(
      resolveAdaptiveThinkingBudget(base({ baseBudgetTokens: undefined })),
    ).toBe(DEFAULT_ROUTINE_TOKENS_WITHOUT_BASE)
  })

  it('no-base planning iteration stays undefined (provider fallback applies)', () => {
    expect(
      resolveAdaptiveThinkingBudget(
        base({ baseBudgetTokens: undefined, iteration: 1 }),
      ),
    ).toBeUndefined()
  })

  it('passes the base through untouched when thinking is off', () => {
    expect(
      resolveAdaptiveThinkingBudget(base({ alwaysThinking: false })),
    ).toBe(8192)
    expect(
      resolveAdaptiveThinkingBudget(
        base({ alwaysThinking: false, baseBudgetTokens: undefined }),
      ),
    ).toBeUndefined()
  })

  // P2-2 audit fix (2026-07) — anti-oscillation latch. Once an all-errors
  // batch snapped the budget back to full, the throttle must stay off for
  // the rest of the run so budget_tokens doesn't flip back and forth
  // (each flip invalidates the Anthropic message-level prompt cache).
  describe('latchedFullBudget (anti-oscillation)', () => {
    it('keeps the full base on routine iterations once latched', () => {
      expect(
        resolveAdaptiveThinkingBudget(base({ iteration: 8, latchedFullBudget: true })),
      ).toBe(8192)
    })

    it('without the latch the same routine iteration throttles (contrast case)', () => {
      expect(
        resolveAdaptiveThinkingBudget(base({ iteration: 8, latchedFullBudget: false })),
      ).toBe(6144)
    })

    it('latched no-base sessions stay undefined (provider fallback, no bounded routine value)', () => {
      expect(
        resolveAdaptiveThinkingBudget(
          base({ iteration: 8, baseBudgetTokens: undefined, latchedFullBudget: true }),
        ),
      ).toBeUndefined()
    })
  })

  it('honours the POLE_ADAPTIVE_THINKING=0 kill-switch', () => {
    process.env.POLE_ADAPTIVE_THINKING = '0'
    expect(resolveAdaptiveThinkingBudget(base())).toBe(8192)
  })

  it('honours the routine factor and min-iteration tunables', () => {
    process.env.POLE_ADAPTIVE_THINKING_ROUTINE_FACTOR = '0.25'
    process.env.POLE_ADAPTIVE_THINKING_ROUTINE_MIN_ITERATION = '5'
    expect(resolveAdaptiveThinkingBudget(base({ iteration: 4 }))).toBe(8192)
    expect(resolveAdaptiveThinkingBudget(base({ iteration: 5 }))).toBe(2048)
  })

  it('ignores invalid factor values (> 1, non-numeric)', () => {
    process.env.POLE_ADAPTIVE_THINKING_ROUTINE_FACTOR = '4'
    expect(resolveAdaptiveThinkingBudget(base())).toBe(6144)
    process.env.POLE_ADAPTIVE_THINKING_ROUTINE_FACTOR = 'abc'
    expect(resolveAdaptiveThinkingBudget(base())).toBe(6144)
  })
})
