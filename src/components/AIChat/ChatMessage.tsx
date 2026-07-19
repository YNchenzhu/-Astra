import React, { Fragment, memo, useRef, useState, useMemo } from 'react'
import { User, Sparkles, CornerDownLeft, Pencil, RefreshCw } from 'lucide-react'
import type { ContentBlock, ToolUseDisplay } from '../../types'
import { UserMessageAttachments } from './chatMessage/UserMessageAttachments'
import { useChatStore } from '../../stores/useChatStore'
import { CodeBlock } from './CodeBlock'
import { ImagePreview } from './ImagePreview'
import { ToolUseCard } from './ToolUseCard'
import { ToolBlockGroup } from './ToolBlockGroup'
import { ThinkingBlock } from './ThinkingBlock'
import { RedactedThinkingBlock } from './RedactedThinkingBlock'
import { ReasoningSummaryBlock } from './ReasoningSummaryBlock'
import { AgentBlock } from './AgentBlock'
import { SubAgentsProgressBar } from './SubAgentsProgressBar'
import { RetrievedChunks } from './RetrievedChunks'
import { AskUserQuestionBlock } from './AskUserQuestionDialog'
import { PlaceholderBlock } from './PlaceholderBlock'
import { groupBlocks } from './chatMessage/groupBlocks'
import { MarkdownContent, AnimatedBlock } from './chatMessage/markdown'
import {
  UserMessageReferencedFiles,
  MemoryCitation,
  MessageTimestamp,
  MessageCopyButton,
  CompactBoundaryRow,
} from './chatMessage/subcomponents'
import { extractMessageCopyText, chatMessagePropsEqual } from './chatMessage/helpers'
import type { ChatMessageProps, ChatMessageStoreSliceProps } from './chatMessage/types'
import { useT } from '../../i18n'
import './ChatInput.css'
import './ChatMessage.css'
import { assistantAvatarUrl } from '../../brandingAssets'

// Re-exported for backward compatibility: `groupBlocks` is consumed by
// `chatMessageHelpers.test.ts`, and `ChatMessageStoreSliceProps` by ChatPanel.
// eslint-disable-next-line react-refresh/only-export-components
export { groupBlocks }
export type { ChatMessageStoreSliceProps }

// Module-level stable handlers: these only read the store via `getState()`,
// so a single shared identity is correct and lets the memoised ToolUseCard /
// ToolBlockGroup skip re-renders (inline arrows would change every render).
const stopToolTaskById = (id: string) => useChatStore.getState().stopToolTask(id)
const retryToolTaskById = (id: string) => useChatStore.getState().retryToolTask(id)

const ChatMessageInner: React.FC<ChatMessageProps> = ({
  message,
  isLastMessage,
  showThinkingSummaries,
  recalledMemories,
  totalThinkingBlocks,
  thinkingAutoCollapseThreshold,
}) => {
  const t = useT()
  const isUser = message.role === 'user'
  const [avatarLoadFailed, setAvatarLoadFailed] = useState(false)
  // Inline edit state for user messages (edit → truncate → resend).
  const [isEditing, setIsEditing] = useState(false)
  const [editText, setEditText] = useState('')
  const showRewind = !isLastMessage && !message.isStreaming

  // Hoisted above every early return so the hook call order is stable.
  // Some rows intentionally render as null / boundary-only, but React still
  // requires this component to call the same hooks across render shapes.
  const grouped = useMemo(() => {
    if (!message.blocks) return []
    return groupBlocks(message.blocks)
  }, [message.blocks])
  const orphanSubAgents = useMemo(() => {
    return message.subAgents?.filter((sa) => !sa.parentToolId) ?? []
  }, [message.subAgents])
  // Map parentToolId -> subAgents. Memoised (and hoisted above the early
  // returns so the hook order stays stable) so `getSubAgentsForTool` returns
  // a STABLE array reference per tool while `message.subAgents` is unchanged —
  // a prerequisite for the ToolUseCard / ToolBlockGroup memo to actually skip.
  //
  // Per-parent array reuse: any sub-agent update produces a fresh
  // `message.subAgents` array, which would otherwise rebuild EVERY parent's
  // bucket with a new reference and re-render every Agent tool card. We keep
  // the previous array reference for a parentToolId whose members are
  // unchanged, so only the tool whose sub-agent actually changed re-renders.
  const subAgentArrayCacheRef = useRef<Map<string, NonNullable<typeof message.subAgents>>>(new Map())
  const subAgentsByParent = useMemo(() => {
    const grouped = new Map<string, NonNullable<typeof message.subAgents>>()
    for (const sa of message.subAgents || []) {
      if (sa.parentToolId) {
        const existing = grouped.get(sa.parentToolId) || []
        existing.push(sa)
        grouped.set(sa.parentToolId, existing)
      }
    }
    const cache = subAgentArrayCacheRef.current
    const next = new Map<string, NonNullable<typeof message.subAgents>>()
    for (const [parentId, arr] of grouped) {
      // 有意的渲染期 ref 缓存(见本 useMemo 上方注释:per-parent 数组引用
      // 复用,保住 ToolUseCard/ToolBlockGroup 的 memo)。此前编译器规则对
      // 本组件整体 bail out,2026-07 拆出 UserMessageAttachments 后组件变得
      // 可分析,规则才开始报;模式本身未变,定向豁免。
      // eslint-disable-next-line react-hooks/refs
      const prev = cache.get(parentId)
      next.set(
        parentId,
        prev && prev.length === arr.length && prev.every((p, i) => p === arr[i])
          ? prev
          : arr,
      )
    }
    // eslint-disable-next-line react-hooks/refs -- 同上,有意的渲染期缓存写回
    subAgentArrayCacheRef.current = next
    return next
  }, [message.subAgents])

  // Plan Phase 2.B — fallback tombstone：当 stream_fallback_reset 已经清空
  // 消息体并打了标记，且当前消息不在 streaming 中且消息确实是空壳（fallback
  // 失败 / 双重失败）→ UI 完全不渲染。
  //
  // 修订：fallback 成功后非流式响应会通过 emitAnthropicNonStreamMessageAsStreamCallbacks
  // 重新往同一条消息追加 blocks。这时标记还在但 blocks 已经有真实内容了 —
  // 这种情况应该正常显示而不是隐藏。只在"标记 + 真的没内容"双重满足时 return null。
  if (
    message._streamFallbackTombstone === true &&
    !message.isStreaming &&
    (!message.blocks || message.blocks.length === 0) &&
    (!message.content || message.content.trim().length === 0) &&
    (!message.toolUses || message.toolUses.length === 0)
  ) {
    return null
  }

  // 长会话兜底：当 thinking 块总数超过阈值时，所有"非 streaming 的"历史
  // thinking 块强制折叠（用户手动展开不受影响）。阈值 0 = 关闭机制。
  const longSessionAutoCollapse =
    typeof thinkingAutoCollapseThreshold === 'number' &&
    thinkingAutoCollapseThreshold > 0 &&
    typeof totalThinkingBlocks === 'number' &&
    totalThinkingBlocks > thinkingAutoCollapseThreshold
  // Compact boundary: dim horizontal divider inserted by
  // `mainStreamRouter` on `context_compact` stream events. Render first
  // so the row never touches any of the assistant-bubble plumbing below
  // (hooks, avatar, copy button, rewind, etc.). The Rules-of-Hooks
  // hazard documented in the assistant-branch comment doesn't apply
  // here — a row tagged `kind === 'compact_boundary'` never mutates
  // into another role at runtime.
  if (message.kind === 'compact_boundary') {
    return <CompactBoundaryRow boundary={message.compactBoundary} />
  }

  // Sub-agent-only messages: standalone timeline entries for orphan sub-agents
  // that were spawned without a parent tool. Render a compact card instead of
  // the full assistant bubble so the timeline stays dense.
  const isSubAgentOnly =
    !isUser &&
    (message.subAgents?.length ?? 0) > 0 &&
    !message.content?.trim() &&
    (!message.blocks || message.blocks.length === 0) &&
    (!message.toolUses || message.toolUses.length === 0) &&
    !message.thinking?.trim() &&
    !message.attachments?.length &&
    !message.referencedFiles?.length

  // Backward-compat: persisted conversations from before the header-pill
  // refactor may still contain `subagent-msg-*` bubbles whose only sub-agent
  // is `session-memory-internal`. Hide them — the live status now lives in
  // the ChatPanel header indicator.
  const isLegacySessionMemoryOnly =
    isSubAgentOnly &&
    (message.subAgents ?? []).every((sa) => sa.agentType === 'session-memory-internal')
  if (isLegacySessionMemoryOnly) return null

  // Stable lookup over the memoised map above (identity irrelevant — only
  // the returned array reference matters for the downstream card memo).
  const getSubAgentsForTool = (toolId: string) => subAgentsByParent.get(toolId)

  // User message — simple text
  if (isUser) {
    const submitEdit = () => {
      const next = editText.trim()
      setIsEditing(false)
      if (!next || next === message.content) return
      void useChatStore.getState().editUserMessage(message.id, next)
    }
    return (
      <div id={`chat-message-${message.id}`} className={`chat-message user`}>
        <div className="chat-message-avatar">
          <User size={16} />
        </div>
        <div className="chat-message-body">
          <div className="chat-message-header">
            <span className="chat-message-role">{t.message.roleUser}</span>
            <MessageTimestamp ts={message.timestamp} />
            {!isEditing && (
              <button
                className="chat-rewind-btn"
                onClick={() => {
                  setEditText(message.content)
                  setIsEditing(true)
                }}
                title={t.message.editMessage}
              >
                <Pencil size={12} />
              </button>
            )}
            {showRewind && !isEditing && (
              <button
                className="chat-rewind-btn chat-rewind-btn--sibling"
                onClick={() => useChatStore.getState().rewindToMessage(message.id)}
                title={t.message.rewind}
              >
                <CornerDownLeft size={13} />
              </button>
            )}
          </div>
          <div className="chat-message-content">
            {message.referencedFiles && message.referencedFiles.length > 0 && (
              <UserMessageReferencedFiles paths={message.referencedFiles} />
            )}
            {/* Render image attachments */}
            {message.attachments && message.attachments.length > 0 && (
              <UserMessageAttachments attachments={message.attachments} />
            )}
            {isEditing ? (
              <div className="chat-message-edit">
                <textarea
                  className="chat-message-edit-input"
                  value={editText}
                  autoFocus
                  rows={Math.min(10, Math.max(2, editText.split('\n').length))}
                  onChange={(e) => setEditText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                      e.preventDefault()
                      submitEdit()
                    } else if (e.key === 'Escape') {
                      setIsEditing(false)
                    }
                  }}
                />
                <div className="chat-message-edit-actions">
                  <button
                    type="button"
                    className="chat-message-copy chat-message-edit-send"
                    disabled={!editText.trim()}
                    onClick={submitEdit}
                  >
                    {t.message.editSend}
                  </button>
                  <button
                    type="button"
                    className="chat-message-copy"
                    onClick={() => setIsEditing(false)}
                  >
                    {t.message.editCancel}
                  </button>
                </div>
              </div>
            ) : (
              <div className="chat-message-text">{message.content}</div>
            )}
            {/* RAG retrieval hit pills — rendered under the user bubble when the
                embedding pipeline surfaced attachment chunks for this turn.
                See src/components/AIChat/RetrievedChunks.tsx for the interactive
                pill strip + click-through modal. */}
            {message.retrievedChunks && message.retrievedChunks.length > 0 && (
              <RetrievedChunks chunks={message.retrievedChunks} />
            )}
          </div>
          <div className="chat-message-actions">
            <MessageCopyButton getText={() => extractMessageCopyText(message)} />
          </div>
        </div>
      </div>
    )
  }

  // Sub-agent-only message: a timeline slot whose only payload is one or
  // more sub-agent cards (no text, no blocks, no toolUses). These typically
  // come from background Agent forks (`run_in_background: true`) whose
  // status updates land AFTER the spawning assistant turn has settled, or
  // from skill / debug fork paths that don't surface a parent tool_use
  // alongside the spawned agent.
  //
  // Earlier this branch stripped the assistant chrome entirely (just the
  // bare `agent-only` card with no avatar / no "星构Astra" header). The
  // outcome was that long-running forks showed up as floating
  // `Ran 1 command 117s · 42.8k tok` rows in the timeline — visually
  // dissociated from any sender, so the user reasonably read them as
  // "rendering timing errors" (the AI Chat bug screenshot 2026-05-28).
  //
  // Fix: render the standard assistant chrome (avatar + "星构Astra" + ts)
  // so the cards clearly attribute to an assistant turn. Keep the
  // `agent-only` class so the tint distinguishes the slot from a chatty
  // assistant bubble. The `session-memory-internal` short-circuit a few
  // lines above still hides those completely, so this change only
  // surfaces user-meaningful forks.
  if (isSubAgentOnly) {
    const orphanAgents = message.subAgents!.filter((sa) => !sa.parentToolId)
    return (
      <div id={`chat-message-${message.id}`} className="chat-message assistant agent-only">
        <div className="chat-message-avatar">
          {avatarLoadFailed ? (
            <Sparkles size={16} />
          ) : (
            <img
              src={assistantAvatarUrl}
              alt="星构Astra"
              className="chat-assistant-avatar-img"
              onError={() => setAvatarLoadFailed(true)}
            />
          )}
        </div>
        <div className="chat-message-body">
          <div className="chat-message-header">
            <span className="chat-message-role">星构Astra</span>
            <MessageTimestamp ts={message.timestamp} />
          </div>
          <div className="chat-message-content">
            <div className="chat-sub-agents">
              {orphanAgents.length > 1 && (
                <SubAgentsProgressBar
                  subAgents={orphanAgents}
                  streaming={message.isStreaming === true}
                />
              )}
              {orphanAgents.map((subAgent) => (
                <AgentBlock key={subAgent.agentId} agent={subAgent} />
              ))}
            </div>
          </div>
        </div>
      </div>
    )
  }

  // Assistant message — render with blocks (chronological order) or fallback
  const hasBlocks = message.blocks && message.blocks.length > 0
  // `grouped` and `orphanSubAgents` are computed unconditionally near the
  // top of the component (above all early returns) so the hook-call order
  // stays stable across renders.

  return (
    <div id={`chat-message-${message.id}`} className="chat-message assistant">
      <div className="chat-message-avatar">
        {avatarLoadFailed ? (
          <Sparkles size={16} />
        ) : (
          <img
            src={assistantAvatarUrl}
            alt="星构Astra"
            className="chat-assistant-avatar-img"
            onError={() => setAvatarLoadFailed(true)}
          />
        )}
      </div>
      <div className="chat-message-body">
        <div className="chat-message-header">
          <span className="chat-message-role">星构Astra</span>
          <MessageTimestamp ts={message.timestamp} />
          <MemoryCitation isLast={!!isLastMessage} recalledMemories={recalledMemories} />
          {showRewind && (
            <button
              className="chat-rewind-btn"
              onClick={() => useChatStore.getState().rewindToMessage(message.id)}
              title={t.message.rewind}
            >
              <CornerDownLeft size={13} />
            </button>
          )}
        </div>
        <div className="chat-message-content">
          {hasBlocks ? (
            // Render blocks in order; orphan sub-agents (no parentToolId) follow the last tool_use
            // group so they stay near Agent/Skill work instead of above the first text block.
            (() => {
              /** 无 parentToolId 的子代理（如 Skill fork）：插在「最后一个工具块」之后，避免首段是 text 时被插到气泡最顶 */
              let lastToolGroupIdx = -1
              grouped.forEach((item, i) => {
                if (Array.isArray(item)) {
                  if (item.some((b) => b.type === 'tool_use')) lastToolGroupIdx = i
                } else if (item.type === 'tool_use') {
                  lastToolGroupIdx = i
                }
              })
              const orphanSubAgentNodes =
                orphanSubAgents.length > 0 ? (
                  <div className="chat-sub-agents">
                    {/* Sprint 4.2: 多个 sub-agent 时聚合总览 */}
                    <SubAgentsProgressBar
                      subAgents={orphanSubAgents}
                      streaming={message.isStreaming === true}
                    />
                    {orphanSubAgents.map((subAgent) => (
                      <AgentBlock key={subAgent.agentId} agent={subAgent} />
                    ))}
                  </div>
                ) : null

              // P0-1 fix: `mainStreamRouter.appendStreamingProgress` writes
              // tool_progress chunks (upstream alignment stage 2) to
              // `message.toolUses[].streamingProgress`, but the block-based
              // render path here was building `ToolUseCard` props from
              // `message.blocks` only — so the live "实时输出" feed never
              // surfaced for typical assistant messages. Look the field up
              // here so chunks flow into the card regardless of which side
              // (blocks vs legacy toolUses) the upstream writes to.
              const getStreamingProgressForBlock = (
                blockId: string,
              ): ToolUseDisplay['streamingProgress'] | undefined => {
                return message.toolUses?.find((tu) => tu.id === blockId)?.streamingProgress
              }

              // Same lookup pattern for `streamingInput` — model-time
              // tool_use JSON arguments live on `message.toolUses[]`
              // (mainStreamRouter writes them there from
              // `tool_input_delta` events), but block-based rendering
              // here builds `ToolUseCard` props from `message.blocks`,
              // so we have to look it up by id and merge in.
              const getStreamingInputForBlock = (
                blockId: string,
              ): ToolUseDisplay['streamingInput'] | undefined => {
                return message.toolUses?.find((tu) => tu.id === blockId)?.streamingInput
              }

              const renderGroupedItem = (item: ContentBlock | ContentBlock[], idx: number) => {
                if (Array.isArray(item)) {
                  const tools = item.filter((b) => b.type === 'tool_use')
                  if (tools.length === 1) {
                    const block = tools[0]
                    return (
                      <AnimatedBlock key={`tool-${block.id}`} blockKey={`tool-${block.id}`}>
                        <ToolUseCard
                          toolUse={{
                            id: block.id,
                            name: block.name,
                            input: block.input,
                            status: block.status,
                            result: block.result,
                            error: block.error,
                            toolErrorClass: block.toolErrorClass,
                            errorWhat: block.errorWhat,
                            errorTried: block.errorTried,
                            errorContext: block.errorContext,
                            errorNext: block.errorNext,
                            streamingProgress: getStreamingProgressForBlock(block.id),
                            streamingInput: getStreamingInputForBlock(block.id),
                          }}
                          taskId={block.taskId}
                          subAgents={getSubAgentsForTool(block.id)}
                          onStop={stopToolTaskById}
                          onRetry={retryToolTaskById}
                        />
                      </AnimatedBlock>
                    )
                  }
                  // Key the group by its FIRST tool id only — a stable anchor
                  // that survives the batch growing as more tool_use blocks
                  // stream in. Keying by the joined id list (`a,b` -> `a,b,c`)
                  // changed identity on every new tool, remounting the whole
                  // group and resetting each inner card's uncontrolled
                  // expand/collapse state (user-collapsed Write/Edit cards
                  // would re-expand mid-task).
                  return (
                    <AnimatedBlock key={`tool-group-${message.id}-${tools[0].id}`} blockKey={`tool-group-${tools[0].id}`}>
                      <ToolBlockGroup
                        tools={tools.map((b) => ({
                          id: b.id,
                          name: b.name,
                          input: b.input,
                          status: b.status,
                          result: b.result,
                          error: b.error,
                          toolErrorClass: b.toolErrorClass,
                          errorWhat: b.errorWhat,
                          errorTried: b.errorTried,
                          errorContext: b.errorContext,
                          errorNext: b.errorNext,
                          streamingProgress: getStreamingProgressForBlock(b.id),
                          streamingInput: getStreamingInputForBlock(b.id),
                          taskId: b.taskId,
                          subAgents: getSubAgentsForTool(b.id),
                        }))}
                        onStop={stopToolTaskById}
                        onRetry={retryToolTaskById}
                      />
                    </AnimatedBlock>
                  )
                }

                const block = item
                switch (block.type) {
                  case 'text': {
                    const isProactiveText = block.text.includes('[Proactive]')
                    // Use message.id + type + message.isStreaming for stable key — avoids remounting
                    // when idx shifts due to blocks being inserted before this one.
                    return (
                      <AnimatedBlock key={`text-${message.id}-${message.isStreaming ? 's' : 'd'}`} blockKey={`text-${message.id}-${message.isStreaming ? 's' : 'd'}`}>
                        <div className={isProactiveText ? 'chat-proactive-text' : undefined}>
                          <MarkdownContent
                            text={block.text}
                            showCursor={message.isStreaming && idx === grouped.length - 1 && (() => {
                              const last = grouped[grouped.length - 1]
                              return !Array.isArray(last) && last.type === 'text'
                            })()}
                          />
                        </div>
                      </AnimatedBlock>
                    )
                  }
                  case 'reasoning_summary':
                    return (
                      <AnimatedBlock
                        key={`summary-${message.id}-${idx}-${block.isStreaming ? 'streaming' : 'done'}`}
                        blockKey={`summary-${message.id}-${idx}-${block.isStreaming ? 'streaming' : 'done'}`}
                      >
                        <ReasoningSummaryBlock
                          content={block.text}
                          isStreaming={block.isStreaming}
                          thinkingTimeMs={block.thinkingTimeMs}
                          thinkingTokens={block.thinkingTokens}
                        />
                      </AnimatedBlock>
                    )
                  case 'thinking':
                    return (
                      <AnimatedBlock key={`thinking-${message.id}-${block.isStreaming ? 'streaming' : 'done'}`} blockKey={`thinking-${message.id}-${block.isStreaming ? 'streaming' : 'done'}`}>
                        <ThinkingBlock
                          content={block.text}
                          isStreaming={block.isStreaming}
                          showSummaryCard={showThinkingSummaries}
                          thinkingTimeMs={block.thinkingTimeMs}
                          thinkingTokens={block.thinkingTokens}
                          compactedAt={block.compactedAt}
                          // 长会话兜底：阈值开启 + 总块数超阈 + 本块非 streaming 时折叠
                          forceCollapsed={longSessionAutoCollapse && !block.isStreaming}
                          /*
                           * stableKey MUST stay constant across the
                           * streaming → done transition, otherwise the
                           * `durationCache` inside ThinkingBlock can't
                           * carry the tick value through the unmount/
                           * remount that the outer AnimatedBlock key
                           * flip forces. Including `idx` lets multiple
                           * thinking blocks within the same message
                           * (thinking → tool → thinking → tool →
                           * thinking) keep independent cache entries
                           * instead of clobbering each other.
                           */
                          stableKey={`${message.id}:thinking:${idx}`}
                        />
                      </AnimatedBlock>
                    )
                  case 'redacted_thinking':
                    // Plan Phase 4 — Anthropic 加密 chain-of-thought 占位。
                    // 不可展开（无可读内容）；data blob 保存在 block.data
                    // 中由 chatMessageToAgentApiRows 在下一轮回灌给 API。
                    return (
                      <AnimatedBlock
                        key={`redacted-${message.id}-${idx}`}
                        blockKey={`redacted-${message.id}-${idx}`}
                      >
                        <RedactedThinkingBlock />
                      </AnimatedBlock>
                    )
                  case 'image':
                    return (
                      <AnimatedBlock
                        key={`image-${message.id}-${idx}`}
                        blockKey={`image-${message.id}-${idx}`}
                      >
                        <ImagePreview src={`data:${block.mediaType};base64,${block.base64}`} />
                      </AnimatedBlock>
                    )
                  case 'tool_use': {
                    return (
                      <AnimatedBlock key={`tool-${block.id}`} blockKey={`tool-${block.id}`}>
                        <ToolUseCard
                          toolUse={{
                            id: block.id,
                            name: block.name,
                            input: block.input,
                            status: block.status,
                            result: block.result,
                            error: block.error,
                            toolErrorClass: block.toolErrorClass,
                            errorWhat: block.errorWhat,
                            errorTried: block.errorTried,
                            errorContext: block.errorContext,
                            errorNext: block.errorNext,
                            streamingProgress: getStreamingProgressForBlock(block.id),
                            streamingInput: getStreamingInputForBlock(block.id),
                          }}
                          taskId={block.taskId}
                          subAgents={getSubAgentsForTool(block.id)}
                          onStop={stopToolTaskById}
                          onRetry={retryToolTaskById}
                        />
                      </AnimatedBlock>
                    )
                  }
                  case 'ask_user_question':
                    return (
                      <AnimatedBlock key={`ask-${block.requestId}`} blockKey={`ask-${block.requestId}`}>
                        <AskUserQuestionBlock
                          requestId={block.requestId}
                          questions={block.questions}
                          status={block.status}
                          answers={block.answers}
                          previewFormat={block.previewFormat}
                        />
                      </AnimatedBlock>
                    )
                  default:
                    return null
                }
              }

              return (
                <>
                  {grouped.map((item, idx) => (
                    <Fragment key={`blk-wrap-${idx}`}>
                      {renderGroupedItem(item, idx)}
                      {lastToolGroupIdx === idx && orphanSubAgentNodes}
                    </Fragment>
                  ))}
                  {lastToolGroupIdx < 0 && orphanSubAgentNodes}
                </>
              )
            })()
          ) : (
            // Fallback: old rendering for messages without blocks
            <>
              {message.thinking ? (
                <ThinkingBlock
                  content={message.thinking}
                  isStreaming={message.isThinking}
                  showSummaryCard={showThinkingSummaries}
                  stableKey={`${message.id}:thinking:legacy`}
                />
              ) : message.isThinking ? (
                <ThinkingBlock
                  content=""
                  isStreaming={true}
                  showSummaryCard={showThinkingSummaries}
                  stableKey={`${message.id}:thinking:legacy`}
                />
              ) : null}
              {message.content ? (
                <div className={message.content.includes('[Proactive]') ? 'chat-proactive-text' : undefined}>
                  <MarkdownContent text={message.content} showCursor={message.isStreaming} />
                </div>
              ) : message.isStreaming ? (
                <span className="chat-streaming-cursor" />
              ) : null}
              {message.toolUses && message.toolUses.length > 0 && (
                <div className="chat-tool-uses">
                  {message.toolUses.map((toolUse) => (
                    <ToolUseCard
                      key={toolUse.id}
                      toolUse={toolUse}
                      subAgents={getSubAgentsForTool(toolUse.id)}
                      onStop={stopToolTaskById}
                      onRetry={retryToolTaskById}
                    />
                  ))}
                </div>
              )}
            </>
          )}

          {/* Orphan sub-agents: inlined before first text when using blocks; legacy path below */}
          {!hasBlocks && message.subAgents?.some((sa) => !sa.parentToolId) && (
            <div className="chat-sub-agents">
              {/* Sprint 4.2: 多个 sub-agent 时聚合总览 */}
              <SubAgentsProgressBar
                subAgents={message.subAgents.filter((sa) => !sa.parentToolId)}
                streaming={message.isStreaming === true}
              />
              {message.subAgents
                .filter((sa) => !sa.parentToolId)
                .map((subAgent) => (
                  <AgentBlock key={subAgent.agentId} agent={subAgent} />
                ))}
            </div>
          )}

          {/* Loading placeholder — Cherry Studio style three-dots. Only shown
              while streaming AND no visible content has arrived yet, so it
              doesn't duplicate the blinking cursor once text/blocks start
              flowing (the cursor below / inside the text block then takes over). */}
          {message.isStreaming &&
            !hasBlocks &&
            !message.content?.trim() &&
            !(message.toolUses && message.toolUses.length > 0) &&
            !message.thinking?.trim() &&
            !message.isThinking && <PlaceholderBlock />}

          {/* Streaming cursor when blocks exist but last block isn't text */}
          {hasBlocks && message.isStreaming && (() => {
            const last = message.blocks![message.blocks!.length - 1]
            return last?.type !== 'text' ? <span className="chat-streaming-cursor" /> : null
          })()}
        </div>
        {message.codeBlocks?.map((block, idx) => (
          <CodeBlock
            key={idx}
            language={block.language}
            code={block.code}
            fileName={block.fileName}
          />
        ))}
        {/* Footer actions: copy button is hidden while still streaming so the
            user doesn't paste a half-formed reply. CodeBlock children carry
            their own per-block Copy button (rendered above), so this surface
            is for the natural-language portion of the reply only — see
            extractMessageCopyText() for the exact subset captured. */}
        {!message.isStreaming && (
          <div className="chat-message-actions">
            <MessageCopyButton getText={() => extractMessageCopyText(message)} />
            <button
              type="button"
              className="chat-message-copy chat-message-icon-btn"
              onClick={() => void useChatStore.getState().regenerateFromMessage(message.id)}
              title={t.message.regenerate}
              aria-label={t.message.regenerate}
            >
              <RefreshCw size={12} />
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

export const ChatMessage = memo(ChatMessageInner, chatMessagePropsEqual)
ChatMessage.displayName = 'ChatMessage'
