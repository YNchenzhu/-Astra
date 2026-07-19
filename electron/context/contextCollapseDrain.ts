/**
 * upstream §14 — reactive compact may try "collapse drain" before full compaction.
 */

import { consumeContextCollapseSummaries } from './contextCollapseStore'
import { SIDE_CHANNEL_KIND, wrapSideChannelBody } from '../constants/sideChannelKinds'

export type DrainContextCollapseOptions = {
  conversationKey?: string
}

/**
 * Prepends a synthetic user turn with queued collapse summaries when the store has entries
 * for {@link DrainContextCollapseOptions.conversationKey}.
 */
export function drainContextCollapseForReactiveCompact<T extends Record<string, unknown>>(
  messages: T[],
  options?: DrainContextCollapseOptions,
): T[] {
  const key = options?.conversationKey?.trim()
  if (!key) return messages
  const summaries = consumeContextCollapseSummaries(key)
  if (summaries.length === 0) return messages
  const body = summaries.map((s, i) => `### Collapsed segment ${i + 1}\n${s}`).join('\n\n')
  // Wrap in `<system-reminder>` + `_convertedFromSystem: true` so the model
  // reads this as a host-generated transcript recap, not as the user's own
  // narration. Without the envelope a bare "[Context collapse summaries…]"
  // user message can be misread by some providers as the user starting
  // their next turn with that text. Mirrors the autoCompact emission shape
  // in `compact.ts` so all "synthetic transcript" injections look the same.
  const injected = {
    role: 'user' as const,
    content: wrapSideChannelBody(
      SIDE_CHANNEL_KIND.contextCollapseDrain,
      `[Context collapse summaries — prior segments folded offline. Treat as authoritative recap of earlier conversation; do NOT respond as if the user just narrated this.]\n\n${body}`,
    ),
    _convertedFromSystem: true,
    _sideChannelKind: SIDE_CHANNEL_KIND.contextCollapseDrain,
  }
  return [injected as unknown as T, ...messages]
}
