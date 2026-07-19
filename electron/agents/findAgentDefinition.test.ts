import { describe, it, expect } from 'vitest'
import { findAgentDefinition } from './subAgentRunner'
import { VERIFICATION_AGENT, EXPLORE_AGENT, FORK_AGENT } from './builtInAgents'
import type { AgentDefinitionUnion } from './types'

describe('findAgentDefinition', () => {
  const agents: AgentDefinitionUnion[] = [VERIFICATION_AGENT, EXPLORE_AGENT, FORK_AGENT]

  it('resolves canonical built-in casing via alias', () => {
    expect(findAgentDefinition('verification', agents)?.agentType).toBe('Verification')
    expect(findAgentDefinition('explore', agents)?.agentType).toBe('Explore')
  })

  it('matches exact type', () => {
    expect(findAgentDefinition('fork', agents)?.agentType).toBe('fork')
  })
})
