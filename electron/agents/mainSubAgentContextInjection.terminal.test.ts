/**
 * Regression coverage for B7 + C9: a background sub-agent that reaches a
 * terminal status (failed / completed / killed) MUST surface a notice to
 * the parent main loop on the next turn, even when it produced zero
 * streamed text. Without this surfacing, a sub-agent that crashes during
 * boot disappears silently and the parent has no signal it died.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { registerActiveAgent, unregisterActiveAgent } from './activeAgentRegistry'
import { injectPendingSubAgentOutputsForMainTurn } from './mainSubAgentContextInjection'
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
    parentAgentId: 'main',
    ...overrides,
  }
}

const registered: string[] = []
afterEach(() => {
  for (const id of registered.splice(0)) {
    unregisterActiveAgent(id)
  }
})

describe('mainSubAgentContextInjection — terminal-status surfacing', () => {
  it('B7+C9: failed sub-agent with empty latestTextOutput STILL emits a notice with the error', () => {
    const id = 'agent-bg-fail-1'
    const a = makeAgent(id, {
      status: 'failed',
      terminalError: 'model boot crashed: ENOENT',
      latestTextOutput: '',
    })
    registerActiveAgent(a)
    registered.push(id)

    const out = injectPendingSubAgentOutputsForMainTurn([
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'continue' },
    ])

    expect(out.length).toBe(3)
    const synthetic = String(out[1]!.content)
    expect(synthetic).toContain('Background sub-agents')
    expect(synthetic).toContain('agent-bg-fail-1')
    expect(synthetic).toContain('status: failed')
    expect(synthetic).toContain('model boot crashed: ENOENT')
    expect(synthetic).toContain('without producing any streamed output')
    // Notice must be marked one-shot so subsequent turns don't replay it
    expect(a.terminalNotifiedToMain).toBe(true)
  })

  it('completed sub-agent that produced text gets the normal text injection (no terminal-empty banner)', () => {
    const id = 'agent-bg-done-1'
    const a = makeAgent(id, {
      status: 'completed',
      latestTextOutput: 'final research findings',
    })
    registerActiveAgent(a)
    registered.push(id)

    const out = injectPendingSubAgentOutputsForMainTurn([
      { role: 'user', content: 'go' },
    ])

    const synthetic = String(out[0]!.content)
    expect(synthetic).toContain('final research findings')
    expect(synthetic).toContain('status: completed')
    expect(synthetic).not.toContain('without producing any streamed output')
  })

  it('terminal notice is one-shot — subsequent turns do not re-emit it', () => {
    const id = 'agent-bg-fail-2'
    const a = makeAgent(id, {
      status: 'failed',
      terminalError: 'crash',
      latestTextOutput: '',
    })
    registerActiveAgent(a)
    registered.push(id)

    const first = injectPendingSubAgentOutputsForMainTurn([
      { role: 'user', content: 'turn-1' },
    ])
    expect(String(first[0]!.content)).toContain('status: failed')

    const second = injectPendingSubAgentOutputsForMainTurn([
      { role: 'user', content: 'turn-2' },
    ])
    expect(second.length).toBe(1)
    expect(String(second[0]!.content)).toBe('turn-2')
  })

  it('still skips running sub-agents that have produced no new delta (no false positives)', () => {
    const id = 'agent-bg-quiet'
    const a = makeAgent(id, {
      status: 'running',
      latestTextOutput: '',
    })
    registerActiveAgent(a)
    registered.push(id)

    const out = injectPendingSubAgentOutputsForMainTurn([
      { role: 'user', content: 'go' },
    ])
    expect(out.length).toBe(1)
    expect(String(out[0]!.content)).toBe('go')
  })

  // ── Hard C9 — supervisor-style interrupt at iteration boundary ──
  //
  // The "soft" C9 that landed earlier surfaces sub-agent failure on the
  // NEXT user-driven main turn. That's still too late: a sub-agent that
  // crashes while the parent is mid-turn (e.g. doing other tool work)
  // would not be visible until the human typed again. Hard C9 invokes
  // the same injector at every agentic-loop iteration boundary inside
  // the parent's CURRENT turn (see `runPreModelPhase`). The two tests
  // below codify the contract that the injector behaves correctly when
  // called multiple times over the lifecycle of a single parent turn.

  it('hard C9: sub-agent flips from running → failed BETWEEN injection points; second call surfaces failure mid-turn', () => {
    const id = 'agent-mid-turn-fail'
    // Simulate iteration 1 (streamHandler entry): agent still booting
    const a = makeAgent(id, {
      status: 'running',
      latestTextOutput: '',
    })
    registerActiveAgent(a)
    registered.push(id)

    // Iter 1 — streamHandler-style entry call, agent has nothing yet.
    const iter1 = injectPendingSubAgentOutputsForMainTurn([
      { role: 'user', content: 'kick off background work' },
    ])
    expect(iter1.length).toBe(1)
    expect(a.terminalNotifiedToMain).not.toBe(true)

    // While the parent's iteration 1 was busy with other tools,
    // the background sub-agent crashed.
    a.status = 'failed'
    a.terminalError = 'spawn ENOENT'

    // Iter 2 — preModel-phase call (the new hard-C9 surface).
    // The failure must appear in the synthetic <system-reminder> NOW,
    // without waiting for another user message.
    const iter2 = injectPendingSubAgentOutputsForMainTurn([
      { role: 'user', content: 'kick off background work' },
    ])
    expect(iter2.length).toBe(2)
    const synthetic = String(iter2[0]!.content)
    expect(synthetic).toContain('status: failed')
    expect(synthetic).toContain('spawn ENOENT')
    expect(a.terminalNotifiedToMain).toBe(true)
  })

  it('hard C9: subsequent iteration-boundary calls in the same turn do NOT re-emit the same notice', () => {
    const id = 'agent-once-per-turn'
    const a = makeAgent(id, {
      status: 'failed',
      terminalError: 'boom',
      latestTextOutput: '',
    })
    registerActiveAgent(a)
    registered.push(id)

    // Iter 1 — streamHandler call surfaces failure.
    const iter1 = injectPendingSubAgentOutputsForMainTurn([
      { role: 'user', content: 'go' },
    ])
    expect(String(iter1[0]!.content)).toContain('status: failed')

    // Iter 2 — preModel call. Already notified, nothing new.
    const iter2 = injectPendingSubAgentOutputsForMainTurn([
      { role: 'user', content: 'go' },
    ])
    expect(iter2.length).toBe(1)
    expect(String(iter2[0]!.content)).toBe('go')

    // Iter 3 — preModel call again, still nothing new.
    const iter3 = injectPendingSubAgentOutputsForMainTurn([
      { role: 'user', content: 'go' },
    ])
    expect(iter3.length).toBe(1)
  })

  it('rewind path: when injection is deferred (orphan tool_use), terminal-notified flag rolls back so next clean turn re-emits', () => {
    const id = 'agent-bg-rewind'
    const a = makeAgent(id, {
      status: 'failed',
      terminalError: 'crash',
      latestTextOutput: '',
    })
    registerActiveAgent(a)
    registered.push(id)

    // Build messages with an orphan tool_use on the last assistant turn:
    // assistant has tool_use id=t1, but user has no matching tool_result.
    // injectPendingSubAgentOutputsForMainTurn must DEFER injection and
    // restore the per-agent state to the pre-collect snapshot.
    const orphan = injectPendingSubAgentOutputsForMainTurn([
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }],
      },
      { role: 'user', content: 'follow-up' },
    ])
    // Defer outcome: pass-through unchanged
    expect(orphan.length).toBe(2)
    expect(a.terminalNotifiedToMain).not.toBe(true)

    // Next clean turn — the deferred terminal notice MUST re-emit
    const clean = injectPendingSubAgentOutputsForMainTurn([
      { role: 'user', content: 'now' },
    ])
    const synthetic = String(clean[0]!.content)
    expect(synthetic).toContain('status: failed')
    expect(synthetic).toContain('crash')
    expect(a.terminalNotifiedToMain).toBe(true)
  })
})
