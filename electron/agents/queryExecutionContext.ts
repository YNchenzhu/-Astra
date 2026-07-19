/**
 * Override {@link AgentContext.querySource} / {@link AgentContext.queryChainId} for nested LLM calls
 * (auto-compact, hook prompt/agent streams) without mutating the parent async chain.
 */

import { getAgentContext, runWithAgentContextAsync, type AgentContext } from './agentContext'
import { generateQueryChainId } from './queryTracking'
import type { QuerySource } from './querySource'

export async function withQueryOverrideForLlmCall<T>(
  source: QuerySource,
  fn: () => Promise<T>,
): Promise<T> {
  const ctx = getAgentContext()
  if (!ctx) {
    return fn()
  }
  const next: AgentContext = {
    ...ctx,
    querySource: source,
    queryChainId: generateQueryChainId(),
  }
  return runWithAgentContextAsync(next, fn)
}
