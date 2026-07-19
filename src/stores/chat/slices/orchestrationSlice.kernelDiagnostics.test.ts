/**
 * Audit R2 (2026-07) — `pushKernelDiagnostic` / `dismissKernelDiagnostic`
 * store semantics. The renderer-originated diagnostic path (e.g.
 * `pause_partial` / `pause_failed` from ChatInput) previously wrote only the
 * top-level `kernelDiagnostics` mirror; switching tabs rebuilt the top-level
 * from the session buffer (`loadConversation` Bug C hydrate) and silently
 * dropped the toast. The action now mirrors into
 * `sessionBuffers[currentConversationId]` too — same dual-write contract as
 * the stream-router side (`orchestrationStreamEvents.ts`).
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { useChatStore } from '../../useChatStore'
import type { ChatSessionSlice } from '../types'

function blankSlice(): ChatSessionSlice {
  return {
    messages: [],
    todos: [],
    isTyping: false,
    pendingPermissionRequest: null,
    pendingAskUserQuestion: null,
    pendingTeamPlanApproval: null,
    pendingPlanApproval: null,
    latestTerminationReason: null,
    kernelDiagnostics: [],
  }
}

beforeEach(() => {
  useChatStore.setState({
    currentConversationId: null,
    sessionBuffers: {},
    kernelDiagnostics: [],
  })
})

describe('pushKernelDiagnostic (audit R2)', () => {
  it('appends to the top-level mirror', () => {
    useChatStore.getState().pushKernelDiagnostic('pause_partial', '部分子智能体未暂停')
    const diags = useChatStore.getState().kernelDiagnostics
    expect(diags).toHaveLength(1)
    expect(diags[0]).toMatchObject({ kind: 'pause_partial', detail: '部分子智能体未暂停' })
    expect(diags[0].id).toContain('pause_partial:')
  })

  it('mirrors into the current conversation session buffer (survives tab switch)', () => {
    useChatStore.setState({
      currentConversationId: 'conv-1',
      sessionBuffers: { 'conv-1': blankSlice() },
    })
    useChatStore.getState().pushKernelDiagnostic('pause_failed', '暂停失败')

    const st = useChatStore.getState()
    expect(st.kernelDiagnostics).toHaveLength(1)
    const buffered = st.sessionBuffers['conv-1']?.kernelDiagnostics ?? []
    expect(buffered).toHaveLength(1)
    expect(buffered[0]).toMatchObject({ kind: 'pause_failed', detail: '暂停失败' })
  })

  it('does not create a session buffer when none exists (top-level only)', () => {
    useChatStore.setState({ currentConversationId: 'conv-ghost', sessionBuffers: {} })
    useChatStore.getState().pushKernelDiagnostic('pause_partial', 'x')
    const st = useChatStore.getState()
    expect(st.kernelDiagnostics).toHaveLength(1)
    expect(st.sessionBuffers['conv-ghost']).toBeUndefined()
  })

  it('caps both mirrors at 30 entries', () => {
    useChatStore.setState({
      currentConversationId: 'conv-1',
      sessionBuffers: { 'conv-1': blankSlice() },
    })
    for (let i = 0; i < 40; i++) {
      useChatStore.getState().pushKernelDiagnostic('pause_partial', `d${i}`)
    }
    const st = useChatStore.getState()
    expect(st.kernelDiagnostics).toHaveLength(30)
    expect(st.kernelDiagnostics[29].detail).toBe('d39')
    expect(st.sessionBuffers['conv-1']?.kernelDiagnostics).toHaveLength(30)
  })
})

describe('dismissKernelDiagnostic', () => {
  it('removes the entry by id from the top-level mirror', () => {
    useChatStore.getState().pushKernelDiagnostic('pause_partial', 'to dismiss')
    const id = useChatStore.getState().kernelDiagnostics[0].id
    useChatStore.getState().dismissKernelDiagnostic(id)
    expect(useChatStore.getState().kernelDiagnostics).toHaveLength(0)
  })
})
