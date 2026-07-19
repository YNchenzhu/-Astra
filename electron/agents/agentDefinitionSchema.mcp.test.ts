import { describe, it, expect } from 'vitest'
import { safeParseCustomAgentJsonRecord } from './agentDefinitionSchema'

describe('agentJsonRecordZod mcpServers', () => {
  it('accepts string and inline spec objects', () => {
    const r = safeParseCustomAgentJsonRecord('x', {
      description: 'd',
      prompt: 'p',
      mcpServers: ['a', { name: 'b', config: { command: 'node' } }],
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.def.mcpServers).toEqual(['a', { name: 'b', config: { command: 'node' } }])
  })
})
