/**
 * GuardBudgetLedger — P1-2 (2026-07 核心层做深).
 *
 * The no-tool continuation guards (decision-table rows 12b-12f) and the
 * stop-hook recursion machinery each carry a per-turn budget counter on
 * {@link LoopState}. Their RESET rules — the "genuine forward progress"
 * semantics that re-arm a spent budget — used to exist only as a hand-
 * written sequence of assignments inside `runAgenticIteration` (post-tool
 * block), with the rationale spread across ~60 lines of comments. Adding
 * a guard meant touching four places (loopShared field + setup init +
 * iteration reset + noTools accounting) and NOTHING verified the reset
 * sequence stayed in sync with each guard's documented contract.
 *
 * This module makes the reset policy DECLARATIVE:
 *
 *   - {@link GUARD_BUDGET_RESET_POLICY} names every budget field and the
 *     forward-progress signal that resets it. New guards add ONE row.
 *   - {@link applyForwardProgressReset} is the single production apply
 *     point, called from the iteration body after a tool batch executes.
 *
 * Reset semantics (verbatim from the guards' contracts):
 *
 *   - `any_batch` — ANY executed tool batch counts, including an all-error
 *     one. Used by guards that police "announced/reasoned but did not
 *     ACT": a failing tool call is still the model acting on its
 *     declaration (the all-error follow-up is the stricter
 *     `success_batch` guards' territory). A nudge that produced no tool
 *     call never reaches this reset, so consecutive re-declarations still
 *     end the turn — the anti-spiral property is preserved.
 *   - `success_batch` — only a batch containing at least one SUCCESS
 *     re-arms. Used by guards where a pure failure streak must not earn
 *     repeated nudges (all-tools-failed, verification, completion
 *     evidence).
 *
 * Deliberately NOT in the ledger:
 *
 *   - `consecutiveCompactFailures` / `maxOutputRecoveryCycles` — recovery
 *     counters with different lifecycles (compact-success reset / kernel
 *     crash-recovery seeding), not forward-progress budgets.
 *   - The IterationStallGuard streak — an external per-conversation
 *     singleton (needs ALS for the conversation id); the iteration body
 *     keeps that reset next to this ledger's apply call.
 */

import type { LoopState } from './loopShared'

export type GuardBudgetResetSignal = 'any_batch' | 'success_batch'

/** LoopState counter fields resettable to zero by forward progress. */
export type GuardBudgetField =
  | 'declaredIntentNudgeCount'
  | 'thinkingOnlySilentTurnNudgeCount'
  | 'allToolsFailedNudgeCount'
  | 'verificationGateNudgeCount'
  | 'completionEvidenceChallengeCount'
  | 'consecutiveStopHookBlocks'

/**
 * The declarative policy. Registry order is irrelevant (resets are
 * independent); grouping mirrors the decision-table row order for
 * readability.
 */
export const GUARD_BUDGET_RESET_POLICY: ReadonlyArray<{
  readonly field: GuardBudgetField
  readonly resetOn: GuardBudgetResetSignal
  /** Which guard / mechanism the budget serves (docs + telemetry). */
  readonly guard: string
}> = [
  // Stop-hook machinery — successful tool execution is upstream's
  // canonical forward-progress signal; a benign earlier activation must
  // not count against an unrelated later issue.
  { field: 'consecutiveStopHookBlocks', resetOn: 'any_batch', guard: 'stop-hook circuit breaker (cap 8)' },
  // Row 12b — a failing tool call is still ACTING on the declaration.
  { field: 'declaredIntentNudgeCount', resetOn: 'any_batch', guard: 'declared-intent guard (row 12b)' },
  // Row 12e — same "produced real action" semantics as 12b.
  { field: 'thinkingOnlySilentTurnNudgeCount', resetOn: 'any_batch', guard: 'thinking-only silent-turn guard (row 12e)' },
  // Row 12c — stricter: a pure failure streak earns exactly ONE nudge
  // until a tool finally succeeds.
  { field: 'allToolsFailedNudgeCount', resetOn: 'success_batch', guard: 'all-tools-failed guard (row 12c)' },
  // Row 12d — a success-bearing batch means the model acted on the nudge
  // (e.g. delegated to Verification); later unverified edits re-arm.
  { field: 'verificationGateNudgeCount', resetOn: 'success_batch', guard: 'verification gate (row 12d)' },
  // Row 12f — real work after a challenge re-arms the handshake for the
  // NEXT completion attempt.
  { field: 'completionEvidenceChallengeCount', resetOn: 'success_batch', guard: 'completion-evidence handshake (row 12f)' },
]

/**
 * Apply the forward-progress resets for one executed tool batch.
 *
 * @param batchHadSuccess `!state.lastToolBatchAllErrors` at the call site
 *   — true when the batch contained at least one successful result.
 *
 * Also clears the per-hook stop-hook recursion set (`stopHookActive`),
 * which rides the same `any_batch` signal but is a Set rather than a
 * numeric budget.
 */
export function applyForwardProgressReset(
  state: Pick<LoopState, GuardBudgetField | 'stopHookActive'>,
  opts: { batchHadSuccess: boolean },
): void {
  state.stopHookActive.clear()
  for (const entry of GUARD_BUDGET_RESET_POLICY) {
    if (entry.resetOn === 'any_batch' || opts.batchHadSuccess) {
      state[entry.field] = 0
    }
  }
}
