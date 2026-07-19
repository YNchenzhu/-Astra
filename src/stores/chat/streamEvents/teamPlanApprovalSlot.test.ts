/**
 * Tests for the renderer-side `pendingTeamPlanApproval` slot and the
 * `respondToTeamPlanApproval` action wired in `toolSlice.ts`. Validates:
 *   1. `handleTeamPlanApprovalRequestEvent` writes the slot from a stream
 *      event payload — single-slot semantics preserved when a second
 *      request arrives.
 *   2. `respondToTeamPlanApproval` clears the slot after IPC success and
 *      also clears it on IPC failure (the card has nothing to do anymore).
 *
 * Mocks `services/electronAPI.ts` so the action doesn't try to invoke the
 * real preload bridge in jsdom. Mirrors the pattern used in the
 * `mainStreamRouter.*.test.ts` family.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// vi.hoisted: vitest hoists `vi.mock(...)` calls to the top of the file,
// so any function the factory references must also be hoisted.
const hoisted = vi.hoisted(() => ({
  respondTeamPlanApproval: vi.fn(),
}))

vi.mock('../../../services/electronAPI', async () => {
  const actual = await vi.importActual<
    typeof import('../../../services/electronAPI')
  >('../../../services/electronAPI')
  return {
    ...actual,
    respondTeamPlanApproval: hoisted.respondTeamPlanApproval,
  }
})

// Avoid the desktop-notify path requiring a real settings store fixture
// — return a benign noop. This is renderer-side only; doesn't affect the
// store action under test.
vi.mock('../../desktopNotify', () => ({
  maybeDesktopNotify: vi.fn(),
}))

import { useChatStore } from '../../../stores/useChatStore'
import { handleTeamPlanApprovalRequestEvent } from '../../../stores/chat/streamEvents/permissionStreamEvents'
import type { ChatSessionSlice, ChatState } from '../../../stores/chat/types'
import type { StreamEvent } from '../../../types'

function applyToCurrent(
  fn: (sl: ChatSessionSlice) => ChatSessionSlice,
  extra?: Partial<ChatState>,
): void {
  const st = useChatStore.getState()
  const cid = st.currentConversationId
  if (!cid) {
    // Test-only: when there is no current conversation, just patch
    // top-level pending* fields so assertions can read them.
    const slice: ChatSessionSlice = {
      messages: st.messages,
      todos: st.todos,
      isTyping: st.isTyping,
      pendingPermissionRequest: st.pendingPermissionRequest,
      pendingAskUserQuestion: st.pendingAskUserQuestion,
      pendingTeamPlanApproval: st.pendingTeamPlanApproval,
      pendingPlanApproval: st.pendingPlanApproval,
      latestTerminationReason: st.latestTerminationReason ?? null,
    }
    const next = fn(slice)
    useChatStore.setState({
      pendingPermissionRequest: next.pendingPermissionRequest,
      pendingAskUserQuestion: next.pendingAskUserQuestion,
      pendingTeamPlanApproval: next.pendingTeamPlanApproval,
      pendingPlanApproval: next.pendingPlanApproval,
      ...(extra ?? {}),
    })
    return
  }
  // Should not happen in these tests, but mirror the prod code path
  // shape so callers don't drift.
  useChatStore.setState({})
}

describe('pendingTeamPlanApproval slot + respondToTeamPlanApproval (P0-2 follow-up)', () => {
  beforeEach(() => {
    hoisted.respondTeamPlanApproval.mockReset()
    useChatStore.setState({
      currentConversationId: null,
      pendingPermissionRequest: null,
      pendingAskUserQuestion: null,
      pendingTeamPlanApproval: null,
    })
  })

  afterEach(() => {
    useChatStore.setState({
      pendingTeamPlanApproval: null,
    })
  })

  it('writes the slot from a team_plan_approval_request stream event', () => {
    const event: StreamEvent = {
      type: 'team_plan_approval_request',
      teamRequestId: 'tplan-1',
      requestId: 'tplan-1',
      workerAgentId: 'researcher@team-a',
      teamName: 'team-a',
      planMarkdown: '# Plan\n- step 1',
    }
    handleTeamPlanApprovalRequestEvent(event, applyToCurrent, false)
    const slot = useChatStore.getState().pendingTeamPlanApproval
    expect(slot).not.toBeNull()
    expect(slot?.requestId).toBe('tplan-1')
    expect(slot?.workerAgentId).toBe('researcher@team-a')
    expect(slot?.teamName).toBe('team-a')
    expect(slot?.planMarkdown).toContain('step 1')
    expect(typeof slot?.receivedAt).toBe('number')
  })

  it('keeps the existing card when a second request arrives (single-slot)', () => {
    const first: StreamEvent = {
      type: 'team_plan_approval_request',
      teamRequestId: 'tplan-A',
      workerAgentId: 'worker-a',
      planMarkdown: 'first',
    }
    const second: StreamEvent = {
      type: 'team_plan_approval_request',
      teamRequestId: 'tplan-B',
      workerAgentId: 'worker-b',
      planMarkdown: 'second',
    }
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      handleTeamPlanApprovalRequestEvent(first, applyToCurrent, false)
      handleTeamPlanApprovalRequestEvent(second, applyToCurrent, false)
      const slot = useChatStore.getState().pendingTeamPlanApproval
      expect(slot?.requestId).toBe('tplan-A')
      expect(slot?.planMarkdown).toBe('first')
      expect(warnSpy).toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('drops events that have no teamRequestId', () => {
    const event = {
      type: 'team_plan_approval_request',
      planMarkdown: 'orphan',
    } as unknown as StreamEvent
    handleTeamPlanApprovalRequestEvent(event, applyToCurrent, false)
    expect(useChatStore.getState().pendingTeamPlanApproval).toBeNull()
  })

  it('respondToTeamPlanApproval calls IPC and clears the slot on success', async () => {
    useChatStore.setState({
      pendingTeamPlanApproval: {
        requestId: 'tplan-1',
        workerAgentId: 'worker',
        planMarkdown: 'plan',
        receivedAt: Date.now(),
      },
    })
    hoisted.respondTeamPlanApproval.mockResolvedValue(true)

    const ok = await useChatStore.getState().respondToTeamPlanApproval({
      requestId: 'tplan-1',
      approve: true,
      detail: 'go for it',
    })
    expect(ok).toBe(true)
    expect(hoisted.respondTeamPlanApproval).toHaveBeenCalledWith({
      requestId: 'tplan-1',
      approve: true,
      detail: 'go for it',
    })
    expect(useChatStore.getState().pendingTeamPlanApproval).toBeNull()
  })

  it('respondToTeamPlanApproval clears the slot even on IPC failure', async () => {
    useChatStore.setState({
      pendingTeamPlanApproval: {
        requestId: 'tplan-1',
        workerAgentId: 'worker',
        planMarkdown: 'plan',
        receivedAt: Date.now(),
      },
    })
    hoisted.respondTeamPlanApproval.mockRejectedValue(new Error('boom'))

    const ok = await useChatStore.getState().respondToTeamPlanApproval({
      requestId: 'tplan-1',
      approve: false,
    })
    expect(ok).toBe(false)
    expect(useChatStore.getState().pendingTeamPlanApproval).toBeNull()
  })

  it('respondToTeamPlanApproval does NOT clear a slot belonging to a different request', async () => {
    useChatStore.setState({
      pendingTeamPlanApproval: {
        requestId: 'tplan-OTHER',
        workerAgentId: 'worker',
        planMarkdown: 'plan',
        receivedAt: Date.now(),
      },
    })
    hoisted.respondTeamPlanApproval.mockResolvedValue(true)

    await useChatStore.getState().respondToTeamPlanApproval({
      requestId: 'tplan-OLD',
      approve: true,
    })
    // Slot still occupied by the unrelated request.
    expect(useChatStore.getState().pendingTeamPlanApproval?.requestId).toBe('tplan-OTHER')
  })
})
