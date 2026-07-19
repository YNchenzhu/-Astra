/**
 * Unit tests for the main-chat plan-approval bridge — covers the
 * tri-state outcome contract (the IDE `create_plan`-style) and the
 * drain-hook integration with `cancelPendingInteractionsForConversation`
 * (the fix landed in the post-implementation audit).
 *
 * Test areas:
 *   - `resolveMainChatPlanApprovalResponse` accepts/rejects/cancels by id.
 *   - `awaitMainChatPlanApproval` emits a tagged `plan_approval_request`
 *     event with the right envelope shape (name / overview / todos /
 *     phases / isProject / allowedPrompts).
 *   - Pre-aborted signal resolves immediately as cancelled+aborted.
 *   - Abort signal mid-wait resolves as cancelled+aborted.
 *   - Timeout path resolves as rejected+timeout (overridden via env so
 *     the test runs in milliseconds, not 10 minutes).
 *   - Drain hook (`cancelPendingInteractionsForConversation`) wakes only
 *     the matching conversation's waits.
 *   - All-cancel hook (`cancelAllPendingInteractions`) wakes everything.
 *   - Plan body > 24 KB is truncated before emit.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  awaitMainChatPlanApproval,
  resolveMainChatPlanApprovalResponse,
} from './mainChatPlanApprovalBridge'
import {
  cancelAllPendingInteractions,
  cancelPendingInteractionsForConversation,
  setStreamEventSender,
} from '../ai/interactionState'
import {
  runWithAgentContextAsync,
  type AgentContext,
} from './agentContext'
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
    agentId: asAgentId('main'),
    ...overrides,
  }
}

/**
 * Capture every stream event the bridge emits during a test. Each entry
 * is the raw event payload, including the `conversationId` tag the
 * `emit()` helper adds.
 */
function captureStreamEvents(): {
  events: Array<Record<string, unknown>>
  restore: () => void
} {
  const events: Array<Record<string, unknown>> = []
  setStreamEventSender((e) => {
    events.push(e)
  })
  return { events, restore: () => setStreamEventSender(null) }
}

afterEach(() => {
  // Defensive: drain anything a failing test left parked so the next
  // test starts with a clean module-level map.
  cancelAllPendingInteractions()
  setStreamEventSender(null)
  delete process.env.ASTRA_MAIN_PLAN_APPROVAL_TIMEOUT_MS
})

describe('mainChatPlanApprovalBridge — resolver direct path', () => {
  it('returns false when the requestId is unknown', () => {
    expect(
      resolveMainChatPlanApprovalResponse({
        requestId: 'plan-does-not-exist',
        outcome: 'accepted',
      }),
    ).toBe(false)
  })

  it('resolves with accepted + user_decision when the resolver fires', async () => {
    const cap = captureStreamEvents()
    try {
      const ctx = minimalCtx({ streamConversationId: 'conv-A' })
      const decisionPromise = runWithAgentContextAsync(ctx, async () =>
        awaitMainChatPlanApproval({ planMarkdown: '# Plan' }),
      )
      await new Promise((r) => setImmediate(r))

      const evt = cap.events.find((e) => e.type === 'plan_approval_request')
      expect(evt).toBeDefined()
      expect(evt?.conversationId).toBe('conv-A')
      const requestId = evt?.requestId as string
      expect(typeof requestId).toBe('string')

      const ok = resolveMainChatPlanApprovalResponse({
        requestId,
        outcome: 'accepted',
        detail: 'go',
      })
      expect(ok).toBe(true)

      const decision = await decisionPromise
      expect(decision.outcome).toBe('accepted')
      expect(decision.reason).toBe('user_decision')
      expect(decision.detail).toBe('go')
    } finally {
      cap.restore()
    }
  })

  it('resolves with rejected when the resolver picks reject', async () => {
    const cap = captureStreamEvents()
    try {
      const ctx = minimalCtx({ streamConversationId: 'conv-B' })
      const p = runWithAgentContextAsync(ctx, async () =>
        awaitMainChatPlanApproval({ planMarkdown: '# Plan' }),
      )
      await new Promise((r) => setImmediate(r))
      const requestId = cap.events.find((e) => e.type === 'plan_approval_request')
        ?.requestId as string

      resolveMainChatPlanApprovalResponse({
        requestId,
        outcome: 'rejected',
        detail: 'too broad',
      })
      const d = await p
      expect(d.outcome).toBe('rejected')
      expect(d.detail).toBe('too broad')
    } finally {
      cap.restore()
    }
  })

  it('resolves with cancelled when the resolver picks cancel', async () => {
    const cap = captureStreamEvents()
    try {
      const ctx = minimalCtx({ streamConversationId: 'conv-C' })
      const p = runWithAgentContextAsync(ctx, async () =>
        awaitMainChatPlanApproval({ planMarkdown: '# Plan' }),
      )
      await new Promise((r) => setImmediate(r))
      const requestId = cap.events.find((e) => e.type === 'plan_approval_request')
        ?.requestId as string

      resolveMainChatPlanApprovalResponse({
        requestId,
        outcome: 'cancelled',
      })
      const d = await p
      expect(d.outcome).toBe('cancelled')
      expect(d.reason).toBe('user_decision')
    } finally {
      cap.restore()
    }
  })

  it('a second resolve for the same id is a no-op (returns false)', async () => {
    const cap = captureStreamEvents()
    try {
      const ctx = minimalCtx({ streamConversationId: 'conv-D' })
      const p = runWithAgentContextAsync(ctx, async () =>
        awaitMainChatPlanApproval({ planMarkdown: '# Plan' }),
      )
      await new Promise((r) => setImmediate(r))
      const requestId = cap.events.find((e) => e.type === 'plan_approval_request')
        ?.requestId as string

      expect(
        resolveMainChatPlanApprovalResponse({ requestId, outcome: 'accepted' }),
      ).toBe(true)
      // Second resolve — already cleared from the pending map.
      expect(
        resolveMainChatPlanApprovalResponse({ requestId, outcome: 'rejected' }),
      ).toBe(false)

      await p
    } finally {
      cap.restore()
    }
  })
})

describe('mainChatPlanApprovalBridge — envelope shape', () => {
  it('emits the structured envelope (name/overview/todos/phases/isProject/allowedPrompts)', async () => {
    const cap = captureStreamEvents()
    try {
      const ctx = minimalCtx({ streamConversationId: 'conv-shape' })
      const p = runWithAgentContextAsync(ctx, async () =>
        awaitMainChatPlanApproval({
          planMarkdown: '# Plan',
          name: 'Refactor X',
          overview: 'Replace Y with Z.',
          isProject: true,
          todos: [
            { id: 't1', content: 'audit', status: 'completed' },
            { id: 't2', content: 'implement', status: 'pending' },
          ],
          phases: [
            { name: 'Phase 1', todos: [{ content: 'read', status: 'completed' }] },
          ],
          allowedPrompts: [{ tool: 'Bash', prompt: 'npm test' }],
        }),
      )
      await new Promise((r) => setImmediate(r))

      const evt = cap.events.find((e) => e.type === 'plan_approval_request')
      expect(evt).toBeDefined()
      expect(evt?.conversationId).toBe('conv-shape')

      const env = evt?.planEnvelope as Record<string, unknown> | undefined
      expect(env).toBeDefined()
      expect(env?.name).toBe('Refactor X')
      expect(env?.overview).toBe('Replace Y with Z.')
      expect(env?.isProject).toBe(true)
      expect(Array.isArray(env?.todos)).toBe(true)
      expect((env?.todos as unknown[])).toHaveLength(2)
      expect(Array.isArray(env?.phases)).toBe(true)
      expect((evt?.allowedPrompts as unknown[])).toHaveLength(1)

      // Cleanup.
      resolveMainChatPlanApprovalResponse({
        requestId: evt?.requestId as string,
        outcome: 'rejected',
      })
      await p
    } finally {
      cap.restore()
    }
  })

  it('omits planEnvelope entirely when no structured fields are supplied', async () => {
    const cap = captureStreamEvents()
    try {
      const ctx = minimalCtx({ streamConversationId: 'conv-bare' })
      const p = runWithAgentContextAsync(ctx, async () =>
        awaitMainChatPlanApproval({ planMarkdown: '# Plan' }),
      )
      await new Promise((r) => setImmediate(r))

      const evt = cap.events.find((e) => e.type === 'plan_approval_request')
      expect(evt).toBeDefined()
      // No planEnvelope key (and no allowedPrompts key either).
      expect('planEnvelope' in (evt as object)).toBe(false)
      expect('allowedPrompts' in (evt as object)).toBe(false)

      resolveMainChatPlanApprovalResponse({
        requestId: evt?.requestId as string,
        outcome: 'rejected',
      })
      await p
    } finally {
      cap.restore()
    }
  })

  it('truncates plan markdown bodies that exceed 24 KB', async () => {
    const cap = captureStreamEvents()
    try {
      const big = 'x'.repeat(50_000)
      const ctx = minimalCtx({ streamConversationId: 'conv-big' })
      const p = runWithAgentContextAsync(ctx, async () =>
        awaitMainChatPlanApproval({ planMarkdown: big }),
      )
      await new Promise((r) => setImmediate(r))

      const evt = cap.events.find((e) => e.type === 'plan_approval_request')
      const body = (evt?.planMarkdown as string) ?? ''
      expect(body.length).toBeLessThan(big.length)
      expect(body).toContain('truncated for display')

      resolveMainChatPlanApprovalResponse({
        requestId: evt?.requestId as string,
        outcome: 'rejected',
      })
      await p
    } finally {
      cap.restore()
    }
  })
})

describe('mainChatPlanApprovalBridge — abort signal', () => {
  it('a pre-aborted signal resolves immediately as cancelled+aborted (no event emitted)', async () => {
    const cap = captureStreamEvents()
    try {
      const ac = new AbortController()
      ac.abort()
      const ctx = minimalCtx({ streamConversationId: 'conv-pre' })

      const d = await runWithAgentContextAsync(ctx, async () =>
        awaitMainChatPlanApproval(
          { planMarkdown: '# Plan' },
          { signal: ac.signal },
        ),
      )
      expect(d.outcome).toBe('cancelled')
      expect(d.reason).toBe('aborted')
      // Early-out path skips the event emit entirely.
      expect(cap.events.find((e) => e.type === 'plan_approval_request')).toBeUndefined()
    } finally {
      cap.restore()
    }
  })

  it('mid-wait abort resolves as cancelled+aborted', async () => {
    const cap = captureStreamEvents()
    try {
      const ac = new AbortController()
      const ctx = minimalCtx({ streamConversationId: 'conv-mid' })
      const p = runWithAgentContextAsync(ctx, async () =>
        awaitMainChatPlanApproval(
          { planMarkdown: '# Plan' },
          { signal: ac.signal },
        ),
      )
      await new Promise((r) => setImmediate(r))
      ac.abort()
      const d = await p
      expect(d.outcome).toBe('cancelled')
      expect(d.reason).toBe('aborted')
    } finally {
      cap.restore()
    }
  })
})

describe('mainChatPlanApprovalBridge — timeout', () => {
  beforeEach(() => {
    // Min effective override is 5_000 ms (see bridge); use just above it.
    process.env.ASTRA_MAIN_PLAN_APPROVAL_TIMEOUT_MS = '5001'
  })

  it('resolves as rejected+timeout when nobody answers', async () => {
    const cap = captureStreamEvents()
    try {
      const ctx = minimalCtx({ streamConversationId: 'conv-timeout' })
      const start = Date.now()
      const d = await runWithAgentContextAsync(ctx, async () =>
        awaitMainChatPlanApproval({ planMarkdown: '# Plan' }),
      )
      const elapsed = Date.now() - start
      expect(d.outcome).toBe('rejected')
      expect(d.reason).toBe('timeout')
      // Sanity: elapsed should be in the ballpark of the override (5s) —
      // generous bound for slow CI machines.
      expect(elapsed).toBeGreaterThanOrEqual(4_500)
      expect(elapsed).toBeLessThan(15_000)
    } finally {
      cap.restore()
    }
  }, 20_000)
})

describe('mainChatPlanApprovalBridge — cancel drain hooks', () => {
  it('cancelPendingInteractionsForConversation wakes only matching waits', async () => {
    const cap = captureStreamEvents()
    try {
      // Two parallel waits on different conversations.
      const ctxA = minimalCtx({ streamConversationId: 'conv-A' })
      const ctxB = minimalCtx({ streamConversationId: 'conv-B' })
      const pA = runWithAgentContextAsync(ctxA, async () =>
        awaitMainChatPlanApproval({ planMarkdown: '# A' }),
      )
      const pB = runWithAgentContextAsync(ctxB, async () =>
        awaitMainChatPlanApproval({ planMarkdown: '# B' }),
      )
      await new Promise((r) => setImmediate(r))

      // Cancel only conv-A. The drain hook should resolve A but leave B.
      cancelPendingInteractionsForConversation('conv-A')
      const a = await pA
      expect(a.outcome).toBe('cancelled')
      expect(a.reason).toBe('aborted')

      // B is still parked. Resolve it explicitly so we don't leak.
      const evtB = cap.events.find(
        (e) => e.type === 'plan_approval_request' && e.conversationId === 'conv-B',
      )
      expect(evtB).toBeDefined()
      resolveMainChatPlanApprovalResponse({
        requestId: evtB?.requestId as string,
        outcome: 'accepted',
      })
      const b = await pB
      expect(b.outcome).toBe('accepted')
    } finally {
      cap.restore()
    }
  })

  it('cancelAllPendingInteractions wakes every pending wait', async () => {
    const cap = captureStreamEvents()
    try {
      const ctxA = minimalCtx({ streamConversationId: 'conv-A' })
      const ctxB = minimalCtx({ streamConversationId: 'conv-B' })
      const pA = runWithAgentContextAsync(ctxA, async () =>
        awaitMainChatPlanApproval({ planMarkdown: '# A' }),
      )
      const pB = runWithAgentContextAsync(ctxB, async () =>
        awaitMainChatPlanApproval({ planMarkdown: '# B' }),
      )
      await new Promise((r) => setImmediate(r))

      cancelAllPendingInteractions()
      const [a, b] = await Promise.all([pA, pB])
      expect(a.outcome).toBe('cancelled')
      expect(a.reason).toBe('aborted')
      expect(b.outcome).toBe('cancelled')
      expect(b.reason).toBe('aborted')
    } finally {
      cap.restore()
    }
  })
})
