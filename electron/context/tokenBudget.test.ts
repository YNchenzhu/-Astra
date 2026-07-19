/**
 * Unit tests for the token-budget state machine.
 *
 * Behaviour parity reference: upstream `src/query/tokenBudget.ts`:
 *   - 90% consumption stop threshold
 *   - Diminishing-returns detection: ≥ 3 continuations AND last two deltas
 *     both under `minDeltaForProgress`
 *   - Max-continuations hard cap (extension over upstream; their loop relied
 *     on the diminishing-returns gate alone)
 *
 * These cases exhaustively exercise the decision table so the state machine
 * stays pure as the agentic-loop integration evolves around it.
 */

import { describe, it, expect } from 'vitest'
import {
  createTokenBudgetState,
  recordOutputTokens,
  checkTokenBudget,
} from './tokenBudget'

describe('tokenBudget state machine', () => {
  it('continues when usage is under the consumption threshold', () => {
    const state = createTokenBudgetState({ totalBudget: 10_000 })
    recordOutputTokens(state, 1_000)
    const result = checkTokenBudget(state)
    expect(result.action).toBe('continue')
    if (result.action === 'continue') {
      expect(result.reminderMessage).toMatch(/9,?000 tokens remaining|10[,.]?000/)
      expect(state.continuationCount).toBe(1)
    }
  })

  it('stops once consumption crosses the 90% threshold (default)', () => {
    const state = createTokenBudgetState({ totalBudget: 1_000 })
    recordOutputTokens(state, 950)
    const result = checkTokenBudget(state)
    expect(result.action).toBe('stop')
    if (result.action === 'stop') {
      expect(result.reason).toMatch(/95%/)
    }
  })

  it('respects a custom consumption threshold', () => {
    const state = createTokenBudgetState({
      totalBudget: 1_000,
      consumptionThreshold: 0.5,
    })
    recordOutputTokens(state, 600)
    const result = checkTokenBudget(state)
    expect(result.action).toBe('stop')
  })

  it('stops on diminishing returns after 3 continuations with small deltas', () => {
    // Default minDeltaForProgress = 500, minContinuationsForDiminishing = 3.
    const state = createTokenBudgetState({ totalBudget: 100_000 })

    // First continuation — big delta, no diminishing trigger.
    recordOutputTokens(state, 5_000)
    expect(checkTokenBudget(state).action).toBe('continue')

    // Second continuation — also big.
    recordOutputTokens(state, 4_000)
    expect(checkTokenBudget(state).action).toBe('continue')

    // Third continuation — big again (continuationCount → 3 after this).
    recordOutputTokens(state, 3_000)
    expect(checkTokenBudget(state).action).toBe('continue')

    // Fourth+ checks: small delta, last two are small → diminishing returns.
    recordOutputTokens(state, 100)
    recordOutputTokens(state, 50)
    const result = checkTokenBudget(state)
    expect(result.action).toBe('stop')
    if (result.action === 'stop') {
      expect(result.reason).toMatch(/Diminishing returns/)
    }
  })

  it('does not flag diminishing returns before the minimum continuation count', () => {
    const state = createTokenBudgetState({ totalBudget: 100_000 })
    // Two small deltas but only 1 prior continuation → must still continue.
    recordOutputTokens(state, 50)
    recordOutputTokens(state, 50)
    expect(checkTokenBudget(state).action).toBe('continue')
  })

  it('stops when max continuations reached', () => {
    const state = createTokenBudgetState({
      totalBudget: 1_000_000,
      maxContinuations: 2,
    })
    recordOutputTokens(state, 1_000)
    expect(checkTokenBudget(state).action).toBe('continue')
    recordOutputTokens(state, 1_000)
    expect(checkTokenBudget(state).action).toBe('continue')

    // continuationCount is now 2 → next check must stop.
    recordOutputTokens(state, 1_000)
    const result = checkTokenBudget(state)
    expect(result.action).toBe('stop')
    if (result.action === 'stop') {
      expect(result.reason).toMatch(/Max token budget continuations/)
    }
  })

  it('reminderMessage exposes the canonical budget telemetry', () => {
    // upstream's coordinator-mode worker reads these numbers verbatim to decide
    // how aggressively to fan out remaining sub-tasks. Lock the shape so a
    // refactor doesn't silently drop one of them.
    const state = createTokenBudgetState({ totalBudget: 10_000 })
    recordOutputTokens(state, 2_500)
    const result = checkTokenBudget(state)
    if (result.action === 'continue') {
      expect(result.reminderMessage).toContain('2,500')
      expect(result.reminderMessage).toContain('10,000')
      expect(result.reminderMessage).toMatch(/25%/)
    } else {
      throw new Error(`expected continue, got ${result.action}: ${result.reason}`)
    }
  })

  it('continuationCount monotonically increases per continue decision', () => {
    const state = createTokenBudgetState({ totalBudget: 1_000_000 })
    for (let i = 0; i < 5; i++) {
      recordOutputTokens(state, 1_000)
      checkTokenBudget(state)
    }
    // 5 calls, each chose continue (well under 90%) → 5 increments.
    expect(state.continuationCount).toBe(5)
  })

  it('treats zero-delta as no progress without immediately stopping', () => {
    // Defensive: if the model returns a no-tool stream with output_tokens=0
    // (e.g. retry/stream-fallback that flushes only thinking deltas), the
    // budget tracker must not classify that as diminishing on its own —
    // the upstream parity requires the prior 3-continuation gate first.
    const state = createTokenBudgetState({ totalBudget: 10_000 })
    recordOutputTokens(state, 0)
    expect(checkTokenBudget(state).action).toBe('continue')
    expect(state.usedOutputTokens).toBe(0)
  })

  // ── P0.1 upstream-parity scalar-window tests ──────────────────────────
  //
  // The previous unbounded `outputDeltas` array implementation passed every
  // existing test above, but it left two subtle holes that the upstream
  // `BudgetTracker.lastDeltaTokens + prevDeltaTokens` two-scalar window
  // closes naturally. These 4 cases lock in the strict semantics:
  //   - BOTH deltas must be below threshold (a single isolated small delta
  //     is not enough)
  //   - the gate at `minContinuationsForDiminishing` is non-negotiable
  //   - the "previous" delta is the literal one before the current one,
  //     not "any of the last N"

  it('P0.1: small prev + large last → continue (last is not small)', () => {
    // After 3 successful continuations, deltas of 100 then 600 should NOT
    // trip diminishing returns — only the prev was small. upstream requires
    // both prev AND last < threshold.
    const state = createTokenBudgetState({ totalBudget: 100_000 })
    recordOutputTokens(state, 5_000)
    expect(checkTokenBudget(state).action).toBe('continue')
    recordOutputTokens(state, 4_000)
    expect(checkTokenBudget(state).action).toBe('continue')
    recordOutputTokens(state, 3_000)
    expect(checkTokenBudget(state).action).toBe('continue')
    // Now continuationCount == 3, diminishing gate is open.
    recordOutputTokens(state, 100) // prev becomes 100 next time
    recordOutputTokens(state, 600) // last = 600 (≥ threshold)
    expect(checkTokenBudget(state).action).toBe('continue')
  })

  it('P0.1: large prev + small last → continue (prev is not small)', () => {
    const state = createTokenBudgetState({ totalBudget: 100_000 })
    recordOutputTokens(state, 5_000)
    expect(checkTokenBudget(state).action).toBe('continue')
    recordOutputTokens(state, 4_000)
    expect(checkTokenBudget(state).action).toBe('continue')
    recordOutputTokens(state, 3_000)
    expect(checkTokenBudget(state).action).toBe('continue')
    recordOutputTokens(state, 600) // prev = 600 (≥ threshold)
    recordOutputTokens(state, 100) // last = 100
    expect(checkTokenBudget(state).action).toBe('continue')
  })

  it('P0.1: both small after the 3-continuation gate opens → stop', () => {
    // upstream exact case: continuationCount >= 3, prev and last BOTH small.
    const state = createTokenBudgetState({ totalBudget: 100_000 })
    recordOutputTokens(state, 5_000)
    expect(checkTokenBudget(state).action).toBe('continue')
    recordOutputTokens(state, 4_000)
    expect(checkTokenBudget(state).action).toBe('continue')
    recordOutputTokens(state, 3_000)
    expect(checkTokenBudget(state).action).toBe('continue')
    recordOutputTokens(state, 100)
    recordOutputTokens(state, 100)
    const result = checkTokenBudget(state)
    expect(result.action).toBe('stop')
    if (result.action === 'stop') {
      expect(result.reason).toMatch(/Diminishing returns/)
    }
  })

  it('P0.1: two small deltas before continuationCount reaches 3 → continue', () => {
    // The diminishing gate must respect `minContinuationsForDiminishing`.
    // Two consecutive small deltas at continuationCount==2 are not enough
    // — the loop must have already chosen "continue" at least 3 times.
    const state = createTokenBudgetState({ totalBudget: 100_000 })
    recordOutputTokens(state, 5_000)
    expect(checkTokenBudget(state).action).toBe('continue')
    // continuationCount == 1 now
    recordOutputTokens(state, 100)
    recordOutputTokens(state, 100)
    // prev = last = 100, both small — but continuationCount is still 1,
    // below the gate of 3 → must continue.
    expect(checkTokenBudget(state).action).toBe('continue')
  })

  it('P0.1: prevDeltaTokens defaults to NEVER_RECORDED so single small delta cannot trip', () => {
    // Edge case the old array-based impl glossed over: a brand-new state
    // with only ONE recorded delta must never report diminishing, even when
    // continuationCount has been advanced past the gate. Use 5 — comfortably
    // past the 3-count gate but below the 10-count maxContinuations cap.
    const state = createTokenBudgetState({ totalBudget: 100_000 })
    state.continuationCount = 5
    recordOutputTokens(state, 100)
    // prev is still NEVER_RECORDED → diminishing check must short-circuit.
    expect(checkTokenBudget(state).action).toBe('continue')
  })
})
