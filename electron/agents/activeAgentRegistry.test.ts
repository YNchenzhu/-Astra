import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  registerActiveAgent,
  unregisterActiveAgent,
  recordAgentTokenUsage,
  cleanupStaleAgents,
  getActiveAgent,
  sendToAgent,
  waitForAgentMailboxOrAbort,
  MAX_CONCURRENT_AGENTS,
} from './activeAgentRegistry'
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

describe('activeAgentRegistry', () => {
  it('refuses registration beyond MAX_CONCURRENT_AGENTS', () => {
    for (let i = 0; i < MAX_CONCURRENT_AGENTS; i++) {
      const id = `a${i}`
      const a = makeAgent(id)
      const r = registerActiveAgent(a)
      expect(r.ok).toBe(true)
      registered.push(id)
    }
    const overflow = makeAgent('overflow')
    const r = registerActiveAgent(overflow)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/Too many concurrent/)
  })

  it('recordAgentTokenUsage aborts when over maxTokenBudget', () => {
    const ac = new AbortController()
    const agent = makeAgent('budget-test', {
      abortController: ac,
      agentDef: { ...stubDef, maxTokenBudget: 80 },
    })
    const reg = registerActiveAgent(agent)
    expect(reg.ok).toBe(true)
    registered.push('budget-test')

    recordAgentTokenUsage('budget-test', 50, 40)
    expect(ac.signal.aborted).toBe(true)
    expect(agent.tokenBudgetExceeded).toBe(true)
  })

  it('recordAgentTokenUsage takes max of input across turns and sums output', () => {
    // Anthropic API semantics: `input_tokens` is per-turn cumulative (includes
    // the full conversation prefix). The previous implementation accumulated
    // input across turns, double-counting the prefix N times for an N-turn
    // run. The corrected accounting takes max(input) + sum(output).
    const ac = new AbortController()
    const agent = makeAgent('multi-turn', {
      abortController: ac,
      // Pick a budget high enough that the old buggy code (615) would trip
      // but the corrected code (315) would not — proves the fix end-to-end.
      agentDef: { ...stubDef, maxTokenBudget: 400 },
    })
    const reg = registerActiveAgent(agent)
    expect(reg.ok).toBe(true)
    registered.push('multi-turn')

    // Simulate 3 turns of cumulative input (100 → 200 → 300) + per-turn
    // output deltas (5 + 5 + 5).
    recordAgentTokenUsage('multi-turn', 100, 5)
    recordAgentTokenUsage('multi-turn', 200, 5)
    recordAgentTokenUsage('multi-turn', 300, 5)

    expect(agent.latestInputTokens).toBe(300)
    expect(agent.cumulativeOutputTokens).toBe(15)
    expect(agent.tokenCount).toBe(315)
    expect(ac.signal.aborted).toBe(false)
    expect(agent.tokenBudgetExceeded).toBeFalsy()
  })

  it('recordAgentTokenUsage tolerates non-monotonic input (max wins)', () => {
    // Defensive: a retry/recovery path might re-emit a smaller usage value
    // (e.g. the next iteration starts from a compacted prefix). Max ensures
    // we never under-count the largest prefix the model actually saw.
    const ac = new AbortController()
    const agent = makeAgent('non-monotonic', {
      abortController: ac,
      agentDef: { ...stubDef, maxTokenBudget: 10_000 },
    })
    const reg = registerActiveAgent(agent)
    expect(reg.ok).toBe(true)
    registered.push('non-monotonic')

    recordAgentTokenUsage('non-monotonic', 500, 10)
    recordAgentTokenUsage('non-monotonic', 200, 10) // smaller — must be ignored for input
    recordAgentTokenUsage('non-monotonic', 800, 10)

    expect(agent.latestInputTokens).toBe(800)
    expect(agent.cumulativeOutputTokens).toBe(30)
    expect(agent.tokenCount).toBe(830)
  })

  it('scheduleActiveAgentTimeout aborts after agentDef.timeout', async () => {
    vi.useFakeTimers()
    try {
      const ac = new AbortController()
      const agent = makeAgent('timeout-agent', {
        abortController: ac,
        agentDef: { ...stubDef, timeout: 80 },
      })
      const reg = registerActiveAgent(agent)
      expect(reg.ok).toBe(true)
      registered.push('timeout-agent')

      await vi.advanceTimersByTimeAsync(120)
      expect(ac.signal.aborted).toBe(true)
      expect(agent.status).toBe('failed')
    } finally {
      vi.useRealTimers()
      unregisterActiveAgent('timeout-agent')
      const i = registered.indexOf('timeout-agent')
      if (i >= 0) registered.splice(i, 1)
    }
  })

  it('waitForAgentMailboxOrAbort resolves when sendToAgent enqueues mail', async () => {
    const id = 'mailbox-1'
    const ac = new AbortController()
    const agent = makeAgent(id, { pendingMessages: [] })
    registerActiveAgent(agent)
    registered.push(id)

    const wait = waitForAgentMailboxOrAbort(id, ac.signal)
    queueMicrotask(() => {
      sendToAgent(id, 'ping')
    })
    await expect(wait).resolves.toBeUndefined()
    expect(getActiveAgent(id)?.pendingMessages).toEqual(['ping'])
  })

  it('cleanupStaleAgents evicts oldest terminal agents above TERMINAL_HISTORY_MAX', () => {
    // Sprint 3.3 redesigned terminal-row eviction from age-based to
    // capacity-based (see comment block at the top of activeAgentRegistry).
    // Default cap is 500; this test registers cap+2 terminals with strictly
    // ascending `endedAt` timestamps and verifies the two oldest are
    // evicted by FIFO while the most recent are retained.
    const cap = 500 // matches TERMINAL_HISTORY_MAX default
    const total = cap + 2
    const ids: string[] = []
    for (let i = 0; i < total; i++) {
      const id = `stale-${i}`
      const agent = makeAgent(id, {
        status: 'completed',
        startTime: 1_000 + i,
        endedAt: 1_000 + i,
      })
      registerActiveAgent(agent)
      ids.push(id)
      registered.push(id)
    }

    cleanupStaleAgents()

    // Oldest two evicted (FIFO by endedAt).
    expect(getActiveAgent('stale-0')).toBeUndefined()
    expect(getActiveAgent('stale-1')).toBeUndefined()
    // Newest retained.
    expect(getActiveAgent(`stale-${total - 1}`)).toBeDefined()
    // afterEach's `unregisterActiveAgent` is a no-op for already-evicted
    // ids, so leaving the full list in `registered` is safe.
  })

  it('cleanupStaleAgents marks running agents as failed when 2× timeout exceeded', () => {
    const ac = new AbortController()
    const limit = 5_000
    const agent = makeAgent('runaway-1', {
      status: 'running',
      abortController: ac,
      startTime: Date.now() - limit * 3,
      agentDef: { ...stubDef, timeout: limit },
    })
    registerActiveAgent(agent)
    registered.push('runaway-1')

    cleanupStaleAgents()

    expect(agent.status).toBe('failed')
    expect(ac.signal.aborted).toBe(true)
  })
})
