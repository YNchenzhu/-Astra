/**
 * `context_compact` transient-toast behaviour + `stream_fallback_reset`
 * empty-shell tombstoning + compact-summary capture.
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

import type { ChatMessage, StreamEvent } from '../../types'
import { handleMainStreamEvent, useChatStore } from './storeCompose'
import { pendingAssistantByConversation } from './sessionSlice'
import {
  CONV_ID,
  installAssistant,
  resetChatStoreState,
  flushAndClearPending,
} from './mainStreamRouter.testHelpers'
import {
  useCompactionToastStore,
  __resetCompactionToastForTests,
} from '../useCompactionToastStore'

beforeEach(() => {
  resetChatStoreState()
  __resetCompactionToastForTests()
})

afterEach(() => {
  flushAndClearPending()
  __resetCompactionToastForTests()
})

// --- context_compact: transient toast (no permanent transcript divider) ---

describe('handleMainStreamEvent: context_compact', () => {
  it('does NOT append a transcript entry; resolves the toast to done + reclaimed', () => {
    installAssistant()
    const before = useChatStore.getState().messages
    expect(before).toHaveLength(1)

    handleMainStreamEvent({
      type: 'context_compact',
      conversationId: CONV_ID,
      level: 'auto_compact',
      preTokens: 80_000,
      postTokens: 55_000,
      reclaimedTokens: 25_000,
    } as unknown as StreamEvent)

    // No permanent divider is inserted any more — the transcript is unchanged.
    const msgs = useChatStore.getState().messages
    expect(msgs).toHaveLength(1)
    expect(msgs[0].content).toBe('')

    // The transient toast resolves to its "done" state.
    const notice = useCompactionToastStore.getState().notice
    expect(notice).toMatchObject({
      status: 'done',
      level: 'auto_compact',
      reclaimedTokens: 25_000,
    })
  })

  it('context_compact_start shows a transient "compacting" toast', () => {
    installAssistant()
    handleMainStreamEvent({
      type: 'context_compact_start',
      conversationId: CONV_ID,
      level: 'history_snip',
    } as unknown as StreamEvent)

    expect(useChatStore.getState().messages).toHaveLength(1)
    expect(useCompactionToastStore.getState().notice).toMatchObject({
      status: 'compacting',
      level: 'history_snip',
    })
  })

  it('start → done transitions the same toast slot, then it can be dismissed', () => {
    installAssistant()
    handleMainStreamEvent({
      type: 'context_compact_start',
      conversationId: CONV_ID,
      level: 'auto_compact',
    } as unknown as StreamEvent)
    const startId = useCompactionToastStore.getState().notice?.id
    expect(startId).toBeDefined()

    handleMainStreamEvent({
      type: 'context_compact',
      conversationId: CONV_ID,
      level: 'auto_compact',
      reclaimedTokens: 12_000,
    } as unknown as StreamEvent)

    const notice = useCompactionToastStore.getState().notice
    expect(notice?.id).toBe(startId)
    expect(notice?.status).toBe('done')
  })

  // --- Phase 2.B — stream_fallback_reset 空壳治理 ---
  //
  // Anthropic HTTP 529 触发非流式 fallback 时，main 进程发出
  // `stream_fallback_reset` 事件。mainStreamRouter 把当前 assistant 消息的
  // 内容全部清空，并额外打 `_streamFallbackTombstone: true` 标记。
  //
  // 下游消费者据此：
  //   1. contextBuilder 不回灌（unit-tested 在 contextBuilder.agentApi.test.ts）
  //   2. ChatMessage UI 不渲染（行为已实现于 ChatMessage.tsx）
  //   3. cleanMessagesForPersist 整条丢弃（unit-tested 在 conversationPersistence.test.ts）
  // 本块测试只覆盖路由器的写入语义。
  it('stream_fallback_reset clears content AND marks the message as _streamFallbackTombstone', () => {
    const assistantId = 'msg-fallback-test'
    const message: ChatMessage = {
      id: assistantId,
      role: 'assistant',
      content: '半截流式回复',
      timestamp: Date.now(),
      isStreaming: true,
      isThinking: true,
      thinking: '正在被打断的思考',
      blocks: [
        {
          type: 'thinking',
          text: '正在被打断的思考',
          isStreaming: true,
        },
        {
          type: 'tool_use',
          id: 'tu-pending',
          name: 'Read',
          input: { filePath: 'a.ts' },
          status: 'running',
        },
      ],
      toolUses: [
        {
          id: 'tu-pending',
          name: 'Read',
          input: { filePath: 'a.ts' },
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
    })
    pendingAssistantByConversation.set(CONV_ID, assistantId)

    handleMainStreamEvent({
      type: 'stream_fallback_reset',
      conversationId: CONV_ID,
      status: '529',
      reason: 'overloaded',
    } as unknown as StreamEvent)

    const msg = useChatStore.getState().messages[0]
    expect(msg).toBeDefined()
    // 内容已全部清空
    expect(msg.content).toBe('')
    expect(msg.thinking).toBe('')
    expect(msg.isThinking).toBe(false)
    expect(msg.blocks).toEqual([])
    expect(msg.toolUses).toEqual([])
    // 关键：tombstone 标记必须置位 — 下游 contextBuilder / UI / persist
    // 都依赖它识别"这是个被 fallback 抛弃的空壳"。
    expect(msg._streamFallbackTombstone).toBe(true)
  })

  it('captures the summary payload into currentCompactSummary for the next send', () => {
    installAssistant()
    handleMainStreamEvent({
      type: 'context_compact',
      conversationId: CONV_ID,
      level: 'auto_compact',
      text: 'Recap: ran tests, fixed Bug 42.',
    } as unknown as StreamEvent)

    expect(useChatStore.getState().currentCompactSummary).toBe(
      'Recap: ran tests, fixed Bug 42.',
    )
  })
})
