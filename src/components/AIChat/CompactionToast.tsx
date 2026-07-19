/**
 * Transient context-compaction toast.
 *
 * Driven by {@link useCompactionToastStore}, which the main-stream router
 * updates on `context_compact_start` (status 'compacting') and
 * `context_compact` (status 'done', then auto-dismiss). Replaces the old
 * permanent `compact_boundary` transcript dividers that stacked at the bottom
 * and never disappeared.
 *
 * Mount once inside the chat panel (it's absolutely positioned relative to the
 * panel). Renders nothing when no notice is active.
 */
import React from 'react'
import { Check } from 'lucide-react'
import { useCompactionToastStore } from '../../stores/useCompactionToastStore'
import { useChatStore } from '../../stores/useChatStore'
import { describeCompactLevel, COMPACT_TOKEN_DIGITS } from './chatMessage/helpers'

export const CompactionToast: React.FC = () => {
  const notice = useCompactionToastStore((s) => s.notice)
  const activeConversationId = useChatStore((s) => s.currentConversationId)
  // Only surface the notice for the conversation it belongs to — switching
  // tabs mid-compaction must not flash a stale spinner on another conversation.
  if (!notice || notice.conversationId !== activeConversationId) return null

  const levelLabel = describeCompactLevel(notice.level)

  let text: string
  if (notice.status === 'compacting') {
    text = `正在压缩上下文 · ${levelLabel}…`
  } else {
    const reclaimed =
      typeof notice.reclaimedTokens === 'number' && notice.reclaimedTokens > 0
        ? ` · 释放 ${COMPACT_TOKEN_DIGITS.format(notice.reclaimedTokens)} tokens`
        : ''
    text = `上下文已压缩 · ${levelLabel}${reclaimed}`
  }

  return (
    <div
      className={`compaction-toast${notice.status === 'done' ? ' is-done' : ''}`}
      role="status"
      aria-live="polite"
    >
      {notice.status === 'compacting' ? (
        <span className="compaction-toast-spinner" aria-hidden />
      ) : (
        <Check size={13} className="compaction-toast-check" aria-hidden />
      )}
      <span className="compaction-toast-text">{text}</span>
    </div>
  )
}
