import type { TodoItem } from '../../types'

/**
 * Parse a `TodoWrite` tool_result `output` string into `TodoItem[]`.
 *
 * The `TodoWriteTool.execute` contract returns `JSON.stringify({ items, message })`
 * (see electron/tools/TodoWriteTool.ts). Older payload shapes that happen to be
 * a bare JSON array are also accepted so we gracefully handle pre-refactor
 * recordings. Failure modes (non-string, non-JSON, missing `items`) return
 * `undefined` — callers treat that as "no change".
 */
export function parseTodoItemsFromToolOutput(raw: unknown): TodoItem[] | undefined {
  if (typeof raw !== 'string' || raw.trim().length === 0) return undefined
  try {
    const parsed = JSON.parse(raw) as unknown
    if (Array.isArray(parsed)) return parsed as TodoItem[]
    if (
      parsed &&
      typeof parsed === 'object' &&
      Array.isArray((parsed as { items?: unknown }).items)
    ) {
      return (parsed as { items: TodoItem[] }).items
    }
  } catch {
    /* ignore — sub-agent runners occasionally ship non-JSON error strings */
  }
  return undefined
}
