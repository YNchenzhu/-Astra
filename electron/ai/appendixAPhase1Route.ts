/**
 * Appendix A phase-one style routing hint for telemetry (Ink `processUserInput` analogue).
 * Desktop payloads are already structured; we infer slash-like prompts from the last user turn.
 */

function lastUserPlainText(messages: Array<{ role: string; content: unknown }>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'user') continue
    const c = m.content
    if (typeof c === 'string') return c.trim()
    if (Array.isArray(c)) {
      const parts = c
        .map((b) => {
          if (!b || typeof b !== 'object') return ''
          const t = (b as { type?: unknown }).type
          if (t === 'text' && typeof (b as { text?: unknown }).text === 'string') {
            return String((b as { text: string }).text)
          }
          return ''
        })
        .join('')
      return parts.trim()
    }
  }
  return ''
}

/** `slash_like`: last user text starts with `/` (skills / commands style). */
export function classifyAppendixAPhase1Route(
  messages: Array<{ role: string; content: unknown }>,
): 'slash_like' | 'text_prompt' {
  const t = lastUserPlainText(messages)
  if (t.startsWith('/')) return 'slash_like'
  return 'text_prompt'
}
