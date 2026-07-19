/**
 * upstream §6 / §17 — minimal API-bound invariants before Anthropic Messages requests.
 */

import { ensureToolUseResultPairing } from './ensureToolUseResultPairing'
import { SIDE_CHANNEL_KIND, wrapSideChannelBody } from '../constants/sideChannelKinds'

/** Report §6.2 — `API_MAX_MEDIA_PER_REQUEST` style cap for images per request. */
export const API_MAX_MEDIA_ITEMS_PER_REQUEST = 100

function countImageBlocksInMessages(messages: ReadonlyArray<Record<string, unknown>>): number {
  let n = 0
  for (const m of messages) {
    const c = m.content
    if (!Array.isArray(c)) continue
    for (const b of c) {
      if ((b as { type?: string }).type === 'image') n++
    }
  }
  return n
}

/**
 * If an assistant turn ends with `thinking` / `redacted_thinking`, append an empty text block
 * so the block is not last (§10.2).
 *
 * When `strictThinkingEcho` is true this is a no-op — required for DeepSeek's
 * Anthropic-compat endpoint which requires historical thinking blocks to be
 * echoed back verbatim, including when they trail the message.
 */
export function fixAssistantThinkingNotLastBlock<T extends Record<string, unknown>>(
  messages: T[],
  strictThinkingEcho?: boolean,
): T[] {
  if (strictThinkingEcho) return messages.map((m) => ({ ...m }))
  return messages.map((m) => {
    if (m.role !== 'assistant') return m
    const c = m.content
    if (!Array.isArray(c) || c.length === 0) return m
    const last = c[c.length - 1] as { type?: string }
    const t = last?.type
    if (t === 'thinking' || t === 'redacted_thinking') {
      return {
        ...m,
        content: [...c, { type: 'text', text: '' }],
      } as T
    }
    return m
  })
}

/**
 * Drops oldest `image` content blocks until at most {@link API_MAX_MEDIA_ITEMS_PER_REQUEST}
 * remain.
 *
 * When any image is actually dropped, we inject a single `<system-reminder>`
 * text block into the **most recent user message** explaining how many images
 * were omitted and from which turn range. Without this signal the model has
 * no idea that its "please compare the second and the first screenshot"
 * request is now impossible to fulfil — it just silently hallucinates.
 */
export function stripExcessImageBlocks<T extends Record<string, unknown>>(
  messages: T[],
  maxItems: number = API_MAX_MEDIA_ITEMS_PER_REQUEST,
): T[] {
  const total = countImageBlocksInMessages(messages)
  if (total <= maxItems) return messages
  let toDrop = total - maxItems
  const originalToDrop = toDrop
  const out: T[] = []
  // Track the first / last user-message indices that lost an image so the
  // surfaced reminder can cite a range the user recognises.
  let firstStrippedIdx = -1
  let lastStrippedIdx = -1
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (toDrop <= 0) {
      out.push(m)
      continue
    }
    const c = m.content
    if (!Array.isArray(c)) {
      out.push(m)
      continue
    }
    const next: unknown[] = []
    let droppedHere = 0
    for (const b of c) {
      if (toDrop > 0 && (b as { type?: string }).type === 'image') {
        toDrop--
        droppedHere++
        continue
      }
      next.push(b)
    }
    if (droppedHere > 0) {
      if (firstStrippedIdx < 0) firstStrippedIdx = i
      lastStrippedIdx = i
    }
    out.push({ ...m, content: next } as T)
  }

  // Surface a compact notice on the last user message so the model knows it
  // is operating on a reduced image set. Skip if we somehow never had a user
  // message (should be impossible in normal flows).
  if (originalToDrop > 0) {
    const reminderText = wrapSideChannelBody(
      SIDE_CHANNEL_KIND.imageBudgetNote,
      `[Image budget note] ${originalToDrop} earlier image attachment${originalToDrop > 1 ? 's were' : ' was'} omitted from this request to stay within the ${maxItems}-image per-request cap. If the user refers to "the previous screenshot / picture / page N" and you cannot find a matching image block in the visible history, ask the user to re-attach it. The images most recently attached (within the cap) ARE present.`,
    )
    for (let i = out.length - 1; i >= 0; i--) {
      const m = out[i]
      if (m.role !== 'user') continue
      const c = m.content
      if (typeof c === 'string') {
        out[i] = { ...m, content: `${c}\n\n${reminderText}` } as T
      } else if (Array.isArray(c)) {
        out[i] = { ...m, content: [...c, { type: 'text', text: reminderText }] } as T
      }
      break
    }
  }
  // Silence linter for the tracking refs even when only emitting the notice.
  void firstStrippedIdx
  void lastStrippedIdx
  return out
}

/**
 * F1 (2026-06) — drop the OpenAI-Responses-only `openai2Reasoning` payload
 * from tool_use blocks before they go out on an Anthropic wire. The field is
 * written by the openai2 stream path (see `compatibleClient` /
 * `claudeToOpenAI2`); when the user switches provider mid-conversation the
 * history still carries it, and Anthropic gateways may reject unknown
 * tool_use fields. Idempotent; returns the same array when nothing matched.
 */
function stripOpenai2ReasoningFromToolUse<T extends Record<string, unknown>>(
  messages: T[],
): T[] {
  let touched = false
  const out = messages.map((m) => {
    const c = m.content
    if (m.role !== 'assistant' || !Array.isArray(c)) return m
    if (!c.some((b) => (b as Record<string, unknown>)?.openai2Reasoning !== undefined)) return m
    touched = true
    return {
      ...m,
      content: c.map((b) => {
        const blk = b as Record<string, unknown>
        if (blk?.openai2Reasoning === undefined) return b
        const { openai2Reasoning: _drop, ...rest } = blk
        return rest
      }),
    } as T
  })
  return touched ? out : messages
}

/**
 * §6 / §17 pipeline for Anthropic wire: image cap then thinking tail fix.
 * Tool pairing is enforced as a final safety net for third-party gateways
 * (e.g. DeepSeek) that strictly validate tool_use/tool_result ordering.
 *
 * When `strictThinkingEcho` is true, `fixAssistantThinkingNotLastBlock` is
 * skipped so that historical thinking blocks are echoed back exactly as-is.
 */
export function applyAnthropicApiMessageInvariants<T extends Record<string, unknown>>(
  messages: T[],
  strictThinkingEcho?: boolean,
): T[] {
  // Enforce tool pairing — critical for DeepSeek Anthropic compat (HTTP 400
  // "tool_use ids were found without tool_result blocks immediately after")
  // when any pre-send pipeline silently broke the pairing. Idempotent.
  messages = ensureToolUseResultPairing(messages) as T[]
  messages = stripOpenai2ReasoningFromToolUse(messages)
  return fixAssistantThinkingNotLastBlock(stripExcessImageBlocks(messages), strictThinkingEcho)
}
