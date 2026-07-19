/**
 * Planless-implementation guard — force-plan nudge (row 12a3, audit G1).
 *
 * ## Why this exists
 *
 * The plan-step driver (`planStepGuard`) only drives granularity when an
 * active plan EXISTS. A user who says "implement X" without going through Plan
 * mode produces no plan and no TodoWrite list, so the model can big-bang a
 * large change with zero host-tracked steps — the exact "plan-free execution"
 * failure mode the industry mitigates with plan-first defaults. This guard is
 * the realistic host-level approximation at the no-tool boundary: when the
 * model is about to stop after making SUBSTANTIAL workspace changes WITHOUT
 * any plan or task list, nudge it ONCE to lay the remaining work out as
 * trackable, verifiable steps (TodoWrite / plan) before continuing.
 *
 * Coding-work-package scoped: it keys on workspace file mutations (the same
 * counter the verification gate uses) and points the model at TodoWrite / Plan
 * mode before continuing. For writing / legal / imported domain bundles, a
 * host-forced "track before continuing" nudge can incorrectly interrupt a
 * domain-specific completion flow (the bundle prompt owns its own review /
 * validation order), so those bundles are exempt unless they explicitly opt
 * into code verification.
 *
 * ## Semantics
 *
 * - One-shot per "planless episode": fires at most once until the model either
 *   creates a plan / todo list (precondition clears) or the conversation is
 *   reset. Never spirals (a single nudge, then the turn may end).
 * - Mutually exclusive with the tracked-work guards (`activeTodoPanelGuard`,
 *   `planStepGuard`): it requires NO active todos AND NO active plan, so the
 *   caller's ordering never double-injects.
 * - Question-tail exempt (symmetric with the other guards).
 *
 * Opt out via `POLE_PLANLESS_GUARD=0`; mutation threshold via
 * `POLE_PLANLESS_GUARD_MIN_MUTATIONS` (default 5).
 */

import { getAgentContext } from '../../agents/agentContext'
import { getActivePlanStepsSnapshot } from '../../planning/planRuntime'
import { getVerificationGateState } from '../../planning/verificationGateState'
import { hasActiveTodos } from '../../tools/TodoWriteTool'
import { isUserQuestionTail } from './declaredIntentGuard'
import { activeBundleUsesCodeVerification } from './verificationGate'

/** Marker for tests / telemetry greps. */
export const PLANLESS_GUARD_MARKER = '[Unplanned changes — track before continuing]'

export function isPlanlessGuardEnabled(): boolean {
  const raw = process.env.POLE_PLANLESS_GUARD?.trim().toLowerCase()
  return !(raw === '0' || raw === 'false' || raw === 'no' || raw === 'off')
}

function minMutationsBeforeNudge(): number {
  const n = Number.parseInt(process.env.POLE_PLANLESS_GUARD_MIN_MUTATIONS ?? '', 10)
  return Number.isFinite(n) && n > 0 ? n : 5
}

const OPEN_STATUSES = new Set(['pending', 'in_progress'])

/** Conversations already nudged in the current planless episode (one-shot). */
const nudgedConversations = new Set<string>()

/** Production seam — drop one-shot flags (e.g. on bundle / work-package switch). */
export function clearPlanlessGuardState(): void {
  nudgedConversations.clear()
}

/** Test seam. */
export function __resetPlanlessGuardForTests(): void {
  nudgedConversations.clear()
}

function activePlanHasOpenSteps(): boolean {
  const snap = getActivePlanStepsSnapshot()
  return Boolean(snap && snap.steps.some((s) => OPEN_STATUSES.has(s.status)))
}

/**
 * Produce the row 12a3 signal, or `undefined` when the guard must not fire.
 *
 * Gates (all required):
 *   1. `POLE_PLANLESS_GUARD` not disabled.
 *   2. Active bundle uses code-style verification (`code-dev` or explicit
 *      `executionPolicy.verification.kind === "code"`).
 *   3. Main chat.
 *   4. Visible reply is not a question to the user.
 *   5. NO active plan steps AND NO active TodoWrite items (work is untracked).
 *   6. Substantial workspace mutations recorded (>= threshold).
 *   7. One-shot budget for this planless episode unspent.
 */
export function buildPlanlessImplementationGuardSignal(
  accumulatedText: string,
): { mutationCount: number; directiveBody: string } | undefined {
  if (!isPlanlessGuardEnabled()) return undefined
  if (!activeBundleUsesCodeVerification()) return undefined

  const ctx = getAgentContext()
  const agentId = ctx?.agentId ?? 'main'
  if (agentId !== 'main') return undefined

  const convId = ctx?.streamConversationId?.trim()

  // Work is already tracked → not our case. Clear the one-shot flag so a later
  // genuinely-untracked episode (after the model finished and cleared its
  // list) can nudge again.
  if (activePlanHasOpenSteps() || hasActiveTodos('main')) {
    if (convId) nudgedConversations.delete(convId)
    return undefined
  }

  if (isUserQuestionTail(accumulatedText)) return undefined

  const mutationCount = convId
    ? getVerificationGateState(convId)?.mutationCount ?? 0
    : 0
  if (mutationCount < minMutationsBeforeNudge()) return undefined

  // One-shot per episode.
  if (convId) {
    if (nudgedConversations.has(convId)) return undefined
    nudgedConversations.add(convId)
  }

  const directiveBody =
    `${PLANLESS_GUARD_MARKER}\n\n` +
    `You have made ${mutationCount} workspace change(s) without a tracked plan or task list. ` +
    `Before continuing, externalize the work so progress is visible and each unit can be verified:\n` +
    `  (a) call TodoWrite to lay out the remaining steps (one in_progress at a time), OR\n` +
    `  (b) if the task is large or multi-file, enter Plan mode to produce an ordered plan first.\n\n` +
    `Then continue, marking steps complete as you go. This keeps large changes reviewable instead of one big untracked batch.`

  return { mutationCount, directiveBody }
}
