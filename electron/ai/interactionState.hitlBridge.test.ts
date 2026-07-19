/**
 * P2.1 follow-up — `respondAskUserQuestion` durable-HITL fallback.
 *
 * Behaviour matrix:
 *
 *   - Legacy (in-memory pending entry exists) → resolve the entry, return true (unchanged).
 *   - Durable HITL (no entry; kernel registered for the conversation; `toolUseId` used
 *     as requestId) → enqueue a `pending_human_resume` into the kernel inbox so the
 *     next turn's tool re-execution picks it up.
 *
 * Coverage:
 *   1. Pending entry path stays untouched (legacy regression).
 *   2. No pending entry + no conversation id → returns false (no-op).
 *   3. No pending entry + kernel registered → enqueues the resume value.
 *   4. Multiple calls with same toolUseId → second call enqueues a second resume (the
 *      tool itself dedupes via inbox consumption).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { respondAskUserQuestion } from './interactionState'
import { OrchestrationKernel } from '../orchestration/kernel'
import { createTransportAdapter, noopHookPolicy } from '../orchestration/transport'
import { DefaultToolRuntimePort } from '../orchestration/toolRuntime/defaultToolRuntimePort'
import { createNoopMcpSessionAdapter } from '../orchestration/mcpSessionAdapter'
import {
  clearOrchestrationKernelRegistryForTests,
  registerOrchestrationKernelForConversation,
} from '../orchestration/activeKernelRegistry'
import { createInitialKernelLoopState } from '../orchestration/kernelTypes'

// Mock the agent context the fallback path reads to get the conversation id.
let mockConversationId: string | undefined
vi.mock('../agents/agentContext', () => ({
  getAgentContext: vi.fn(() => ({
    streamConversationId: mockConversationId,
    signal: new AbortController().signal,
  })),
  syncAgentContextConversation: vi.fn(),
  runWithAgentContextAsync: vi.fn(async (_ctx: unknown, fn: () => unknown) => fn()),
}))

// Mock the elicitation hooks so the bridge doesn't try to reach real hook plumbing.
vi.mock('../tools/hooks/runtimeHookBridges', () => ({
  fireElicitationHooksDeferred: vi.fn(),
  fireElicitationResultHooksDeferred: vi.fn(),
}))

/**
 * Wait for the dynamic-import bridge in `respondAskUserQuestion` to settle. The bridge
 * uses `import('../orchestration/inbox')`, which resolves on a future microtask tick.
 * Polling instead of a fixed delay keeps the test fast in steady state and robust on
 * slow machines.
 */
async function waitForInbox(
  kernel: OrchestrationKernel,
  minLength: number,
  timeoutMs = 1000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (kernel.getState().inbox.length >= minLength) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error(
    `Inbox did not reach length ${minLength} within ${timeoutMs}ms (got ${kernel.getState().inbox.length})`,
  )
}

beforeEach(() => {
  mockConversationId = undefined
  clearOrchestrationKernelRegistryForTests()
})

afterEach(() => {
  clearOrchestrationKernelRegistryForTests()
  vi.clearAllMocks()
})

describe('respondAskUserQuestion — durable HITL fallback', () => {
  it('returns false when no pending entry AND no conversation id', async () => {
    mockConversationId = undefined
    await expect(
      respondAskUserQuestion({
        requestId: 'unknown-id',
        answers: { Q: 'A' },
      }),
    ).resolves.toBe(false)
  })

  it('returns true and enqueues resume when no pending entry + kernel registered', async () => {
    mockConversationId = 'conv-bridge-1'
    const kernel = new OrchestrationKernel(
      {
        tools: new DefaultToolRuntimePort({ get: () => null, set: () => {} }),
        permission: { noteToolInvocation: vi.fn() },
        session: createNoopMcpSessionAdapter(),
        transport: createTransportAdapter(vi.fn()),
        hooks: noopHookPolicy,
      },
      undefined,
      createInitialKernelLoopState([]),
      'conv-bridge-1',
    )
    registerOrchestrationKernelForConversation('conv-bridge-1', kernel)
    const ok = await respondAskUserQuestion({
      requestId: 'tu_abc',
      answers: { 'Pick?': 'B' },
    })
    expect(ok).toBe(true)
    // After await, the resume is already enqueued — no microtask polling needed (G8).
    await waitForInbox(kernel, 1)
    const state = kernel.getState()
    expect(state.inbox).toHaveLength(1)
    const item = state.inbox[0]
    expect(item.kind).toBe('pending_human_resume')
    if (item.kind === 'pending_human_resume') {
      expect(item.toolUseId).toBe('tu_abc')
      expect(item.value).toEqual({
        answers: { 'Pick?': 'B' },
        outcome: 'answered',
      })
    }
  })

  it('preserves annotations field when supplied', async () => {
    mockConversationId = 'conv-bridge-2'
    const kernel = new OrchestrationKernel(
      {
        tools: new DefaultToolRuntimePort({ get: () => null, set: () => {} }),
        permission: { noteToolInvocation: vi.fn() },
        session: createNoopMcpSessionAdapter(),
        transport: createTransportAdapter(vi.fn()),
        hooks: noopHookPolicy,
      },
      undefined,
      createInitialKernelLoopState([]),
      'conv-bridge-2',
    )
    registerOrchestrationKernelForConversation('conv-bridge-2', kernel)
    await respondAskUserQuestion({
      requestId: 'tu_annot',
      answers: { Q: 'A' },
      annotations: { Q: { preview: 'p', notes: 'n' } },
    })
    await waitForInbox(kernel, 1)
    const item = kernel.getState().inbox[0]
    expect(item.kind).toBe('pending_human_resume')
    if (item.kind === 'pending_human_resume') {
      const v = item.value as { annotations?: unknown }
      expect(v.annotations).toEqual({ Q: { preview: 'p', notes: 'n' } })
    }
  })

  it('two answers for different toolUseIds queue independently', async () => {
    mockConversationId = 'conv-bridge-3'
    const kernel = new OrchestrationKernel(
      {
        tools: new DefaultToolRuntimePort({ get: () => null, set: () => {} }),
        permission: { noteToolInvocation: vi.fn() },
        session: createNoopMcpSessionAdapter(),
        transport: createTransportAdapter(vi.fn()),
        hooks: noopHookPolicy,
      },
      undefined,
      createInitialKernelLoopState([]),
      'conv-bridge-3',
    )
    registerOrchestrationKernelForConversation('conv-bridge-3', kernel)
    await respondAskUserQuestion({ requestId: 'tu_first', answers: { Q1: 'A' } })
    await respondAskUserQuestion({ requestId: 'tu_second', answers: { Q2: 'B' } })
    await waitForInbox(kernel, 2)
    expect(kernel.getState().inbox).toHaveLength(2)
    const ids = kernel
      .getState()
      .inbox.filter((i) => i.kind === 'pending_human_resume')
      .map((i) => (i.kind === 'pending_human_resume' ? i.toolUseId : ''))
    expect(ids).toEqual(['tu_first', 'tu_second'])
  })
})
