/**
 * Agent Context
 *
 * Simple context storage for agent execution.
 * Allows multiple agents to run concurrently without state pollution.
 */

import type { AgentExecutionContext } from '../../types/Agent'

let currentContext: AgentExecutionContext | undefined

/**
 * Get current agent context.
 */
export function getAgentContext(): AgentExecutionContext | undefined {
  return currentContext
}

/**
 * Run a function with agent context.
 */
export async function runWithAgentContext<T>(
  context: AgentExecutionContext,
  fn: () => Promise<T>,
): Promise<T> {
  const previousContext = currentContext
  currentContext = context
  try {
    return await fn()
  } finally {
    currentContext = previousContext
  }
}
