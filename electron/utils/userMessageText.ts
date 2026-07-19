/**
 * Normalize chat `content` to plain text for memory recall, skill discovery, etc.
 * Matches Anthropic-style messages where `content` may be a string or block array.
 */

export function userMessageContentToPlainText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const b = block as Record<string, unknown>
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
    if (b.type === 'tool_result' && typeof b.content === 'string') parts.push(b.content)
  }
  return parts.join('\n')
}
