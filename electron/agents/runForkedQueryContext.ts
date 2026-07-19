/**
 * upstream report §16.4 — forked query: isolated ALS row, new chain id, optional prompt-cache write skip.
 */

import type { AgentContext } from './agentContext'
import { runWithAgentContextAsync } from './agentContext'
import type { QuerySource } from './querySource'
import { generateQueryChainId } from './queryTracking'
import { asAgentId } from '../tools/ids'

export type RunForkedQueryContextOptions = {
  querySource: QuerySource
  /** Short label for logging / agent id prefix (e.g. `session-memory`). */
  forkLabel: string
}

/**
 * Run `fn` under a child {@link AgentContext} that does not reuse the parent's `agentId`,
 * so module-level cleanup keyed by “main” vs fork can discriminate (§16.2 / §16.5).
 */
export async function runForkedQueryContext<T>(
  base: AgentContext,
  options: RunForkedQueryContextOptions,
  fn: (ctx: AgentContext) => Promise<T>,
): Promise<T> {
  const short = generateQueryChainId().replace(/-/g, '').slice(0, 10)
  const forkAgentId = asAgentId(`fork:${options.forkLabel}:${short}`)
  const child: AgentContext = {
    ...base,
    agentId: forkAgentId,
    parentAgentId: base.agentId,
    queryChainId: generateQueryChainId(),
    querySource: options.querySource,
    skipPromptCacheWrite: true,
  }
  return runWithAgentContextAsync(child, () => fn(child))
}
