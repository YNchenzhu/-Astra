/**
 * Task runtime notification drain — surfaces completed / failed /
 * killed / stalled background-task events into the model's next turn.
 *
 * ## upstream parity
 *
 * upstream's `unified_tasks` attachment family aggregates background
 * task lifecycle deltas at the same `getAttachmentMessages` call
 * site this collector runs at. 星构Astra already had the drain
 * machinery in `electron/tools/tasks/notificationSystem.ts` (queue
 * + XML formatter) and an IPC `tasks:drain-notifications` handler
 * exposing it to the renderer — but the agent loop itself never
 * called the drain, so finished background tasks were invisible to
 * the model until the user explicitly mentioned them. upstream's
 * comment on `drainPendingTaskNotifications` literally said
 * "integrate this into your AI chat loop"; this collector is that
 * wiring.
 *
 * ## What it does
 *
 * On every `post_tool` callsite (after a tool batch resolves):
 *
 *   1. Check `hasPendingTaskNotifications()` — cheap O(1).
 *   2. If yes, drain the queue as XML via `drainPendingTaskNotifications()`.
 *   3. Wrap the XML in the `taskRuntimeNotification` side-channel
 *      envelope and push as a user-role message so the model sees
 *      it on the next stream.
 *
 * The drain is destructive (clears the queue), so the notification
 * is delivered exactly once. If the renderer's `tasks:drain-notifications`
 * IPC also fires for the same notifications (it doesn't today —
 * renderer typically polls only when the user opens the task pill),
 * there's a small race; the queue handles concurrent drains by
 * popping atomically.
 *
 * ## Gating
 *
 *   - Main chat only — sub-agents have their own per-agent
 *     notification stream via the lifecycle hooks. Avoids
 *     duplicating completion notices in two transcripts.
 *   - Always-on; no env disable knob (notifications are payload,
 *     not nudges — suppressing them would mean the model never
 *     learns that a background bash finished).
 */

import type { Collector } from '../hostAttachments'
import { getAgentContext } from '../../../agents/agentContext'
import {
  drainPendingTaskNotifications,
  hasPendingTaskNotifications,
} from '../../../tools/tasks/drainNotifications'
import {
  SIDE_CHANNEL_KIND,
  makeSideChannelUserMessage,
} from '../../../constants/sideChannelKinds'

export const taskRuntimeNotificationsCollector: Collector = {
  name: 'task_runtime_notifications',
  callSites: ['post_tool', 'no_tools_continue'],

  async run(ctx) {
    const agentCtx = getAgentContext()
    const isMainChat = !agentCtx?.agentId || agentCtx.agentId === 'main'
    if (!isMainChat) return null

    if (!hasPendingTaskNotifications()) return null

    const xml = drainPendingTaskNotifications()
    if (!xml || xml.trim() === '') return null

    ctx.state.appendixReport('P2_Q_inter_agent_inject', {
      iteration: ctx.state.iteration,
      source: 'task_runtime_notifications',
    })

    return {
      kind: 'push_message',
      sideChannelKind: SIDE_CHANNEL_KIND.taskRuntimeNotification,
      message: makeSideChannelUserMessage(
        SIDE_CHANNEL_KIND.taskRuntimeNotification,
        xml,
      ),
    }
  },
}
