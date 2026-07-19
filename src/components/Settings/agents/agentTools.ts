import { ALL_TOOLS, type BuiltinAgentMeta, type ToolName } from './agentConstants'

export function computeDisallowed(tools: readonly ToolName[]): ToolName[] {
  return ALL_TOOLS.filter((t) => !tools.includes(t))
}

export function computeAllowed(disallowed: readonly ToolName[]): ToolName[] {
  return ALL_TOOLS.filter((t) => !disallowed.includes(t))
}

/** For each agent, compute canonical allowed/disallowed lists. */
export function resolveAgentTools(
  agent: BuiltinAgentMeta,
): { allowed: ToolName[]; disallowed: ToolName[] } {
  const hasExplicitTools = agent.tools && agent.tools.length > 0
  const hasExplicitDisallow = agent.disallowedTools && agent.disallowedTools.length > 0

  if (hasExplicitTools) {
    const tools = agent.tools as readonly ToolName[]
    return { allowed: [...tools] as ToolName[], disallowed: computeDisallowed(tools) }
  }
  if (hasExplicitDisallow) {
    const disallowed = agent.disallowedTools as readonly ToolName[]
    return { allowed: computeAllowed(disallowed), disallowed: [...disallowed] as ToolName[] }
  }
  return { allowed: [...ALL_TOOLS], disallowed: [] }
}
