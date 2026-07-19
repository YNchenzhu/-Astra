/**
 * Destructive tests — main-agent wake-up + undelivered-output parking
 * (audit 2026-06, "spawn → main turn ends → work finishes → nothing
 * wakes the main agent / result lost in the 5s unregister window").
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  bufferUndeliveredSubAgentOutput,
  clearUndeliveredSubAgentOutputsForTests,
  drainUndeliveredSubAgentOutputs,
  restoreUndeliveredSubAgentOutputs,
} from './undeliveredSubAgentBuffer'
import {
  registerActiveAgent,
  unregisterActiveAgent,
} from './activeAgentRegistry'
import { injectPendingSubAgentOutputsForMainTurn } from './mainSubAgentContextInjection'
import {
  requestSubAgentTerminalWake,
  requestTeamMemberIdleWake,
  __emittedWakesForTests,
  __resetIdleAgentsForTests,
} from './mainAgentWakeup'
import type { ActiveAgent, BuiltInAgentDefinition } from './types'
import { asAgentId } from '../tools/ids'

const stubDef: BuiltInAgentDefinition = {
  agentType: 'general-purpose',
  description: 'stub',
  getSystemPrompt: () => 'stub',
  tools: [],
  source: 'built-in',
}

function makeTerminalAgent(
  id: string,
  overrides: Partial<ActiveAgent> = {},
): ActiveAgent {
  return {
    agentId: asAgentId(id),
    agentType: 'general-purpose',
    agentDef: stubDef,
    description: 'test agent',
    messages: [],
    pendingMessages: [],
    abortController: new AbortController(),
    startTime: Date.now(),
    status: 'completed',
    resolve: () => {},
    ...overrides,
  } as ActiveAgent
}

beforeEach(() => {
  clearUndeliveredSubAgentOutputsForTests()
  __emittedWakesForTests.length = 0
  __resetIdleAgentsForTests()
})

afterEach(() => {
  clearUndeliveredSubAgentOutputsForTests()
})

describe('undeliveredSubAgentBuffer — parking semantics', () => {
  it('drops entries with no undelivered text AND no pending terminal notice', () => {
    bufferUndeliveredSubAgentOutput({
      agentId: 'a1',
      agentType: 'Explore',
      status: 'completed',
      undeliveredText: '   ',
      terminalNoticePending: false,
    })
    expect(drainUndeliveredSubAgentOutputs()).toHaveLength(0)
  })

  it('keeps a text-less entry when the terminal notice was never delivered', () => {
    bufferUndeliveredSubAgentOutput({
      agentId: 'a2',
      agentType: 'Explore',
      status: 'failed',
      terminalError: 'boom',
      undeliveredText: '',
      terminalNoticePending: true,
    })
    const drained = drainUndeliveredSubAgentOutputs()
    expect(drained).toHaveLength(1)
    expect(drained[0].terminalError).toBe('boom')
  })

  it('caps total entries (oldest dropped) under a pathological burst', () => {
    for (let i = 0; i < 60; i++) {
      bufferUndeliveredSubAgentOutput({
        agentId: `burst-${i}`,
        agentType: 'Explore',
        status: 'completed',
        undeliveredText: `report ${i}`,
        terminalNoticePending: true,
      })
    }
    const drained = drainUndeliveredSubAgentOutputs()
    expect(drained.length).toBeLessThanOrEqual(30)
    expect(drained[drained.length - 1].agentId).toBe('burst-59')
  })

  it('restore puts entries back at the front (FIFO order preserved)', () => {
    bufferUndeliveredSubAgentOutput({
      agentId: 'later',
      agentType: 'Explore',
      status: 'completed',
      undeliveredText: 'x',
      terminalNoticePending: true,
    })
    restoreUndeliveredSubAgentOutputs([
      {
        agentId: 'earlier',
        agentType: 'Explore',
        status: 'completed',
        undeliveredText: 'y',
        terminalNoticePending: true,
        bufferedAt: 0,
      },
    ])
    const drained = drainUndeliveredSubAgentOutputs()
    expect(drained.map((e) => e.agentId)).toEqual(['earlier', 'later'])
  })
})

describe('unregisterActiveAgent → parking → next-turn injection (5s window fix)', () => {
  it('an undelivered terminal result survives unregister and reaches the next main turn', () => {
    const a = makeTerminalAgent('park-1', {
      latestTextOutput: '## Final report\nвсе done',
      mainContextDeliveryOffset: 0,
      terminalNotifiedToMain: false,
    })
    registerActiveAgent(a)
    unregisterActiveAgent(a.agentId)

    // Registry row is GONE — the legacy collector path sees nothing live.
    const out = injectPendingSubAgentOutputsForMainTurn([
      { role: 'user', content: 'next user turn' },
    ])
    expect(out).toHaveLength(2)
    const synthetic = String(out[0].content)
    expect(synthetic).toContain('## Final report')
    expect(synthetic).toContain('park-1')
    expect(synthetic).toContain('status: completed')

    // Delivered exactly once.
    const second = injectPendingSubAgentOutputsForMainTurn([
      { role: 'user', content: 'another turn' },
    ])
    expect(second).toHaveLength(1)
  })

  it('does NOT double-deliver when the live collector already surfaced everything', () => {
    const text = 'already delivered text'
    const a = makeTerminalAgent('park-2', {
      latestTextOutput: text,
      mainContextDeliveryOffset: text.length,
      terminalNotifiedToMain: true,
    })
    registerActiveAgent(a)
    unregisterActiveAgent(a.agentId)

    const out = injectPendingSubAgentOutputsForMainTurn([
      { role: 'user', content: 'next' },
    ])
    expect(out).toHaveLength(1)
  })

  it('skips parking for non-main parents (sibling sub-agent trees stay private)', () => {
    const a = makeTerminalAgent('park-3', {
      parentAgentId: asAgentId('agent-bg-123-1'),
      latestTextOutput: 'private to sub-tree',
      terminalNotifiedToMain: false,
    })
    registerActiveAgent(a)
    unregisterActiveAgent(a.agentId)

    const out = injectPendingSubAgentOutputsForMainTurn([
      { role: 'user', content: 'next' },
    ])
    expect(out).toHaveLength(1)
  })

  it('orphan tool_use defers parked delivery WITHOUT losing it (rewind path)', () => {
    const a = makeTerminalAgent('park-4', {
      latestTextOutput: 'deferred report',
      terminalNotifiedToMain: false,
    })
    registerActiveAgent(a)
    unregisterActiveAgent(a.agentId)

    // Last assistant has an unfulfilled tool_use → injection must defer.
    const deferred = injectPendingSubAgentOutputsForMainTurn([
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }],
      },
      { role: 'user', content: [{ type: 'text', text: 'no tool_result here' }] },
    ])
    expect(deferred).toHaveLength(2)

    // Next clean turn delivers the parked entry.
    const clean = injectPendingSubAgentOutputsForMainTurn([
      { role: 'user', content: 'clean turn' },
    ])
    expect(clean).toHaveLength(2)
    expect(String(clean[0].content)).toContain('deferred report')
  })
})

describe('mainAgentWakeup — wake event emission', () => {
  it('terminal wake carries completed/failed status', () => {
    requestSubAgentTerminalWake({ agentId: 'w1', success: true })
    requestSubAgentTerminalWake({ agentId: 'w2', success: false, teamName: 'alpha' })
    expect(__emittedWakesForTests).toEqual([
      { type: 'subagent-terminal-wake', agentId: 'w1', status: 'completed', outstandingActiveAgents: 0 },
      { type: 'subagent-terminal-wake', agentId: 'w2', status: 'failed', teamName: 'alpha', outstandingActiveAgents: 0 },
    ])
  })

  it('team-member idle wake carries idle status + team', () => {
    requestTeamMemberIdleWake({ agentId: 'member-1', teamName: 'alpha' })
    expect(__emittedWakesForTests).toEqual([
      { type: 'subagent-terminal-wake', agentId: 'member-1', status: 'idle', teamName: 'alpha', outstandingActiveAgents: 0 },
    ])
  })

  it('never throws when no Electron window exists (lazy require failure path)', () => {
    expect(() =>
      requestSubAgentTerminalWake({ agentId: 'w3', success: true }),
    ).not.toThrow()
  })
})
