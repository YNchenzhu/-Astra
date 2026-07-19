/**
 * Ensure every assistant tool_use has a matching tool_result (upstream §17.1 / messages ensureToolResultPairing).
 */

import { SIDE_CHANNEL_KIND, wrapSideChannelBody } from '../constants/sideChannelKinds'

function cloneContent(content: unknown): unknown {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return content
  return (content as Record<string, unknown>[]).map((b) => ({ ...b }))
}

function toolUseIdsFromAssistant(msg: Record<string, unknown>): string[] {
  if (!Array.isArray(msg.content)) return []
  const ids: string[] = []
  for (const b of msg.content as Record<string, unknown>[]) {
    if (b.type === 'tool_use' && typeof b.id === 'string') ids.push(b.id)
  }
  return ids
}

function toolResultIdsFromUser(msg: Record<string, unknown>): Set<string> {
  const s = new Set<string>()
  if (!Array.isArray(msg.content)) return s
  for (const b of msg.content as Record<string, unknown>[]) {
    if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
      s.add(b.tool_use_id)
    }
  }
  return s
}

const SYNTHETIC_ERROR =
  'Error: Tool execution failed (synthetic tool_result — pairing repair for API invariants).'

/**
 * Marker text block separating synthetic tool_result blocks from any
 * real user-authored content that follows in the same user turn.
 *
 * v1/C3 + v2/C1 fix — without this separator, the user message looks
 * like `[tool_result(error), <user's actual text>]`, and the model
 * frequently reads the error as something the user reported. The marker
 * is a `<system-reminder>` text block so the standing system prompt
 * already tells the model how to interpret it as side-channel context.
 *
 * The marker goes AFTER the synth tool_result blocks (so DeepSeek /
 * Anthropic still see "tool_result blocks immediately after tool_use"
 * — text blocks following the synth are tolerated). Real user content
 * comes after the marker.
 */
const SYNTH_USER_SEPARATOR_MARKER: Record<string, unknown> = {
  type: 'text',
  text: wrapSideChannelBody(
    SIDE_CHANNEL_KIND.pairingRepair,
    '[Pairing repair] The tool_result block(s) above are synthetic placeholders inserted by the host because their parent tool_use was not paired with a real result (interrupted run, dropped frame, or fork boundary). They are NOT a fresh failure that the user is reporting. Treat any user content below as a separate, independent turn — do not apologize for the synthetic error.',
  ),
}

function userContentToBlocks(content: unknown): Array<Record<string, unknown>> {
  if (typeof content === 'string') {
    return content.length > 0 ? [{ type: 'text', text: content }] : []
  }
  if (Array.isArray(content)) {
    return content as Array<Record<string, unknown>>
  }
  return []
}

function userMessageHasNonToolResultContent(
  blocks: Array<Record<string, unknown>>,
): boolean {
  return blocks.some((b) => b && b.type !== 'tool_result')
}

function reorderMatchingToolResultsFirst(
  blocks: Array<Record<string, unknown>>,
  neededIds: string[],
): Array<Record<string, unknown>> {
  const needed = new Set(neededIds)
  const matchingToolResults: Array<Record<string, unknown>> = []
  const rest: Array<Record<string, unknown>> = []

  for (const block of blocks) {
    if (
      block?.type === 'tool_result' &&
      typeof block.tool_use_id === 'string' &&
      needed.has(block.tool_use_id)
    ) {
      matchingToolResults.push(block)
    } else {
      rest.push(block)
    }
  }

  return [...matchingToolResults, ...rest]
}

/**
 * Insert or prepend synthetic tool_result blocks so no tool_use is orphaned.
 *
 * Always merges synth into the immediately-following user message (converting
 * string content to a `text` block when needed) so the output never grows two
 * consecutive user messages — DeepSeek's Anthropic-compat endpoint enforces
 * `tool_use` followed by `tool_result blocks immediately after` (see
 * `.claude/memory/deepseek-anthropic-tool-call-ordering-constraint.md`); a
 * synth-then-existing-user split previously slipped past it because the
 * compat HTTP client doesn't re-run `mergeConsecutiveUserMessages` after the
 * pairing pass.
 *
 * v1/C3 + v2/C1 — when the merged user already contains non-tool_result
 * content (real user text, sub-agent inject, etc.), insert
 * {@link SYNTH_USER_SEPARATOR_MARKER} between the synth blocks and the
 * existing content so the model can tell synth pairing repair from the
 * surrounding turn.
 */
export function ensureToolUseResultPairing(
  messages: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = messages.map((m) => ({
    ...m,
    content: cloneContent(m.content),
  }))

  for (let i = 0; i < out.length; i++) {
    const msg = out[i]
    if (msg.role !== 'assistant') continue
    const needed = toolUseIdsFromAssistant(msg)
    if (needed.length === 0) continue

    const next = out[i + 1]
    // Bug C fix (debug session cb2d71): scan ALL consecutive user messages
    // following the assistant (up to the next assistant) for tool_result
    // blocks, not just `out[i+1]`. Pre-fix the function only checked the
    // immediate next user message — when an unrelated user message
    // (e.g. an empty stub from injectPendingSubAgentOutputsForMainTurn,
    // or a side-channel text message) sat between the assistant tool_use
    // and the real tool_result, the function falsely thought the
    // tool_result was "missing" and synthesised a SYNTHETIC_ERROR
    // duplicate. The downstream mergeConsecutiveUserMessages in
    // normalizeMessagesForAPI then collapsed the consecutive user
    // messages into one and produced two tool_result blocks with the
    // same tool_use_id, which deepseek/Anthropic reject with HTTP 400
    // "each tool_use must have a single result".
    const present = new Set<string>()
    for (let j = i + 1; j < out.length; j++) {
      const m = out[j]
      if (m.role !== 'user') break
      for (const id of toolResultIdsFromUser(m)) {
        present.add(id)
      }
    }
    const missing = needed.filter((id) => !present.has(id))
    if (missing.length === 0) {
      out[i + 1] = {
        ...next,
        content: reorderMatchingToolResultsFirst(userContentToBlocks(next.content), needed),
      }
      continue
    }

    const synth = missing.map((tool_use_id) => ({
      type: 'tool_result',
      tool_use_id,
      content: SYNTHETIC_ERROR,
      is_error: true,
    }))

    if (next && next.role === 'user') {
      const existingBlocks = userContentToBlocks(next.content)
      const hasRealContent = userMessageHasNonToolResultContent(existingBlocks)
      out[i + 1] = {
        ...next,
        content: hasRealContent
          ? [...synth, { ...SYNTH_USER_SEPARATOR_MARKER }, ...existingBlocks]
          : [...synth, ...existingBlocks],
      }
    } else {
      out.splice(i + 1, 0, {
        role: 'user',
        content: synth,
        _convertedFromSystem: true,
      })
    }
  }

  return out
}
