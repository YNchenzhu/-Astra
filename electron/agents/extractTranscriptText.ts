/**
 * Transcript-level fallback for sub-agent reported output.
 *
 * upstream parity: `finalizeAgentTool` in `upstream-main` walks the
 * agent's message history backward to pull the most recent assistant
 * `text` block whenever the final assistant message ended on a
 * `tool_use` (loop exited mid-turn at maxTurns or abort). Our
 * resolver previously only had three string-shaped sources
 * (`lastFinalText`, `outputText`, `latestTextOutput`) and would
 * surface the "Agent completed without output." placeholder when a
 * tool-heavy run produced no tool-free final turn — even though
 * earlier assistant turns contained perfectly usable text.
 *
 * This helper is the missing fourth source. Pure / sync / no I/O.
 */

/**
 * Walk `messages` from end to start, return the joined `text` content
 * of the most recent message with `role === 'assistant'` that has at
 * least one non-empty text block (or a non-empty string body).
 *
 * Returns `undefined` when no such message exists.
 *
 * Accepts a loose shape on purpose: callers across this codebase
 * already use `Array<Record<string, unknown>>` (see
 * `AgentContext.messages`, `AgenticLoopParams.messages`,
 * `LoopState.apiMessages`) and we want to keep this helper usable
 * without forcing a type assertion at every call site.
 */
export function extractLastAssistantText(
  messages: ReadonlyArray<{ role?: unknown; content?: unknown }> | undefined,
): string | undefined {
  if (!messages || messages.length === 0) return undefined

  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (!m || m.role !== 'assistant') continue

    const c = m.content
    if (typeof c === 'string') {
      const t = c.trim()
      if (t) return t
      continue
    }
    if (!Array.isArray(c)) continue

    const parts: string[] = []
    for (const block of c) {
      if (
        block &&
        typeof block === 'object' &&
        (block as { type?: unknown }).type === 'text'
      ) {
        const text = (block as { text?: unknown }).text
        if (typeof text === 'string' && text.length > 0) {
          parts.push(text)
        }
      }
    }
    const joined = parts.join('\n').trim()
    if (joined) return joined
  }

  return undefined
}
