/**
 * Agent-definition lookup by type name.
 *
 * Extracted from `subAgentRunner.ts` (file-split refactor). `subAgentRunner.ts`
 * keeps a compat re-export so existing import paths
 * (`import { findAgentDefinition } from './subAgentRunner'`) keep working.
 */

import type { AgentDefinitionUnion } from './types'

/** Lowercase alias → canonical `agentType` (upstream report §2.4 naming drift). */
const AGENT_TYPE_CANONICAL_ALIASES: Record<string, string> = {
  verification: 'Verification',
  explore: 'Explore',
  plan: 'Plan',
  fork: 'fork',
  'general-purpose': 'general-purpose',
}

/**
 * Find an agent definition by type name (exact match, then canonical aliases, then case-insensitive).
 */
export function findAgentDefinition(
  agentType: string,
  allAgents: AgentDefinitionUnion[]
): AgentDefinitionUnion | undefined {
  const t = agentType.trim()
  if (!t) return undefined
  const direct = allAgents.find((a) => a.agentType === t)
  if (direct) return direct
  const canon = AGENT_TYPE_CANONICAL_ALIASES[t.toLowerCase()]
  if (canon) {
    const byCanon = allAgents.find((a) => a.agentType === canon)
    if (byCanon) return byCanon
  }
  const lower = t.toLowerCase()
  return allAgents.find((a) => a.agentType.toLowerCase() === lower)
}
