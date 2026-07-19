/**
 * Stale-todo nudge collector — upstream parity for
 * `src/utils/attachments.ts#getTodoReminderAttachments` and the
 * `'todo_reminder'` case of `src/utils/messages.ts`.
 *
 * ## What it does
 *
 * When the agent has gone several iterations without calling
 * `TodoWrite`, re-surface the existing checklist inside a
 * `<system-reminder>` block so the model is reminded it exists.
 * The nudge is intentionally non-instructional ("feel free to
 * ignore"): it counters the failure mode where the agent forgets
 * to mark items `completed` mid-task, not a mandate to use the
 * tool when it wouldn't have anyway.
 *
 * ## Gating (星构Astra coexist-aware, double cadence)
 *
 *   1. **Mode** — V1 must be enabled (`isTodoV1Enabled()`). The V2
 *      surface uses its own `staleTaskNudge` collector with TaskManager
 *      as the data source. In `'coexist'` mode an extra cross-surface
 *      mute fires: if the model used V2 (TaskCreate / TaskUpdate)
 *      within the last {@link CROSS_SURFACE_MUTE_TURNS} assistant
 *      turns, this nudge is suppressed so the user does not hear
 *      two reminders about the same idle stretch.
 *   2. **Tool availability** — `TodoWrite` must be in the active
 *      tool set. upstream's analog checks `toolUseContext.options.tools`
 *      via name match; we do the same against `state.iterationToolDefs`.
 *   3. **Turn cadence** — must have:
 *        - ≥ {@link TURNS_SINCE_WRITE} assistant turns since the
 *          last assistant message that contained a TodoWrite
 *          `tool_use` block, AND
 *        - ≥ {@link TURNS_BETWEEN_REMINDERS} assistant turns since
 *          the last reminder of this same kind was injected.
 *      Both windows count **assistant** turns only and ignore
 *      thinking-only messages.
 *
 * The double cadence is what stops a single quiet stretch from
 * triggering a reminder on every subsequent iteration. upstream
 * uses {10, 10}; we keep the same values.
 *
 * ## Call site
 *
 * `post_tool` — matches upstream's `getAttachmentMessages` call site
 * in `src/query.ts` after `runTools`. The model perceives the
 * reminder as attached to the just-finished tool batch rather than
 * as a fresh user instruction.
 *
 * ## Disable
 *
 * `POLE_STALE_TODO_NUDGE=0` opts out for the rest of the process.
 */

import type { Collector } from '../hostAttachments'
import { getAgentContext } from '../../../agents/agentContext'
import { getTodos, hasActiveTodos } from '../../../tools/TodoWriteTool'
import type { TodoItem } from '../../../tools/TodoWriteTool'
import { isTodoCoexistMode, isTodoV1Enabled } from '../../../tools/todoMode'
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

const TODO_WRITE_TOOL_NAME = 'TodoWrite'
const TASK_CREATE_TOOL_NAME = 'TaskCreate'
const TASK_UPDATE_TOOL_NAME = 'TaskUpdate'

/** upstream parity: `TODO_REMINDER_CONFIG.TURNS_SINCE_WRITE`. */
export const TURNS_SINCE_WRITE = 10
/** upstream parity: `TODO_REMINDER_CONFIG.TURNS_BETWEEN_REMINDERS`. */
export const TURNS_BETWEEN_REMINDERS = 10

/**
 * Coexist-mode cross-surface mute window. If the model used a V2
 * task tool (`TaskCreate` / `TaskUpdate`) within this many assistant
 * turns, suppress the V1 stale-todo nudge. Rationale: the user just
 * heard the model talk about tasks on the other surface; bombing them
 * with a "your TodoWrite list is stale" reminder in the same window
 * is pure noise. Half of the base 10-turn cadence felt right; tune
 * via `POLE_STALE_TODO_CROSS_MUTE_TURNS` if needed.
 */
export const CROSS_SURFACE_MUTE_TURNS = 5

function isStaleTodoNudgeEnabled(): boolean {
  const raw = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process?.env?.POLE_STALE_TODO_NUDGE?.trim().toLowerCase()
  return !(raw === '0' || raw === 'false' || raw === 'no')
}

function readCrossSurfaceMuteTurns(): number {
  const raw = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process?.env?.POLE_STALE_TODO_CROSS_MUTE_TURNS?.trim()
  if (!raw) return CROSS_SURFACE_MUTE_TURNS
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return CROSS_SURFACE_MUTE_TURNS
  return Math.floor(n)
}


/**
 * Returns `true` when the assistant message's content array contains
 * a `tool_use` block named `TodoWrite`.
 */
function hasTodoWriteToolUse(msg: Record<string, unknown>): boolean {
  const content = msg.content
  if (!Array.isArray(content)) return false
  for (const block of content as Array<Record<string, unknown>>) {
    if (block?.type === 'tool_use' && block.name === TODO_WRITE_TOOL_NAME) return true
  }
  return false
}

interface TurnCounts {
  /** Assistant turns since the most-recent TodoWrite (or total if never). */
  turnsSinceLastTodoWrite: number
  /** Assistant turns since the most-recent stale-todo reminder (or total if never). */
  turnsSinceLastReminder: number
}

/**
 * Walk `messages` backwards, accumulating assistant-turn counts for
 * the two gates. upstream parity: count assistant turns only, skip
 * thinking-only messages, and **do not** count the assistant turn
 * that contained the TodoWrite call itself as "1 turn since" — the
 * call IS the write.
 */
export function computeTurnCounts(
  messages: ReadonlyArray<Record<string, unknown>>,
): TurnCounts {
  let lastTodoWriteFound = false
  let lastReminderFound = false
  let assistantTurnsSinceWrite = 0
  let assistantTurnsSinceReminder = 0

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (!msg) continue
    const role = msg.role

    if (role === 'assistant') {
      if (isThinkingOnlyAssistantMessage(msg)) continue
      // upstream key invariant: check for TodoWrite BEFORE incrementing
      // counter — the turn that contains the TodoWrite call counts as
      // "0 turns since write", not "1".
      if (!lastTodoWriteFound && hasTodoWriteToolUse(msg)) {
        lastTodoWriteFound = true
      }
      if (!lastTodoWriteFound) assistantTurnsSinceWrite++
      if (!lastReminderFound) assistantTurnsSinceReminder++
    } else if (role === 'user' && !lastReminderFound) {
      const kind = readSideChannelKind(msg)
      if (kind === SIDE_CHANNEL_KIND.staleTodoNudge) {
        lastReminderFound = true
      }
    }

    if (lastTodoWriteFound && lastReminderFound) break
  }

  return {
    turnsSinceLastTodoWrite: assistantTurnsSinceWrite,
    turnsSinceLastReminder: assistantTurnsSinceReminder,
  }
}

function renderTodoListBody(todos: ReadonlyArray<TodoItem>): string {
  const items = todos
    .map((t, i) => `${i + 1}. [${t.status}] ${t.content}`)
    .join('\n')
  // First line is the kind's bracket marker — see
  // `SIDE_CHANNEL_KIND_SPECS[staleTodoNudge].marker` for why. Keeps
  // `detectSideChannelKindFromText` able to recover the kind when the
  // typed `_sideChannelKind` flag is missing (e.g. transcripts loaded
  // from disk after restart, or external normalization passes that
  // strip internal metadata).
  const intro =
    "[Stale todo reminder]\n" +
    "The TodoWrite tool hasn't been used recently. If you're working on tasks that " +
    "would benefit from being tracked, use the TodoWrite tool to track them. If " +
    "you're not working on any tasks, feel free to ignore this reminder."
  if (items.length === 0) return intro
  return `${intro}\n\nHere are the existing contents of your todo list:\n\n${items}`
}

export const staleTodoNudgeCollector: Collector = {
  name: 'stale_todo_nudge',
  callSites: ['post_tool'],

  async run(ctx) {
    if (!isStaleTodoNudgeEnabled()) return null
    if (!isTodoV1Enabled()) return null

    const { state } = ctx

    // Tool-availability gate — if the agent doesn't have TodoWrite
    // in its current tool surface, there is nothing to nudge toward.
    const todoToolPresent = state.iterationToolDefs?.some(
      (t) => t?.name === TODO_WRITE_TOOL_NAME,
    )
    if (!todoToolPresent) return null

    // Coexist-mode cross-surface mute: if the model used V2 task tools
    // recently, this user already saw the model talking about tasks on
    // the other surface. Double-nudging in the same window is noise.
    if (
      isTodoCoexistMode() &&
      hasRecentToolUse(
        state.apiMessages,
        [TASK_CREATE_TOOL_NAME, TASK_UPDATE_TOOL_NAME],
        readCrossSurfaceMuteTurns(),
      )
    ) {
      return null
    }

    // Use the same key as TodoWriteTool.call(): defaults to 'main' for
    // the main chat (set by streamHandler), or the sub-agent's id.
    const agentCtx = getAgentContext()
    const todoKey = agentCtx?.agentId ?? 'main'

    // Intentional upstream divergence (audit T-1, 2026-05): suppress
    // the reminder when the agent has no active items. upstream fires
    // even with an empty store ("you haven't used TodoWrite"); we
    // require ≥1 `pending` or `in_progress` item.
    //
    // Why diverge: upstream runs in a CLI where the user explicitly
    // invoked the agent for a specific task — empty-store reminders
    // there mean "you forgot to plan first". 星构Astra's main chat
    // is conversational; an empty-store reminder 10 turns into a
    // chitchat / Q&A session would be pure noise. Tying the gate
    // to active items keeps the nudge action-relevant.
    //
    // To restore strict parity (fire even when empty), drop the
    // `hasActiveTodos` check and always read `getTodos(todoKey)`.
    if (!hasActiveTodos(todoKey)) return null
    const todos = getTodos(todoKey)

    // Fix B (2026-05) — human-redirect suppression. If a genuine human
    // user message has arrived since the last TodoWrite, the human is
    // actively steering this turn. Re-surfacing the prior checklist as a
    // `<system-reminder>` right after a fresh, possibly-narrower
    // instruction is the exact failure mode we hit: the model treated the
    // resurfaced "70-tool test" list as a mandate to keep going and
    // abandoned the user's single-tool request. The nudge is meant for
    // autonomous drift (model grinding for 10+ turns with no human input),
    // not for the turn right after the human spoke — so mute it here.
    if (hasGenuineHumanTurnSinceLastToolUse(state.apiMessages, [TODO_WRITE_TOOL_NAME])) {
      return null
    }

    const { turnsSinceLastTodoWrite, turnsSinceLastReminder } = computeTurnCounts(
      state.apiMessages,
    )
    if (turnsSinceLastTodoWrite < TURNS_SINCE_WRITE) return null
    if (turnsSinceLastReminder < TURNS_BETWEEN_REMINDERS) return null

    state.appendixReport('P2_Q_compaction_reminder', {
      iteration: state.iteration,
      kind: 'stale_todo_nudge',
      itemCount: todos.length,
      turnsSinceLastTodoWrite,
      turnsSinceLastReminder,
    })

    return {
      kind: 'push_message',
      sideChannelKind: SIDE_CHANNEL_KIND.staleTodoNudge,
      message: makeSideChannelUserMessage(
        SIDE_CHANNEL_KIND.staleTodoNudge,
        renderTodoListBody(todos),
      ),
    }
  },
}
