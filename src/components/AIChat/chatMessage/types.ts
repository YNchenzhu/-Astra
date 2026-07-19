import type { ChatMessage as ChatMessageType } from '../../../types'

/** Passed from ChatPanel so memo can re-render when settings / memory citation state changes. */
export type ChatMessageStoreSliceProps = {
  showThinkingSummaries: boolean
  recalledMemories: ReadonlyArray<{
    filename: string
    name?: string
    type?: string
    matchSnippet?: string
  }>
}

export interface ChatMessageProps extends ChatMessageStoreSliceProps {
  message: ChatMessageType
  isLastMessage?: boolean
  /**
   * 长会话兜底（plan Phase 3.B）：当前会话累积的 thinking 块总数。父组件
   * （ChatPanel）用 useMemo 一次计算后通过 prop drill 传下来 — 比每个
   * ChatMessage 各自订阅 store 便宜得多，且保持组件纯。
   *
   * undefined / 0 = 关闭长会话折叠行为（保持原有逻辑）。
   */
  totalThinkingBlocks?: number
  /**
   * 配套阈值（`useSettingsStore.thinkingAutoCollapseThreshold`）。同样通过
   * prop drill 而不是订阅，原因同上。0 = 关闭机制。
   */
  thinkingAutoCollapseThreshold?: number
}
