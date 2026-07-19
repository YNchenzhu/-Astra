/**
 * upstream §13 — optional auto-fold of oldest messages into collapse store + inline summary user turn.
 * Enable with `POLE_CONTEXT_COLLAPSE_AUTO=1` (uses one extra LLM call when over auto-compact threshold).
 */

import type { ProviderConfig } from '../ai/client'
import { streamText } from '../ai/client'
import { SIDE_QUERY_ALWAYS_THINKING } from '../ai/sideQueryThinkingPolicy'
import { appendContextCollapseSummary } from './contextCollapseStore'
import { estimateConversationTokens } from './tokenCounter'
import type { ContextThresholds } from './manager'
import { SIDE_CHANNEL_KIND, makeSideChannelUserMessage } from '../constants/sideChannelKinds'

const SEGMENT_MESSAGE_COUNT = 4

function transcriptForMessages(messages: Array<Record<string, unknown>>): string {
  return messages
    .map((msg) => {
      const role = String(msg.role || '')
      const content = msg.content
      if (typeof content === 'string') return `[${role}]: ${content}`
      if (Array.isArray(content)) {
        const parts = content
          .map((b: Record<string, unknown>) => {
            if (b.type === 'text') return String(b.text || '')
            if (b.type === 'tool_use') return `[tool_use ${b.name}]`
            if (b.type === 'tool_result') return `[tool_result]`
            return `[${b.type}]`
          })
          .join(' ')
        return `[${role}]: ${parts}`
      }
      return ''
    })
    .filter(Boolean)
    .join('\n\n')
}

export async function autoFoldOldestMessagesForContextCollapse(options: {
  messages: Array<Record<string, unknown>>
  systemPrompt: string
  thresholds: ContextThresholds
  toolDefsTokens: number
  config: ProviderConfig
  model: string
  signal: AbortSignal
  collapseConversationKey: string
}): Promise<Array<Record<string, unknown>> | null> {
  if (process.env.POLE_CONTEXT_COLLAPSE_AUTO !== '1') return null
  const {
    messages,
    systemPrompt,
    thresholds,
    toolDefsTokens,
    config,
    model,
    signal,
    collapseConversationKey,
  } = options
  if (messages.length < 12) return null
  const est = estimateConversationTokens(messages, systemPrompt) + toolDefsTokens
  if (est < thresholds.autoCompactTokens) return null

  const head = messages.slice(0, SEGMENT_MESSAGE_COUNT)
  const tail = messages.slice(SEGMENT_MESSAGE_COUNT)
  const transcript = transcriptForMessages(head)
  if (transcript.length < 80) return null

  let summary = ''
  try {
    await streamText(
      config,
      {
        model,
        maxTokens: 1024,
        messages: [
          {
            role: 'user',
            content: `Summarize the following conversation turns in at most 1200 characters. Preserve user goals, file paths, errors, and unresolved work.\n\n---\n${transcript}`,
          },
        ],
        systemPrompt: 'You output only the summary text, no preamble.',
        alwaysThinking: SIDE_QUERY_ALWAYS_THINKING,
      },
      {
        onTextDelta: (t) => {
          summary += t
        },
        onMessageEnd: () => {},
        onError: (e) => {
          throw new Error(String(e))
        },
      },
      signal,
    )
  } catch {
    return null
  }
  const s = summary.trim()
  if (!s) return null
  appendContextCollapseSummary(collapseConversationKey, s)
  // Wrap in `<system-reminder>` + `_convertedFromSystem: true` so the model
  // recognises this as a host-generated recap (parity with `compact.ts` and
  // `contextCollapseDrain.ts`). Without the envelope the bare "[Prior
  // conversation segment …]" user message can be misread as a fresh user
  // statement on some providers.
  return [
    makeSideChannelUserMessage(
      SIDE_CHANNEL_KIND.contextCollapseAuto,
      `[Prior conversation segment — auto-folded for context. Treat as authoritative recap; do NOT respond as if the user just narrated this.]\n${s}`,
    ),
    ...tail,
  ]
}
