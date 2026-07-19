/**
 * P0 audit fixes — coverage for G1 / G2 / G3 / G7.
 *
 *   G1 — `canUseDurableHITL` returns false when kernel is missing → callers fall back to
 *        legacy IPC. Verified at the helper level here; AskUserQuestion integration is
 *        in `AskUserQuestionTool.hitl.test.ts`.
 *   G2 — `pending_human_resume` items survive AppendList overflow eviction. Flushable
 *        items get dropped first; HITL signals are protected.
 *   G3 — `unregisterOrchestrationKernelForConversation` clears any pending HITL entry
 *        for that conversation (prevents registry leak on session teardown).
 *   G7 — `recordPendingHITL` logs a warning when overwriting a prior entry (diagnostics
 *        breadcrumb for the G4 / G1 corner cases).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  InterruptForHITL,
  canUseDurableHITL,
  clearAllPendingHITLForTests,
  clearPendingHITLForConversation,
  recordPendingHITL,
  takePendingHITL,
} from './hitl'
import { applySessionCommands } from './sessionCommands'
import { createInitialKernelLoopState } from './kernelTypes'
import {
  clearOrchestrationKernelRegistryForTests,
  registerOrchestrationKernelForConversation,
  unregisterOrchestrationKernelForConversation,
} from './activeKernelRegistry'
import { OrchestrationKernel } from './kernel'
import { createTransportAdapter, noopHookPolicy } from './transport'
import { DefaultToolRuntimePort } from './toolRuntime/defaultToolRuntimePort'
import { createNoopMcpSessionAdapter } from './mcpSessionAdapter'

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

describe('G1 — canUseDurableHITL', () => {
  // flag flipped to opt-out (default on). Updated to explicitly
  // set the off value rather than relying on "unset means off".
  it('returns false when the flag is explicitly off (regardless of registration state)', () => {
    process.env.POLE_ORCHESTRATION_DURABLE_HITL = '0'
    expect(canUseDurableHITL('conv-1')).toBe(false)
    const kernel = makeKernel('conv-1')
    registerOrchestrationKernelForConversation('conv-1', kernel)
    expect(canUseDurableHITL('conv-1')).toBe(false)
  })

  it('returns false when the flag is on but no conversation id', () => {
    process.env.POLE_ORCHESTRATION_DURABLE_HITL = '1'
    expect(canUseDurableHITL(undefined)).toBe(false)
    expect(canUseDurableHITL('')).toBe(false)
    expect(canUseDurableHITL('   ')).toBe(false)
  })

  it('returns false when the flag is on + conversation id but no kernel registered', () => {
    process.env.POLE_ORCHESTRATION_DURABLE_HITL = '1'
    expect(canUseDurableHITL('conv-unregistered')).toBe(false)
  })

  it('returns true only when flag-on + conversation id + kernel registered', () => {
    process.env.POLE_ORCHESTRATION_DURABLE_HITL = '1'
    const kernel = makeKernel('conv-ok')
    registerOrchestrationKernelForConversation('conv-ok', kernel)
    expect(canUseDurableHITL('conv-ok')).toBe(true)
  })
})

describe('G2 — pending_human_resume protected from FIFO eviction', () => {
  beforeEach(() => {
    clearOrchestrationKernelRegistryForTests()
  })

  it('mixed inbox at cap: flushable items evicted, HITL signals preserved', () => {
    const state = createInitialKernelLoopState([])
    // Fill the inbox: 198 synthetic_user_text items (oldest first) + 2 HITL at the end.
    let s = state
    for (let i = 0; i < 198; i++) {
      s = applySessionCommands(s, [
        {
          kind: 'EnqueueInbox',
          item: { kind: 'synthetic_user_text', text: `text-${i}` },
        },
      ])
    }
    s = applySessionCommands(s, [
      {
        kind: 'EnqueueInbox',
        item: { kind: 'pending_human_resume', toolUseId: 'tu_a', value: 'A' },
      },
      {
        kind: 'EnqueueInbox',
        item: { kind: 'pending_human_resume', toolUseId: 'tu_b', value: 'B' },
      },
    ])
    expect(s.inbox).toHaveLength(200)
    // Now push 5 more synthetic items — these should evict the OLDEST synthetic items,
    // NOT the HITL ones.
    for (let i = 0; i < 5; i++) {
      s = applySessionCommands(s, [
        {
          kind: 'EnqueueInbox',
          item: { kind: 'synthetic_user_text', text: `flood-${i}` },
        },
      ])
    }
    // Cap held — protected HITL items still present.
    expect(s.inbox).toHaveLength(200)
    const hitl = s.inbox.filter((i) => i.kind === 'pending_human_resume')
    expect(hitl).toHaveLength(2)
    expect(hitl.map((i) => (i.kind === 'pending_human_resume' ? i.toolUseId : ''))).toEqual([
      'tu_a',
      'tu_b',
    ])
  })

  it('inbox of all-HITL items: cap exceeded but items kept (no silent drop)', () => {
    // Pathological: 200 HITL items + 1 more. Drop policy says "all-protected → accept
    // overflow rather than drop a HITL". So inbox ends up at 201.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      let s = createInitialKernelLoopState([])
      for (let i = 0; i < 200; i++) {
        s = applySessionCommands(s, [
          {
            kind: 'EnqueueInbox',
            item: { kind: 'pending_human_resume', toolUseId: `tu_${i}`, value: i },
          },
        ])
      }
      expect(s.inbox).toHaveLength(200)
      s = applySessionCommands(s, [
        {
          kind: 'EnqueueInbox',
          item: { kind: 'pending_human_resume', toolUseId: 'tu_200', value: 200 },
        },
      ])
      expect(s.inbox).toHaveLength(201)
      // All 201 still HITL items.
      expect(
        s.inbox.every((i) => i.kind === 'pending_human_resume'),
      ).toBe(true)
      // Warned at least once about over-cap.
      expect(
        warnSpy.mock.calls.some((c) => String(c[0]).includes('all-protected')),
      ).toBe(true)
    } finally {
      warnSpy.mockRestore()
    }
  })
})

describe('G3 — kernel unregister clears pending HITL', () => {
  it('takePendingHITL returns undefined after unregisterOrchestrationKernelForConversation', () => {
    recordPendingHITL('conv-tear', {
      toolUseId: 'tu_x',
      question: 'q',
      kind: 'ask_user_question',
      recordedAt: Date.now(),
    })
    expect(takePendingHITL('conv-tear')).toBeDefined()
    // Re-record so we can verify the unregister path clears it (takePendingHITL above
    // already consumed it).
    recordPendingHITL('conv-tear', {
      toolUseId: 'tu_y',
      question: 'q2',
      kind: 'ask_user_question',
      recordedAt: Date.now(),
    })
    unregisterOrchestrationKernelForConversation('conv-tear')
    expect(takePendingHITL('conv-tear')).toBeUndefined()
  })

  it('unregister of conv A does NOT touch conv B', () => {
    recordPendingHITL('conv-a', {
      toolUseId: 'a',
      question: 'qa',
      kind: 'ask_user_question',
      recordedAt: Date.now(),
    })
    recordPendingHITL('conv-b', {
      toolUseId: 'b',
      question: 'qb',
      kind: 'ask_user_question',
      recordedAt: Date.now(),
    })
    unregisterOrchestrationKernelForConversation('conv-a')
    expect(takePendingHITL('conv-a')).toBeUndefined()
    expect(takePendingHITL('conv-b')).toBeDefined()
  })

  it('clearPendingHITLForConversation directly: idempotent + safe for empty id', () => {
    recordPendingHITL('conv-z', {
      toolUseId: 'z',
      question: null,
      kind: 'ask_user_question',
      recordedAt: Date.now(),
    })
    clearPendingHITLForConversation('conv-z')
    expect(takePendingHITL('conv-z')).toBeUndefined()
    // Idempotent.
    clearPendingHITLForConversation('conv-z')
    // Empty / undefined id is a no-op (no throw).
    expect(() => clearPendingHITLForConversation('')).not.toThrow()
    expect(() => clearPendingHITLForConversation(undefined)).not.toThrow()
  })
})

describe('G7 — recordPendingHITL warns on overwrite', () => {
  it('first record: no warning', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      recordPendingHITL('conv-w', {
        toolUseId: 'a',
        question: 'q',
        kind: 'ask_user_question',
        recordedAt: 1,
      })
      expect(warnSpy).not.toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('second record without taking the first → warns with both kind/toolUseId', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      recordPendingHITL('conv-w2', {
        toolUseId: 'first',
        question: 'q',
        kind: 'ask_user_question',
        recordedAt: 1,
      })
      recordPendingHITL('conv-w2', {
        toolUseId: 'second',
        question: 'q',
        kind: 'permission_ask',
        recordedAt: 2,
      })
      expect(warnSpy).toHaveBeenCalledOnce()
      const msg = String(warnSpy.mock.calls[0][0])
      expect(msg).toContain('first')
      expect(msg).toContain('second')
      expect(msg).toContain('ask_user_question')
      expect(msg).toContain('permission_ask')
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('take + record fresh = no warn (legitimate sequential HITL across turns)', () => {
    recordPendingHITL('conv-w3', {
      toolUseId: 'a',
      question: null,
      kind: 'ask_user_question',
      recordedAt: 1,
    })
    takePendingHITL('conv-w3')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      recordPendingHITL('conv-w3', {
        toolUseId: 'b',
        question: null,
        kind: 'ask_user_question',
        recordedAt: 2,
      })
      expect(warnSpy).not.toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
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

// Satisfy import linter — InterruptForHITL is exported for callers but not directly
// exercised in this file (the catcher tests live in `hitlEndToEnd.test.ts`).
void InterruptForHITL
