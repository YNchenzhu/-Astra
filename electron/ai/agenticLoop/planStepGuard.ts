/**
 * Plan-step driver — work-package-neutral granularity guard (row 12a2).
 *
 * ## Why this exists
 *
 * The host had a completion guard for the V1 `TodoWrite` surface
 * (`activeTodoPanelGuard`, row 12a) but NOTHING equivalent for the V2 / plan
 * surface: a model running against an approved plan (steps persisted as
 * `TaskManager` tasks with `source: 'plan'`) could silently `completed` while
 * plan steps were still open, and the active plan was never used to DRIVE
 * execution — it only tracked progress for the UI. This guard closes both
 * gaps: it keeps the original goal's step list in front of the model and
 * intercepts a premature "done" while plan steps remain open.
 *
 * A "step" here is just a tracked plan task — a domain-neutral unit. The same
 * mechanism drives a coding plan ("add route → write handler → add tests") and
 * a writing plan ("outline → draft → tone pass") identically; it never assumes
 * code.
 *
 * ## Relationship to other guards
 *
 * - Mirrors {@link buildActiveTodoPanelGuardSignal} (row 12a) but for the
 *   plan / V2 surface. The caller computes this only when the V1 todo guard
 *   did NOT fire, so the two never double-inject (V1 todos take precedence
 *   when both surfaces are somehow active).
 * - Not one-shot, by design — like the V1 todo guard it keeps surfacing while
 *   open plan steps remain. The iteration-stall guard + stop-hook circuit
 *   breaker remain the anti-spiral backstops (a model that genuinely cannot
 *   make progress trips those instead of looping forever here).
 *
 * ## Work-package control
 *
 * Respects the active bundle's {@link BundleExecutionPolicy.stepGranularity}:
 *   - `coarse`        → guard disabled (the work package wants the model to
 *                       batch larger units; host does not drive per-step).
 *   - `fine` / `model-decides` / unset → guard active (drift prevention is the
 *                       universal default).
 *
 * Opt out entirely via `POLE_PLAN_STEP_GUARD=0`.
 */

import { getAgentContext } from '../../agents/agentContext'
import { getActiveBundle } from '../../agents/bundles/bundleRegistryQueries'
import { getActivePlanStepsSnapshot } from '../../planning/planRuntime'
import { isUserQuestionTail } from './declaredIntentGuard'
import { hasGenuineHumanTurnSinceLastToolUse } from './hostAttachments/messageHistoryQueries'

/** Marker for tests / telemetry greps. */
export const PLAN_STEP_GUARD_MARKER = '[Active plan — step driver]'

/** Tasks the model would update to mark progress. Mentioned in the directive. */
const TASK_UPDATE_TOOL_NAME = 'TaskUpdate'

export function isPlanStepGuardEnabled(): boolean {
  const raw = process.env.POLE_PLAN_STEP_GUARD?.trim().toLowerCase()
  return !(raw === '0' || raw === 'false' || raw === 'no' || raw === 'off')
}

/**
 * Anti-spiral cap (audit R1). Unlike a one-shot guard, this one fires while
 * open plan steps remain, so a model that keeps stopping without making step
 * progress could otherwise be force-continued until `max_turns`. After N
 * consecutive plan-guard nudges with NO step progress (open-step count not
 * decreasing) we stop firing for this episode and let the turn end — the user
 * gets control back. Resets on genuine progress (a step closes) or a human
 * redirect. Tunable via `POLE_PLAN_STEP_GUARD_MAX_NUDGES` (default 6).
 */
function maxConsecutivePlanNudges(): number {
  const n = Number.parseInt(process.env.POLE_PLAN_STEP_GUARD_MAX_NUDGES ?? '', 10)
  return Number.isFinite(n) && n > 0 ? n : 6
}

const episodeByConversation = new Map<
  string,
  { lastOpenCount: number; consecutive: number }
>()

/** Production seam — drop episode counters (e.g. on bundle / work-package switch). */
export function clearPlanStepGuardEpisodes(): void {
  episodeByConversation.clear()
}

/** Test seam. */
export function __resetPlanStepGuardEpisodesForTests(): void {
  episodeByConversation.clear()
}

/**
 * Does the active work package opt OUT of host step driving? Only an explicit
 * `stepGranularity: 'coarse'` disables the guard; everything else (including
 * no declared policy) keeps it on so drift prevention is the default.
 */
function activeBundleWantsCoarseSteps(): boolean {
  return getActiveBundle()?.executionPolicy?.stepGranularity === 'coarse'
}

const OPEN_STATUSES = new Set(['pending', 'in_progress'])

/**
 * Produce the row 12a2 signal for `decideIterationOutcome`, or `undefined`
 * when the guard must not fire (so the caller can spread it conditionally).
 *
 * Gates (all required):
 *   1. `POLE_PLAN_STEP_GUARD` not disabled.
 *   2. Active bundle does not request `coarse` step granularity.
 *   3. The active agent is the main chat (sub-agents own their own runs).
 *   4. The model's visible reply is NOT a genuine question to the user
 *      (ending to await an answer is correct even with open steps — symmetric
 *      with the V1 todo guard's exemption).
 *   5. There IS an active plan with at least one open (`pending` /
 *      `in_progress`) step.
 *
 * Directive framing mirrors the V1 todo guard: a hard "turn cannot end" when
 * the run is autonomous, softened to "reconcile the plan" when a genuine human
 * message arrived since the last plan progress (scope may have changed).
 */
export function buildPlanStepGuardSignal(
  apiMessages: ReadonlyArray<Record<string, unknown>>,
  accumulatedText: string,
): { openCount: number; directiveBody: string } | undefined {
  if (!isPlanStepGuardEnabled()) return undefined
  if (activeBundleWantsCoarseSteps()) return undefined

  const ctx = getAgentContext()
  const agentId = ctx?.agentId ?? 'main'
  if (agentId !== 'main') return undefined

  if (isUserQuestionTail(accumulatedText)) return undefined

  const snapshot = getActivePlanStepsSnapshot()
  if (!snapshot || snapshot.steps.length === 0) return undefined

  const open = snapshot.steps.filter((s) => OPEN_STATUSES.has(s.status))
  if (open.length === 0) return undefined

  const humanRedirected = hasGenuineHumanTurnSinceLastToolUse(apiMessages, [
    TASK_UPDATE_TOOL_NAME,
  ])

  // Anti-spiral cap (audit R1). Track consecutive nudges per conversation;
  // reset on step progress (open count dropped) or a human redirect; bail out
  // once the cap is hit so the turn can end instead of looping to max_turns.
  const convId = ctx?.streamConversationId?.trim()
  if (convId) {
    const ep = episodeByConversation.get(convId) ?? {
      lastOpenCount: open.length,
      consecutive: 0,
    }
    const progressed = open.length < ep.lastOpenCount
    if (progressed || humanRedirected) {
      ep.consecutive = 0
    } else if (ep.consecutive >= maxConsecutivePlanNudges()) {
      // Cap reached with no progress — stop firing for this episode. Reset so
      // the next genuine attempt (after the turn ends / user steps in) starts
      // fresh, and let the turn complete normally.
      ep.lastOpenCount = open.length
      ep.consecutive = 0
      episodeByConversation.set(convId, ep)
      return undefined
    }
    ep.lastOpenCount = open.length
    ep.consecutive += 1
    episodeByConversation.set(convId, ep)
  }

  const current = open.find((s) => s.status === 'in_progress')
  const total = snapshot.steps.length
  const doneCount = total - snapshot.steps.filter((s) => OPEN_STATUSES.has(s.status)).length

  const list = open
    .map((s, i) => `${i + 1}. [${s.status}] ${s.subject}`)
    .join('\n')

  const header = current
    ? `Current step (${doneCount}/${total} done): ${current.subject}`
    : `${open.length} plan step(s) still open (${doneCount}/${total} done)`

  const directiveBody = humanRedirected
    ? `${PLAN_STEP_GUARD_MARKER} reconcile before ending\n\n` +
      `${header}\n\n` +
      `The active plan still has open step(s), and the user has sent a new message ` +
      `since the last plan progress. Before you end this turn:\n` +
      `  (a) if the user's latest message is still part of this plan, continue the current step and ` +
      `mark finished steps via ${TASK_UPDATE_TOOL_NAME}; OR\n` +
      `  (b) if the scope changed, update the plan (remove / replace steps that no longer apply), ` +
      `then answer the new request.\n\n` +
      `Do NOT keep grinding stale steps the user did not ask for. Once the plan reflects the ` +
      `current request, it is fine to end the turn.\n\n` +
      `Open steps:\n\n${list}`
    : `${PLAN_STEP_GUARD_MARKER} turn cannot end yet\n\n` +
      `${header}\n\n` +
      `Work the CURRENT step now, one step at a time. You MUST NOT end this turn until you either:\n` +
      `  (a) make progress on the current step and mark every finished step ` +
      `\`completed\` via ${TASK_UPDATE_TOOL_NAME} (then move to the next step); OR\n` +
      `  (b) update the plan via ${TASK_UPDATE_TOOL_NAME} to remove / replace steps that no longer apply.\n\n` +
      `Open steps:\n\n${list}`

  return { openCount: open.length, directiveBody }
}
