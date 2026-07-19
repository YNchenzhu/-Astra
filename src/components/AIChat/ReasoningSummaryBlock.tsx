/**
 * ReasoningSummaryBlock — provider-emitted safe-to-show TL;DR of the
 * model's chain of thought.
 *
 * Source: OpenAI Responses API's `output[].type === 'reasoning'.summary[]`
 * stream (mapped by `electron/ai/transformer/claudeToOpenAI2.ts` into a
 * pseudo-Claude `reasoning_summary_delta` SSE event). The Anthropic-compat
 * consumer accumulates per-block and forwards on `content_block_stop`.
 *
 * Distinct from {@link ThinkingBlock}:
 *   - Summaries are short by design (a few sentences); no structured-
 *     section parser, no markdown auto-scroll viewport, no auto-collapse.
 *   - No `signature` round-trip: the API contract treats summaries as
 *     output-only.
 *   - Chrome is intentionally more "informational" than "loading": it
 *     reads as a finished artifact, not a live process trace.
 *
 * Kept deliberately minimal — the value proposition is "show the user
 * what reasoning informed this answer without dumping raw o-series
 * chain-of-thought (which violates OpenAI's ToS for that family)".
 */
import React from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ActivityRow } from './activity/ActivityRow'
import './ThinkingBlock.css'

interface ReasoningSummaryBlockProps {
  content?: string
  isStreaming?: boolean
  thinkingTimeMs?: number
  thinkingTokens?: number
}

function formatSeconds(ms: number): string {
  const safe = typeof ms === 'number' && Number.isFinite(ms) ? Math.max(0, ms) : 0
  return `${(safe / 1000).toFixed(1)}s`
}

function formatTokens(n: number | undefined): string {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return ''
  if (n < 1000) return String(n)
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`
  return `${Math.round(n / 1000)}k`
}

export const ReasoningSummaryBlock: React.FC<ReasoningSummaryBlockProps> = ({
  content = '',
  isStreaming,
  thinkingTimeMs,
  thinkingTokens,
}) => {
  // Summaries are short — start expanded by default since collapsing a
  // 2-3 sentence block adds friction without saving real estate.
  const [expanded, setExpanded] = React.useState(true)

  const trimmed = content.trim()
  if (!isStreaming && !trimmed) return null

  const tokensStr = !isStreaming ? formatTokens(thinkingTokens) : ''
  const timeStr =
    typeof thinkingTimeMs === 'number' && thinkingTimeMs > 0
      ? formatSeconds(thinkingTimeMs)
      : ''
  const metaParts: string[] = []
  if (timeStr) metaParts.push(`for ${timeStr}`)
  if (tokensStr) metaParts.push(`· ~${tokensStr} tok`)
  const meta = metaParts.join(' ') || (isStreaming ? '…' : '')

  return (
    <div className="reasoning-summary-block">
      <ActivityRow
        actionWord={isStreaming ? 'Summarising reasoning' : 'Reasoning summary'}
        meta={meta}
        status={isStreaming ? 'running' : 'idle'}
        expanded={expanded}
        onExpandedChange={setExpanded}
      >
        {trimmed ? (
          <div className="thinking-markdown reasoning-summary-markdown">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
          </div>
        ) : null}
      </ActivityRow>
    </div>
  )
}
