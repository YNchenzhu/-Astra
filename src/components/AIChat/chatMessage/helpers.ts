import type { ChatMessage as ChatMessageType } from '../../../types'
import type { ChatMessageProps } from './types'

export const MEMORY_TYPE_LABELS: Record<string, string> = {
  user: '用户',
  feedback: '反馈',
  project: '项目',
  reference: '参考',
}

export function refPathBasename(filePath: string): string {
  const parts = filePath.replace(/\\/g, '/').split('/')
  return parts[parts.length - 1] || filePath
}

export const REF_OPEN_LANG_MAP: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
  py: 'python', rs: 'rust', go: 'go', java: 'java', json: 'json',
  css: 'css', html: 'html', md: 'markdown', yaml: 'yaml', yml: 'yaml',
  sh: 'shell', sql: 'sql', xml: 'xml',
}

/**
 * Reference-only equality. Relies on `patchConversationSlice` producing a
 * fresh `message` object on every store mutation — which it does — so any
 * change that needs to reach the UI is signalled by `prev.message !== next.message`.
 *
 * Earlier this function tried to "deep compare" by checking `blocks.length`
 * and `subAgents.length`. That was incorrect: streaming deltas mutate fields
 * INSIDE the existing trailing block / sub-agent (text growing,
 * status: running → completed, toolUses appended, output appended) without
 * changing array length, so the memo would silently swallow every update
 * after the first one. Symptoms were:
 *   - Thinking block stuck on the first delta (e.g. "Good" forever)
 *   - Sub-agent stuck on "starting…" with no tool / output / status updates
 * The reference compare is both correct and the cheapest possible check.
 */
export function chatMessagePropsEqual(prev: ChatMessageProps, next: ChatMessageProps): boolean {
  return (
    prev.message === next.message &&
    prev.isLastMessage === next.isLastMessage &&
    prev.showThinkingSummaries === next.showThinkingSummaries &&
    prev.recalledMemories === next.recalledMemories &&
    // 长会话兜底：当 totalThinkingBlocks / 阈值变化时，需要重渲染让
    // ThinkingBlock 的 forceCollapsed prop 重新计算
    prev.totalThinkingBlocks === next.totalThinkingBlocks &&
    prev.thinkingAutoCollapseThreshold === next.thinkingAutoCollapseThreshold
  )
}

/**
 * Compact, locale-aware timestamp chip rendered next to the role name.
 *
 * - Today          → `HH:MM`
 * - Yesterday      → `昨天 HH:MM`
 * - Earlier this year → `MM/DD HH:MM`
 * - Different year   → `YYYY/MM/DD HH:MM`
 *
 * Hover reveals a full ISO string via `title`, useful when the user needs to
 * cite an exact moment (bug reports, support tickets, …).
 *
 * Pure function output → no internal state → no re-render churn beyond
 * whatever drove the parent to re-render.
 */
export function formatMessageTimestamp(ts: number, now: Date = new Date()): string {
  const d = new Date(ts)
  if (!Number.isFinite(d.getTime())) return ''
  const pad = (n: number) => n.toString().padStart(2, '0')
  const hhmm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  if (sameDay) return hhmm
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  const isYesterday =
    d.getFullYear() === yesterday.getFullYear() &&
    d.getMonth() === yesterday.getMonth() &&
    d.getDate() === yesterday.getDate()
  if (isYesterday) return `昨天 ${hhmm}`
  if (d.getFullYear() === now.getFullYear()) {
    return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${hhmm}`
  }
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${hhmm}`
}

/**
 * Extract user-copyable plain text from a message.
 *
 * - User messages: `content` is already a plain string the user typed.
 * - Assistant messages with structured `blocks`: concat every `text` block
 *   in order. Skips `thinking` (sidecar reasoning) and `tool_use` (machine
 *   noise the user almost never wants to paste). Falls back to `content`
 *   when blocks are absent (legacy / streaming-fallback path).
 *
 * Code blocks (`message.codeBlocks`) are deliberately not appended — they
 * already render their own per-block Copy button (CodeBlock.tsx). Including
 * them here would duplicate text and bloat the clipboard for users who
 * want to quote a paragraph.
 */
export function extractMessageCopyText(message: ChatMessageType): string {
  if (message.role === 'user') return message.content ?? ''
  const blocks = message.blocks
  if (blocks && blocks.length > 0) {
    const parts: string[] = []
    for (const b of blocks) {
      if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
        parts.push(b.text)
      }
    }
    if (parts.length > 0) return parts.join('\n\n')
  }
  return message.content ?? ''
}

/**
 * Map host-side compaction action labels to a short, user-readable
 * Chinese descriptor for the boundary divider. Falls back to the raw
 * level token when an unknown label arrives (defensive — keeps
 * forward compat with future levels the renderer hasn't learnt yet).
 */
export function describeCompactLevel(level: string): string {
  switch (level) {
    case 'micro_compact':
      return '微压缩'
    case 'auto_compact':
      return '自动压缩'
    case 'history_snip':
      return '历史裁剪'
    case 'soft_clear':
      return '清理工具结果'
    case 'reactive_compact':
      return '反应式压缩'
    case 'stripped_image':
      return '剥离图片'
    case 'blocking':
    case 'block_micro':
      return '阻塞压缩'
    case 'warning':
      return '预警压缩'
    case 'error':
      return '紧急压缩'
    case 'collapse_drain':
      return '折叠归并'
    default:
      return level
  }
}

export const COMPACT_TOKEN_DIGITS = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })
