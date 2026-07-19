/**
 * Unit tests for the snip-nudge tracker.
 *
 * Critical invariants:
 *
 *   1. First call for a conversation primes the baseline but does NOT
 *      nudge (we only nudge on observed growth, not on initial size).
 *   2. Growth below threshold does not trigger.
 *   3. Growth at/above threshold triggers exactly once, then resets
 *      the baseline (next nudge requires another full threshold of
 *      growth).
 *   4. `recordSnipEvent` resets the baseline AND records freed tokens
 *      for the next nudge payload.
 *   5. Per-conversation isolation.
 *   6. Hard cap on nudges per conversation.
 */

import { afterEach, describe, expect, it } from 'vitest'
import {
  __resetSnipNudgeTrackerForTests,
  DEFAULT_GROWTH_THRESHOLD_TOKENS,
  DEFAULT_MAX_NUDGES_PER_CONVERSATION,
  recordSnipEvent,
  shouldEmitContextEfficiencyNudge,
} from './snipNudgeTracker'

afterEach(() => __resetSnipNudgeTrackerForTests())

describe('shouldEmitContextEfficiencyNudge — initial observation', () => {
  it('first call primes the baseline without emitting', () => {
    const payload = shouldEmitContextEfficiencyNudge({
      conversationId: 'c',
      currentTokenEstimate: 50_000,
    })
    expect(payload).toBeNull()
  })

  it('returns null for empty conversation id (defensive)', () => {
    const payload = shouldEmitContextEfficiencyNudge({
      conversationId: '',
      currentTokenEstimate: 100_000,
    })
    expect(payload).toBeNull()
  })

  it('returns null for non-finite or non-positive current estimate', () => {
    expect(
      shouldEmitContextEfficiencyNudge({
        conversationId: 'c',
        currentTokenEstimate: 0,
      }),
    ).toBeNull()
    expect(
      shouldEmitContextEfficiencyNudge({
        conversationId: 'c',
        currentTokenEstimate: Number.NaN,
      }),
    ).toBeNull()
  })
})

describe('shouldEmitContextEfficiencyNudge — growth gating', () => {
  it('does not emit when growth is below threshold', () => {
    shouldEmitContextEfficiencyNudge({
      conversationId: 'c',
      currentTokenEstimate: 50_000,
    })
    const payload = shouldEmitContextEfficiencyNudge({
      conversationId: 'c',
      currentTokenEstimate: 50_000 + DEFAULT_GROWTH_THRESHOLD_TOKENS - 1,
    })
    expect(payload).toBeNull()
  })

  it('emits once when growth meets the threshold', () => {
    shouldEmitContextEfficiencyNudge({
      conversationId: 'c',
      currentTokenEstimate: 50_000,
    })
    const payload = shouldEmitContextEfficiencyNudge({
      conversationId: 'c',
      currentTokenEstimate: 50_000 + DEFAULT_GROWTH_THRESHOLD_TOKENS,
    })
    expect(payload).not.toBeNull()
    expect(payload!.grownTokens).toBe(DEFAULT_GROWTH_THRESHOLD_TOKENS)
    expect(payload!.currentTokens).toBe(50_000 + DEFAULT_GROWTH_THRESHOLD_TOKENS)
    expect(payload!.nudgeIndex).toBe(1)
  })

  it('resets baseline after emission — next nudge needs another full threshold', () => {
    shouldEmitContextEfficiencyNudge({
      conversationId: 'c',
      currentTokenEstimate: 50_000,
    })
    shouldEmitContextEfficiencyNudge({
      conversationId: 'c',
      currentTokenEstimate: 50_000 + DEFAULT_GROWTH_THRESHOLD_TOKENS,
    })
    // Tiny additional growth — no emit.
    expect(
      shouldEmitContextEfficiencyNudge({
        conversationId: 'c',
        currentTokenEstimate: 50_000 + DEFAULT_GROWTH_THRESHOLD_TOKENS + 100,
      }),
    ).toBeNull()
    // Full additional threshold — emit again, nudgeIndex bumps.
    const payload = shouldEmitContextEfficiencyNudge({
      conversationId: 'c',
      currentTokenEstimate:
        50_000 + DEFAULT_GROWTH_THRESHOLD_TOKENS * 2,
    })
    expect(payload).not.toBeNull()
    expect(payload!.nudgeIndex).toBe(2)
  })

  it('honors a custom growthThreshold override', () => {
    shouldEmitContextEfficiencyNudge({
      conversationId: 'c',
      currentTokenEstimate: 10_000,
      growthThreshold: 500,
    })
    const payload = shouldEmitContextEfficiencyNudge({
      conversationId: 'c',
      currentTokenEstimate: 10_600,
      growthThreshold: 500,
    })
    expect(payload).not.toBeNull()
    expect(payload!.grownTokens).toBe(600)
  })

  it('stops emitting after maxNudges is hit', () => {
    shouldEmitContextEfficiencyNudge({
      conversationId: 'c',
      currentTokenEstimate: 10_000,
      growthThreshold: 100,
      maxNudges: 2,
    })
    // 1st emit
    expect(
      shouldEmitContextEfficiencyNudge({
        conversationId: 'c',
        currentTokenEstimate: 10_100,
        growthThreshold: 100,
        maxNudges: 2,
      }),
    ).not.toBeNull()
    // 2nd emit
    expect(
      shouldEmitContextEfficiencyNudge({
        conversationId: 'c',
        currentTokenEstimate: 10_200,
        growthThreshold: 100,
        maxNudges: 2,
      }),
    ).not.toBeNull()
    // 3rd would-be — capped
    expect(
      shouldEmitContextEfficiencyNudge({
        conversationId: 'c',
        currentTokenEstimate: 10_500,
        growthThreshold: 100,
        maxNudges: 2,
      }),
    ).toBeNull()
  })

  it('default maxNudges constant is positive and finite', () => {
    expect(Number.isInteger(DEFAULT_MAX_NUDGES_PER_CONVERSATION)).toBe(true)
    expect(DEFAULT_MAX_NUDGES_PER_CONVERSATION).toBeGreaterThan(0)
  })
})

describe('shouldEmitContextEfficiencyNudge — implicit compact detection', () => {
  // F1 audit fix: only history_snip explicitly calls `recordSnipEvent`.
  // Other host-side compact paths (auto_compact / micro_compact /
  // reactive_compact / context_collapse_drain) free tokens too. The
  // tracker self-heals by treating any drop in current tokens vs
  // baseline as an implicit compact event — resets baseline, no nudge.
  it('detects implicit compact and resets baseline on token drop', () => {
    // Prime baseline at 100k.
    shouldEmitContextEfficiencyNudge({
      conversationId: 'c',
      currentTokenEstimate: 100_000,
    })
    // Hidden auto_compact fires → current drops to 60k.
    expect(
      shouldEmitContextEfficiencyNudge({
        conversationId: 'c',
        currentTokenEstimate: 60_000,
      }),
    ).toBeNull()
    // Subsequent growth measured from 60k baseline, not the pre-compact
    // 100k that would have inflated `grown` to 15k+40k=55k.
    const payload = shouldEmitContextEfficiencyNudge({
      conversationId: 'c',
      currentTokenEstimate: 60_000 + DEFAULT_GROWTH_THRESHOLD_TOKENS,
    })
    expect(payload).not.toBeNull()
    expect(payload!.grownTokens).toBe(DEFAULT_GROWTH_THRESHOLD_TOKENS)
  })

  it('does not consume a nudge slot on the implicit-compact reset', () => {
    shouldEmitContextEfficiencyNudge({
      conversationId: 'c',
      currentTokenEstimate: 100_000,
    })
    // Reset event (drop) — should not decrement maxNudges quota.
    shouldEmitContextEfficiencyNudge({
      conversationId: 'c',
      currentTokenEstimate: 50_000,
    })
    // We should still be able to nudge maxNudges times after this.
    for (let i = 1; i <= DEFAULT_MAX_NUDGES_PER_CONVERSATION; i++) {
      const r = shouldEmitContextEfficiencyNudge({
        conversationId: 'c',
        currentTokenEstimate:
          50_000 + DEFAULT_GROWTH_THRESHOLD_TOKENS * i,
      })
      expect(r).not.toBeNull()
      expect(r!.nudgeIndex).toBe(i)
    }
  })
})

describe('recordSnipEvent', () => {
  it('resets baseline so growth restarts from post-snip value', () => {
    // Prime with 100k, then nudge at 100k + threshold.
    shouldEmitContextEfficiencyNudge({
      conversationId: 'c',
      currentTokenEstimate: 100_000,
    })
    // Host snip frees 30k → current is now 70k.
    recordSnipEvent('c', 70_000, 30_000)
    // Tiny growth — no nudge (baseline is now 70k).
    expect(
      shouldEmitContextEfficiencyNudge({
        conversationId: 'c',
        currentTokenEstimate: 75_000,
      }),
    ).toBeNull()
    // Full threshold growth from 70k baseline.
    const payload = shouldEmitContextEfficiencyNudge({
      conversationId: 'c',
      currentTokenEstimate: 70_000 + DEFAULT_GROWTH_THRESHOLD_TOKENS,
    })
    expect(payload).not.toBeNull()
    expect(payload!.lastSnipFreedTokens).toBe(30_000)
  })

  it('ignores empty conversation id', () => {
    recordSnipEvent('', 100, 50)
    // No state was created — first nudge call still primes baseline.
    expect(
      shouldEmitContextEfficiencyNudge({
        conversationId: 'c',
        currentTokenEstimate: 200,
      }),
    ).toBeNull()
  })
})

describe('per-conversation isolation', () => {
  it('isolates growth state across conversations', () => {
    shouldEmitContextEfficiencyNudge({
      conversationId: 'a',
      currentTokenEstimate: 100_000,
    })
    shouldEmitContextEfficiencyNudge({
      conversationId: 'b',
      currentTokenEstimate: 50_000,
    })
    // a grows past threshold — emits.
    expect(
      shouldEmitContextEfficiencyNudge({
        conversationId: 'a',
        currentTokenEstimate: 100_000 + DEFAULT_GROWTH_THRESHOLD_TOKENS,
      }),
    ).not.toBeNull()
    // b's small growth — no emit, fully independent.
    expect(
      shouldEmitContextEfficiencyNudge({
        conversationId: 'b',
        currentTokenEstimate: 60_000,
      }),
    ).toBeNull()
  })
})
