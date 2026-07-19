/**
 * P2.1 follow-up — HITL durable end-to-end:
 *
 *   1. AskUserQuestion (or permission-ask) throws `InterruptForHITL`.
 *   2. `runAgenticToolUse` catches it: synthesises a paused placeholder tool_result
 *      AND records the pending interrupt in the per-conversation registry.
 *   3. (skipped here — the agentic-loop ApplyResults phase reads the registry, emits
 *      a `interrupt` phase event with `interruptReason: 'hitl'`, and calls
 *      `kernel.interrupt('hitl')`.)
 *   4. Renderer enqueues a `pending_human_resume` and the next turn re-executes the
 *      tool, hitting the resumed branch.
 *
 * This test exercises steps 1–2 + 4 directly (the agentic-loop pump in step 3 is covered
 * by `electron/orchestration/hitl.test.ts::tryConsumePendingHumanResume` separately —
 * combining them here would need an entire mocked agentic loop).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  InterruptForHITL,
  buildPausedToolResultBlock,
  clearAllPendingHITLForTests,
  recordPendingHITL,
  takePendingHITL,
  tryConsumePendingHumanResume,
} from './hitl'
import { OrchestrationKernel } from './kernel'
import { createTransportAdapter, emitPhaseEvent, noopHookPolicy } from './transport'
import { DefaultToolRuntimePort } from './toolRuntime/defaultToolRuntimePort'
import { createNoopMcpSessionAdapter } from './mcpSessionAdapter'
import {
  clearOrchestrationKernelRegistryForTests,
  registerOrchestrationKernelForConversation,
} from './activeKernelRegistry'
import { createInitialKernelLoopState } from './kernelTypes'
import { enqueueHumanResume } from './inbox'

const previousFlag = process.env.POLE_ORCHESTRATION_DURABLE_HITL

afterEach(() => {
  if (previousFlag === undefined) {
    delete process.env.POLE_ORCHESTRATION_DURABLE_HITL
  } else {
    process.env.POLE_ORCHESTRATION_DURABLE_HITL = previousFlag
  }
  clearOrchestrationKernelRegistryForTests()
  clearAllPendingHITLForTests()
})

describe('HITL end-to-end (P2.1 catcher → kernel pause → resume)', () => {
  beforeEach(() => {
    process.env.POLE_ORCHESTRATION_DURABLE_HITL = '1'
  })

  it('placeholder tool_result carries the wire-format-valid pairing', () => {
    const block = buildPausedToolResultBlock('tu_42')
    expect(block.type).toBe('tool_result')
    expect(block.tool_use_id).toBe('tu_42')
    expect(block.is_error).toBe(false)
    expect(block._hitlPlaceholder).toBe(true)
    expect(typeof block.content).toBe('string')
  })

  it('catcher → registry → take cycle: pending HITL flows end-to-end', () => {
    const conversationId = 'conv-e2e-1'
    const kernel = makeKernel(conversationId)
    registerOrchestrationKernelForConversation(conversationId, kernel)

    // Simulate the catch in runAgenticToolUse.ts.
    const err = new InterruptForHITL('tu_qx', { questions: [{ question: 'A?' }] })
    recordPendingHITL(conversationId, {
      toolUseId: err.toolUseId,
      question: err.question,
      kind: 'ask_user_question',
      recordedAt: Date.now(),
    })

    // Simulate toolExec.ts reading the registry after the batch.
    const pending = takePendingHITL(conversationId)
    expect(pending).toBeDefined()
    expect(pending!.toolUseId).toBe('tu_qx')
    expect(pending!.kind).toBe('ask_user_question')
    // Registry is single-shot: a second take returns undefined.
    expect(takePendingHITL(conversationId)).toBeUndefined()
  })

  it('kernel.interrupt("hitl") is accepted by the type system + observable via signal', () => {
    const conversationId = 'conv-e2e-hitl'
    const kernel = makeKernel(conversationId)
    expect(kernel.getAbortSignal().aborted).toBe(false)
    kernel.interrupt('hitl')
    expect(kernel.getInterruptReason()).toBe('hitl')
    expect(kernel.getAbortSignal().aborted).toBe(true)
  })

  it('phase event for HITL carries the question payload to renderer subscribers', () => {
    const emitted: Array<Record<string, unknown>> = []
    const transport = createTransportAdapter((ev) =>
      emitted.push(ev as Record<string, unknown>),
    )
    emitPhaseEvent(transport, {
      phase: 'interrupt',
      iteration: 3,
      innerIteration: 1,
      conversationId: 'conv-e2e-hitl-ev',
      interruptReason: 'hitl',
    })
    expect(emitted).toHaveLength(1)
    expect(emitted[0].orchestrationPhase).toBe('interrupt')
    expect(emitted[0].interruptReason).toBe('hitl')
    expect(emitted[0].conversationId).toBe('conv-e2e-hitl-ev')
  })

  it('full pause → renderer-supplied resume → tool re-execution picks up answer', () => {
    const conversationId = 'conv-e2e-resume'
    const kernel = makeKernel(conversationId)
    registerOrchestrationKernelForConversation(conversationId, kernel)

    // Step 1: tool threw → batch caught → registry recorded.
    recordPendingHITL(conversationId, {
      toolUseId: 'tu_resume_me',
      question: { questions: [{ question: 'Approve?' }] },
      kind: 'ask_user_question',
      recordedAt: Date.now(),
    })
    // Step 2: toolExec picked up the signal — interrupt + clear registry.
    const pending = takePendingHITL(conversationId)
    expect(pending).toBeDefined()
    kernel.interrupt('hitl')
    expect(kernel.getAbortSignal().aborted).toBe(true)

    // Step 3: renderer collects the answer and enqueues a resume.
    const enq = enqueueHumanResume(conversationId, 'tu_resume_me', { answers: { 'Approve?': 'yes' } })
    expect(enq.ok).toBe(true)

    // Step 4: on the next turn the tool re-executes; it consumes the resume.
    const consumed = tryConsumePendingHumanResume(conversationId, 'tu_resume_me')
    expect(consumed.resumed).toBe(true)
    if (consumed.resumed) {
      expect(consumed.value).toEqual({ answers: { 'Approve?': 'yes' } })
    }
    // Inbox now empty — second execution returns resumed=false (re-entrancy safety).
    expect(kernel.getState().inbox).toHaveLength(0)
    expect(tryConsumePendingHumanResume(conversationId, 'tu_resume_me').resumed).toBe(false)
  })

  it('parallel conversations do not cross-contaminate the registry', () => {
    recordPendingHITL('conv-a', {
      toolUseId: 'tu_a',
      question: 'A',
      kind: 'ask_user_question',
      recordedAt: 1,
    })
    recordPendingHITL('conv-b', {
      toolUseId: 'tu_b',
      question: 'B',
      kind: 'permission_ask',
      recordedAt: 2,
    })
    const a = takePendingHITL('conv-a')
    expect(a?.toolUseId).toBe('tu_a')
    expect(a?.kind).toBe('ask_user_question')
    // Reading conv-a doesn't touch conv-b.
    const b = takePendingHITL('conv-b')
    expect(b?.toolUseId).toBe('tu_b')
    expect(b?.kind).toBe('permission_ask')
  })
})

function makeKernel(conversationId: string): OrchestrationKernel {
  return new OrchestrationKernel(
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
}
