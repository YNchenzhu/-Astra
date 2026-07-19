import { describe, expect, it, vi } from 'vitest'
import { OrchestrationKernel } from './kernel'
import { createInitialKernelLoopState } from './kernelTypes'
import { noopHookPolicy, createTransportAdapter } from './transport'
import { DefaultToolRuntimePort } from './toolRuntime/defaultToolRuntimePort'
import { createNoopMcpSessionAdapter } from './mcpSessionAdapter'
import {
  clearOrchestrationKernelRegistryForTests,
  registerOrchestrationKernelForConversation,
  unregisterOrchestrationKernelForConversation,
} from './activeKernelRegistry'
import {
  enqueueHumanResume,
  enqueueInterAgentMailboxDraft,
  enqueueSlashCommand,
  enqueueSyntheticUserText,
} from './inbox'

vi.mock('./phases/iteration', () => ({
  runAgenticLoop: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../agents/agentContext', () => ({
  getAgentContext: vi.fn().mockReturnValue(null),
}))

describe('orchestration inbox + registry', () => {
  it('enqueueSyntheticUserText reaches kernel inbox for registered conversation', async () => {
    clearOrchestrationKernelRegistryForTests()
    const emit = vi.fn()
    const ports = {
      tools: new DefaultToolRuntimePort({ get: () => null, set: () => {} }),
      permission: { noteToolInvocation: vi.fn() },
      session: createNoopMcpSessionAdapter(),
      transport: createTransportAdapter(emit),
      hooks: noopHookPolicy,
    }
    const kernel = new OrchestrationKernel(ports, undefined, createInitialKernelLoopState([]), 'c1')
    registerOrchestrationKernelForConversation('c1', kernel)

    const r = enqueueSyntheticUserText('c1', 'hello from inbox', 'test')
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error('expected ok')
    expect(r.inboxItemId).toMatch(/^[0-9a-f-]{36}$/i)
    expect(kernel.getState().inbox).toHaveLength(1)
    expect(kernel.getState().inbox[0]).toMatchObject({
      kind: 'synthetic_user_text',
      text: 'hello from inbox',
      source: 'test',
      inboxItemId: r.inboxItemId,
    })

    unregisterOrchestrationKernelForConversation('c1')
    expect(enqueueSyntheticUserText('c1', 'orphan').ok).toBe(false)
  })

  // ── Audit P0 §4.3 — `'empty_payload'` reason distinguishes
  //    "missing conversationId" from "empty content" ──
  describe('InboxEnqueueResult.empty_payload (audit P0 §4.3)', () => {
    it('returns empty_payload when synthetic text is empty / whitespace', () => {
      const r1 = enqueueSyntheticUserText('any-conv', '')
      const r2 = enqueueSyntheticUserText('any-conv', '   ')
      expect(r1.ok).toBe(false)
      expect(r2.ok).toBe(false)
      if (r1.ok || r2.ok) throw new Error('unreachable')
      expect(r1.reason).toBe('empty_payload')
      expect(r2.reason).toBe('empty_payload')
    })

    it('returns empty_payload when slash command name is empty', () => {
      const r = enqueueSlashCommand('any-conv', '   ')
      expect(r.ok).toBe(false)
      if (r.ok) throw new Error('unreachable')
      expect(r.reason).toBe('empty_payload')
    })

    it('returns empty_payload when mailbox draft has no lines', () => {
      const r = enqueueInterAgentMailboxDraft('any-conv', [])
      expect(r.ok).toBe(false)
      if (r.ok) throw new Error('unreachable')
      expect(r.reason).toBe('empty_payload')
    })

    it('returns empty_payload when human-resume toolUseId is empty', () => {
      const r = enqueueHumanResume('any-conv', '   ', { answers: {} })
      expect(r.ok).toBe(false)
      if (r.ok) throw new Error('unreachable')
      expect(r.reason).toBe('empty_payload')
    })

    it('returns no_conversation when conversationId is empty (regression: must not collapse with empty_payload)', () => {
      // Non-empty payload but empty conversationId — distinct reason.
      const r = enqueueSyntheticUserText('   ', 'real text')
      expect(r.ok).toBe(false)
      if (r.ok) throw new Error('unreachable')
      expect(r.reason).toBe('no_conversation')
    })
  })
})
