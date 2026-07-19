/**
 * Discrete (non-streaming) stream events handled by `handleMainStreamEvent`:
 *   - `mode_changed`        → reconciles permissionMode / chatInteractionMode
 *   - `tool_progress`       → updates tool block status on phase='end'
 *   - `tool_use_summary`    → attaches metadata to the matching toolUses entry
 *   - `subagent_notification` → fires desktop toast via `notifyDesktop`
 *
 * Split out of the original monolithic `handleMainStreamEvent.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../services/electronAPI', async () => {
  const m = await import('./mainStreamRouter.testMocks')
  return m.electronApiMock()
})
vi.mock('../useSettingsStore', async () => {
  const m = await import('./mainStreamRouter.testMocks')
  return m.settingsStoreMock()
})
vi.mock('../useFileStore', async () => {
  const m = await import('./mainStreamRouter.testMocks')
  return m.fileStoreMock()
})
vi.mock('../useWorkspaceStore', async () => {
  const m = await import('./mainStreamRouter.testMocks')
  return m.workspaceStoreMock()
})
vi.mock('../useBuddyStore', async () => {
  const m = await import('./mainStreamRouter.testMocks')
  return m.buddyStoreMock()
})

import type { StreamEvent, ToolUseDisplay } from '../../types'
import { handleMainStreamEvent, useChatStore } from './storeCompose'
import { notifyDesktopSpy } from './mainStreamRouter.testMocks'
import {
  CONV_ID,
  TOOL_USE_ID,
  installAssistant,
  getFirstToolBlock,
  getFirstToolUse,
  resetChatStoreState,
  flushAndClearPending,
} from './mainStreamRouter.testHelpers'
import { pendingAssistantByConversation } from './sessionSlice'

beforeEach(() => {
  resetChatStoreState()
  notifyDesktopSpy.mockClear()
})

afterEach(() => {
  flushAndClearPending()
})

// --- mode_changed --------------------------------------------------------------

describe('handleMainStreamEvent: mode_changed', () => {
  it('switches the input mode from Plan back to Agent when ExitPlanMode leaves plan', () => {
    useChatStore.setState({
      currentConversationId: CONV_ID,
      permissionMode: 'plan',
      chatInteractionMode: 'plan',
    })

    handleMainStreamEvent({
      type: 'mode_changed',
      conversationId: CONV_ID,
      mode: 'default',
    } as unknown as StreamEvent)

    expect(useChatStore.getState().permissionMode).toBe('default')
    expect(useChatStore.getState().chatInteractionMode).toBe('agent')
  })

  it('does not overwrite Ask when a non-plan mode_changed event arrives', () => {
    useChatStore.setState({
      currentConversationId: CONV_ID,
      permissionMode: 'default',
      chatInteractionMode: 'ask',
    })

    handleMainStreamEvent({
      type: 'mode_changed',
      conversationId: CONV_ID,
      mode: 'default',
    } as unknown as StreamEvent)

    expect(useChatStore.getState().permissionMode).toBe('default')
    expect(useChatStore.getState().chatInteractionMode).toBe('ask')
  })

  it('ignores mode_changed events from background conversations', () => {
    useChatStore.setState({
      currentConversationId: CONV_ID,
      permissionMode: 'plan',
      chatInteractionMode: 'plan',
    })

    handleMainStreamEvent({
      type: 'mode_changed',
      conversationId: 'background-conv',
      mode: 'default',
    } as unknown as StreamEvent)

    expect(useChatStore.getState().permissionMode).toBe('plan')
    expect(useChatStore.getState().chatInteractionMode).toBe('plan')
  })
})

// --- tool_progress ------------------------------------------------------------

describe('handleMainStreamEvent: tool_progress', () => {
  it('flips tool block + toolUses entry to "error" on phase=end + success=false', () => {
    installAssistant()

    handleMainStreamEvent({
      type: 'tool_progress',
      conversationId: CONV_ID,
      toolUseId: TOOL_USE_ID,
      phase: 'end',
      success: false,
    } as unknown as StreamEvent)

    expect(getFirstToolBlock()?.status).toBe('error')
    expect(getFirstToolUse()?.status).toBe('error')
  })

  it('keeps status "running" on phase=end + success=true (tool_result owns the final flip)', () => {
    installAssistant()

    handleMainStreamEvent({
      type: 'tool_progress',
      conversationId: CONV_ID,
      toolUseId: TOOL_USE_ID,
      phase: 'end',
      success: true,
    } as unknown as StreamEvent)

    expect(getFirstToolBlock()?.status).toBe('running')
    expect(getFirstToolUse()?.status).toBe('running')
  })

  it('is a no-op for phase=chunk / phase=start', () => {
    installAssistant()

    handleMainStreamEvent({
      type: 'tool_progress',
      conversationId: CONV_ID,
      toolUseId: TOOL_USE_ID,
      phase: 'chunk',
    } as unknown as StreamEvent)

    expect(getFirstToolBlock()?.status).toBe('running')
  })

  it('ignores events with no toolUseId or no registered assistant', () => {
    installAssistant()
    pendingAssistantByConversation.clear() // no assistant registered

    handleMainStreamEvent({
      type: 'tool_progress',
      conversationId: CONV_ID,
      toolUseId: TOOL_USE_ID,
      phase: 'end',
      success: false,
    } as unknown as StreamEvent)

    // Still running — handler early-returned because assistantId was missing.
    expect(getFirstToolBlock()?.status).toBe('running')
  })
})

// --- tool_use_summary ---------------------------------------------------------

describe('handleMainStreamEvent: tool_use_summary', () => {
  it('attaches metadata to the matching toolUses entry', () => {
    installAssistant()

    handleMainStreamEvent({
      type: 'tool_use_summary',
      conversationId: CONV_ID,
      toolUseId: TOOL_USE_ID,
      metadata: { durationMs: 1234, exitCode: 0 },
    } as unknown as StreamEvent)

    const t = getFirstToolUse() as (ToolUseDisplay & { metadata?: Record<string, unknown> }) | null
    expect(t?.metadata).toEqual({ durationMs: 1234, exitCode: 0 })
  })

  it('is a no-op if metadata is missing', () => {
    installAssistant()

    handleMainStreamEvent({
      type: 'tool_use_summary',
      conversationId: CONV_ID,
      toolUseId: TOOL_USE_ID,
    } as unknown as StreamEvent)

    const t = getFirstToolUse() as (ToolUseDisplay & { metadata?: Record<string, unknown> }) | null
    expect(t?.metadata).toBeUndefined()
  })
})

// --- subagent_notification ----------------------------------------------------

describe('handleMainStreamEvent: subagent_notification', () => {
  it('fires a desktop notification with the provided title / body', () => {
    installAssistant()

    handleMainStreamEvent({
      type: 'subagent_notification',
      conversationId: CONV_ID,
      title: '子任务完成',
      body: 'Agent(run-foo) finished',
    } as unknown as StreamEvent)

    expect(notifyDesktopSpy).toHaveBeenCalledTimes(1)
    const call = notifyDesktopSpy.mock.calls[0][0]
    expect(call.title).toBe('子任务完成')
    expect(call.body).toBe('Agent(run-foo) finished')
  })

  it('clamps overly long bodies with an ellipsis', () => {
    installAssistant()

    const longBody = 'x'.repeat(500)
    handleMainStreamEvent({
      type: 'subagent_notification',
      conversationId: CONV_ID,
      title: 't',
      body: longBody,
    } as unknown as StreamEvent)

    const call = notifyDesktopSpy.mock.calls[0][0]
    expect(call.body.length).toBeLessThanOrEqual(120)
    expect(call.body.endsWith('…')).toBe(true)
  })

  it('prefixes "其他会话" when the event targets a different conversation', () => {
    installAssistant(CONV_ID)
    useChatStore.setState({ currentConversationId: 'other-conv' })

    handleMainStreamEvent({
      type: 'subagent_notification',
      conversationId: CONV_ID,
      title: 't',
      body: 'hello',
    } as unknown as StreamEvent)

    const call = notifyDesktopSpy.mock.calls[0][0]
    expect(call.body).toContain('（其他会话）')
    expect(call.body).toContain('hello')
  })
})
