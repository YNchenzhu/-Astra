/**
 * upstream §4.2 — Session Memory Compact (zero API cost).
 *
 * Uses existing session-memory markdown notes as a compaction substitute instead
 * of calling an LLM to generate a summary.  Falls back to traditional compact when
 * the resulting token estimate still exceeds the auto-compact threshold.
 *
 * Enabled when `POLE_SM_COMPACT=1` or both feature flags are true.
 */

import { estimateConversationTokens, estimateTextTokens } from './tokenCounter'
import { readSessionMemoryMarkdown } from '../session/sessionMemoryPaths'
import { getWorkspacePath } from '../tools/workspaceState'
import { getMemoryFeatureFlags } from '../memory/memoryFeatureFlags'
import { createCompactBoundaryMarker } from './compactBoundary'
import { getLastSummarizedMessageId } from '../session/sessionMemoryTrigger'
import type { ContextThresholds } from './manager'

export const SM_COMPACT_MIN_TOKENS = 10_000
export const SM_COMPACT_MIN_TEXT_BLOCK_MESSAGES = 5
export const SM_COMPACT_MAX_TOKENS = 40_000
const SM_COMPACT_MAX_SECTION_TOKENS = 2_000

export function isSessionMemoryCompactEnabled(): boolean {
  return getMemoryFeatureFlags().sessionMemoryCompactEnabled
}

function truncateSection(section: string, maxTokens: number): string {
  const est = estimateTextTokens(section)
  if (est <= maxTokens) return section
  const ratio = maxTokens / est
  const target = Math.floor(section.length * ratio * 0.95)
  return section.slice(0, target) + '\n[section truncated]'
}

/**
 * Truncate oversized sections in session-memory markdown so the total stays under
 * {@link SM_COMPACT_MAX_SECTION_TOKENS} per section and a global token ceiling.
 */
export function truncateSessionMemorySections(
  markdown: string,
  maxTotalTokens: number = SM_COMPACT_MAX_TOKENS,
): string {
  const sectionRe = /^(#{1,3}\s+.*)$/gm
  const headers: { idx: number; header: string }[] = []
  let m: RegExpExecArray | null
  while ((m = sectionRe.exec(markdown)) !== null) {
    headers.push({ idx: m.index, header: m[0] })
  }

  if (headers.length === 0) {
    return truncateSection(markdown, maxTotalTokens)
  }

  const sections: string[] = []
  for (let i = 0; i < headers.length; i++) {
    const start = headers[i].idx
    const end = i + 1 < headers.length ? headers[i + 1].idx : markdown.length
    sections.push(markdown.slice(start, end).trimEnd())
  }

  const preamble = headers[0].idx > 0 ? markdown.slice(0, headers[0].idx).trimEnd() : ''

  const truncated = sections.map((s) => truncateSection(s, SM_COMPACT_MAX_SECTION_TOKENS))
  let result = preamble ? `${preamble}\n\n${truncated.join('\n\n')}` : truncated.join('\n\n')

  const totalEst = estimateTextTokens(result)
  if (totalEst > maxTotalTokens) {
    result = truncateSection(result, maxTotalTokens)
  }

  return result
}

function adjustStartIndexForToolPairing(
  messages: Array<Record<string, unknown>>,
  startIndex: number,
): number {
  let idx = startIndex
  while (idx > 0) {
    const msg = messages[idx]
    if (!Array.isArray(msg.content)) break

    const blocks = msg.content as Array<Record<string, unknown>>
    const toolResultIds = new Set<string>()
    for (const b of blocks) {
      if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
        toolResultIds.add(b.tool_use_id)
      }
    }
    if (toolResultIds.size === 0) break

    let needsPrev = false
    for (let k = idx - 1; k >= 0; k--) {
      const prev = messages[k]
      if (!Array.isArray(prev.content)) continue
      const prevBlocks = prev.content as Array<Record<string, unknown>>
      for (const b of prevBlocks) {
        if (b.type === 'tool_use' && typeof b.id === 'string' && toolResultIds.has(b.id)) {
          if (k < idx) {
            idx = k
            needsPrev = true
          }
        }
      }
    }
    if (!needsPrev) break
  }
  return idx
}

function adjustStartIndexForThinking(
  messages: Array<Record<string, unknown>>,
  startIndex: number,
): number {
  let idx = startIndex
  if (idx <= 0) return idx

  const msg = messages[idx]
  if (msg.role !== 'assistant') return idx

  const mid = msg.id
  if (typeof mid !== 'string') return idx

  for (let k = idx - 1; k >= 0; k--) {
    const prev = messages[k]
    if (prev.role === 'assistant' && prev.id === mid) {
      idx = k
    } else {
      break
    }
  }
  return idx
}

export interface SessionMemoryCompactResult {
  messages: Array<Record<string, unknown>>
  wasCompacted: boolean
  sessionMemoryContent?: string
}

/**
 * Try session-memory compact: replace old history with existing session memory notes.
 * Returns `null` when SM compact is not possible or not effective enough.
 */
export async function trySessionMemoryCompact(options: {
  conversationId: string | undefined
  messages: Array<Record<string, unknown>>
  systemPrompt: string
  thresholds: ContextThresholds
  toolDefsTokens: number
  /**
   * Forwarded to the boundary marker so the model can `Read` the full
   * pre-compact transcript when the SM summary alone is too lossy.
   * Threaded from the same caller that builds `transcriptPath` for
   * `autoCompact` (manager → CompactOptions).
   */
  transcriptPath?: string
}): Promise<SessionMemoryCompactResult | null> {
  if (!isSessionMemoryCompactEnabled()) return null

  const { conversationId, messages, systemPrompt, thresholds, toolDefsTokens, transcriptPath } = options
  const cid = conversationId?.trim()
  if (!cid) return null

  if (messages.length < SM_COMPACT_MIN_TEXT_BLOCK_MESSAGES) return null

  const memContentRaw = await readSessionMemoryMarkdown(cid, getWorkspacePath())
  if (memContentRaw === null) return null
  let memContent = memContentRaw

  memContent = memContent.trim()
  if (!memContent || estimateTextTokens(memContent) < 200) return null

  const truncatedMem = truncateSessionMemorySections(memContent)

  const est = estimateConversationTokens(messages, systemPrompt) + toolDefsTokens
  if (est < SM_COMPACT_MIN_TOKENS) return null

  // upstream §4.2 — use lastSummarizedMessageId for precise boundary when available,
  // falling back to the sliding-window heuristic for legacy / recovery sessions.
  const lastSummarizedId = getLastSummarizedMessageId(cid)
  let startIndex: number
  if (lastSummarizedId) {
    let lastSummarizedIdx = -1
    for (let i = messages.length - 1; i >= 0; i--) {
      if (typeof (messages[i] as Record<string, unknown>).id === 'string' &&
          (messages[i] as Record<string, unknown>).id === lastSummarizedId) {
        lastSummarizedIdx = i
        break
      }
    }
    startIndex = lastSummarizedIdx >= 0
      ? lastSummarizedIdx + 1
      : Math.max(0, messages.length - SM_COMPACT_MIN_TEXT_BLOCK_MESSAGES)
  } else {
    startIndex = Math.max(0, messages.length - SM_COMPACT_MIN_TEXT_BLOCK_MESSAGES)
  }
  const minKeepEst = () =>
    estimateConversationTokens(messages.slice(startIndex), systemPrompt) + toolDefsTokens

  while (startIndex > 0 && minKeepEst() < SM_COMPACT_MAX_TOKENS) {
    startIndex--
  }

  startIndex = adjustStartIndexForToolPairing(messages, startIndex)
  startIndex = adjustStartIndexForThinking(messages, startIndex)

  const keptMessages = messages.slice(startIndex)
  const boundary = createCompactBoundaryMarker(
    `[Session memory compact — notes used in place of LLM summary]\n\n${truncatedMem}`,
    transcriptPath,
  )

  const compactedMessages: Array<Record<string, unknown>> = [boundary, ...keptMessages]

  const postCompactEst =
    estimateConversationTokens(compactedMessages, systemPrompt) + toolDefsTokens
  if (postCompactEst >= thresholds.autoCompactTokens) {
    return null
  }

  return {
    messages: compactedMessages,
    wasCompacted: true,
    sessionMemoryContent: truncatedMem,
  }
}
