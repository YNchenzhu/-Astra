import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  getAllAgentDefinitions,
  rebuildAgentDefinitions,
  setRendererCustomAgentsSnapshot,
} from './registry'

describe('renderer custom agents (Settings UI sync)', () => {
  afterEach(() => {
    setRendererCustomAgentsSnapshot([])
    rebuildAgentDefinitions(null, undefined)
  })

  beforeEach(() => {
    setRendererCustomAgentsSnapshot([])
    rebuildAgentDefinitions(null, undefined)
  })

  it('uses display name as agentType, not stable id', () => {
    setRendererCustomAgentsSnapshot([
      {
        id: 'custom-1739123',
        name: '代码审查',
        description: '审查 PR',
        prompt: 'You review code.',
      },
    ])
    rebuildAgentDefinitions(null, undefined)
    const agents = getAllAgentDefinitions()
    expect(agents.some((a) => a.agentType === '代码审查')).toBe(true)
    expect(agents.some((a) => a.agentType === 'custom-1739123')).toBe(false)
  })

  it('drops duplicate display names (first wins)', () => {
    setRendererCustomAgentsSnapshot([
      {
        id: 'a',
        name: 'dup',
        description: 'one',
        prompt: 'first prompt',
      },
      {
        id: 'b',
        name: 'dup',
        description: 'two',
        prompt: 'second prompt',
      },
    ])
    rebuildAgentDefinitions(null, undefined)
    const dups = getAllAgentDefinitions().filter((a) => a.agentType === 'dup')
    expect(dups).toHaveLength(1)
    expect(dups[0].source).toBe('custom')
    expect(dups[0].getSystemPrompt()).toBe('first prompt')
  })

  it('does not override built-in when custom name collides', () => {
    setRendererCustomAgentsSnapshot([
      {
        id: 'x',
        name: 'Explore',
        description: 'fake',
        prompt: 'should not replace built-in',
      },
    ])
    rebuildAgentDefinitions(null, undefined)
    const explore = getAllAgentDefinitions().filter((a) => a.agentType === 'Explore')
    expect(explore).toHaveLength(1)
    expect(explore[0].source).toBe('built-in')
  })
})
