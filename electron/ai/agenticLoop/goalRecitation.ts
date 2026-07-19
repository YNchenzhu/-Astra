/**
 * Goal recitation — ephemeral per-request re-surfacing of the current
 * task list at the very END of the model's context.
 *
 * ## Why (2026-06 long-run hallucination audit, GAP 1)
 *
 * Manus' production lesson ("Attention through Recitation"): in long
 * agentic runs the user's original request drifts toward the
 * low-attention middle of the transcript while the tail fills with
 * tool results and host reminders. Constantly rewriting the goal into
 * the END of the context pushes the global plan into the model's
 * recency zone, countering lost-in-the-middle and goal drift — one of
 * the two drivers of the "前几轮正常，越到后面越漂" degradation (the
 * other driver, host-authored past-tense completion claims, was fixed
 * by the ledger-TTL / summary-opt-in change).
 *
 * ## Design constraints
 *
 *   1. **Ephemeral, never persisted.** The recitation is appended to a
 *      COPY of the messages array at request time (`stream.ts`) and is
 *      NOT written into `state.apiMessages`. A persisted per-iteration
 *      reminder would accumulate in history and recreate the uniform-
 *      pattern pollution this audit just removed. Rebuilt fresh every
 *      stream pass, so it is always current and never duplicated.
 *   2. **Deterministic data source.** Content is rendered from the
 *      TodoWrite store (`getTodos`) — counted and quoted, never
 *      LLM-judged. No active todos → no recitation → zero token cost.
 *   3. **Cache-friendly.** Appended at the absolute tail (inside / after
 *      the final user message), so the prompt prefix — and therefore
 *      provider prompt cache — is unaffected.
 *   4. **Main chat only.** Sub-agents are short-lived and budget-capped;
 *      their goal is the fork directive at the head of a small context.
 *
 * Disable via `POLE_GOAL_RECITATION=0`.
 */

import { getAgentContext } from '../../agents/agentContext'
import {
  getTodos,
  getTodoObjectiveMeta,
  type TodoItem,
  type TodoObjectiveMeta,
} from '../../tools/TodoWriteTool'
import { taskManager } from '../../tools/TaskManager'
import { isTodoV1Enabled, isTodoV2Enabled } from '../../tools/todoMode'
import { extractCurrentUserQueryText } from '../../context/anchorUserQuery'
import {
  SIDE_CHANNEL_KIND,
  wrapSideChannelBody,
} from '../../constants/sideChannelKinds'

type Msg = Record<string, unknown>

/** First body line — marker for tests / telemetry greps. */
export const GOAL_RECITATION_MARKER = '[Goal recitation — host-generated]'

/** Cap open items rendered; oldest-first (TodoWrite preserves order). */
export const MAX_RECITED_ITEMS = 10
/** Per-item character cap so a pathological todo can't bloat the tail. */
export const MAX_RECITED_ITEM_CHARS = 160

export function isGoalRecitationEnabled(): boolean {
  const raw = process.env.POLE_GOAL_RECITATION?.trim().toLowerCase()
  return !(raw === '0' || raw === 'false' || raw === 'no' || raw === 'off')
}

// ─── Untracked-run fallback (2026-07 deep-loop drift uplift) ───────────
//
// The todo/objective recitation above covers only runs where the model
// (or user) created tracked work. The very common "one-line instruction,
// model starts working immediately, never writes a todo" long run had NO
// recitation at all — precisely the sessions with the least drift
// protection. Fallback: once the run is deep enough
// ({@link GOAL_RECITATION_FALLBACK_MIN_ITERATION}), recite the CURRENT
// user query's ordinary text (the same span `anchorUserQuery` wraps at
// wire time) instead. Same ephemeral, tail-appended, cache-friendly
// mechanics; still main-chat-only.

/** Iteration (1-based) at which the untracked-run fallback starts firing. */
export const GOAL_RECITATION_FALLBACK_MIN_ITERATION = parsePositiveIntEnv(
  process.env.POLE_GOAL_RECITATION_FALLBACK_MIN_ITERATION,
  8,
)

/** Char cap for the recited query text (long pasted prompts stay bounded). */
export const MAX_RECITED_QUERY_CHARS = 600

export function isGoalRecitationFallbackEnabled(): boolean {
  const raw = process.env.POLE_GOAL_RECITATION_FALLBACK?.trim().toLowerCase()
  return !(raw === '0' || raw === 'false' || raw === 'no' || raw === 'off')
}

function parsePositiveIntEnv(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function truncateItem(content: string): string {
  const flat = content.replace(/\s+/g, ' ').trim()
  if (flat.length <= MAX_RECITED_ITEM_CHARS) return flat
  return `${flat.slice(0, MAX_RECITED_ITEM_CHARS - 1)}…`
}

/**
 * Objective header line, framed by the write-time verification verdict
 * (2026-07 复审 P0 fix). A verified objective keeps the strong "user's
 * ultimate goal" framing; an UNVERIFIED one — the model-authored text
 * shared zero informative tokens with the user's request at write time —
 * is presented as a candidate so the original instruction stays
 * authoritative on conflict. Pure — exported for tests.
 */
export function renderObjectiveHeaderLine(
  objectiveText: string,
  verified: boolean,
): string {
  const obj = truncateItem(objectiveText)
  return verified
    ? `Underlying objective (the user's ultimate goal): ${obj}`
    : `Working objective (assistant-inferred, NOT verified against the user's request — if it conflicts with the user's actual instruction, follow the instruction and correct this via TodoWrite): ${obj}`
}

/**
 * Render the recitation body from a todo snapshot. Pure — exported for
 * tests. Returns `null` when there is nothing worth reciting (no open
 * items), so callers can no-op without touching the messages array.
 */
export function buildGoalRecitationText(
  todos: ReadonlyArray<TodoItem>,
  objective?: string | TodoObjectiveMeta,
): string | null {
  const open = todos.filter(
    (t) => t.status === 'pending' || t.status === 'in_progress',
  )
  if (open.length === 0) return null
  const completedCount = todos.length - open.length

  const lines: string[] = [
    GOAL_RECITATION_MARKER,
    'Deterministic snapshot of your CURRENT task list, re-surfaced so the original goal stays in recent attention. This is background — not a new instruction and not new work:',
  ]
  // P2: lead with the user's underlying objective (the *why*) when one was
  // captured, so deep intent — not just the step list — stays in recent
  // attention. Verbatim from the TodoWrite `objective` field; never judged
  // — but framed by the write-time verification verdict (string input is
  // treated as verified for legacy callers/tests).
  const meta: TodoObjectiveMeta | undefined =
    typeof objective === 'string'
      ? objective.trim()
        ? { text: objective, verified: true }
        : undefined
      : objective
  const obj = meta?.text.replace(/\s+/g, ' ').trim()
  if (obj && meta) {
    lines.push(renderObjectiveHeaderLine(obj, meta.verified))
  }
  const shown = open.slice(0, MAX_RECITED_ITEMS)
  for (const t of shown) {
    lines.push(`- [${t.status}] ${truncateItem(t.content)}`)
  }
  if (open.length > shown.length) {
    lines.push(`- …and ${open.length - shown.length} more open item(s)`)
  }
  lines.push(
    `(${open.length} open, ${completedCount} completed.) Continue the first unfinished item unless the user's latest message redirects you; mark items completed via TodoWrite as you finish them.`,
  )
  return lines.join('\n')
}

/**
 * V2 / v2-only fallback (audit P2-V2): when there is no open V1 todo list
 * to anchor the recitation but an objective WAS captured (via TaskCreate)
 * and managed tasks are still open, re-surface just the objective. Pure —
 * exported for tests. Returns `null` when there is nothing to recite.
 * String input is treated as verified (legacy callers/tests).
 */
export function buildObjectiveOnlyRecitation(
  objective: string | TodoObjectiveMeta | undefined,
): string | null {
  const meta: TodoObjectiveMeta | undefined =
    typeof objective === 'string' ? { text: objective, verified: true } : objective
  const obj = meta?.text.replace(/\s+/g, ' ').trim()
  if (!obj || !meta) return null
  return [
    GOAL_RECITATION_MARKER,
    "Re-surfaced so the user's underlying goal stays in recent attention. This is background — not a new instruction and not new work:",
    renderObjectiveHeaderLine(obj, meta.verified),
    'Keep driving the open managed tasks toward this objective; update them via TaskUpdate as you progress.',
  ].join('\n')
}

/**
 * Untracked-run fallback body: recite the current user query verbatim
 * (capped). Pure — exported for tests. Returns `null` on empty input.
 */
export function buildUserQueryRecitation(queryText: string): string | null {
  const flat = queryText.replace(/\s+/g, ' ').trim()
  if (!flat) return null
  const capped =
    flat.length <= MAX_RECITED_QUERY_CHARS
      ? flat
      : `${flat.slice(0, MAX_RECITED_QUERY_CHARS - 1)}…`
  return [
    GOAL_RECITATION_MARKER,
    'This run has no tracked task list, so the user\'s original instruction for the current turn is re-surfaced to keep it in recent attention. This is background — not a new instruction and not new work:',
    `Original instruction: ${capped}`,
    'Continue working toward this instruction unless the user\'s latest message redirects you. If the work has grown multi-step, track it with TodoWrite so progress stays visible.',
  ].join('\n')
}

/**
 * Append `recitationText` to the END of a COPY of `messages`:
 *
 *   - tail message is a user message with string content → append after
 *     a blank line
 *   - tail message is a user message with a content-block array →
 *     append as a trailing `text` block (same shape the deterministic
 *     ledger used inside tool_result user messages)
 *   - tail message is not a user message (or array is empty) → append a
 *     standalone user message
 *
 * Never mutates the input array or its messages. Pure — exported for
 * tests.
 */
export function appendEphemeralGoalRecitation(
  messages: ReadonlyArray<Msg>,
  recitationText: string,
): Msg[] {
  const wrapped = wrapSideChannelBody(
    SIDE_CHANNEL_KIND.genericConvertedSystem,
    recitationText,
  )
  const out = [...messages]
  const last = out[out.length - 1]
  if (last && last.role === 'user') {
    const c = last.content
    if (typeof c === 'string') {
      out[out.length - 1] = { ...last, content: `${c}\n\n${wrapped}` }
      return out
    }
    if (Array.isArray(c)) {
      out[out.length - 1] = {
        ...last,
        content: [
          ...(c as Array<Record<string, unknown>>),
          { type: 'text', text: wrapped },
        ],
      }
      return out
    }
  }
  out.push({ role: 'user', content: wrapped })
  return out
}

/**
 * Production wrapper used by `stream.ts`. Applies all gates and returns
 * the SAME array reference when the recitation does not apply (cheap
 * no-op for the common case).
 */
export function withEphemeralGoalRecitation(
  messages: Msg[],
  opts?: {
    /**
     * Current inner-loop iteration (1-based, `state.iteration`). Gates the
     * untracked-run fallback: shallow runs never see it. Omitted (legacy
     * callers / tests) ⇒ fallback never fires.
     */
    iteration?: number
  },
): Msg[] {
  if (!isGoalRecitationEnabled()) return messages
  if (messages.length === 0) return messages

  const agentId = getAgentContext()?.agentId ?? 'main'
  if (agentId !== 'main') return messages

  // Tracked-work recitation — runs whenever either task surface is active
  // (audit P2-V2 — previously hard-gated on V1, which silently disabled
  // recitation in v2-only mode). The objective meta carries the write-time
  // verification verdict so the header framing stays honest (2026-07 复审).
  let text: string | null = null
  if (isTodoV1Enabled() || isTodoV2Enabled()) {
    const objectiveMeta = getTodoObjectiveMeta(agentId)
    // Primary: V1 todo list (+ objective header) when there are open todos.
    text = isTodoV1Enabled()
      ? buildGoalRecitationText(getTodos(agentId), objectiveMeta)
      : null
    // Fallback (V2 / v2-only): objective-only, gated on open managed tasks so
    // a stale stored objective can't recite forever after the work is done.
    if (!text && isTodoV2Enabled() && objectiveMeta && taskManager.hasOpenTasks()) {
      text = buildObjectiveOnlyRecitation(objectiveMeta)
    }
  }

  // Untracked-run fallback (2026-07): deep loop, nothing tracked to recite
  // → recite the current user query itself. Runs even when both task
  // surfaces are disabled (that configuration otherwise has zero
  // recitation coverage by definition).
  if (
    !text &&
    isGoalRecitationFallbackEnabled() &&
    (opts?.iteration ?? 0) >= GOAL_RECITATION_FALLBACK_MIN_ITERATION
  ) {
    const query = extractCurrentUserQueryText(messages)
    if (query) text = buildUserQueryRecitation(query)
  }

  if (!text) return messages

  return appendEphemeralGoalRecitation(messages, text)
}
