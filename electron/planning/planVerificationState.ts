/**
 * Plan-verification state tracker.
 *
 * Tracks "this conversation just exited plan mode; the model should
 * call `VerifyPlanExecution` before considering the task done". Drives
 * the `verify_plan_reminder` host attachment.
 *
 * ## State model
 *
 * Per-conversation: at most one pending verification entry. Set by
 * `ExitPlanModeTool.finalizeExitPlanMode` AFTER the user approves
 * the plan and the implementation is about to begin. Cleared by
 * `VerifyPlanExecutionTool` after the model produces a verification
 * report.
 *
 * The reminder collector consults the entry's `exitedAtIteration`
 * to decide WHEN to nag — too eager (1-2 iterations after exit)
 * fires before the model has done any implementation work; too lazy
 * (50+ iterations) fires after the model has long moved on. The
 * collector chooses a sensible window (default ≥ 5 iterations).
 *
 * ## Why not a per-LoopState field
 *
 * Plan verification spans multiple top-level turns in the same
 * conversation (the user may start the implementation in turn N,
 * pause, send another message, and the verification reminder should
 * still fire). LoopState is per-turn — would lose the flag between
 * turns. The Map keyed by `streamConversationId` survives.
 */

export interface PendingPlanVerification {
  /**
   * Stable plan identifier. Today the closest thing is the plan
   * markdown's first-line title or a fallback `plan-<timestamp>`.
   * The `VerifyPlanExecution` tool accepts this as an argument so the
   * model self-validates against the right plan.
   */
  readonly planId: string
  /**
   * Full plan markdown body — included so the verification report
   * can do a step-by-step comparison without re-Reading the
   * persisted plan file. Bounded length so the state stays small.
   */
  readonly planText: string
  /**
   * Wall-clock at exit (informational only; the reminder collector
   * uses its own per-conversation `firstObservedAtIteration` to
   * compute the nudge cadence rather than depending on this).
   */
  readonly exitedAt: number
}

const pendingByConversation = new Map<string, PendingPlanVerification>()

export function markPendingPlanVerification(
  conversationId: string,
  entry: PendingPlanVerification,
): void {
  if (!conversationId) return
  pendingByConversation.set(conversationId, entry)
}

export function getPendingPlanVerification(
  conversationId: string,
): PendingPlanVerification | undefined {
  if (!conversationId) return undefined
  return pendingByConversation.get(conversationId)
}

/**
 * Clear the pending entry. Called by `VerifyPlanExecutionTool` after
 * the model produces a verification report.
 */
export function clearPendingPlanVerification(conversationId: string): void {
  if (!conversationId) return
  pendingByConversation.delete(conversationId)
}

/**
 * Drop ALL pending plan-verification entries. Production seam — called on
 * work-package (bundle) switch so a plan started under one bundle does not
 * keep nagging the model with `verify_plan_reminder` after the user moved to
 * a different work package.
 */
export function clearAllPendingPlanVerification(): void {
  pendingByConversation.clear()
}

/** Test seam — drop one or all entries. */
export function __resetPendingPlanVerificationForTests(
  conversationId?: string,
): void {
  if (conversationId) pendingByConversation.delete(conversationId)
  else pendingByConversation.clear()
}
