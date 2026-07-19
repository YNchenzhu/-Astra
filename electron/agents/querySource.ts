/**
 * upstream report §16.1 — logical source of a model query (multi-agent correlation).
 */

import type { AgentId } from '../tools/ids'

export type QuerySource =
  | 'repl_main_thread'
  | 'compact'
  | 'session_memory'
  | 'marble_origami'
  | 'tool_summary'
  | 'sdk'
  | `agent:${string}`

const AGENT_PREFIX = 'agent:' as const

/** Normalize a custom sub-agent label into {@link QuerySource}. */
export function agentQuerySource(label: string): QuerySource {
  const t = label.trim()
  return t ? (`${AGENT_PREFIX}${t}` as QuerySource) : `${AGENT_PREFIX}unknown`
}

/**
 * Derive a coarse query source from ALS {@link AgentContext.agentId} when no explicit source was set.
 */
export function querySourceFromAgentId(agentId: AgentId | undefined): QuerySource {
  const id = agentId?.trim()
  if (!id || id === 'main') return 'repl_main_thread'
  if (id.startsWith('fork:')) return agentQuerySource(id.slice('fork:'.length) || 'fork')
  if (id.startsWith('skill-fork-')) return agentQuerySource('skill-fork')
  return agentQuerySource(id)
}
