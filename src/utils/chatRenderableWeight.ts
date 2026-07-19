import type { ChatMessage } from '../types'

/**
 * Rough size of user-visible payload (chars). Tool results / streamed text dominate token count;
 * avoids JSON.stringify on every tool input for speed — inputs are usually smaller than Read/Grep output.
 */
export function estimateMessageRenderableChars(message: ChatMessage): number {
  let n = message.content?.length ?? 0
  if (message.thinking) n += message.thinking.length

  const blocks = message.blocks
  if (blocks) {
    for (const b of blocks) {
      if (b.type === 'text') n += b.text.length
      if (b.type === 'thinking') n += b.text.length
      // Reasoning-summary blocks (B): rendered as their own ChatMessage
      // row so they consume DOM + markdown-parse work just like text /
      // thinking. Missing them under-counted the renderable size of any
      // turn that emitted a summary, occasionally letting a chat slip
      // past the virtualization threshold when it shouldn't have.
      if (b.type === 'reasoning_summary') n += b.text.length
      if (b.type === 'redacted_thinking') {
        // Plan Phase 4 — 占位单行的视觉成本，独立于 data blob 大小
        // (data 是不可读的加密串)。粗略估 32 字符等效（≈ 一行 hint）。
        n += 32
      }
      if (b.type === 'tool_use') {
        n += (b.result?.length ?? 0) + (b.error?.length ?? 0)
      }
    }
  }

  const toolUses = message.toolUses
  if (toolUses) {
    for (const t of toolUses) {
      n += (t.result?.length ?? 0) + (t.error?.length ?? 0)
    }
  }

  const subAgents = message.subAgents
  if (subAgents) {
    for (const s of subAgents) {
      n += (s.output?.length ?? 0)
      // Sub-agent thinking + reasoning summary are flat strings (the
      // sub-agent UI uses a flat-field model rather than a blocks array,
      // see `AgentBlock.tsx`). Both render as their own collapsible rows
      // inside `<AgentBlock>`, so they belong in the size estimate.
      n += (s.thinking?.length ?? 0)
      n += (s.reasoningSummary?.length ?? 0)
      for (const t of s.toolUses) {
        n += (t.result?.length ?? 0) + (t.error?.length ?? 0)
      }
    }
  }

  return n
}

/** Sum of estimateMessageRenderableChars for all messages. */
export function estimateConversationRenderableChars(messages: ChatMessage[]): number {
  let t = 0
  for (const m of messages) {
    t += estimateMessageRenderableChars(m)
  }
  return t
}

/** Turn on virtual list when message count reaches this (fewer DOM nodes + markdown parses). */
export const CHAT_VIRTUALIZE_MESSAGE_COUNT_THRESHOLD = 40

/**
 * Heuristic: ~12.5k tokens at chars/4 ≈ 50k chars. Medium chats virtualize earlier so layout/markdown
 * work stays bounded without waiting for very long threads.
 */
export const CHAT_VIRTUALIZE_CHAR_THRESHOLD = 50_000
