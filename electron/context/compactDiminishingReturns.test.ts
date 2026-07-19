/**
 * P3.1 — Unit tests for the compact diminishing-returns gate.
 *
 * Each test locks in one row of the predicate's truth table:
 *
 *   - Below minHistory → no signal, return false.
 *   - All N most-recent weak → true (gate fires).
 *   - Any 1 of the N most-recent strong → false (streak broken).
 *   - History older than minHistory entries does NOT influence the gate
 *     — only the trailing `minHistory` entries matter.
 *   - Edge cases: empty history, zero / negative preTokens.
 *
 * Pure function — these tests run in microseconds and lock down the
 * algorithm independent of ContextManager wiring.
 */

import { describe, it, expect } from 'vitest'
import {
  isCompactDiminishing,
  recordCompactAttempt,
  type CompactAttempt,
} from './compactDiminishingReturns'

function attempt(pre: number, post: number, ranAt = Date.now()): CompactAttempt {
  return { preTokens: pre, postTokens: post, ranAt }
}

describe('isCompactDiminishing', () => {
  it('returns false on empty history (no signal)', () => {
    expect(isCompactDiminishing([])).toBe(false)
  })

  it('returns false when history length is below minHistory (default 3)', () => {
    expect(
      isCompactDiminishing([
        attempt(100_000, 99_500),
        attempt(99_500, 99_000),
      ]),
    ).toBe(false)
  })

  it('returns true when ALL of the last 3 attempts reclaim < 5%', () => {
    expect(
      isCompactDiminishing([
        attempt(100_000, 99_500), // 0.5% reclaim
        attempt(99_500, 99_000), // ~0.5% reclaim
        attempt(99_000, 98_500), // ~0.5% reclaim
      ]),
    ).toBe(true)
  })

  it('returns false when ANY of the last 3 reclaims ≥ 5% (streak broken)', () => {
    expect(
      isCompactDiminishing([
        attempt(100_000, 99_500), // weak
        attempt(99_500, 80_000), // STRONG (~19%)
        attempt(99_000, 98_500), // weak
      ]),
    ).toBe(false)
  })

  it('ignores history older than the last minHistory entries', () => {
    // Old strong reclaim from 5 attempts ago shouldn't unlock the gate
    // — only the trailing 3 matter.
    expect(
      isCompactDiminishing([
        attempt(200_000, 100_000), // STRONG (50%), but too old
        attempt(99_500, 99_000),
        attempt(99_000, 98_700),
        attempt(98_700, 98_400),
      ]),
    ).toBe(true)
  })

  it('respects custom minHistoryToTriggerDiminishing override', () => {
    // With minHistory=5 the same trio that triggered above is too short.
    expect(
      isCompactDiminishing(
        [
          attempt(100_000, 99_500),
          attempt(99_500, 99_000),
          attempt(99_000, 98_700),
        ],
        { minHistoryToTriggerDiminishing: 5 },
      ),
    ).toBe(false)
  })

  it('respects custom minReclaimRatio override', () => {
    // With a 1% threshold, 0.5%-reclaim attempts are still weak →
    // gate fires; with a 0.1% threshold, the same attempts are now
    // strong → gate stays open.
    const hist = [
      attempt(100_000, 99_500), // 0.5% reclaim
      attempt(99_500, 99_000),
      attempt(99_000, 98_500),
    ]
    expect(isCompactDiminishing(hist, { minReclaimRatio: 0.01 })).toBe(true)
    expect(isCompactDiminishing(hist, { minReclaimRatio: 0.001 })).toBe(false)
  })

  it('returns false defensively when an attempt has zero / negative preTokens', () => {
    // Degenerate input (e.g. a logged attempt where the snapshot
    // failed) → we DON'T fire the gate, because we can't trust the
    // signal. upstream behaviour: don't penalise weird telemetry.
    expect(
      isCompactDiminishing([
        attempt(0, 0),
        attempt(99_500, 99_000),
        attempt(99_000, 98_500),
      ]),
    ).toBe(false)
  })
})

describe('recordCompactAttempt', () => {
  it('appends to history without mutating the original', () => {
    const orig: CompactAttempt[] = [attempt(100, 50)]
    const next = recordCompactAttempt(orig, attempt(50, 25))
    expect(next).toHaveLength(2)
    expect(orig).toHaveLength(1) // not mutated
  })

  it('trims to maxRetention when history exceeds the cap', () => {
    let h: ReadonlyArray<CompactAttempt> = []
    for (let i = 0; i < 10; i++) {
      h = recordCompactAttempt(h, attempt(1000 - i, 500 - i), 5)
    }
    expect(h).toHaveLength(5)
    // Verify it kept the MOST RECENT 5 (drops the oldest).
    expect(h[0].preTokens).toBe(995)
    expect(h[4].preTokens).toBe(991)
  })

  it('defaults maxRetention to 2× minHistory (= 6 with default config)', () => {
    let h: ReadonlyArray<CompactAttempt> = []
    for (let i = 0; i < 10; i++) {
      h = recordCompactAttempt(h, attempt(1000, 500))
    }
    expect(h).toHaveLength(6)
  })
})
