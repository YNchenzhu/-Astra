/**
 * Group transcript messages at **API round** boundaries (upstream
 * `groupMessagesByApiRound` analogue).
 *
 * A new group starts when a new `assistant` message appears whose round key
 * differs from the previous assistant's. Streaming chunks from the same API
 * response should share one key (Anthropic `id` on the message when present);
 * when absent we fall back to the first `tool_use` block id, then a short
 * content hash — good enough for compaction summarization layout.
 */

function djb2Hash(input: string): string {
  let h = 5381
  for (let i = 0; i < input.length; i++) {
    h = (h * 33) ^ input.charCodeAt(i)!
  }
  return (h >>> 0).toString(16)
}

function assistantRoundKey(msg: Record<string, unknown>): string {
  if (typeof msg.id === 'string' && msg.id.trim()) return msg.id.trim()
  const nested = (msg as { message?: { id?: string } }).message?.id
  if (typeof nested === 'string' && nested.trim()) return nested.trim()
  const c = msg.content
  if (Array.isArray(c)) {
    for (const b of c as Record<string, unknown>[]) {
      if (b?.type === 'tool_use') {
        const id = String(b.id ?? '').trim()
        if (id) return `tu:${id}`
      }
    }
  }
  const raw = typeof c === 'string' ? c : JSON.stringify(c ?? '')
  return `h:${djb2Hash(raw.slice(0, 600))}`
}

/**
 * Partition messages into API-round groups for summarization / analysis.
 */
export function groupMessagesByApiRound(
  messages: Array<Record<string, unknown>>,
): Array<Array<Record<string, unknown>>> {
  const groups: Array<Array<Record<string, unknown>>> = []
  let current: Array<Record<string, unknown>> = []
  let lastAssistantKey: string | undefined

  for (const msg of messages) {
    if (
      msg.role === 'assistant' &&
      current.length > 0 &&
      lastAssistantKey !== undefined &&
      assistantRoundKey(msg) !== lastAssistantKey
    ) {
      groups.push(current)
      current = [msg]
    } else {
      current.push(msg)
    }
    if (msg.role === 'assistant') {
      lastAssistantKey = assistantRoundKey(msg)
    }
  }
  if (current.length > 0) groups.push(current)
  return groups
}
