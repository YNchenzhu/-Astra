/**
 * GuardBudgetLedger (P1-2, 2026-07 核心层做深) — locks the declarative
 * forward-progress reset policy that replaced the hand-written assignment
 * sequence in `orchestration/phases/iteration.ts`.
 */

import { describe, expect, it } from 'vitest'
import {
  GUARD_BUDGET_RESET_POLICY,
  applyForwardProgressReset,
  type GuardBudgetField,
} from './guardBudgetLedger'

function makeCounters(value = 3): Parameters<typeof applyForwardProgressReset>[0] {
  return {
    declaredIntentNudgeCount: value,
    thinkingOnlySilentTurnNudgeCount: value,
    allToolsFailedNudgeCount: value,
    verificationGateNudgeCount: value,
    completionEvidenceChallengeCount: value,
    consecutiveStopHookBlocks: value,
    stopHookActive: new Set(['hook-a', 'hook-b']),
  }
}

describe('GUARD_BUDGET_RESET_POLICY — registry shape', () => {
  it('lists every budget field exactly once', () => {
    const fields = GUARD_BUDGET_RESET_POLICY.map((e) => e.field)
    expect(new Set(fields).size).toBe(fields.length)
    const expected: GuardBudgetField[] = [
      'declaredIntentNudgeCount',
      'thinkingOnlySilentTurnNudgeCount',
      'allToolsFailedNudgeCount',
      'verificationGateNudgeCount',
      'completionEvidenceChallengeCount',
      'consecutiveStopHookBlocks',
    ]
    expect(new Set(fields)).toEqual(new Set(expected))
  })

  it('pins each guard contract to its documented reset signal', () => {
    const byField = Object.fromEntries(
      GUARD_BUDGET_RESET_POLICY.map((e) => [e.field, e.resetOn]),
    )
    // "Announced/reasoned but did not act" guards — any batch is action.
    expect(byField.declaredIntentNudgeCount).toBe('any_batch')
    expect(byField.thinkingOnlySilentTurnNudgeCount).toBe('any_batch')
    expect(byField.consecutiveStopHookBlocks).toBe('any_batch')
    // Stricter guards — a pure failure streak must not re-arm.
    expect(byField.allToolsFailedNudgeCount).toBe('success_batch')
    expect(byField.verificationGateNudgeCount).toBe('success_batch')
    expect(byField.completionEvidenceChallengeCount).toBe('success_batch')
  })
})

describe('applyForwardProgressReset — behaviour', () => {
  it('success-bearing batch resets EVERY budget and clears the hook set', () => {
    const s = makeCounters()
    applyForwardProgressReset(s, { batchHadSuccess: true })
    expect(s.declaredIntentNudgeCount).toBe(0)
    expect(s.thinkingOnlySilentTurnNudgeCount).toBe(0)
    expect(s.allToolsFailedNudgeCount).toBe(0)
    expect(s.verificationGateNudgeCount).toBe(0)
    expect(s.completionEvidenceChallengeCount).toBe(0)
    expect(s.consecutiveStopHookBlocks).toBe(0)
    expect(s.stopHookActive.size).toBe(0)
  })

  it('all-error batch resets only the any_batch budgets (12c/12d/12f stay spent)', () => {
    const s = makeCounters()
    applyForwardProgressReset(s, { batchHadSuccess: false })
    // Any-batch group re-armed — a failing tool call is still ACTING.
    expect(s.declaredIntentNudgeCount).toBe(0)
    expect(s.thinkingOnlySilentTurnNudgeCount).toBe(0)
    expect(s.consecutiveStopHookBlocks).toBe(0)
    expect(s.stopHookActive.size).toBe(0)
    // Success-batch group untouched — pure failure streaks earn ONE nudge.
    expect(s.allToolsFailedNudgeCount).toBe(3)
    expect(s.verificationGateNudgeCount).toBe(3)
    expect(s.completionEvidenceChallengeCount).toBe(3)
  })
})
