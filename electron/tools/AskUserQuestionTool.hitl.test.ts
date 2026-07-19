/**
 * P2.1 — AskUserQuestion durable HITL behaviour.
 *
 *   - Flag OFF (default): tool calls `requestAskUserQuestion` and returns the resolved answer
 *     (i.e. the legacy "await IPC promise" path is untouched).
 *   - Flag ON, no resume queued: tool throws `InterruptForHITL` instead of awaiting.
 *   - Flag ON, resume queued: tool consumes the resume and returns it as the formatted answer.
 *
 * NOTE (2026-06): AskUserQuestion requires an explicit per-tool opt-in
 * (`POLE_ASK_USER_QUESTION_DURABLE_HITL=1`) on top of the orchestration-wide
 * `POLE_ORCHESTRATION_DURABLE_HITL` flag — see the G1 comment in
 * `AskUserQuestionTool.ts` (durable resume lifecycle not finished; default
 * stays on the legacy await path). The "flag ON" suite sets both.
 *
 * The tool's input validation paths are covered by `AskUserQuestionTool.test.ts`. This file
 * focuses on the `call()` body — specifically the P2.1 branch.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { askUserQuestionTool } from './AskUserQuestionTool'
import { isInterruptForHITL } from '../orchestration/hitl'
import { enqueueHumanResume } from '../orchestration/inbox'
import { OrchestrationKernel } from '../orchestration/kernel'
import { createTransportAdapter, noopHookPolicy } from '../orchestration/transport'
import { DefaultToolRuntimePort } from '../orchestration/toolRuntime/defaultToolRuntimePort'
import { createNoopMcpSessionAdapter } from '../orchestration/mcpSessionAdapter'
import {
  clearOrchestrationKernelRegistryForTests,
  registerOrchestrationKernelForConversation,
} from '../orchestration/activeKernelRegistry'
import { createInitialKernelLoopState } from '../orchestration/kernelTypes'

// Mock the interactionState IPC so the legacy-path test doesn't hang.
vi.mock('../ai/interactionState', () => ({
  requestAskUserQuestion: vi.fn(async () => ({
    outcome: 'answered' as const,
    answers: { 'Pick?': 'A' },
    annotations: undefined,
  })),
}))

// Mock the agentContext lookup — we only need `streamConversationId` for the HITL path.
// The legacy-path test sets the streamConversationId to undefined so the flag-off branch
// still works (the legacy path does not require a conversation id).
let mockConversationId: string | undefined
vi.mock('../agents/agentContext', () => ({
  getAgentContext: vi.fn(() => ({
    streamConversationId: mockConversationId,
    signal: new AbortController().signal,
  })),
  // The HITL helper uses a late require of activeKernelRegistry; agentContext itself isn't
  // touched by hitl.ts, but the AskUserQuestion tool needs the export.
  syncAgentContextConversation: vi.fn(),
  runWithAgentContextAsync: vi.fn(async (_ctx, fn) => fn()),
  getAgentContextPendingHookStop: vi.fn(),
  consumeAgentContextPendingHookStop: vi.fn(),
}))

const sampleInput = {
  questions: [
    {
      header: 'Pick',
      question: 'Pick?',
      options: [
        { label: 'A', description: 'first' },
        { label: 'B', description: 'second' },
      ],
    },
  ],
}

const previousFlag = process.env.POLE_ORCHESTRATION_DURABLE_HITL
const previousAskOptIn = process.env.POLE_ASK_USER_QUESTION_DURABLE_HITL

afterEach(() => {
  if (previousFlag === undefined) {
    delete process.env.POLE_ORCHESTRATION_DURABLE_HITL
  } else {
    process.env.POLE_ORCHESTRATION_DURABLE_HITL = previousFlag
  }
  if (previousAskOptIn === undefined) {
    delete process.env.POLE_ASK_USER_QUESTION_DURABLE_HITL
  } else {
    process.env.POLE_ASK_USER_QUESTION_DURABLE_HITL = previousAskOptIn
  }
  clearOrchestrationKernelRegistryForTests()
})

describe('AskUserQuestion — durable HITL flag OFF (regression)', () => {
  beforeEach(() => {
    delete process.env.POLE_ORCHESTRATION_DURABLE_HITL
    delete process.env.POLE_ASK_USER_QUESTION_DURABLE_HITL
    mockConversationId = undefined
    vi.clearAllMocks()
  })

  it('falls back to the legacy IPC await path and returns the formatted answer', async () => {
    const result = await askUserQuestionTool.execute(sampleInput, {
      toolUseId: 'tu_legacy',
    } as unknown as Parameters<typeof askUserQuestionTool.execute>[1])
    expect(result.success).toBe(true)
    const { requestAskUserQuestion } = await import('../ai/interactionState')
    expect(requestAskUserQuestion).toHaveBeenCalledTimes(1)
  })
})

describe('AskUserQuestion — durable HITL flag ON', () => {
  beforeEach(() => {
    process.env.POLE_ORCHESTRATION_DURABLE_HITL = '1'
    process.env.POLE_ASK_USER_QUESTION_DURABLE_HITL = '1'
    clearOrchestrationKernelRegistryForTests()
    vi.clearAllMocks()
  })

  it('throws InterruptForHITL when no resume is queued', async () => {
    const conversationId = 'conv-hitl-on-1'
    mockConversationId = conversationId
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
      conversationId,
    )
    registerOrchestrationKernelForConversation(conversationId, kernel)
    let thrown: unknown
    try {
      await askUserQuestionTool.execute(sampleInput, {
        toolUseId: 'tu_pause',
      } as unknown as Parameters<typeof askUserQuestionTool.execute>[1])
    } catch (e) {
      thrown = e
    }
    expect(isInterruptForHITL(thrown)).toBe(true)
    if (isInterruptForHITL(thrown)) {
      expect(thrown.toolUseId).toBe('tu_pause')
      expect((thrown.question as { questions: unknown }).questions).toBeDefined()
    }
    // Tool MUST NOT invoke the legacy IPC when throwing — flag-on path is exclusive.
    const { requestAskUserQuestion } = await import('../ai/interactionState')
    expect(requestAskUserQuestion).not.toHaveBeenCalled()
  })

  it('returns the resume value when one is queued (post-restart recovery)', async () => {
    const conversationId = 'conv-hitl-on-2'
    mockConversationId = conversationId
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
      conversationId,
    )
    registerOrchestrationKernelForConversation(conversationId, kernel)
    // Renderer reply (e.g. after a process restart): user answered B for Pick.
    const enqueue = enqueueHumanResume(conversationId, 'tu_resumed', {
      answers: { 'Pick?': 'B' },
    })
    expect(enqueue.ok).toBe(true)

    const result = await askUserQuestionTool.execute(sampleInput, {
      toolUseId: 'tu_resumed',
    } as unknown as Parameters<typeof askUserQuestionTool.execute>[1])
    expect(result.success).toBe(true)
    expect(result.output).toContain('Pick?')
    // The inbox item was consumed (no double-answer on re-execute).
    expect(kernel.getState().inbox).toHaveLength(0)
    // IPC was bypassed: no renderer round-trip needed when the answer was already enqueued.
    const { requestAskUserQuestion } = await import('../ai/interactionState')
    expect(requestAskUserQuestion).not.toHaveBeenCalled()
  })
})
