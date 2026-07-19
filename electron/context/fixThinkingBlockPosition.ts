/**
 * upstream §17.2 / §10.2(2) — thinking blocks must not be the last block in an assistant message.
 * §10.2(1)(3) 与 §10.3 见 {@link normalizeAnthropicThinkingTranscript}。
 */

function cloneContent(content: unknown): unknown {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return content
  return (content as Record<string, unknown>[]).map((b) => ({ ...b }))
}

/**
 * Appends a minimal trailing text block when an assistant message would end on `thinking` or
 * `redacted_thinking` (some providers reject that shape).
 *
 * When `strictThinkingEcho` is true, the function is a no-op — required for
 * DeepSeek's Anthropic-compat endpoint which mandates thinking blocks be echoed
 * back exactly as-is (including when they are the last block).
 */
export function fixThinkingBlockPosition(
  messages: Array<Record<string, unknown>>,
  strictThinkingEcho?: boolean,
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = messages.map((m) => ({
    ...m,
    content: cloneContent(m.content),
  }))

  if (strictThinkingEcho) return out

  for (const msg of out) {
    if (msg.role !== 'assistant') continue
    const content = msg.content
    if (!Array.isArray(content) || content.length === 0) continue
    const blocks = content as Record<string, unknown>[]
    const last = blocks[blocks.length - 1]
    const t = last?.type
    if (t === 'thinking' || t === 'redacted_thinking') {
      msg.content = [...blocks, { type: 'text', text: ' ' }]
    }
  }

  return out
}
