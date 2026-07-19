import { describe, expect, it } from 'vitest'
import { getAgentToolPrompt } from './agentPrompt'
import type { AgentDefinition } from './types'

describe('getAgentToolPrompt', () => {
  it('formats tool lists when tools were persisted as a comma-separated string (YAML / UI quirks)', () => {
    const agent = {
      agentType: 'string-tools-agent',
      whenToUse: 'testing',
      tools: 'Read, Grep, Glob',
    } as unknown as AgentDefinition

    expect(() => getAgentToolPrompt([agent])).not.toThrow()
    expect(getAgentToolPrompt([agent])).toContain('Read, Grep, Glob')
  })

  it('handles disallowedTools as a string for the prompt line', () => {
    const agent = {
      agentType: 'deny-string-agent',
      whenToUse: 'testing',
      disallowedTools: 'Bash, Edit',
    } as unknown as AgentDefinition

    expect(() => getAgentToolPrompt([agent])).not.toThrow()
    expect(getAgentToolPrompt([agent])).toContain('All tools except Bash, Edit')
  })

  it('does not teach the model to launch Agent for a greeting', () => {
    const prompt = getAgentToolPrompt([])

    expect(prompt).toContain('The user is only greeting')
    expect(prompt).toContain('Do not call Agent or any workspace tool')
    expect(prompt).not.toContain('launch the greeting-responder agent')
  })
})
