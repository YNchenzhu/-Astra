import type { AgentDefinitionUnion } from './types'

/**
 * True when an `Agent` tool_use targets an agent definition marked read-only
 * ({@link AgentDefinition.isReadOnly} === true). Matches {@link createAgentTool}:
 * omitted `subagent_type` → `general-purpose` (typically not read-only).
 */
export function isAgentToolTargetReadOnly(
  toolInput: Record<string, unknown> | undefined,
  allAgents: AgentDefinitionUnion[],
): boolean {
  const raw = typeof toolInput?.subagent_type === 'string' ? toolInput.subagent_type.trim() : ''
  const key = raw || 'general-purpose'
  const def = allAgents.find((a) => a.agentType === key)
  if (!def) return false
  return def.isReadOnly === true
}
