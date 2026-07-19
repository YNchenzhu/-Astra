/**
 * ChatMessageList — the scrolling transcript subtree.
 *
 * Extracted from `ChatPanel` so the `messages` subscription (which changes on
 * every streaming delta) lives HERE, not in the panel. Previously ChatPanel
 * subscribed to `messages` and therefore re-rendered its entire chrome
 * (header, ContextMeter, StreamingModeBar, prompts, …) plus recomputed its
 * O(n) derived memos on every token. Now only this subtree re-renders per
 * delta; the panel re-renders only when a message is added/removed (length)
 * or another subscribed field changes.
 *
 * Owns everything that depends on the live message array:
 *   - virtualization decision + the VirtualMessageList / plain map
 *   - the `.chat-messages` scroll container + empty state
 *   - follow-the-bottom state, the scroll listener, and the three scroll-snap
 *     effects (conversation switch, virtualize flip, per-delta follow)
 *
 * Exposes `jumpToMessage` via ref so the panel's ReasoningTimeline / history
 * search can still scroll the transcript.
 */
import React, {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useChatStore } from '../../../stores/useChatStore'
import {
  CHAT_VIRTUALIZE_CHAR_THRESHOLD,
  CHAT_VIRTUALIZE_MESSAGE_COUNT_THRESHOLD,
  estimateConversationRenderableChars,
} from '../../../utils/chatRenderableWeight'
import { ChatMessage } from '../ChatMessage'
import { VirtualMessageList, type VirtualMessageListHandle } from '../VirtualMessageList'
import { ChatEmptyStateAvatar } from './ChatEmptyStateAvatar'
import type { ChatMessageStoreSliceProps } from '../chatMessage/types'
import { useT } from '../../../i18n'

export interface ChatMessageListHandle {
  jumpToMessage: (messageId: string) => void
}

interface ChatMessageListProps {
  showThinkingSummaries: boolean
  recalledMemories: ChatMessageStoreSliceProps['recalledMemories']
  thinkingAutoCollapseThreshold: number
  prefersReducedMotion: boolean
  enableTools: boolean
  promptSuggestionEnabled: boolean
  suggestions: string[]
  onSuggestionClick: (text: string) => void
}

const ChatMessageListInner = (
  {
    showThinkingSummaries,
    recalledMemories,
    thinkingAutoCollapseThreshold,
    prefersReducedMotion,
    enableTools,
    promptSuggestionEnabled,
    suggestions,
    onSuggestionClick,
  }: ChatMessageListProps,
  ref: React.Ref<ChatMessageListHandle>,
) => {
  const t = useT()
  const messages = useChatStore((s) => s.messages)
  const isTyping = useChatStore((s) => s.isTyping)
  const currentConversationId = useChatStore((s) => s.currentConversationId)

  const messagesContainerRef = useRef<HTMLDivElement>(null)
  const virtualListRef = useRef<VirtualMessageListHandle>(null)
  const [isNearBottom, setIsNearBottom] = useState(true)
  const isNearBottomRef = useRef(true)

  const conversationRenderableChars = useMemo(
    () => estimateConversationRenderableChars(messages),
    [messages],
  )
  /** Few messages can still be huge (tool dumps); must virtualize before layout/paint eats the UI thread. */
  const shouldVirtualize =
    messages.length > CHAT_VIRTUALIZE_MESSAGE_COUNT_THRESHOLD ||
    conversationRenderableChars >= CHAT_VIRTUALIZE_CHAR_THRESHOLD

  const lastMessage = messages.length > 0 ? messages[messages.length - 1] : undefined
  const assistantStreaming =
    lastMessage?.role === 'assistant' && Boolean(lastMessage?.isStreaming)
  /** 跟随时用 instant scroll，避免 smooth 以过时 scrollHeight 为目标导致「离底差一截」 */
  const stickFollowOutput = Boolean(isTyping || assistantStreaming)

  // 长会话兜底：一次性扫所有 assistant.blocks 计 thinking 块总数。
  const totalThinkingBlocks = useMemo(() => {
    let n = 0
    for (const m of messages) {
      if (m.role !== 'assistant') continue
      const blocks = m.blocks
      if (!Array.isArray(blocks)) continue
      for (const b of blocks) {
        if (b.type === 'thinking') n++
      }
    }
    return n
  }, [messages])

  const renderMessageItem = useCallback(
    (message: (typeof messages)[number], index: number) => (
      <ChatMessage
        key={message.id}
        message={message}
        isLastMessage={index === messages.length - 1}
        showThinkingSummaries={showThinkingSummaries}
        recalledMemories={recalledMemories}
        totalThinkingBlocks={totalThinkingBlocks}
        thinkingAutoCollapseThreshold={thinkingAutoCollapseThreshold}
      />
    ),
    [
      messages.length,
      recalledMemories,
      showThinkingSummaries,
      totalThinkingBlocks,
      thinkingAutoCollapseThreshold,
    ],
  )

  // Scroll listener only needs to be bound once; the ref and closure capture
  // the container node, and the handler reads live scrollTop/scrollHeight.
  useEffect(() => {
    const container = messagesContainerRef.current
    if (!container) return

    const onScroll = () => {
      const distanceToBottom = container.scrollHeight - container.scrollTop - container.clientHeight
      const near = distanceToBottom < 120
      isNearBottomRef.current = near
      setIsNearBottom(near)
    }

    onScroll()
    container.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      container.removeEventListener('scroll', onScroll)
    }
  }, [])

  // Switching to a different conversation is "open fresh from the bottom".
  useEffect(() => {
    isNearBottomRef.current = true
    const raf = requestAnimationFrame(() => {
      virtualListRef.current?.scrollToBottom('auto')
      const container = messagesContainerRef.current
      if (container) {
        container.scrollTo({ top: container.scrollHeight, behavior: 'auto' })
      }
    })
    return () => cancelAnimationFrame(raf)
  }, [currentConversationId])

  // `shouldVirtualize` can flip mid-stream; re-assert follow-the-bottom across
  // the plain-list <-> VirtualMessageList swap. useLayoutEffect so we read
  // `isNearBottomRef` BEFORE the clamp-induced scroll event overwrites it.
  const prevShouldVirtualizeRef = useRef(shouldVirtualize)
  useLayoutEffect(() => {
    if (prevShouldVirtualizeRef.current === shouldVirtualize) return
    prevShouldVirtualizeRef.current = shouldVirtualize
    if (!isNearBottomRef.current) return

    const snap = () => {
      virtualListRef.current?.scrollToBottom('auto')
      const container = messagesContainerRef.current
      if (container) {
        container.scrollTo({ top: container.scrollHeight, behavior: 'auto' })
      }
    }
    snap()
    const raf = requestAnimationFrame(() => {
      if (isNearBottomRef.current) snap()
    })
    return () => cancelAnimationFrame(raf)
  }, [shouldVirtualize])

  useEffect(() => {
    if (messages.length === 0 || !isNearBottom) return

    const behavior: ScrollBehavior =
      prefersReducedMotion || stickFollowOutput ? 'auto' : 'smooth'

    if (shouldVirtualize) {
      virtualListRef.current?.scrollToBottom(behavior)
      if (behavior === 'auto' && stickFollowOutput) {
        requestAnimationFrame(() => {
          if (!isNearBottomRef.current) return
          virtualListRef.current?.scrollToBottom('auto')
        })
      }
      return
    }

    const container = messagesContainerRef.current
    if (!container) return
    container.scrollTo({
      top: container.scrollHeight,
      behavior,
    })
    if (behavior === 'auto' && stickFollowOutput) {
      requestAnimationFrame(() => {
        if (!isNearBottomRef.current || !messagesContainerRef.current) return
        const el = messagesContainerRef.current
        el.scrollTo({ top: el.scrollHeight, behavior: 'auto' })
      })
    }
  }, [messages, isNearBottom, prefersReducedMotion, shouldVirtualize, stickFollowOutput])

  const jumpToMessage = useCallback(
    (messageId: string) => {
      virtualListRef.current?.scrollToMessage(messageId, prefersReducedMotion ? 'auto' : 'smooth')
      if (!shouldVirtualize) {
        const target = document.getElementById(`chat-message-${messageId}`)
        target?.scrollIntoView({ behavior: prefersReducedMotion ? 'auto' : 'smooth', block: 'start' })
      }
    },
    [prefersReducedMotion, shouldVirtualize],
  )

  useImperativeHandle(ref, () => ({ jumpToMessage }), [jumpToMessage])

  const messagesBody = useMemo(() => {
    if (!shouldVirtualize) {
      return messages.map((msg, idx) => (
        <ChatMessage
          key={msg.id}
          message={msg}
          isLastMessage={idx === messages.length - 1}
          showThinkingSummaries={showThinkingSummaries}
          recalledMemories={recalledMemories}
          totalThinkingBlocks={totalThinkingBlocks}
          thinkingAutoCollapseThreshold={thinkingAutoCollapseThreshold}
        />
      ))
    }

    return (
      <VirtualMessageList
        ref={virtualListRef}
        messages={messages}
        containerRef={messagesContainerRef}
        renderMessage={renderMessageItem}
        pinToBottomRef={isNearBottomRef}
      />
    )
  }, [
    messages,
    renderMessageItem,
    shouldVirtualize,
    showThinkingSummaries,
    recalledMemories,
    totalThinkingBlocks,
    thinkingAutoCollapseThreshold,
  ])

  const isEmpty = messages.length === 0

  return (
    <div className="chat-messages" ref={messagesContainerRef}>
      {isEmpty && (
        <div className="chat-empty-state">
          <ChatEmptyStateAvatar />
          <h3>{t.chat.emptyTitle}</h3>
          <p>{enableTools ? t.chat.emptyWithTools : t.chat.emptyNoTools}</p>
          {promptSuggestionEnabled && (
            <div className="chat-empty-suggestions">
              {suggestions.map((text) => (
                <button
                  key={text}
                  className="chat-empty-suggestion"
                  onClick={() => onSuggestionClick(text)}
                  title={t.chat.suggestionFillTitle}
                >
                  {text}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {messagesBody}
    </div>
  )
}

// Memoised: ChatPanel re-renders on its own ~0.3Hz timers (spinner tip /
// context / planning polls). Its props here are stable refs (settings + a
// useMemo'd suggestions array + stable store actions), so memo lets the
// transcript subtree skip those parent re-renders entirely — only this
// component's own `messages` subscription drives its updates.
export const ChatMessageList = memo(
  forwardRef<ChatMessageListHandle, ChatMessageListProps>(ChatMessageListInner),
)
ChatMessageList.displayName = 'ChatMessageList'
