/**
 * 临时复现测试:连续两个 edit_file 工具在同一 assistant 消息内的
 * 流式渲染(tool_input_delta → tool_start → tool_result → 下一个工具)。
 * 用于排查"第二个编辑卡片不再流式渲染"的回归。
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

import type { ChatMessage, StreamEvent } from '../../types'
import { handleMainStreamEvent, useChatStore } from './storeCompose'
import { pendingAssistantByConversation } from './sessionSlice'
import { flushPendingToolInputsNow } from './toolInputDeltaBatcher'
import {
  CONV_ID,
  ASSISTANT_ID,
  resetChatStoreState,
  flushAndClearPending,
} from './mainStreamRouter.testHelpers'

beforeEach(() => {
  resetChatStoreState()
})

afterEach(() => {
  flushAndClearPending()
})

function installEmptyAssistant(): void {
  const message: ChatMessage = {
    id: ASSISTANT_ID,
    role: 'assistant',
    content: '',
    timestamp: Date.now(),
    isStreaming: true,
    blocks: [],
    toolUses: [],
  }
  useChatStore.setState({
    currentConversationId: CONV_ID,
    messages: [message],
    sessionBuffers: {
      [CONV_ID]: {
        messages: [message],
        todos: [],
        isTyping: true,
        pendingPermissionRequest: null,
        pendingAskUserQuestion: null,
        pendingTeamPlanApproval: null,
        pendingPlanApproval: null,
      },
    },
    isTyping: true,
  })
  pendingAssistantByConversation.set(CONV_ID, ASSISTANT_ID)
}

function delta(toolUseId: string, partialJson: string): void {
  handleMainStreamEvent({
    type: 'tool_input_delta',
    conversationId: CONV_ID,
    toolUseId,
    toolName: 'edit_file',
    partialJson,
  } as unknown as StreamEvent)
}

describe('连续两个 edit_file 的流式渲染', () => {
  it('第二个工具的 tool_input_delta 仍然实时更新 streamingInput', () => {
    installEmptyAssistant()

    // ── 第一个编辑:流式参数 → tool_start → tool_result ────────────
    delta('edit-1', '{"filePath":"a.ts","oldString":"x"')
    delta('edit-1', '{"filePath":"a.ts","oldString":"x","newString":"y"}')
    flushPendingToolInputsNow()

    let m = useChatStore.getState().messages[0]
    expect(m.toolUses?.[0]?.streamingInput?.partialJson).toContain('newString')

    handleMainStreamEvent({
      type: 'tool_start',
      conversationId: CONV_ID,
      toolUse: {
        id: 'edit-1',
        name: 'edit_file',
        input: { filePath: 'a.ts', oldString: 'x', newString: 'y' },
      },
    } as unknown as StreamEvent)
    handleMainStreamEvent({
      type: 'tool_result',
      conversationId: CONV_ID,
      toolResult: { id: 'edit-1', name: 'edit_file', success: true, output: 'ok' },
    } as unknown as StreamEvent)

    // ── 第二轮:thinking → 第二个编辑流式参数 ─────────────────────
    handleMainStreamEvent({
      type: 'thinking_delta',
      conversationId: CONV_ID,
      text: '接着改第二处。',
    } as unknown as StreamEvent)

    delta('edit-2', '{"filePath":"b.ts","oldString":"m"')

    m = useChatStore.getState().messages[0]
    const tu2 = m.toolUses?.find((t) => t.id === 'edit-2')
    // 第一个 delta 应当同步 seed 占位卡片 + streamingInput
    expect(tu2).toBeTruthy()
    expect(tu2?.streamingInput?.partialJson).toBe('{"filePath":"b.ts","oldString":"m"')
    const block2 = m.blocks?.find((b) => b.type === 'tool_use' && b.id === 'edit-2')
    expect(block2).toBeTruthy()

    // 后续 delta 走批处理路径,flush 后应可见
    delta('edit-2', '{"filePath":"b.ts","oldString":"m","newString":"n"}')
    flushPendingToolInputsNow()

    m = useChatStore.getState().messages[0]
    const tu2b = m.toolUses?.find((t) => t.id === 'edit-2')
    expect(tu2b?.streamingInput?.partialJson).toBe(
      '{"filePath":"b.ts","oldString":"m","newString":"n"}',
    )
  })
})
