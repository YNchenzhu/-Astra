/**
 * Reasoning timeline — a conversation-level overview of every `thinking`
 * / `reasoning_summary` block the model has emitted, in turn order, so
 * users can jump to "the moment the model decided X" in a long agentic
 * session without scrolling through thousands of lines.
 *
 * Mounted as a popover toggled from the chat header (sibling pattern to
 * `ConversationList`). Click an entry → caller's `onJumpToMessage` runs
 * — wired in `ChatPanel` to the existing `jumpToMessage` callback that
 * already handles virtualized + non-virtualized scroll alike.
 *
 * Deliberately read-only and stateless: the parent owns visibility +
 * close logic. The timeline itself recomputes entries from the current
 * `messages` array via a single `useMemo` selector — cheap because we
 * walk blocks once and emit one entry per thinking-shaped block.
 */
import React, { useEffect, useMemo, useRef } from 'react'
import { Brain, X } from 'lucide-react'
import type { ChatMessage, ContentBlock } from '../../types'
import { useChatStore } from '../../stores/useChatStore'
import './ReasoningTimeline.css'

/** One row of the timeline — derived from a single thinking-shaped block. */
export interface ReasoningTimelineEntry {
  /** Message id of the parent assistant message; powers `onJumpToMessage`. */
  messageId: string
  /** 1-based assistant-turn index across the conversation. */
  turnIndex: number
  /** Index of this entry among other reasoning entries within the same turn (0-based). */
  intraTurnIndex: number
  /** Block kind — drives chrome (`Brain` icon vs `BookText`-style for summary). */
  kind: 'thinking' | 'reasoning_summary' | 'redacted_thinking'
  /** First non-empty line of the block text, trimmed for inline display. */
  preview: string
  /** Wall-clock duration the block was open on the wire, when known. */
  durationMs?: number
  /** Approximate output-token cost, when known. */
  tokens?: number
  /** True when the block was truncated by the persistence-layer compaction pass (C). */
  compacted: boolean
}

/** Aggregate metadata surfaced as a sticky strip atop the list. */
export interface ReasoningTimelineSummary {
  entryCount: number
  totalDurationMs: number
  totalTokens: number
}

const PREVIEW_MAX = 80

function buildPreview(text: string): string {
  // First non-empty line is almost always the most informative; falling
  // back to a whitespace-collapsed prefix when the block opens with
  // multiple blanks (rare but happens with code-fenced reasoning).
  const firstLine = text.split('\n').find((l) => l.trim()) ?? text.trim()
  const collapsed = firstLine.replace(/\s+/g, ' ').trim()
  return collapsed.length > PREVIEW_MAX ? collapsed.slice(0, PREVIEW_MAX) + '…' : collapsed
}

/**
 * Walk the messages array once and emit one entry per `thinking` /
 * `reasoning_summary` block found inside an assistant message's
 * `blocks[]`. Streaming blocks ARE included so the timeline keeps up
 * with a live agent — they're just rendered with a small "(streaming)"
 * pill in the row.
 *
 * Exported for unit-test isolation; the component memoises over
 * messages so call sites don't have to.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function buildReasoningTimeline(
  messages: ChatMessage[],
): { entries: ReasoningTimelineEntry[]; summary: ReasoningTimelineSummary } {
  const entries: ReasoningTimelineEntry[] = []
  let turnIndex = 0
  let totalDurationMs = 0
  let totalTokens = 0
  for (const m of messages) {
    if (m.role !== 'assistant') continue
    turnIndex++
    const blocks = m.blocks
    if (!blocks || blocks.length === 0) continue
    let intra = 0
    for (const b of blocks) {
      // Plan Phase 4 — redacted_thinking 也是"模型在思考"的证据，应该在
      // timeline 里占一行（让用户能跳到那一刻），尽管没有文本可预览。
      if (b.type === 'redacted_thinking') {
        entries.push({
          messageId: m.id,
          turnIndex,
          intraTurnIndex: intra++,
          kind: 'redacted_thinking',
          preview: '(私密推理已加密)',
          compacted: false,
        })
        continue
      }
      if (b.type !== 'thinking' && b.type !== 'reasoning_summary') continue
      // Skip blocks with no usable text — happens transiently at the
      // moment a streaming block opens before its first delta lands.
      // The next render with text in place will surface it.
      const text = (b as Extract<ContentBlock, { type: 'thinking' | 'reasoning_summary' }>).text
      if (!text || !text.trim()) continue
      const duration =
        typeof (b as { thinkingTimeMs?: number }).thinkingTimeMs === 'number' &&
        (b as { thinkingTimeMs: number }).thinkingTimeMs > 0
          ? (b as { thinkingTimeMs: number }).thinkingTimeMs
          : undefined
      const tokens =
        typeof (b as { thinkingTokens?: number }).thinkingTokens === 'number' &&
        (b as { thinkingTokens: number }).thinkingTokens > 0
          ? (b as { thinkingTokens: number }).thinkingTokens
          : undefined
      entries.push({
        messageId: m.id,
        turnIndex,
        intraTurnIndex: intra++,
        kind: b.type,
        preview: buildPreview(text),
        ...(duration !== undefined ? { durationMs: duration } : {}),
        ...(tokens !== undefined ? { tokens } : {}),
        // `compactedAt` only exists on `thinking` blocks (see C); summary
        // blocks aren't compacted by design. Conditional read keeps TS
        // narrowing happy.
        compacted:
          b.type === 'thinking' &&
          typeof (b as { compactedAt?: number }).compactedAt === 'number' &&
          (b as { compactedAt: number }).compactedAt > 0,
      })
      if (duration !== undefined) totalDurationMs += duration
      if (tokens !== undefined) totalTokens += tokens
    }
  }
  return {
    entries,
    summary: {
      entryCount: entries.length,
      totalDurationMs,
      totalTokens,
    },
  }
}

function formatSeconds(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s'
  if (ms < 1000) return `${ms}ms`
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  const mins = Math.floor(ms / 60_000)
  const secs = Math.round((ms % 60_000) / 1000)
  return secs === 0 ? `${mins}m` : `${mins}m${secs}s`
}

function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return ''
  if (n < 1000) return String(n)
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`
  return `${Math.round(n / 1000)}k`
}

export interface ReasoningTimelineProps {
  onJumpToMessage: (messageId: string) => void
  onClose: () => void
}

export const ReasoningTimeline: React.FC<ReasoningTimelineProps> = ({
  onJumpToMessage,
  onClose,
}) => {
  // Subscribe to `messages` directly (rather than receiving a parent snapshot)
  // so the timeline keeps updating with live `thinking` / `reasoning_summary`
  // blocks while the agent is streaming. The parent (ChatPanel) intentionally
  // no longer subscribes to `messages`, so a passed prop would be frozen.
  const messages = useChatStore((s) => s.messages)
  const { entries, summary } = useMemo(() => buildReasoningTimeline(messages), [messages])

  const rootRef = useRef<HTMLDivElement | null>(null)

  // Click-outside + ESC to close. Mirrors the small-popup pattern other
  // header actions (history search, etc.) use elsewhere in this folder.
  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      const root = rootRef.current
      if (!root) return
      const target = e.target as Node
      if (root.contains(target)) return
      // Ignore clicks on the header button itself — the button's
      // onClick handles its own toggle; without this, the same click
      // would close → reopen the panel.
      if ((target as HTMLElement | null)?.closest?.('[data-reasoning-timeline-toggle]')) return
      onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  return (
    <div ref={rootRef} className="reasoning-timeline" role="dialog" aria-label="Reasoning timeline">
      <div className="reasoning-timeline-header">
        <div className="reasoning-timeline-title">
          <Brain size={14} />
          <span>Reasoning timeline</span>
        </div>
        <button
          type="button"
          className="reasoning-timeline-close"
          onClick={onClose}
          aria-label="Close reasoning timeline"
        >
          <X size={14} />
        </button>
      </div>
      <div className="reasoning-timeline-summary">
        {summary.entryCount === 0 ? (
          <span className="reasoning-timeline-summary-empty">No reasoning emitted yet.</span>
        ) : (
          <>
            <span className="reasoning-timeline-summary-count">
              {summary.entryCount} entr{summary.entryCount === 1 ? 'y' : 'ies'}
            </span>
            {summary.totalDurationMs > 0 ? (
              <span className="reasoning-timeline-summary-meta">
                · {formatSeconds(summary.totalDurationMs)}
              </span>
            ) : null}
            {summary.totalTokens > 0 ? (
              <span className="reasoning-timeline-summary-meta">
                · ~{formatTokens(summary.totalTokens)} tok
              </span>
            ) : null}
          </>
        )}
      </div>
      <div className="reasoning-timeline-list">
        {entries.length === 0 ? (
          <div className="reasoning-timeline-empty-hint">
            Send a message that triggers reasoning (extended thinking, o-series, DeepSeek R1, …)
            and entries will appear here in turn order.
          </div>
        ) : (
          entries.map((entry) => (
            <button
              key={`${entry.messageId}:${entry.kind}:${entry.intraTurnIndex}`}
              type="button"
              className={`reasoning-timeline-entry reasoning-timeline-entry-${entry.kind}`}
              onClick={() => {
                onJumpToMessage(entry.messageId)
                onClose()
              }}
            >
              <span className="reasoning-timeline-entry-turn">Turn {entry.turnIndex}</span>
              <span className="reasoning-timeline-entry-preview">{entry.preview}</span>
              <span className="reasoning-timeline-entry-meta">
                {entry.kind === 'reasoning_summary' ? (
                  <span className="reasoning-timeline-entry-kind">summary</span>
                ) : null}
                {entry.compacted ? (
                  <span
                    className="reasoning-timeline-entry-compacted"
                    title="Block was truncated by save-time compaction (see Settings → 保存时压缩思考内容)"
                  >
                    truncated
                  </span>
                ) : null}
                {entry.durationMs !== undefined ? (
                  <span className="reasoning-timeline-entry-time">
                    {formatSeconds(entry.durationMs)}
                  </span>
                ) : null}
                {entry.tokens !== undefined ? (
                  <span className="reasoning-timeline-entry-tokens">
                    ~{formatTokens(entry.tokens)} tok
                  </span>
                ) : null}
              </span>
            </button>
          ))
        )}
      </div>
    </div>
  )
}
