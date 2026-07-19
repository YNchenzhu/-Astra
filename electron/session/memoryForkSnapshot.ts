/**
 * Snapshot ALS {@link AgentContext} for a background fork — avoids racing the live main transcript.
 */

import type { AgentContext } from '../agents/agentContext'

function cloneMessagesDeep(msgs: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  try {
    if (typeof structuredClone === 'function') {
      return structuredClone(msgs)
    }
  } catch {
    /* ignore */
  }
  return JSON.parse(JSON.stringify(msgs)) as Array<Record<string, unknown>>
}

/** Read the plain-text body of a message for tail-dedup comparison. */
function messageText(msg: Record<string, unknown> | undefined): string {
  if (!msg) return ''
  const c = msg.content
  if (typeof c === 'string') return c.trim()
  if (!Array.isArray(c)) return ''
  return (c as Array<Record<string, unknown>>)
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => String(b.text))
    .join('\n')
    .trim()
}

export function snapshotAgentContextForSessionMemoryFork(
  ctx: AgentContext,
  options?: {
    /**
     * 2026-07 one-turn-lag fix — the CURRENT turn's final assistant text.
     *
     * The session-memory extract fires at the turn's natural breakpoint
     * (the stream just ended with zero tool_use blocks) — but at that
     * point the final reply (`state.accumulatedText`) has NOT yet been
     * pushed into `state.apiMessages` (that happens later in
     * `handleNoToolsBranch` Stage 3) and therefore is absent from
     * `ctx.messages`. Without it the scribe's material always ends at
     * the PREVIOUS turn's conclusion plus this turn's question — notes
     * perpetually one round behind. Passing the already-final text here
     * appends it as a synthetic assistant message so the scribe sees the
     * round it is supposedly summarizing.
     *
     * Deduped against the snapshot tail so a future trigger-point move
     * (after the push) cannot double-append.
     */
    pendingAssistantText?: string
  },
): AgentContext {
  const messages = cloneMessagesDeep(ctx.messages)
  const pending = options?.pendingAssistantText?.trim()
  if (pending && messageText(messages[messages.length - 1]) !== pending) {
    messages.push({ role: 'assistant', content: pending })
  }
  return {
    ...ctx,
    messages,
  }
}
