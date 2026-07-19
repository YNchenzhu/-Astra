/**
 * Plan-verification reminder collector — nudges the model to call
 * `VerifyPlanExecution` after it has had several iterations to
 * implement a previously-approved plan.
 *
 * ## upstream parity
 *
 * upstream's `getVerifyPlanReminderAttachment` fires every N human
 * turns since `plan_mode_exit`, gated on the `pendingPlanVerification`
 * appState. Our equivalent uses our own
 * `electron/planning/planVerificationState.ts` tracker (set by
 * `ExitPlanModeTool.finalizeExitPlanMode`, cleared by
 * `VerifyPlanExecutionTool`).
 *
 * ## Gating rationale
 *
 * Two competing concerns:
 *
 *   - Too eager (1-2 iterations after exit): fires before the model
 *     has done any implementation work, so the verification report
 *     would be meaningless.
 *   - Too lazy (50+ iterations): fires after the model has long
 *     since moved on; the user has probably already moved on too.
 *
 * Sweet spot: ≥ `MIN_ITERATIONS_BEFORE_NUDGE` (default 5) since the
 * collector FIRST observed the pending entry. Re-emit every
 * `REPEAT_NUDGE_EVERY_N_ITERATIONS` (default 10) iterations as long
 * as the entry stays pending, capped at `MAX_NUDGES` (default 3)
 * per pending entry to avoid haranguing.
 *
 * ## Why the collector tracks its own first-observed iteration
 *
 * The `ExitPlanModeTool` doesn't have direct access to the agentic
 * loop's iteration counter. Rather than plumbing it through, the
 * collector records when it first SEES a new pending entry — close
 * enough to "right after exit" for the nudge cadence (the gap is
 * one collector run, i.e. one tool batch).
 *
 * ## Gating
 *
 * - **On by default**. Silent unless ExitPlanMode actually ran on
 *   this conversation, and even then bounded by `MIN_ITERATIONS_BEFORE_NUDGE`
 *   + `REPEAT_NUDGE_EVERY_N_ITERATIONS` + `MAX_NUDGES` (≤3 total
 *   nudges per pending entry). Disable via `POLE_VERIFY_PLAN_REMINDER=0`
 *   if the nudges are unwanted.
 * - Main chat only.
 * - `post_tool` call site.
 */

import type { Collector } from '../hostAttachments'
import { getAgentContext } from '../../../agents/agentContext'
import { getPendingPlanVerification } from '../../../planning/planVerificationState'
import {
  SIDE_CHANNEL_KIND,
  wrapSideChannelBody,
} from '../../../constants/sideChannelKinds'

const MIN_ITERATIONS_BEFORE_NUDGE = 5
const REPEAT_NUDGE_EVERY_N_ITERATIONS = 10
const MAX_NUDGES = 3

interface ReminderTrackingEntry {
  planId: string
  firstObservedAtIteration: number
  lastNudgedAtIteration: number
  nudgeCount: number
}

const trackingByConversation = new Map<string, ReminderTrackingEntry>()

function isVerifyPlanReminderEnabled(): boolean {
  const raw = process.env.POLE_VERIFY_PLAN_REMINDER?.trim().toLowerCase()
  // Default-on: only an explicit `0` / `false` / `no` disables.
  if (raw === '0' || raw === 'false' || raw === 'no') return false
  return true
}

/** Test seam — drop one or all conversation entries. */
export function __resetVerifyPlanReminderTrackingForTests(
  conversationId?: string,
): void {
  if (conversationId) trackingByConversation.delete(conversationId)
  else trackingByConversation.clear()
}

export const verifyPlanReminderCollector: Collector = {
  name: 'verify_plan_reminder',
  callSites: ['post_tool'],

  async run(ctx) {
    if (!isVerifyPlanReminderEnabled()) return null
    const { state } = ctx

    const agentCtx = getAgentContext()
    const isMainChat = !agentCtx?.agentId || agentCtx.agentId === 'main'
    if (!isMainChat) return null
    const convId = agentCtx?.streamConversationId?.trim()
    if (!convId) return null

    const pending = getPendingPlanVerification(convId)
    if (!pending) {
      // Pending entry was cleared (model called VerifyPlanExecution
      // or some other path cleared it). Drop tracking too so a
      // future ExitPlanMode starts fresh.
      trackingByConversation.delete(convId)
      return null
    }

    let tracking = trackingByConversation.get(convId)
    if (!tracking || tracking.planId !== pending.planId) {
      // First observation for this pending entry (or it superseded
      // a different plan). Record and skip — we nudge on the NEXT
      // qualifying iteration, not the first.
      tracking = {
        planId: pending.planId,
        firstObservedAtIteration: state.iteration,
        lastNudgedAtIteration: -1,
        nudgeCount: 0,
      }
      trackingByConversation.set(convId, tracking)
      return null
    }

    if (tracking.nudgeCount >= MAX_NUDGES) return null

    const iterationsSinceObserved = state.iteration - tracking.firstObservedAtIteration
    if (iterationsSinceObserved < MIN_ITERATIONS_BEFORE_NUDGE) return null

    // After the first nudge, throttle by REPEAT_NUDGE_EVERY_N_ITERATIONS.
    if (tracking.nudgeCount > 0) {
      const iterationsSinceLastNudge =
        state.iteration - tracking.lastNudgedAtIteration
      if (iterationsSinceLastNudge < REPEAT_NUDGE_EVERY_N_ITERATIONS) return null
    }

    tracking.nudgeCount += 1
    tracking.lastNudgedAtIteration = state.iteration

    const body =
      `You exited plan mode "${pending.planId}" ${iterationsSinceObserved} iterations ago ` +
      `and have not yet called \`VerifyPlanExecution\`. When the implementation work for that ` +
      `plan is complete, please call VerifyPlanExecution with a structured report covering ` +
      `completed / skipped / deviated steps. This closes the loop and clears this reminder.`

    state.appendixReport('P2_Q_compaction_reminder', {
      iteration: state.iteration,
      kind: 'verify_plan_reminder',
      planId: pending.planId,
      iterationsSinceObserved,
      nudgeCount: tracking.nudgeCount,
    })

    return {
      kind: 'push_message',
      sideChannelKind: SIDE_CHANNEL_KIND.genericConvertedSystem,
      message: {
        role: 'user',
        content: wrapSideChannelBody(
          SIDE_CHANNEL_KIND.genericConvertedSystem,
          body,
        ),
        _convertedFromSystem: true,
        _sideChannelKind: SIDE_CHANNEL_KIND.genericConvertedSystem,
      },
    }
  },
}
