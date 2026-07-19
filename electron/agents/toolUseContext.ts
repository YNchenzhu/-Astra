/**
 * AsyncLocalStorage for the current tool_use execution (separate from {@link AgentContext}).
 */

import { AsyncLocalStorage } from 'node:async_hooks'

export type ToolUseExecutionContext = {
  toolUseId: string
  toolName: string
  agentId?: string
  startedAt: number
}

const storage = new AsyncLocalStorage<ToolUseExecutionContext>()

export function getToolUseExecutionContext(): ToolUseExecutionContext | null {
  return storage.getStore() ?? null
}

export function runWithToolUseExecutionContext<T>(
  ctx: ToolUseExecutionContext,
  fn: () => Promise<T>,
): Promise<T> {
  return storage.run(ctx, fn)
}
