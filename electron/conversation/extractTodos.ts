/**
 * Extract the most recent TodoWrite snapshot from a persisted
 * conversation transcript — upstream parity for
 * `src/utils/sessionRestore.ts#extractTodosFromTranscript`.
 *
 * # Why this exists
 *
 * 星构Astra persists two copies of the V1 todo list on disk:
 *
 *   1. `ConversationData.todos` — the renderer's last-known snapshot,
 *      kept as a render-side cache so the UI can paint immediately on
 *      conversation switch without waiting for an IPC round-trip.
 *   2. The TodoWrite `tool_use` blocks inside `messages[]` — the
 *      authoritative record of every checklist update the model has
 *      ever emitted in this conversation.
 *
 * When a conversation is reloaded into the main process, the
 * in-memory `todoStore` (see `electron/tools/TodoWriteTool.ts`) starts
 * empty. Without restoring it, the stale-todo nudge collector and any
 * other reader sees "no todos" even though the renderer is already
 * displaying them — the V1 surface effectively forgets state across
 * conversation switches.
 *
 * upstream solves this by walking the transcript backwards for the
 * last TodoWrite `tool_use` block and writing its `input.todos` into
 * `AppState.todos`. We do the same here — the transcript is the
 * single source of truth, not the cached `todos` field.
 *
 * # Mode gate (callers' responsibility)
 *
 * This function runs unconditionally. Callers gate on
 * `isTodoV1Enabled()` and only call into the V1 restore when V1 is
 * active (`'v1-only'` OR `'coexist'`). In a pure `'v2-only'`
 * deployment the V1 in-memory store has nothing to hydrate — the
 * TaskManager disk files own that state. See
 * `electron/conversation/service.ts#loadConversation`.
 */

import type { TodoItem } from '../tools/TodoWriteTool'
import type { ConversationMessage, ConversationContentBlock } from './types'

const TODO_WRITE_TOOL_NAME = 'TodoWrite'
const VALID_STATUSES = new Set(['pending', 'in_progress', 'completed'])

/**
 * Coerce an arbitrary `tool_use.input.todos` payload (which has been
 * round-tripped through JSON and may have been hand-edited) into the
 * canonical `TodoItem[]` shape. Mirrors the validation that
 * `TodoWriteTool.call()` performs on inbound model output.
 *
 * Returns `null` when the payload is structurally invalid (not an
 * array, items missing `content`, etc.) so callers can distinguish
 * "no TodoWrite in transcript" from "TodoWrite was there but bad".
 */
function coerceTodos(rawTodos: unknown): TodoItem[] | null {
  if (!Array.isArray(rawTodos)) return null
  const out: TodoItem[] = []
  for (const item of rawTodos) {
    if (!item || typeof item !== 'object') return null
    const rec = item as Record<string, unknown>
    const content = typeof rec.content === 'string' ? rec.content.trim() : ''
    if (!content) return null
    const status =
      typeof rec.status === 'string' && VALID_STATUSES.has(rec.status)
        ? (rec.status as TodoItem['status'])
        : 'pending'
    const activeForm =
      typeof rec.activeForm === 'string' && rec.activeForm.trim()
        ? rec.activeForm.trim()
        : content
    out.push({ content, status, activeForm })
  }
  return out
}

/**
 * Look up the FIRST `TodoWrite` `tool_use.input.todos` payload found
 * on an assistant message — checking the structured `toolUses[]`
 * field first (pre-extracted by the renderer), then falling back to
 * walking the content `blocks[]`. Returns the raw payload (which
 * may be undefined / wrong shape) so the caller can apply upstream's
 * "most recent wins, valid or not" semantics.
 *
 * Returns `'none'` when the message has no TodoWrite call at all.
 */
function findFirstTodoWritePayload(msg: ConversationMessage): unknown | 'none' {
  if (msg.role !== 'assistant') return 'none'

  const toolUses = msg.toolUses
  if (Array.isArray(toolUses)) {
    for (const tu of toolUses) {
      if (tu.name !== TODO_WRITE_TOOL_NAME) continue
      return tu.input?.todos
    }
  }

  const blocks = msg.blocks
  if (Array.isArray(blocks)) {
    for (const block of blocks as ConversationContentBlock[]) {
      if (block.type !== 'tool_use') continue
      if (block.name !== TODO_WRITE_TOOL_NAME) continue
      return (block.input as Record<string, unknown>)?.todos
    }
  }

  return 'none'
}

/**
 * Walk `messages` backwards. The FIRST assistant message with a
 * `TodoWrite` tool_use wins — its payload is returned (after
 * validation) or `[]` if validation fails. upstream parity
 * (`sessionRestore.ts:77-93`): we do NOT keep looking for an older
 * valid snapshot, because the most-recent call is the agent's
 * latest intended state — silently restoring something staler than
 * that would be a regression.
 */
export function extractTodosFromTranscript(
  messages: ReadonlyArray<ConversationMessage>,
): TodoItem[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (!msg) continue
    const payload = findFirstTodoWritePayload(msg)
    if (payload === 'none') continue
    const todos = coerceTodos(payload)
    return todos ?? []
  }
  return []
}
