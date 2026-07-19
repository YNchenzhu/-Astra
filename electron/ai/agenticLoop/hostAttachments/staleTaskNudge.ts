/**
 * Stale-task nudge collector — upstream parity for
 * `src/utils/attachments.ts#getTaskReminderAttachments` and the
 * `'task_reminder'` case of `src/utils/messages.ts`.
 *
 * V2 counterpart of {@link ./staleTodoNudge}. When the agent has gone
 * several iterations without calling any of the V2 task tools
 * (`TaskCreate` / `TaskUpdate`), re-surface the current open task
 * list inside a `<system-reminder>` block.
 *
 * ## Differences from {@link ./staleTodoNudge}
 *
 *   - **Data source**: `taskManager.listTasks()` (file-backed) instead
 *     of the per-agent in-memory store.
 *   - **Triggering tools**: either `TaskCreate` OR `TaskUpdate` count
 *     as "fresh activity". upstream's reference treats them as the
 *     equivalent of the V1 TodoWrite call.
 *   - **Mode gate**: V2 must be enabled (`isTodoV2Enabled()`). In
 *     `'coexist'` mode an extra cross-surface mute fires: if the
 *     model used V1 (TodoWrite) within the last
 *     {@link CROSS_SURFACE_MUTE_TURNS} assistant turns, this nudge
 *     is suppressed — symmetric counterpart of `staleTodoNudge`'s
 *     own cross-mute, so the user never sees both surfaces nag in
 *     the same idle window.
 *
 * Scope filtering for the snapshot: only tasks bound to the active
 * conversation are surfaced when an `agentContext.streamConversationId`
 * is available, falling back to the global open list otherwise. upstream
 * supports a `getTaskListId` chain (team / env / session) we have not
 * yet ported — using the conversation scope is the safest local
 * approximation until we wire the same chain.
 */

import type { Collector } from '../hostAttachments'
import { getAgentContext } from '../../../agents/agentContext'
import { taskManager } from '../../../tools/TaskManager'
import type { Task } from '../../../tools/TaskManager'
import { isTodoCoexistMode, isTodoV2Enabled } from '../../../tools/todoMode'
import {
  SIDE_CHANNEL_KIND,
  makeSideChannelUserMessage,
  readSideChannelKind,
} from '../../../constants/sideChannelKinds'
import {
  hasGenuineHumanTurnSinceLastToolUse,
  hasRecentToolUse,
  isThinkingOnlyAssistantMessage,
} from './messageHistoryQueries'

// Re-exported so existing test imports keep working without churn.
export { hasRecentToolUse }

const TASK_CREATE_TOOL_NAME = 'TaskCreate'
const TASK_UPDATE_TOOL_NAME = 'TaskUpdate'
const TODO_WRITE_TOOL_NAME = 'TodoWrite'

/** upstream parity: `TODO_REMINDER_CONFIG.TURNS_SINCE_WRITE`. */
export const TURNS_SINCE_TASK_ACTIVITY = 10
/** upstream parity: `TODO_REMINDER_CONFIG.TURNS_BETWEEN_REMINDERS`. */
export const TURNS_BETWEEN_REMINDERS = 10

/**
 * Coexist-mode cross-surface mute window. Symmetric counterpart of
 * `staleTodoNudge`'s `CROSS_SURFACE_MUTE_TURNS`. If the model used
 * `TodoWrite` within this many assistant turns, suppress the V2
 * stale-task nudge. Override via `POLE_STALE_TASK_CROSS_MUTE_TURNS`.
 */
export const CROSS_SURFACE_MUTE_TURNS = 5

function isStaleTaskNudgeEnabled(): boolean {
  const raw = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process?.env?.POLE_STALE_TASK_NUDGE?.trim().toLowerCase()
  return !(raw === '0' || raw === 'false' || raw === 'no')
}

function readCrossSurfaceMuteTurns(): number {
  const raw = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process?.env?.POLE_STALE_TASK_CROSS_MUTE_TURNS?.trim()
  if (!raw) return CROSS_SURFACE_MUTE_TURNS
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return CROSS_SURFACE_MUTE_TURNS
  return Math.floor(n)
}


function hasTaskActivityToolUse(msg: Record<string, unknown>): boolean {
  const content = msg.content
  if (!Array.isArray(content)) return false
  for (const block of content as Array<Record<string, unknown>>) {
    if (block?.type !== 'tool_use') continue
    const name = block.name
    if (name === TASK_CREATE_TOOL_NAME || name === TASK_UPDATE_TOOL_NAME) return true
  }
  return false
}

interface TurnCounts {
  turnsSinceLastTaskActivity: number
  turnsSinceLastReminder: number
}

export function computeTaskTurnCounts(
  messages: ReadonlyArray<Record<string, unknown>>,
): TurnCounts {
  let lastActivityFound = false
  let lastReminderFound = false
  let assistantTurnsSinceActivity = 0
  let assistantTurnsSinceReminder = 0

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (!msg) continue
    const role = msg.role

    if (role === 'assistant') {
      if (isThinkingOnlyAssistantMessage(msg)) continue
      if (!lastActivityFound && hasTaskActivityToolUse(msg)) {
        lastActivityFound = true
      }
      if (!lastActivityFound) assistantTurnsSinceActivity++
      if (!lastReminderFound) assistantTurnsSinceReminder++
    } else if (role === 'user' && !lastReminderFound) {
      const kind = readSideChannelKind(msg)
      if (kind === SIDE_CHANNEL_KIND.staleTaskNudge) {
        lastReminderFound = true
      }
    }

    if (lastActivityFound && lastReminderFound) break
  }

  return {
    turnsSinceLastTaskActivity: assistantTurnsSinceActivity,
    turnsSinceLastReminder: assistantTurnsSinceReminder,
  }
}

/**
 * Open tasks (status `pending` or `in_progress`) relevant to the current
 * conversation. Cancelled / failed / completed entries are deliberately
 * omitted — they don't help the model decide what to do next.
 *
 * Audit F-16 fix: the previous implementation, when a conversation was bound
 * but no open task matched it, FELL BACK to the unfiltered global list. Since
 * `TaskCreate` historically wrote no `conversationId`, that fallback fired
 * essentially always — surfacing OTHER conversations' (and other work
 * packages') open tasks and pulling the model toward unrelated work. Now we
 * show only tasks that are either bound to THIS conversation OR unscoped
 * (no `conversationId` — e.g. plan-seeded or legacy tasks, which represent
 * the active workspace plan rather than a foreign session). Tasks bound to a
 * DIFFERENT conversation are never shown.
 */
function listOpenTasksInScope(conversationId: string | undefined): Task[] {
  const all = taskManager.listTasks()
  const open = all.filter((t) => t.status === 'pending' || t.status === 'in_progress')
  if (!conversationId) return open
  return open.filter((t) => !t.conversationId || t.conversationId === conversationId)
}

function renderTaskListBody(tasks: ReadonlyArray<Task>): string {
  const items = tasks
    .map((t) => `#${t.taskId} [${t.status}] ${t.subject}`)
    .join('\n')
  // First line is the kind's bracket marker — see
  // `SIDE_CHANNEL_KIND_SPECS[staleTaskNudge].marker` for why. Mirrors
  // `staleTodoNudge.ts`'s rationale.
  const intro =
    "[Stale task reminder]\n" +
    "The task tools haven't been used recently. If you're working on tasks that " +
    "would benefit from being tracked, use TaskCreate / TaskUpdate to keep the " +
    "list current. If you're not working on any tasks, feel free to ignore this reminder."
  if (items.length === 0) return intro
  return `${intro}\n\nHere are the existing open tasks:\n\n${items}`
}

export const staleTaskNudgeCollector: Collector = {
  name: 'stale_task_nudge',
  callSites: ['post_tool'],

  async run(ctx) {
    if (!isStaleTaskNudgeEnabled()) return null
    if (!isTodoV2Enabled()) return null

    const { state } = ctx

    // Tool availability — neither TaskCreate nor TaskUpdate present
    // means the agent has no way to act on the nudge.
    const tools = state.iterationToolDefs ?? []
    const hasCreate = tools.some((t) => t?.name === TASK_CREATE_TOOL_NAME)
    const hasUpdate = tools.some((t) => t?.name === TASK_UPDATE_TOOL_NAME)
    if (!hasCreate && !hasUpdate) return null

    // Coexist-mode cross-surface mute (symmetric counterpart of
    // staleTodoNudge): if the model used V1 TodoWrite recently, the
    // user already saw planning activity — don't pile on with a V2
    // reminder in the same window.
    if (
      isTodoCoexistMode() &&
      hasRecentToolUse(
        state.apiMessages,
        [TODO_WRITE_TOOL_NAME],
        readCrossSurfaceMuteTurns(),
      )
    ) {
      return null
    }

    // Fix B (2026-05) — human-redirect suppression, symmetric with the
    // V1 stale-todo nudge. If a genuine human message has arrived since
    // the last TaskCreate/TaskUpdate, the human is steering this turn;
    // re-surfacing the open task list as a `<system-reminder>` right
    // after a fresh (possibly narrower) instruction is the failure mode
    // where the model abandons the user's request and resumes stale
    // work. Scope the nudge to genuine autonomous drift only.
    if (
      hasGenuineHumanTurnSinceLastToolUse(state.apiMessages, [
        TASK_CREATE_TOOL_NAME,
        TASK_UPDATE_TOOL_NAME,
      ])
    ) {
      return null
    }

    const agentCtx = getAgentContext()
    const conversationId = agentCtx?.streamConversationId?.trim() || undefined
    const open = listOpenTasksInScope(conversationId)
    // Same intentional upstream divergence as the V1 stale-todo nudge:
    // suppress when there are no open tasks. See `staleTodoNudge.ts`
    // for the rationale (avoids chitchat-turn false positives).
    if (open.length === 0) return null

    const { turnsSinceLastTaskActivity, turnsSinceLastReminder } = computeTaskTurnCounts(
      state.apiMessages,
    )
    if (turnsSinceLastTaskActivity < TURNS_SINCE_TASK_ACTIVITY) return null
    if (turnsSinceLastReminder < TURNS_BETWEEN_REMINDERS) return null

    state.appendixReport('P2_Q_compaction_reminder', {
      iteration: state.iteration,
      kind: 'stale_task_nudge',
      itemCount: open.length,
      turnsSinceLastTaskActivity,
      turnsSinceLastReminder,
    })

    return {
      kind: 'push_message',
      sideChannelKind: SIDE_CHANNEL_KIND.staleTaskNudge,
      message: makeSideChannelUserMessage(
        SIDE_CHANNEL_KIND.staleTaskNudge,
        renderTaskListBody(open),
      ),
    }
  },
}
