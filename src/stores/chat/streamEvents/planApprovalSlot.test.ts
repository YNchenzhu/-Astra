/**
 * Tests for the renderer-side `pendingPlanApproval` slot and the
 * `respondToPlanApproval` action wired in `toolSlice.ts`. Mirrors
 * `teamPlanApprovalSlot.test.ts` but for the IDE `create_plan`-style
 * main-chat gate (tri-state outcomes, structured envelope).
 *
 * Validates:
 *   1. `handlePlanApprovalRequestEvent` writes the slot from a stream
 *      event payload — including the structured envelope (name, overview,
 *      todos, phases, isProject) and allowedPrompts.
 *   2. Auto-cancel-stale: when a second `plan_approval_request` arrives
 *      with a different requestId, the predecessor is auto-cancelled
 *      via IPC and the new request takes the slot.
 *   3. Events without requestId are dropped.
 *   4. `respondToPlanApproval` calls IPC and clears the slot on success.
 *   5. Slot still cleared on IPC failure.
 *   6. Slot belonging to a different request is NOT cleared.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const hoisted = vi.hoisted(() => ({
  respondPlanApproval: vi.fn(),
}))

vi.mock('../../../services/electronAPI', async () => {
  const actual = await vi.importActual<
    typeof import('../../../services/electronAPI')
  >('../../../services/electronAPI')
  return {
    ...actual,
    respondPlanApproval: hoisted.respondPlanApproval,
  }
})

vi.mock('../../desktopNotify', () => ({
  maybeDesktopNotify: vi.fn(),
}))

import { useChatStore } from '../../../stores/useChatStore'
import { handlePlanApprovalRequestEvent } from '../../../stores/chat/streamEvents/permissionStreamEvents'
import type { ChatSessionSlice, ChatState } from '../../../stores/chat/types'
import type { StreamEvent } from '../../../types'

function applyToCurrent(
  fn: (sl: ChatSessionSlice) => ChatSessionSlice,
  extra?: Partial<ChatState>,
): void {
  const st = useChatStore.getState()
  const cid = st.currentConversationId
  if (!cid) {
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
  useChatStore.setState({})
}

// `autoCancelStalePlanApproval` reaches for `globalThis.window?.electronAPI?.ai?.respondPlanApproval`
// — give it a spyable shape so single-slot tests can assert the IPC fire.
function installWindowApiSpy(): { spy: ReturnType<typeof vi.fn>; restore: () => void } {
  const spy = vi.fn().mockResolvedValue(undefined)
  const prev = (globalThis as { window?: unknown }).window
  ;(globalThis as { window?: unknown }).window = {
    electronAPI: { ai: { respondPlanApproval: spy } },
  }
  return {
    spy,
    restore: () => {
      if (prev === undefined) {
        delete (globalThis as { window?: unknown }).window
      } else {
        ;(globalThis as { window?: unknown }).window = prev
      }
    },
  }
}

describe('pendingPlanApproval slot + respondToPlanApproval', () => {
  beforeEach(() => {
    hoisted.respondPlanApproval.mockReset()
    useChatStore.setState({
      currentConversationId: null,
      pendingPermissionRequest: null,
      pendingAskUserQuestion: null,
      pendingTeamPlanApproval: null,
      pendingPlanApproval: null,
    })
  })

  afterEach(() => {
    useChatStore.setState({ pendingPlanApproval: null })
  })

  it('writes the slot from a plan_approval_request event (bare body)', () => {
    const event: StreamEvent = {
      type: 'plan_approval_request',
      requestId: 'plan-1',
      planMarkdown: '# Plan\n- step 1',
    }
    handlePlanApprovalRequestEvent(event, applyToCurrent, false)
    const slot = useChatStore.getState().pendingPlanApproval
    expect(slot).not.toBeNull()
    expect(slot?.requestId).toBe('plan-1')
    expect(slot?.planMarkdown).toContain('step 1')
    expect(typeof slot?.receivedAt).toBe('number')
    // No structured fields supplied; slot should not invent them.
    expect(slot?.name).toBeUndefined()
    expect(slot?.todos).toBeUndefined()
    expect(slot?.phases).toBeUndefined()
  })

  it('writes the slot with structured envelope (name/overview/todos/phases/isProject)', () => {
    const event: StreamEvent = {
      type: 'plan_approval_request',
      requestId: 'plan-2',
      planMarkdown: '# Plan',
      planEnvelope: {
        name: 'Refactor X',
        overview: 'Move Y to Z.',
        isProject: true,
        todos: [
          { id: 't1', content: 'audit', status: 'completed' },
          { id: 't2', content: 'implement', status: 'pending' },
        ],
        phases: [
          { name: 'Phase 1', todos: [{ content: 'read', status: 'completed' }] },
        ],
      },
      allowedPrompts: [{ tool: 'Bash', prompt: 'npm test' }],
    }
    handlePlanApprovalRequestEvent(event, applyToCurrent, false)
    const slot = useChatStore.getState().pendingPlanApproval
    expect(slot?.name).toBe('Refactor X')
    expect(slot?.overview).toBe('Move Y to Z.')
    expect(slot?.isProject).toBe(true)
    expect(slot?.todos).toHaveLength(2)
    expect(slot?.phases).toHaveLength(1)
    expect(slot?.allowedPrompts).toHaveLength(1)
  })

  it('auto-cancels the stale predecessor when a different requestId arrives', () => {
    const api = installWindowApiSpy()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const first: StreamEvent = {
        type: 'plan_approval_request',
        requestId: 'plan-A',
        planMarkdown: 'first',
      }
      const second: StreamEvent = {
        type: 'plan_approval_request',
        requestId: 'plan-B',
        planMarkdown: 'second',
      }
      handlePlanApprovalRequestEvent(first, applyToCurrent, false)
      handlePlanApprovalRequestEvent(second, applyToCurrent, false)

      // New request wins the slot.
      const slot = useChatStore.getState().pendingPlanApproval
      expect(slot?.requestId).toBe('plan-B')
      expect(slot?.planMarkdown).toBe('second')
      // Predecessor was auto-cancelled via IPC.
      expect(api.spy).toHaveBeenCalledWith(
        expect.objectContaining({ requestId: 'plan-A', outcome: 'cancelled' }),
      )
      expect(warnSpy).toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
      api.restore()
    }
  })

  it('drops events that have no requestId', () => {
    const event = {
      type: 'plan_approval_request',
      planMarkdown: 'orphan',
    } as unknown as StreamEvent
    handlePlanApprovalRequestEvent(event, applyToCurrent, false)
    expect(useChatStore.getState().pendingPlanApproval).toBeNull()
  })

  it('respondToPlanApproval calls IPC and clears the slot on success', async () => {
    useChatStore.setState({
      pendingPlanApproval: {
        requestId: 'plan-1',
        planMarkdown: 'plan',
        receivedAt: Date.now(),
      },
    })
    hoisted.respondPlanApproval.mockResolvedValue(true)

    const ok = await useChatStore.getState().respondToPlanApproval({
      requestId: 'plan-1',
      outcome: 'accepted',
      detail: 'lgtm',
    })
    expect(ok).toBe(true)
    expect(hoisted.respondPlanApproval).toHaveBeenCalledWith({
      requestId: 'plan-1',
      outcome: 'accepted',
      detail: 'lgtm',
    })
    expect(useChatStore.getState().pendingPlanApproval).toBeNull()
  })

  it('respondToPlanApproval clears the slot even on IPC failure', async () => {
    useChatStore.setState({
      pendingPlanApproval: {
        requestId: 'plan-1',
        planMarkdown: 'plan',
        receivedAt: Date.now(),
      },
    })
    hoisted.respondPlanApproval.mockRejectedValue(new Error('boom'))

    const ok = await useChatStore.getState().respondToPlanApproval({
      requestId: 'plan-1',
      outcome: 'rejected',
    })
    expect(ok).toBe(false)
    expect(useChatStore.getState().pendingPlanApproval).toBeNull()
  })

  it('respondToPlanApproval does NOT clear a slot belonging to a different request', async () => {
    useChatStore.setState({
      pendingPlanApproval: {
        requestId: 'plan-OTHER',
        planMarkdown: 'plan',
        receivedAt: Date.now(),
      },
    })
    hoisted.respondPlanApproval.mockResolvedValue(true)

    await useChatStore.getState().respondToPlanApproval({
      requestId: 'plan-OLD',
      outcome: 'cancelled',
    })
    expect(useChatStore.getState().pendingPlanApproval?.requestId).toBe('plan-OTHER')
  })

  it('supports all three outcomes (accepted / rejected / cancelled) via IPC', async () => {
    const outcomes: Array<'accepted' | 'rejected' | 'cancelled'> = [
      'accepted',
      'rejected',
      'cancelled',
    ]
    for (const outcome of outcomes) {
      hoisted.respondPlanApproval.mockReset()
      hoisted.respondPlanApproval.mockResolvedValue(true)
      useChatStore.setState({
        pendingPlanApproval: {
          requestId: `plan-${outcome}`,
          planMarkdown: 'plan',
          receivedAt: Date.now(),
        },
      })
      await useChatStore.getState().respondToPlanApproval({
        requestId: `plan-${outcome}`,
        outcome,
      })
      expect(hoisted.respondPlanApproval).toHaveBeenCalledWith({
        requestId: `plan-${outcome}`,
        outcome,
      })
      expect(useChatStore.getState().pendingPlanApproval).toBeNull()
    }
  })
})
