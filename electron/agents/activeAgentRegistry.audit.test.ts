/**
 * Depth audit of the sub-agent task lifecycle (activeAgentRegistry).
 *
 * Focus: terminal-state-machine consistency, timer cleanup on every terminal
 * transition, mailbox back-pressure semantics, and mailbox-wait edge cases.
 * Some of these tests document confirmed defects (see comments) and will be
 * flipped to passing once the registry centralizes terminal teardown.
 */
import { describe, it, expect, afterEach } from 'vitest'
import {
  registerActiveAgent,
  unregisterActiveAgent,
  recordAgentTokenUsage,
  cleanupStaleAgents,
  enqueueAgentMailboxMessage,
  waitForAgentMailboxOrAbort,
  lookupActiveAgent,
  markActiveAgentKilled,
  DEFAULT_AGENT_TIMEOUT_MS,
} from './activeAgentRegistry'
import type { ActiveAgent, BuiltInAgentDefinition } from './types'

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
  for (const id of registered.splice(0)) unregisterActiveAgent(id)
})

describe('terminal transitions clear the wall-clock timeout (no timer leak)', () => {
  it('token-budget abort clears the armed timeout handle', () => {
    const agent = makeAgent('audit-budget', { agentDef: { ...stubDef, maxTokenBudget: 80 } })
    expect(registerActiveAgent(agent).ok).toBe(true)
    registered.push('audit-budget')
    // Armed at registration because status === 'running'.
    expect(agent.timeoutHandle).toBeDefined()

    recordAgentTokenUsage('audit-budget', 50, 40) // 90 > 80 -> failed + abort
    expect(agent.status).toBe('failed')
    expect(agent.abortController.signal.aborted).toBe(true)
    // The agent is terminal now; the wall-clock timer must not linger.
    expect(agent.timeoutHandle).toBeUndefined()
  })

  it('stale-cleanup failure transition clears the armed timeout handle', () => {
    const agent = makeAgent('audit-stale', {
      agentDef: { ...stubDef, timeout: 1000 },
      startTime: Date.now() - 5000, // > 2× timeout
    })
    expect(registerActiveAgent(agent).ok).toBe(true)
    registered.push('audit-stale')
    expect(agent.timeoutHandle).toBeDefined()

    cleanupStaleAgents()
    expect(agent.status).toBe('failed')
    expect(agent.abortController.signal.aborted).toBe(true)
    expect(agent.timeoutHandle).toBeUndefined()
  })
})

describe('mailbox back-pressure (enqueueAgentMailboxMessage)', () => {
  it('drops the oldest message and bumps the drop counter at capacity', () => {
    // Use a small cap via direct push simulation: default cap is 256, so push
    // 257 distinct messages and assert FIFO-oldest eviction.
    const agent = makeAgent('audit-mailbox')
    expect(registerActiveAgent(agent).ok).toBe(true)
    registered.push('audit-mailbox')

    for (let i = 0; i < 256; i++) enqueueAgentMailboxMessage(agent, `m${i}`)
    expect(agent.pendingMessages.length).toBe(256)
    expect(agent.mailboxDroppedCount ?? 0).toBe(0)

    const res = enqueueAgentMailboxMessage(agent, 'overflow')
    expect(agent.pendingMessages.length).toBe(256) // capped
    expect(agent.pendingMessages[0]).toBe('m1') // oldest 'm0' dropped
    expect(agent.pendingMessages[agent.pendingMessages.length - 1]).toBe('overflow')
    expect(res.droppedOldest).toBe(true)
    expect(agent.mailboxDroppedCount).toBe(1)
  })
})

describe('waitForAgentMailboxOrAbort edge cases', () => {
  it('resolves immediately when mail already pending', async () => {
    const agent = makeAgent('audit-wait-pending', { pendingMessages: ['hi'] })
    expect(registerActiveAgent(agent).ok).toBe(true)
    registered.push('audit-wait-pending')
    await expect(
      waitForAgentMailboxOrAbort(agent.agentId as never, new AbortController().signal),
    ).resolves.toBeUndefined()
  })

  it('rejects immediately when the signal is already aborted', async () => {
    const agent = makeAgent('audit-wait-aborted')
    expect(registerActiveAgent(agent).ok).toBe(true)
    registered.push('audit-wait-aborted')
    const ac = new AbortController()
    ac.abort()
    await expect(
      waitForAgentMailboxOrAbort(agent.agentId as never, ac.signal),
    ).rejects.toThrow(/abort/i)
  })

  it('rejects pending waiters when the agent is unregistered', async () => {
    const agent = makeAgent('audit-wait-unreg')
    expect(registerActiveAgent(agent).ok).toBe(true)
    const p = waitForAgentMailboxOrAbort(agent.agentId as never, new AbortController().signal)
    const assertion = expect(p).rejects.toThrow(/unregistered/i)
    unregisterActiveAgent('audit-wait-unreg' as never)
    await assertion
  })
})

describe('R3 — unregistering a running agent aborts its controller (no orphan loop)', () => {
  it('aborts the AbortController when the agent is still running', () => {
    const agent = makeAgent('audit-unreg-running')
    expect(registerActiveAgent(agent).ok).toBe(true)
    expect(agent.abortController.signal.aborted).toBe(false)

    unregisterActiveAgent('audit-unreg-running' as never)
    expect(agent.abortController.signal.aborted).toBe(true)
  })

  it('does not throw when unregistering a terminal (non-running) agent', () => {
    const agent = makeAgent('audit-unreg-terminal', { status: 'completed', endedAt: Date.now() })
    expect(registerActiveAgent(agent).ok).toBe(true)
    expect(() => unregisterActiveAgent('audit-unreg-terminal' as never)).not.toThrow()
  })
})

describe('R2 — lookupActiveAgent disambiguates name collisions (abort-by-name contract)', () => {
  it('returns not_found for an unknown id/name', () => {
    expect(lookupActiveAgent('nope').kind).toBe('not_found')
  })

  it('returns found for an exact id match', () => {
    const agent = makeAgent('audit-lookup-id')
    expect(registerActiveAgent(agent).ok).toBe(true)
    registered.push('audit-lookup-id')
    const r = lookupActiveAgent('audit-lookup-id')
    expect(r.kind).toBe('found')
  })

  it('returns found for a unique running name', () => {
    const agent = makeAgent('audit-lookup-name-1', { name: 'worker' })
    expect(registerActiveAgent(agent).ok).toBe(true)
    registered.push('audit-lookup-name-1')
    const r = lookupActiveAgent('worker')
    expect(r.kind).toBe('found')
    if (r.kind === 'found') expect(r.agent.agentId).toBe('audit-lookup-name-1')
  })

  it('returns ambiguous when ≥2 RUNNING agents share a name', () => {
    const a = makeAgent('audit-amb-1', { name: 'dup' })
    const b = makeAgent('audit-amb-2', { name: 'dup' })
    expect(registerActiveAgent(a).ok).toBe(true)
    expect(registerActiveAgent(b).ok).toBe(true)
    registered.push('audit-amb-1', 'audit-amb-2')
    const r = lookupActiveAgent('dup')
    expect(r.kind).toBe('ambiguous')
    if (r.kind === 'ambiguous') expect(r.count).toBe(2)
  })

  it('excludes terminal namesakes from name resolution', () => {
    const running = makeAgent('audit-name-running', { name: 'shared' })
    const done = makeAgent('audit-name-done', { name: 'shared', status: 'completed', endedAt: Date.now() })
    expect(registerActiveAgent(running).ok).toBe(true)
    expect(registerActiveAgent(done).ok).toBe(true)
    registered.push('audit-name-running', 'audit-name-done')
    const r = lookupActiveAgent('shared')
    // Only the running one is eligible → unambiguous found.
    expect(r.kind).toBe('found')
    if (r.kind === 'found') expect(r.agent.agentId).toBe('audit-name-running')
  })
})

describe('R4 — markActiveAgentKilled shares the terminal invariant (kill path)', () => {
  it('aborts, flips to killed, stamps endedAt, and clears the armed timer', () => {
    const agent = makeAgent('audit-kill')
    expect(registerActiveAgent(agent).ok).toBe(true)
    registered.push('audit-kill')
    expect(agent.timeoutHandle).toBeDefined()

    markActiveAgentKilled(agent)

    expect(agent.abortController.signal.aborted).toBe(true)
    expect(agent.status).toBe('killed')
    expect(typeof agent.endedAt).toBe('number')
    expect(agent.timeoutHandle).toBeUndefined()
  })

  it('aborts BEFORE flipping status (no "killed but still running" window)', () => {
    const agent = makeAgent('audit-kill-order')
    expect(registerActiveAgent(agent).ok).toBe(true)
    registered.push('audit-kill-order')
    // Observe the invariant: when the abort fires, status must not yet have
    // been left as a stale 'running' that downstream checks could race on.
    let statusWhenAborted: string | undefined
    agent.abortController.signal.addEventListener('abort', () => {
      statusWhenAborted = agent.status
    })
    markActiveAgentKilled(agent)
    // The abort listener runs synchronously during abort(), before status flip.
    expect(statusWhenAborted).toBe('running')
    expect(agent.status).toBe('killed')
  })

  it('does not stamp a terminalError for a deliberate kill', () => {
    const agent = makeAgent('audit-kill-noerror')
    expect(registerActiveAgent(agent).ok).toBe(true)
    registered.push('audit-kill-noerror')
    markActiveAgentKilled(agent)
    expect(agent.terminalError).toBeUndefined()
  })
})

describe('sanity: default timeout constant', () => {
  it('is 30 minutes', () => {
    expect(DEFAULT_AGENT_TIMEOUT_MS).toBe(30 * 60 * 1000)
  })
})
