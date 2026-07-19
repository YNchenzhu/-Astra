import { describe, it, expect, afterEach } from 'vitest'
import { registerActiveAgent, unregisterActiveAgent } from './activeAgentRegistry'
import { injectPendingSubAgentOutputsForMainTurn } from './mainSubAgentContextInjection'
import type { ActiveAgent } from './types'
import type { BuiltInAgentDefinition } from './types'

const stubDef: BuiltInAgentDefinition = {
  source: 'built-in',
  agentType: 'Explore',
  whenToUse: '',
  getSystemPrompt: () => '',
}

function makeAgent(id: string, overrides: Partial<ActiveAgent> = {}): ActiveAgent {
  return {
    agentId: id,
    agentType: 'Explore',
    agentDef: stubDef,
    description: 'd',
    messages: [],
    pendingMessages: [],
    abortController: new AbortController(),
    startTime: Date.now(),
    status: 'running',
    resolve: () => {},
    ...overrides,
  }
}

const registered: string[] = []

afterEach(() => {
  for (const id of registered.splice(0)) {
    unregisterActiveAgent(id)
  }
})

describe('mainSubAgentContextInjection', () => {
  it('inserts synthetic user message before latest user turn and advances offset', () => {
    const id = 'agent-bg-test'
    const a = makeAgent(id, {
      parentAgentId: 'main',
      latestTextOutput: 'hello explore',
    })
    registerActiveAgent(a)
    registered.push(id)

    const base = [
      { role: 'assistant' as const, content: 'ok' },
      { role: 'user' as const, content: 'user follow-up' },
    ]
    const out = injectPendingSubAgentOutputsForMainTurn(base)

    expect(out.length).toBe(3)
    expect(out[0]!.role).toBe('assistant')
    expect(out[1]!.role).toBe('user')
    expect(out[1]!.content).toContain('hello explore')
    expect(out[1]!.content).toContain('Background sub-agents')
    expect(out[1]!.content).toContain('not proof that the requested work is complete')
    expect(out[2]!.content).toBe('user follow-up')
    expect(a.mainContextDeliveryOffset).toBe('hello explore'.length)

    const outSecond = injectPendingSubAgentOutputsForMainTurn([
      { role: 'assistant' as const, content: 'ok' },
      { role: 'user' as const, content: 'second user' },
    ])
    expect(outSecond.length).toBe(2)
  })

  it('P0-5 — appends after `user(tool_result)` instead of splicing before, so `assistant(tool_use) → user(tool_result)` adjacency is preserved', () => {
    const id = 'agent-bg-pair'
    const a = makeAgent(id, {
      parentAgentId: 'main',
      latestTextOutput: 'explore output',
    })
    registerActiveAgent(a)
    registered.push(id)

    // Shape produced by `subAgentOutputsCollector` (post_tool slot):
    // tool execution pushed [assistant(tool_use), user(tool_result)] and
    // the collector now wants to surface accumulated sub-agent text.
    const base = [
      { role: 'user' as const, content: 'kick off parallel agents' },
      {
        role: 'assistant' as const,
        content: [
          { type: 'tool_use', id: 'call_00_X', name: 'Agent', input: {} },
          { type: 'tool_use', id: 'call_01_Y', name: 'Agent', input: {} },
        ],
      },
      {
        role: 'user' as const,
        content: [
          { type: 'tool_result', tool_use_id: 'call_00_X', content: 'r0' },
          { type: 'tool_result', tool_use_id: 'call_01_Y', content: 'r1' },
        ],
      },
    ]
    const out = injectPendingSubAgentOutputsForMainTurn(base)

    expect(out.length).toBe(4)
    // assistant(tool_use) is at index 1, user(tool_result) MUST stay at 2.
    expect(out[1]!.role).toBe('assistant')
    expect(out[2]!.role).toBe('user')
    expect(Array.isArray(out[2]!.content)).toBe(true)
    const toolResults = (out[2]!.content as Array<{ type: string }>).filter(
      (b) => b.type === 'tool_result',
    )
    expect(toolResults.length).toBe(2)
    // The synthetic sub-agent message is appended AFTER the tool_result user.
    expect(out[3]!.role).toBe('user')
    expect(String(out[3]!.content)).toContain('explore output')
    expect(String(out[3]!.content)).toContain('Background sub-agents')
  })

  it('skips agents spawned from a non-main parent', () => {
    const id = 'nested-worker'
    const a = makeAgent(id, {
      parentAgentId: 'agent-coord-1',
      latestTextOutput: 'secret',
    })
    registerActiveAgent(a)
    registered.push(id)

    const out = injectPendingSubAgentOutputsForMainTurn([
      { role: 'user', content: 'hi' },
    ])
    expect(out).toEqual([{ role: 'user', content: 'hi' }])
  })
})
