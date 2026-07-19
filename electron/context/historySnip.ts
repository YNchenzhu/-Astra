/**
 * History Snip — drop oldest transcript messages to free tokens (upstream §5 layer 3 / §19.2).
 */

import { estimateConversationTokens } from './tokenCounter'

export type HistorySnipOptions = {
  systemPrompt: string
  toolDefsTokens: number
  /** Stop snipping once total estimate is at or below this. */
  targetTotalTokens: number
  /** Do not shrink below this many messages. */
  minMessagesToKeep: number
  /** Tool use IDs whose tool_use/tool_result pairs must be preserved (optional plumbing; currently unpopulated). */
  protectedToolUseIds?: string[]
}

function userMessageHasOrphanToolResult(
  msg: Record<string, unknown> | undefined,
): boolean {
  if (!msg || msg.role !== 'user' || !Array.isArray(msg.content)) return false
  return (msg.content as Array<Record<string, unknown>>).some(
    (b) => b && b.type === 'tool_result',
  )
}

/**
 * P0-5 — sanitize the head of `messages` after a snip:
 *   1. Anthropic Messages API requires the first message to be `user`.
 *      A bare `slice(1)` can leave an `assistant` (with `tool_use`) at
 *      index 0; the request would 400.
 *   2. A user message starting with `tool_result` blocks (whose original
 *      assistant `tool_use` was just snipped away) is also rejected
 *      ("tool_result without tool_use"). Strip those orphans, but only
 *      from the leading user message — once we hit a clean user, the
 *      rest of the array is well-formed.
 *
 * Returns the new array and how many additional messages were removed
 * (counted as snipped for caller telemetry).
 */
function repairHeadAfterSnip(
  messages: Array<Record<string, unknown>>,
): { messages: Array<Record<string, unknown>>; extraSnipped: number } {
  if (messages.length === 0) return { messages, extraSnipped: 0 }
  let extra = 0
  let m = messages
  // 2026-06 destructive 50×120 stress fix — the repair must run to a
  // FIXPOINT. The previous three-phase shape (drop assistants → strip
  // orphan results once → drop assistants again) had a hole: when the
  // head was `assistant(A1), user(results A1), assistant(A2),
  // user(results A2), …` (adjacent tool batches with no ordinary user
  // turn between), phase 3 dropped A2 to satisfy "first message must be
  // user" and then STOPPED — re-exposing `user(results A2)` at the head
  // with orphan tool_result blocks that sailed to the wire and drew a
  // provider 400 ("tool_result without tool_use"). Loop until the head
  // is a user message with no orphan tool_results.
  for (;;) {
    if (m.length === 0) break
    // First message must be `user` (Anthropic 400 otherwise).
    if (m[0]?.role === 'assistant') {
      m = m.slice(1)
      extra++
      continue
    }
    // A leading user carrying tool_result blocks lost its originating
    // assistant tool_use to the snip — strip the orphans.
    if (userMessageHasOrphanToolResult(m[0])) {
      const first = m[0]
      const blocks = first.content as Array<Record<string, unknown>>
      const cleaned = blocks.filter((b) => b && b.type !== 'tool_result')
      if (cleaned.length === 0) {
        m = m.slice(1)
        extra++
        continue
      }
      m = [{ ...first, content: cleaned }, ...m.slice(1)]
      continue
    }
    break
  }
  return { messages: m, extraSnipped: extra }
}

/**
 * Remove messages from the front until estimated tokens ≤ target (or min length reached).
 */
export function snipOldestMessagesForBudget(
  messages: Array<Record<string, unknown>>,
  options: HistorySnipOptions,
): { messages: Array<Record<string, unknown>>; snippedCount: number } {
  const min = Math.max(1, options.minMessagesToKeep)
  let m = messages
  let snippedCount = 0
  const protectedIds = new Set(options.protectedToolUseIds ?? [])

  const totalEst = (): number =>
    estimateConversationTokens(m, options.systemPrompt) + options.toolDefsTokens

  const messageHasProtectedToolReference = (msg: Record<string, unknown> | undefined): boolean => {
    if (!msg || !Array.isArray(msg.content) || protectedIds.size === 0) return false
    return (msg.content as Array<Record<string, unknown>>).some((block) => {
      if (block?.type === 'tool_use' && typeof block.id === 'string') {
        return protectedIds.has(block.id)
      }
      if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        return protectedIds.has(block.tool_use_id)
      }
      return false
    })
  }

  while (m.length > min && totalEst() > options.targetTotalTokens) {
    const dropIdx = m.findIndex((msg, idx) => idx < m.length - min && !messageHasProtectedToolReference(msg))
    if (dropIdx < 0) break
    m = [...m.slice(0, dropIdx), ...m.slice(dropIdx + 1)]
    snippedCount++
  }

  // P0-5 — enforce API invariants on the new head before returning.
  // Without this, the first surviving message could be an `assistant`
  // (Anthropic 400: messages must start with user) or a user starting
  // with orphan `tool_result` blocks (Anthropic 400: tool_result
  // without tool_use). `ensureToolUseResultPairing` only fixes the
  // *forward* direction (orphan tool_use), so it cannot save us here.
  //
  // Repair strips additional messages but is allowed to dip below the
  // `minMessagesToKeep` floor — the floor is a soft preservation hint
  // for the snip loop, while the API invariants are non-negotiable
  // (a 400 wastes the entire turn and is far worse than a thinner tail).
  if (snippedCount > 0) {
    const repaired = repairHeadAfterSnip(m)
    // Always adopt the repaired array — the repair may have stripped
    // orphan tool_result BLOCKS in place without dropping a whole
    // message (extraSnipped === 0). The previous `if (extraSnipped > 0)`
    // gate silently discarded that in-place strip.
    m = repaired.messages
    snippedCount += repaired.extraSnipped
  }

  return { messages: m, snippedCount }
}
