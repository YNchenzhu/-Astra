import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  awaitChatLeaderPlanApproval,
  buildTeamPlanApprovalResponsePayload,
  getChatLeaderPlanApprovalConversationId,
  resolveTeamLeaderPlanApprovalResponse,
  tryResolveTeamPlanApprovalFromProtocolMessage,
} from './teamPlanApprovalLeaderBridge'
import {
  TEAM_INTER_AGENT_SCHEMA,
  parseTeamInterAgentLine,
} from './teamInterAgentProtocol'
import { formatTeamMailboxEnvelopeLine } from '../tools/TeamCreateTool'
import {
  runWithAgentContextAsync,
  type AgentContext,
} from './agentContext'
import {
  cancelAllPendingInteractions,
  cancelPendingInteractionsForConversation,
  setStreamEventSender,
} from '../ai/interactionState'
import { asAgentId } from '../tools/ids'
import type { ProviderConfig } from '../ai/client'

const minimalCtx = (overrides: Partial<AgentContext>): AgentContext => {
  const config: ProviderConfig = { id: 'anthropic', name: 't', apiKey: '' }
  return {
    config,
    model: 'm',
    systemPrompt: '',
    messages: [],
    signal: new AbortController().signal,
    agentId: asAgentId('worker-1'),
    ...overrides,
  }
}

describe('teamPlanApprovalLeaderBridge (P0-2, cc-haha §6.2)', () => {
  it('resolveTeamLeaderPlanApprovalResponse returns false for unknown id', () => {
    expect(
      resolveTeamLeaderPlanApprovalResponse({
        teamRequestId: 'tplan-missing',
        approved: true,
      }),
    ).toBe(false)
  })

  it('tryResolveTeamPlanApprovalFromProtocolMessage returns false when no waiter', () => {
    const msg = {
      schema: TEAM_INTER_AGENT_SCHEMA,
      kind: 'plan_approval_response' as const,
      requestId: 'tplan-nobody',
      approve: true,
    }
    expect(tryResolveTeamPlanApprovalFromProtocolMessage(msg)).toBe(false)
  })

  it('tryResolveTeamPlanApprovalFromProtocolMessage rejects unrelated kinds', () => {
    const msg = {
      schema: TEAM_INTER_AGENT_SCHEMA,
      kind: 'permission_response' as const,
      requestId: 'tperm-1',
      approve: true,
    }
    expect(tryResolveTeamPlanApprovalFromProtocolMessage(msg)).toBe(false)
  })

  it('tryResolveTeamPlanApprovalFromProtocolMessage rejects empty requestId', () => {
    const msg = {
      schema: TEAM_INTER_AGENT_SCHEMA,
      kind: 'plan_approval_response' as const,
      requestId: '',
      approve: true,
    }
    expect(tryResolveTeamPlanApprovalFromProtocolMessage(msg)).toBe(false)
  })

  it('buildTeamPlanApprovalResponsePayload emits a parseable envelope (approve=true)', () => {
    const inner = buildTeamPlanApprovalResponsePayload({
      teamRequestId: 'tplan-a1',
      approve: true,
      detail: 'lgtm — proceed',
    })
    const line = formatTeamMailboxEnvelopeLine({
      from: 'lead',
      to: 'worker',
      teamName: 'Squad',
      type: 'task',
      payload: inner,
    })
    const p = parseTeamInterAgentLine(line)
    expect(p?.kind).toBe('plan_approval_response')
    expect(p?.requestId).toBe('tplan-a1')
    expect(p?.approve).toBe(true)
    expect(p?.detail).toBe('lgtm — proceed')
  })

  it('buildTeamPlanApprovalResponsePayload emits a parseable envelope (approve=false, no detail)', () => {
    const inner = buildTeamPlanApprovalResponsePayload({
      teamRequestId: 'tplan-d1',
      approve: false,
    })
    const line = formatTeamMailboxEnvelopeLine({
      from: 'lead',
      to: 'worker',
      teamName: 'Squad',
      type: 'task',
      payload: inner,
    })
    const p = parseTeamInterAgentLine(line)
    expect(p?.kind).toBe('plan_approval_response')
    expect(p?.requestId).toBe('tplan-d1')
    expect(p?.approve).toBe(false)
    expect(p?.detail).toBeUndefined()
  })

  it('buildTeamPlanApprovalResponsePayload trims whitespace from requestId', () => {
    const inner = buildTeamPlanApprovalResponsePayload({
      teamRequestId: '  tplan-trim  ',
      approve: true,
    })
    const p = parseTeamInterAgentLine(
      formatTeamMailboxEnvelopeLine({
        from: 'lead',
        to: 'worker',
        teamName: 'Squad',
        type: 'task',
        payload: inner,
      }),
    )
    expect(p?.requestId).toBe('tplan-trim')
  })
})

describe('getChatLeaderPlanApprovalConversationId (P0-2 follow-up)', () => {
  afterEach(() => {
    delete process.env.ASTRA_TEAM_LEADER_PLAN_APPROVAL_MAILBOX
  })

  it('returns undefined outside an ALS agent context', () => {
    expect(getChatLeaderPlanApprovalConversationId()).toBeUndefined()
  })

  it('returns undefined when agent context lacks planApprovalDelegateConversationId', async () => {
    const ctx = minimalCtx({})
    let result: string | undefined = 'sentinel'
    await runWithAgentContextAsync(ctx, async () => {
      result = getChatLeaderPlanApprovalConversationId()
    })
    expect(result).toBeUndefined()
  })

  it('returns the conversation id when set on the context', async () => {
    const ctx = minimalCtx({ planApprovalDelegateConversationId: 'conv-leader-123' })
    let result: string | undefined
    await runWithAgentContextAsync(ctx, async () => {
      result = getChatLeaderPlanApprovalConversationId()
    })
    expect(result).toBe('conv-leader-123')
  })

  it('returns undefined for the main agent even when delegate id is set', async () => {
    const ctx = minimalCtx({
      agentId: asAgentId('main'),
      planApprovalDelegateConversationId: 'conv-leader-123',
    })
    let result: string | undefined = 'sentinel'
    await runWithAgentContextAsync(ctx, async () => {
      result = getChatLeaderPlanApprovalConversationId()
    })
    expect(result).toBeUndefined()
  })

  it('returns undefined when env kill-switch is on', async () => {
    process.env.ASTRA_TEAM_LEADER_PLAN_APPROVAL_MAILBOX = '0'
    const ctx = minimalCtx({ planApprovalDelegateConversationId: 'conv-leader-123' })
    let result: string | undefined = 'sentinel'
    await runWithAgentContextAsync(ctx, async () => {
      result = getChatLeaderPlanApprovalConversationId()
    })
    expect(result).toBeUndefined()
  })

  it('treats whitespace-only delegate id as unset', async () => {
    const ctx = minimalCtx({ planApprovalDelegateConversationId: '   ' })
    let result: string | undefined = 'sentinel'
    await runWithAgentContextAsync(ctx, async () => {
      result = getChatLeaderPlanApprovalConversationId()
    })
    expect(result).toBeUndefined()
  })
})

describe('awaitChatLeaderPlanApproval (P0-2 follow-up)', () => {
  it('emits a team_plan_approval_request event tagged with the leader conversation id', async () => {
    const events: Array<Record<string, unknown>> = []
    setStreamEventSender((e) => {
      events.push(e)
    })

    try {
      const ctx = minimalCtx({})
      const decisionPromise = runWithAgentContextAsync(ctx, async () =>
        awaitChatLeaderPlanApproval({
          delegateConversationId: 'conv-leader-X',
          planMarkdown: '# Plan\n- step 1\n- step 2',
        }),
      )
      // Give the event emit a microtask to flush.
      await new Promise((resolve) => setImmediate(resolve))

      const planEvt = events.find((e) => e.type === 'team_plan_approval_request')
      expect(planEvt).toBeDefined()
      expect(planEvt?.conversationId).toBe('conv-leader-X')
      expect(typeof planEvt?.teamRequestId).toBe('string')
      expect(planEvt?.workerAgentId).toBe('worker-1')
      expect(planEvt?.planMarkdown).toContain('step 1')

      // Resolve the worker's wait via the shared resolver, then await the
      // promise so the test's lifetime tracks the actual lifecycle.
      const requestId = planEvt?.teamRequestId as string
      const ok = resolveTeamLeaderPlanApprovalResponse({
        teamRequestId: requestId,
        approved: true,
        detail: 'go ahead',
      })
      expect(ok).toBe(true)

      const decision = await decisionPromise
      expect(decision.approved).toBe(true)
      expect(decision.reason).toBe('lead_decision')
      expect(decision.detail).toBe('go ahead')
    } finally {
      setStreamEventSender(null)
    }
  })

  it('returns no_leader when delegate conversation id is empty', async () => {
    const ctx = minimalCtx({})
    const decision = await runWithAgentContextAsync(ctx, async () =>
      awaitChatLeaderPlanApproval({
        delegateConversationId: '',
        planMarkdown: '# Plan',
      }),
    )
    expect(decision.approved).toBe(false)
    expect(decision.reason).toBe('no_leader')
  })

  it('honours an aborted signal as a denial with reason=aborted', async () => {
    setStreamEventSender(() => {})
    try {
      const ac = new AbortController()
      ac.abort()
      const ctx = minimalCtx({})
      const decision = await runWithAgentContextAsync(ctx, async () =>
        awaitChatLeaderPlanApproval({
          delegateConversationId: 'conv-leader-X',
          planMarkdown: '# Plan',
          signal: ac.signal,
        }),
      )
      expect(decision.approved).toBe(false)
      expect(decision.reason).toBe('aborted')
    } finally {
      setStreamEventSender(null)
    }
  })

  it('truncates oversized plan bodies before delivery', async () => {
    const events: Array<Record<string, unknown>> = []
    setStreamEventSender((e) => {
      events.push(e)
    })
    try {
      const big = 'x'.repeat(50_000)
      const ctx = minimalCtx({})
      const decisionPromise = runWithAgentContextAsync(ctx, async () =>
        awaitChatLeaderPlanApproval({
          delegateConversationId: 'conv-leader-X',
          planMarkdown: big,
        }),
      )
      await new Promise((resolve) => setImmediate(resolve))
      const evt = events.find((e) => e.type === 'team_plan_approval_request')
      const body = (evt?.planMarkdown as string) ?? ''
      // Truncated to 24K with a marker; not the original 50K.
      expect(body.length).toBeLessThan(big.length)
      expect(body).toContain('truncated for mailbox delivery')

      // Cleanup.
      const tid = evt?.teamRequestId as string
      resolveTeamLeaderPlanApprovalResponse({
        teamRequestId: tid,
        approved: false,
      })
      await decisionPromise
    } finally {
      setStreamEventSender(null)
    }
  })

  // Avoid lint warning about unused `vi` import on tests that don't mock —
  // a few of the tests above could swap to `vi.spyOn` later without churn.
  it('module-level vi import stays used', () => {
    expect(vi.fn).toBeDefined()
  })
})

/**
 * Drain-hook tests (added with the post-implementation audit fix). The
 * teammate bridge now registers with `cancelPendingInteractionsForConversation`
 * and `cancelAllPendingInteractions` so a single `cancelStream` wakes any
 * parked plan-approval Promise — without these hooks, the worker would
 * block in `tool.call()` until the 10-minute timeout fired.
 */
describe('teamPlanApprovalLeaderBridge — cancel drain hooks (audit follow-up)', () => {
  afterEach(() => {
    // Defensive: drain anything a failing test left parked.
    cancelAllPendingInteractions()
    setStreamEventSender(null)
  })

  it('cancelPendingInteractionsForConversation wakes a wait when the LEADER conv matches', async () => {
    setStreamEventSender(() => {})
    const ctx = minimalCtx({ streamConversationId: 'conv-worker' })
    const p = runWithAgentContextAsync(ctx, async () =>
      awaitChatLeaderPlanApproval({
        delegateConversationId: 'conv-leader',
        planMarkdown: '# Plan',
      }),
    )
    await new Promise((r) => setImmediate(r))

    cancelPendingInteractionsForConversation('conv-leader')
    const d = await p
    expect(d.approved).toBe(false)
    expect(d.reason).toBe('aborted')
  })

  it('cancelPendingInteractionsForConversation wakes a wait when the WORKER conv matches', async () => {
    setStreamEventSender(() => {})
    const ctx = minimalCtx({ streamConversationId: 'conv-worker' })
    const p = runWithAgentContextAsync(ctx, async () =>
      awaitChatLeaderPlanApproval({
        delegateConversationId: 'conv-leader',
        planMarkdown: '# Plan',
      }),
    )
    await new Promise((r) => setImmediate(r))

    cancelPendingInteractionsForConversation('conv-worker')
    const d = await p
    expect(d.approved).toBe(false)
    expect(d.reason).toBe('aborted')
  })

  it('cancelPendingInteractionsForConversation does NOT wake unrelated convs', async () => {
    setStreamEventSender(() => {})
    const ctx = minimalCtx({ streamConversationId: 'conv-worker' })
    const p = runWithAgentContextAsync(ctx, async () =>
      awaitChatLeaderPlanApproval({
        delegateConversationId: 'conv-leader',
        planMarkdown: '# Plan',
      }),
    )
    await new Promise((r) => setImmediate(r))

    cancelPendingInteractionsForConversation('conv-unrelated')

    // The wait is still parked. Resolve manually so we can await without
    // hanging the test runner.
    let resolved = false
    void p.then(() => {
      resolved = true
    })
    await new Promise((r) => setImmediate(r))
    expect(resolved).toBe(false)

    // Cleanup: resolve via the all-cancel hook so the test exits clean.
    cancelAllPendingInteractions()
    await p
  })

  it('cancelAllPendingInteractions wakes every parked wait', async () => {
    setStreamEventSender(() => {})
    const ctxA = minimalCtx({ streamConversationId: 'conv-worker-A' })
    const ctxB = minimalCtx({ streamConversationId: 'conv-worker-B' })
    const pA = runWithAgentContextAsync(ctxA, async () =>
      awaitChatLeaderPlanApproval({
        delegateConversationId: 'conv-leader-A',
        planMarkdown: '# Plan A',
      }),
    )
    const pB = runWithAgentContextAsync(ctxB, async () =>
      awaitChatLeaderPlanApproval({
        delegateConversationId: 'conv-leader-B',
        planMarkdown: '# Plan B',
      }),
    )
    await new Promise((r) => setImmediate(r))

    cancelAllPendingInteractions()
    const [a, b] = await Promise.all([pA, pB])
    expect(a.approved).toBe(false)
    expect(a.reason).toBe('aborted')
    expect(b.approved).toBe(false)
    expect(b.reason).toBe('aborted')
  })
})
