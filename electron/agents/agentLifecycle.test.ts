/**
 * `agentLifecycle` facade: keep activeAgentRegistry + MultiAgentOrchestrator
 * in lock-step.
 *
 * Invariants under test:
 *   - Successful spawn lands in BOTH registries.
 *   - Registry-cap rejection does NOT pollute orchestrator.
 *   - Orchestrator failure ROLLS BACK the registry entry.
 *   - `skipActiveRegistry: true` only adds the orchestrator edge.
 *   - `unspawnAndUntrackAgent` drops both sides; safe to call when either
 *     is already gone.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  spawnAndTrackAgent,
  trackAgentInOrchestrator,
  unspawnAndUntrackAgent,
} from './agentLifecycle'
import {
  getActiveAgent,
  getActiveAgents,
  registerActiveAgent,
  unregisterActiveAgent,
  MAX_CONCURRENT_AGENTS,
} from './activeAgentRegistry'
import {
  getMultiAgentOrchestrator,
  resetMultiAgentOrchestratorForTests,
} from './multiAgentOrchestratorSingleton'
import { resetToolOrchestratorForTests } from '../orchestration/toolRuntime/orchestrator'
import type { ActiveAgent, BuiltInAgentDefinition } from './types'
import { asAgentId, type AgentId } from '../tools/ids'

const stubDef: BuiltInAgentDefinition = {
  source: 'built-in',
  agentType: 'Explore',
  whenToUse: '',
  getSystemPrompt: () => '',
}

function makeAgent(id: string, overrides: Partial<ActiveAgent> = {}): ActiveAgent {
  return {
    agentId: asAgentId(id),
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

const registered: AgentId[] = []

beforeEach(() => {
  resetMultiAgentOrchestratorForTests()
  resetToolOrchestratorForTests()
})

afterEach(() => {
  // Defensive teardown: anything spawnAndTrackAgent may have leaked.
  for (const id of registered.splice(0)) {
    try {
      unspawnAndUntrackAgent(id)
    } catch {
      /* ignore */
    }
  }
  // And anything the test pre-registered directly.
  for (const id of [...getActiveAgents().keys()]) {
    try {
      unregisterActiveAgent(asAgentId(id))
    } catch {
      /* ignore */
    }
  }
  resetMultiAgentOrchestratorForTests()
  resetToolOrchestratorForTests()
  vi.restoreAllMocks()
})

describe('spawnAndTrackAgent', () => {
  it('registers the agent in both registries on success', () => {
    const agent = makeAgent('a1', { parentAgentId: asAgentId('parent') })
    const result = spawnAndTrackAgent(agent)
    expect(result.ok).toBe(true)
    registered.push(agent.agentId)

    // registry side
    expect(getActiveAgent('a1')).toBe(agent)

    // orchestrator side — edge under parent, meta derived from ActiveAgent
    const orch = getMultiAgentOrchestrator()
    const spawned = orch.get('a1')
    expect(spawned).toBeDefined()
    expect(spawned!.meta.agentType).toBe('Explore')
    expect(spawned!.meta.parentKernelId).toBe('parent')
    expect(orch.listChildren('parent').map((s) => s.meta.kernelId)).toEqual(['a1'])
  })

  it('forwards conversationId and worktreePath when present', () => {
    const agent = makeAgent('a2', { streamConversationId: 'conv-X' })
    const result = spawnAndTrackAgent(agent, { worktreePath: '/wt/foo' })
    expect(result.ok).toBe(true)
    registered.push(agent.agentId)

    const meta = getMultiAgentOrchestrator().get('a2')!.meta
    expect(meta.conversationId).toBe('conv-X')
    expect(meta.worktreePath).toBe('/wt/foo')
  })

  it('shim.interrupt aborts the original AbortController', () => {
    const ac = new AbortController()
    const agent = makeAgent('a3', { abortController: ac })
    const result = spawnAndTrackAgent(agent)
    expect(result.ok).toBe(true)
    registered.push(agent.agentId)

    // interruptTree(self) → walks just this node → shim.interrupt → ac.abort()
    expect(ac.signal.aborted).toBe(false)
    const cascaded = getMultiAgentOrchestrator().interruptTree('a3', 'user')
    expect(cascaded).toBe(1)
    expect(ac.signal.aborted).toBe(true)
  })

  it('does NOT pollute orchestrator when registry-cap is exceeded', () => {
    // Fill the registry to the cap.
    for (let i = 0; i < MAX_CONCURRENT_AGENTS; i++) {
      const ok = registerActiveAgent(makeAgent(`fill-${i}`))
      expect(ok.ok).toBe(true)
    }

    const overflow = makeAgent('overflow')
    const result = spawnAndTrackAgent(overflow)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/Too many concurrent/)

    // Critical invariant: orchestrator must NOT have a phantom edge.
    expect(getMultiAgentOrchestrator().get('overflow')).toBeUndefined()
  })

  it('rolls back the registry entry when orchestrator.register throws', () => {
    const orch = getMultiAgentOrchestrator()
    const registerSpy = vi
      .spyOn(orch, 'register')
      .mockImplementation(() => {
        throw new Error('boom')
      })

    const agent = makeAgent('rollback')
    const result = spawnAndTrackAgent(agent)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/boom/)

    // BOTH sides must be empty — this is the bug class the facade exists to prevent.
    expect(getActiveAgent('rollback')).toBeUndefined()
    expect(orch.get('rollback')).toBeUndefined()

    registerSpy.mockRestore()
  })

})

describe('trackAgentInOrchestrator', () => {
  it('adds only the orchestrator edge (registry untouched)', () => {
    const ac = new AbortController()
    const result = trackAgentInOrchestrator({
      agentId: asAgentId('team-1'),
      agentType: 'Explore',
      abortController: ac,
      parentAgentId: 'team-parent',
      conversationId: 'conv-team',
      worktreePath: '/wt/team',
    })
    expect(result.ok).toBe(true)
    registered.push(asAgentId('team-1'))

    // Orchestrator side: edge under parent with all meta fields.
    const orch = getMultiAgentOrchestrator()
    const meta = orch.get('team-1')!.meta
    expect(meta.agentType).toBe('Explore')
    expect(meta.parentKernelId).toBe('team-parent')
    expect(meta.conversationId).toBe('conv-team')
    expect(meta.worktreePath).toBe('/wt/team')

    // Registry side: facade did NOT register on this path.
    expect(getActiveAgent('team-1')).toBeUndefined()
  })

  it('returns ok:false when orchestrator.register throws (registry untouched either way)', () => {
    const orch = getMultiAgentOrchestrator()
    vi.spyOn(orch, 'register').mockImplementation(() => {
      throw new Error('boom')
    })

    const result = trackAgentInOrchestrator({
      agentId: asAgentId('team-throw'),
      agentType: 'Explore',
      abortController: new AbortController(),
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/boom/)

    // Registry must be untouched — caller owns it on this path.
    expect(getActiveAgent('team-throw')).toBeUndefined()
  })

  it('shim.interrupt aborts the supplied AbortController', () => {
    const ac = new AbortController()
    const result = trackAgentInOrchestrator({
      agentId: asAgentId('team-abort'),
      agentType: 'Explore',
      abortController: ac,
    })
    expect(result.ok).toBe(true)
    registered.push(asAgentId('team-abort'))

    expect(ac.signal.aborted).toBe(false)
    getMultiAgentOrchestrator().interruptTree('team-abort', 'user')
    expect(ac.signal.aborted).toBe(true)
  })
})

describe('unspawnAndUntrackAgent', () => {
  it('drops both sides after a normal spawn', () => {
    const agent = makeAgent('u1', { parentAgentId: asAgentId('uparent') })
    expect(spawnAndTrackAgent(agent).ok).toBe(true)
    registered.push(agent.agentId)

    unspawnAndUntrackAgent(asAgentId('u1'))
    expect(getActiveAgent('u1')).toBeUndefined()
    expect(getMultiAgentOrchestrator().get('u1')).toBeUndefined()
    // No stale child edge under the parent.
    expect(getMultiAgentOrchestrator().listChildren('uparent')).toHaveLength(0)
  })

  it('is idempotent when called twice', () => {
    const agent = makeAgent('u2')
    expect(spawnAndTrackAgent(agent).ok).toBe(true)
    registered.push(agent.agentId)

    unspawnAndUntrackAgent(asAgentId('u2'))
    expect(() => unspawnAndUntrackAgent(asAgentId('u2'))).not.toThrow()
  })

  it('does not throw when only one side is registered', () => {
    // Only registry — no orchestrator edge.
    const agent = makeAgent('regOnly')
    expect(registerActiveAgent(agent).ok).toBe(true)
    expect(() => unspawnAndUntrackAgent(asAgentId('regOnly'))).not.toThrow()
    expect(getActiveAgent('regOnly')).toBeUndefined()
  })
})
