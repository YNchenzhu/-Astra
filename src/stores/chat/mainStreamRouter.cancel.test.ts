/**
 * `cancelMessage` tombstone-lite behaviour for streaming reasoning blocks.
 *
 * 用户按 Stop 时：上一版 `cancelMessage` 只把 thinking 块的 `isStreaming`
 * 翻成 false，但 `b.text` 里那截被打断的内部推理还保留着。下一轮
 * `chatMessageToAgentApiRows` 会把它当 history 回灌给模型——半截推理
 * 通常停在反思/假设阶段，回灌后模型会照着错误前提继续推，是典型的
 * "思考链噪声 → AI 幻觉"链路。
 *
 * 修复后参照 upstream-main `query.ts:712` 的 tombstone，更克制：只清
 * 当前那条半成品 thinking 块的 text（而非整条 assistant 消息）。
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

import type { ChatMessage } from '../../types'
import type { ContentBlock } from '../../types/tool'
import { useChatStore } from './storeCompose'
import { pendingAssistantByConversation } from './sessionSlice'
import { CONV_ID, resetChatStoreState, flushAndClearPending } from './mainStreamRouter.testHelpers'

beforeEach(() => {
  resetChatStoreState()
})

afterEach(() => {
  flushAndClearPending()
})

describe('cancelMessage tombstone-lite for streaming thinking blocks', () => {
  it('clears the text of a streaming thinking block so it is dropped from next-turn history', async () => {
    const assistantId = 'msg-cancel-1'
    const message: ChatMessage = {
      id: assistantId,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      isStreaming: true,
      isThinking: true,
      blocks: [
        // Half-streamed reasoning the user is about to cancel mid-thought.
        {
          type: 'thinking',
          text: '让我先怀疑这条路是错的,因为...',
          isStreaming: true,
        },
      ],
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
    pendingAssistantByConversation.set(CONV_ID, assistantId)

    await useChatStore.getState().cancelMessage()

    const msg = useChatStore.getState().messages[0]
    const thinkingBlock = msg?.blocks?.find((b) => b.type === 'thinking') as
      | Extract<ContentBlock, { type: 'thinking' }>
      | undefined

    // 块还在 — 我们没像 upstream 那样整条 tombstone，只清掉这一块的 payload。
    expect(thinkingBlock).toBeDefined()
    expect(thinkingBlock!.text).toBe('')
    expect(thinkingBlock!.isStreaming).toBe(false)
    // 整条消息也已收尾,跟上一个 bug 修复一致。
    expect(msg?.isStreaming).toBe(false)
    expect(useChatStore.getState().isTyping).toBe(false)
  })

  it('clears the text of a streaming reasoning_summary block on cancel (same tombstone-lite as thinking)', async () => {
    // Parity with thinking: OpenAI o-series streams reasoning_summary as its
    // own block channel. Without this branch, a cancel mid-summary would
    // leave the block with `isStreaming:true` (UI spinner stuck) AND a
    // half-formed text payload that ReasoningSummaryBlock would render
    // until the next message_stop — which never arrives because the user
    // cancelled.
    const assistantId = 'msg-cancel-rs'
    const message: ChatMessage = {
      id: assistantId,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      isStreaming: true,
      blocks: [
        {
          type: 'reasoning_summary',
          text: 'I started to summarise but the user hit Stop here',
          isStreaming: true,
        },
      ],
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
    pendingAssistantByConversation.set(CONV_ID, assistantId)

    await useChatStore.getState().cancelMessage()

    const block = useChatStore.getState().messages[0]?.blocks?.find(
      (b) => b.type === 'reasoning_summary',
    ) as Extract<ContentBlock, { type: 'reasoning_summary' }> | undefined

    expect(block).toBeDefined()
    expect(block!.text).toBe('')
    expect(block!.isStreaming).toBe(false)
  })

  it('marks running tool_use blocks + toolUses as stopped (not completed) on cancel', async () => {
    // Honesty fix: a user Stop is a cancellation, not a success. A running
    // tool must land on the terminal 'stopped' status (which the ToolUseCard
    // renders with a retry affordance), never the misleading 'completed'.
    const assistantId = 'msg-cancel-tool'
    const message: ChatMessage = {
      id: assistantId,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      isStreaming: true,
      blocks: [
        {
          type: 'tool_use',
          id: 'tu-running',
          name: 'Bash',
          input: { command: 'sleep 100' },
          status: 'running',
        },
      ],
      toolUses: [
        {
          id: 'tu-running',
          name: 'Bash',
          input: { command: 'sleep 100' },
          status: 'running',
        },
      ],
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
    pendingAssistantByConversation.set(CONV_ID, assistantId)

    await useChatStore.getState().cancelMessage()

    const msg = useChatStore.getState().messages[0]
    const toolBlock = msg?.blocks?.find((b) => b.type === 'tool_use') as
      | Extract<ContentBlock, { type: 'tool_use' }>
      | undefined
    expect(toolBlock?.status).toBe('stopped')
    expect(msg?.toolUses?.[0]?.status).toBe('stopped')
  })

  it('keeps completed (non-streaming) thinking blocks untouched on cancel', async () => {
    // Cancel 时只动"还在 streaming 的"那一块。前面已经完成、有 signature
    // 的 thinking 块属于稳定历史,不应该被一起清空——否则会破坏当轮内
    // 多段思考 (thinking → tool_use → thinking) 中已签名的前段。
    const assistantId = 'msg-cancel-2'
    const message: ChatMessage = {
      id: assistantId,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      isStreaming: true,
      isThinking: true,
      blocks: [
        {
          type: 'thinking',
          text: '稳定的前段思考',
          isStreaming: false,
          signature: 'sig-stable',
        },
        {
          type: 'tool_use',
          id: 'tu-1',
          name: 'Bash',
          input: { command: 'ls' },
          status: 'completed',
        },
        {
          type: 'thinking',
          text: '正在被打断的后段',
          isStreaming: true,
        },
      ],
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
    pendingAssistantByConversation.set(CONV_ID, assistantId)

    await useChatStore.getState().cancelMessage()

    const blocks = useChatStore.getState().messages[0]?.blocks ?? []
    const thinkingBlocks = blocks.filter(
      (b): b is Extract<ContentBlock, { type: 'thinking' }> => b.type === 'thinking',
    )
    expect(thinkingBlocks).toHaveLength(2)
    // 前段稳定块保留 text + signature。
    expect(thinkingBlocks[0].text).toBe('稳定的前段思考')
    expect(thinkingBlocks[0].isStreaming).toBe(false)
    expect(thinkingBlocks[0].signature).toBe('sig-stable')
    // 后段被取消那一块 text 清空。
    expect(thinkingBlocks[1].text).toBe('')
    expect(thinkingBlocks[1].isStreaming).toBe(false)
  })
})
