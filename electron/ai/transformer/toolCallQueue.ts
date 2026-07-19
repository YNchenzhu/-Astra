/**
 * FIFO helpers for pairing `tool_use` calls to their incoming `tool_result` /
 * `functionResponse` events.
 *
 * These live in their own module so both directions of every transformer can
 * import them without creating a circular dependency via `./index`.
 *
 * See {@link TransformContext.pendingToolCallsByName} for the full rationale
 * (fix for R3: same tool name called twice in a turn losing its first id).
 */

import type { TransformContext } from './types'

/**
 * Enqueue a pending tool call keyed by name. Returns the ordinal assigned
 * so the caller can correlate replay events with their ordinal position.
 */
export function enqueuePendingToolCall(
  ctx: TransformContext,
  name: string,
  id: string,
): number {
  ctx.toolCallOrdinal += 1
  const q = ctx.pendingToolCallsByName.get(name) ?? []
  q.push({ id, ordinal: ctx.toolCallOrdinal })
  ctx.pendingToolCallsByName.set(name, q)
  ctx.toolUseIDToName.set(id, name)
  return ctx.toolCallOrdinal
}

/**
 * Pop the oldest pending call for `name` (FIFO). Returns `undefined` if the
 * queue is empty.
 */
export function dequeuePendingToolCallByName(
  ctx: TransformContext,
  name: string,
): string | undefined {
  const q = ctx.pendingToolCallsByName.get(name)
  if (!q || q.length === 0) return undefined
  const entry = q.shift()!
  if (q.length === 0) ctx.pendingToolCallsByName.delete(name)
  return entry.id
}

/** Peek without removing. */
export function peekPendingToolCallByName(
  ctx: TransformContext,
  name: string,
): string | undefined {
  const q = ctx.pendingToolCallsByName.get(name)
  return q && q.length > 0 ? q[0].id : undefined
}
