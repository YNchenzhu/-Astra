/**
 * Durable HITL primitives.
 *
 * Coverage strategy:
 *   1. Exception class — `InterruptForHITL` survives serialisation and `instanceof`.
 *   2. Inbox lookup — `findPendingHumanResume` finds the right item and reports the
 *      remaining queue without mutating the input state.
 *   3. Kernel integration — `consumeHumanResume` removes the matched entry and persists.
 *   4. End-to-end pause/resume — kernel + tool collaboration through
 *      `tryConsumePendingHumanResume`.
 *   5. Flag gating — default OFF means the env-flag helper returns false and resume lookup
 *      is a no-op for legacy callers.
 *   6. flushInboxToTranscript retains `pending_human_resume` (not user-visible text).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  InterruptForHITL,
  findPendingHumanResume,
  isDurableHITLEnabled,
  isInterruptForHITL,
  tryConsumePendingHumanResume,
} from './hitl'
import { createInitialKernelLoopState } from './kernelTypes'
import { applySessionCommands, flushInboxToTranscript } from './sessionCommands'
import { enqueueHumanResume } from './inbox'
import { OrchestrationKernel } from './kernel'
import { createTransportAdapter, noopHookPolicy } from './transport'
import { DefaultToolRuntimePort } from './toolRuntime/defaultToolRuntimePort'
import { createNoopMcpSessionAdapter } from './mcpSessionAdapter'
import {
  clearOrchestrationKernelRegistryForTests,
  registerOrchestrationKernelForConversation,
} from './activeKernelRegistry'

const previousFlag = process.env.POLE_ORCHESTRATION_DURABLE_HITL

afterEach(() => {
  if (previousFlag === undefined) {
    delete process.env.POLE_ORCHESTRATION_DURABLE_HITL
  } else {
    process.env.POLE_ORCHESTRATION_DURABLE_HITL = previousFlag
  }
  clearOrchestrationKernelRegistryForTests()
})

describe('InterruptForHITL', () => {
  it('is an Error subclass with toolUseId + question fields', () => {
    const err = new InterruptForHITL('tu_42', { question: 'do it?' })
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(InterruptForHITL)
    expect(err.toolUseId).toBe('tu_42')
    expect(err.question).toEqual({ question: 'do it?' })
    expect(err.tag).toBe('orchestration:hitl')
    expect(err.name).toBe('InterruptForHITL')
  })

  it('isInterruptForHITL recognises both real instances and tagged plain objects', () => {
    const err = new InterruptForHITL('tu_x', null)
    expect(isInterruptForHITL(err)).toBe(true)
    // After JSON round-trip (serialised across IPC) the prototype is lost — the tag survives.
    const plain = {
      tag: 'orchestration:hitl',
      toolUseId: 'tu_x',
      question: null,
    }
    expect(isInterruptForHITL(plain)).toBe(true)
    expect(isInterruptForHITL({})).toBe(false)
    expect(isInterruptForHITL(new Error('other'))).toBe(false)
    expect(isInterruptForHITL(null)).toBe(false)
  })
})

describe('findPendingHumanResume', () => {
  it('returns null when the inbox has no matching resume', () => {
    const state = createInitialKernelLoopState([])
    expect(findPendingHumanResume(state, 'tu_1')).toBeNull()
    const stateWithOthers = applySessionCommands(state, [
      { kind: 'EnqueueInbox', item: { kind: 'synthetic_user_text', text: 'hi' } },
    ])
    expect(findPendingHumanResume(stateWithOthers, 'tu_1')).toBeNull()
  })

  it('finds the matching resume and reports the remaining inbox', () => {
    const state = applySessionCommands(createInitialKernelLoopState([]), [
      { kind: 'EnqueueInbox', item: { kind: 'synthetic_user_text', text: 'hi' } },
      {
        kind: 'EnqueueInbox',
        item: { kind: 'pending_human_resume', toolUseId: 'tu_42', value: { answer: 42 } },
      },
      { kind: 'EnqueueInbox', item: { kind: 'slash_command', name: 'compact', args: '' } },
    ])
    const result = findPendingHumanResume(state, 'tu_42')
    expect(result).not.toBeNull()
    expect(result!.value).toEqual({ answer: 42 })
    expect(result!.remainingInbox).toHaveLength(2)
    expect(result!.remainingInbox.map((i) => i.kind)).toEqual([
      'synthetic_user_text',
      'slash_command',
    ])
    // Lookup is non-mutating.
    expect(state.inbox).toHaveLength(3)
  })
})

describe('isDurableHITLEnabled', () => {
  // flag flipped to opt-out (default on). Asserts updated to match
  // the new opt-out semantics: only `'0' | 'false' | 'no'` disables it; any
  // other value (including unset / empty) leaves it enabled.
  it('returns false only for explicit off values', () => {
    process.env.POLE_ORCHESTRATION_DURABLE_HITL = '0'
    expect(isDurableHITLEnabled()).toBe(false)
    process.env.POLE_ORCHESTRATION_DURABLE_HITL = 'false'
    expect(isDurableHITLEnabled()).toBe(false)
    process.env.POLE_ORCHESTRATION_DURABLE_HITL = 'no'
    expect(isDurableHITLEnabled()).toBe(false)
  })

  it('returns true when unset (default on)', () => {
    delete process.env.POLE_ORCHESTRATION_DURABLE_HITL
    expect(isDurableHITLEnabled()).toBe(true)
    process.env.POLE_ORCHESTRATION_DURABLE_HITL = ''
    expect(isDurableHITLEnabled()).toBe(true)
  })

  it('returns true for canonical "on" values', () => {
    for (const v of ['1', 'true', 'yes', 'TRUE', 'Yes']) {
      process.env.POLE_ORCHESTRATION_DURABLE_HITL = v
      expect(isDurableHITLEnabled()).toBe(true)
    }
  })
})

describe('OrchestrationKernel.consumeHumanResume', () => {
  it('removes the matching pending_human_resume and persists', () => {
    const ports = {
      tools: new DefaultToolRuntimePort({ get: () => null, set: () => {} }),
      permission: { noteToolInvocation: vi.fn() },
      session: createNoopMcpSessionAdapter(),
      transport: createTransportAdapter(vi.fn()),
      hooks: noopHookPolicy,
    }
    const kernel = new OrchestrationKernel(
      ports,
      undefined,
      createInitialKernelLoopState([]),
      'conv-hitl',
    )
    kernel.enqueueInboxItem({
      kind: 'pending_human_resume',
      toolUseId: 'tu_1',
      value: 'A',
    })
    kernel.enqueueInboxItem({
      kind: 'pending_human_resume',
      toolUseId: 'tu_2',
      value: 'B',
    })
    expect(kernel.getState().inbox).toHaveLength(2)
    expect(kernel.consumeHumanResume('tu_1')).toBe(true)
    expect(kernel.getState().inbox).toHaveLength(1)
    const remaining = kernel.getState().inbox[0]
    expect(remaining.kind).toBe('pending_human_resume')
    expect(remaining.kind === 'pending_human_resume' && remaining.toolUseId).toBe('tu_2')
    // Idempotent: calling again with the same id is a no-op.
    expect(kernel.consumeHumanResume('tu_1')).toBe(false)
  })
})

describe('tryConsumePendingHumanResume (end-to-end)', () => {
  beforeEach(() => {
    clearOrchestrationKernelRegistryForTests()
  })

  it('returns resumed=false when no kernel is registered', () => {
    const r = tryConsumePendingHumanResume('conv-unknown', 'tu_x')
    expect(r.resumed).toBe(false)
  })

  it('returns resumed=false when there is no matching resume for the tool_use_id', () => {
    const ports = {
      tools: new DefaultToolRuntimePort({ get: () => null, set: () => {} }),
      permission: { noteToolInvocation: vi.fn() },
      session: createNoopMcpSessionAdapter(),
      transport: createTransportAdapter(vi.fn()),
      hooks: noopHookPolicy,
    }
    const kernel = new OrchestrationKernel(
      ports,
      undefined,
      createInitialKernelLoopState([]),
      'conv-hitl-2',
    )
    registerOrchestrationKernelForConversation('conv-hitl-2', kernel)
    const r = tryConsumePendingHumanResume('conv-hitl-2', 'tu_missing')
    expect(r.resumed).toBe(false)
  })

  it('returns and consumes the queued resume value', () => {
    const ports = {
      tools: new DefaultToolRuntimePort({ get: () => null, set: () => {} }),
      permission: { noteToolInvocation: vi.fn() },
      session: createNoopMcpSessionAdapter(),
      transport: createTransportAdapter(vi.fn()),
      hooks: noopHookPolicy,
    }
    const kernel = new OrchestrationKernel(
      ports,
      undefined,
      createInitialKernelLoopState([]),
      'conv-hitl-3',
    )
    registerOrchestrationKernelForConversation('conv-hitl-3', kernel)

    // Renderer-side: user answered the question, the IPC handler called enqueueHumanResume.
    const result = enqueueHumanResume('conv-hitl-3', 'tu_99', { answers: { q1: 'option-A' } })
    expect(result.ok).toBe(true)
    expect(kernel.getState().inbox).toHaveLength(1)

    // Tool-side: the AskUserQuestion call picks up the answer.
    const r = tryConsumePendingHumanResume('conv-hitl-3', 'tu_99')
    expect(r.resumed).toBe(true)
    if (r.resumed) {
      expect(r.value).toEqual({ answers: { q1: 'option-A' } })
    }
    // Inbox is now empty — second call returns resumed=false (re-entrancy safety).
    expect(kernel.getState().inbox).toHaveLength(0)
    const r2 = tryConsumePendingHumanResume('conv-hitl-3', 'tu_99')
    expect(r2.resumed).toBe(false)
  })
})

describe('sessionCommands flushInboxToTranscript retains pending_human_resume (P2.1)', () => {
  it('flushes text-bearing kinds but keeps the HITL signal in the inbox', () => {
    const state = applySessionCommands(createInitialKernelLoopState([]), [
      { kind: 'EnqueueInbox', item: { kind: 'synthetic_user_text', text: 'hello' } },
      {
        kind: 'EnqueueInbox',
        item: { kind: 'pending_human_resume', toolUseId: 'tu_x', value: 'A' },
      },
    ])
    const after = flushInboxToTranscript(state)
    // The text-bearing item was merged into transcript; the HITL item is preserved for the
    // tool to consume later.
    expect(after.inbox).toHaveLength(1)
    expect(after.inbox[0].kind).toBe('pending_human_resume')
    // Transcript got the synthetic text appended.
    expect(after.transcript.length).toBeGreaterThan(state.transcript.length)
  })
})
