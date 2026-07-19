/**
 * upstream §3.2 — Session Memory extraction trigger (rolling counters + gates).
 * - Init: ≥10_000 tokens since last extract, then either ≥3 tool calls **or** last assistant turn had 0 tools.
 * - Update: ≥5_000 tokens since last extract, same disjunctive condition.
 */

/** First extract needs this many input tokens (approx) since last consume */
export const SESSION_MEMORY_INIT_MESSAGE_TOKENS = 10_000

/** Subsequent extracts need this many tokens since last consume */
export const SESSION_MEMORY_MIN_TOKENS_BETWEEN_UPDATES = 5_000

export const SESSION_MEMORY_TOOL_CALLS_BETWEEN_UPDATES = 3

type ConvState = {
  tokensSinceExtract: number
  toolCallsSinceExtract: number
  lastTurnToolCalls: number
  /** After first successful extract, use 5k threshold instead of 10k */
  hasCompletedExtract: boolean
  /** When the user denies session-memory writes, suppress further triggers for this conversation. */
  suppressedByDenial: boolean
  /**
   * UUID of the last API message at the time the previous extract was consumed.
   * Used by compaction to calculate a precise boundary (upstream §4.2 §6.5).
   */
  lastSummarizedMessageId?: string
}

const byConversation = new Map<string, ConvState>()

/**
 * Soft cap on retained per-conversation trigger states (MEM18). Each entry is
 * ~80 bytes, so the cap is generous — what we're really preventing is
 * unbounded growth in long-running daily-driver sessions where the user
 * cycles through hundreds of conversations without restarting the app.
 *
 * Eviction policy is FIFO on insertion order (Maps preserve it). The trigger
 * state is purely a counter cache: discarding an old entry just means the
 * next turn for that conversation pays one extra "fresh state" allocation,
 * which is fine — no correctness impact.
 */
const MAX_TRACKED_CONVERSATIONS = 512

function getState(conversationId: string): ConvState {
  let s = byConversation.get(conversationId)
  if (!s) {
    s = {
      tokensSinceExtract: 0,
      toolCallsSinceExtract: 0,
      lastTurnToolCalls: 0,
      hasCompletedExtract: false,
      suppressedByDenial: false,
    }
    if (byConversation.size >= MAX_TRACKED_CONVERSATIONS) {
      // Drop the oldest entry to keep the Map bounded. JS Map iteration
      // order is insertion order; the first key is the oldest.
      const oldest = byConversation.keys().next().value
      if (oldest !== undefined) byConversation.delete(oldest)
    }
    byConversation.set(conversationId, s)
  }
  return s
}

/**
 * Drop the trigger state for a conversation that's known to be over (e.g.
 * user deleted the conversation, or app code is shutting down a session).
 * Optional surface — callers that don't bother still get the FIFO cap
 * above.
 */
export function dropSessionMemoryTriggerState(conversationId: string | undefined): void {
  const id = conversationId?.trim()
  if (!id) return
  byConversation.delete(id)
}

/**
 * Call after each successful model stream on the main thread (one assistant turn).
 */
export function recordMainThreadSessionMemorySignals(
  conversationId: string | undefined,
  input: { inputTokensThisTurn: number; toolCallsThisTurn: number },
): void {
  const id = conversationId?.trim()
  if (!id) return
  const s = getState(id)
  const add = Math.max(0, Math.floor(input.inputTokensThisTurn))
  s.tokensSinceExtract += add
  s.lastTurnToolCalls = Math.max(0, Math.floor(input.toolCallsThisTurn))
  s.toolCallsSinceExtract += s.lastTurnToolCalls
}

/**
 * upstream §3.2 — trigger when token threshold met AND
 * (tool calls ≥3 **or** last assistant turn had no tool calls — natural breakpoint).
 */
export function shouldTriggerSessionMemoryExtract(conversationId: string | undefined): boolean {
  const id = conversationId?.trim()
  if (!id) return false
  const s = byConversation.get(id)
  if (!s) return false
  if (s.suppressedByDenial) return false

  const tokenThreshold = s.hasCompletedExtract
    ? SESSION_MEMORY_MIN_TOKENS_BETWEEN_UPDATES
    : SESSION_MEMORY_INIT_MESSAGE_TOKENS

  if (s.tokensSinceExtract < tokenThreshold) return false

  // Require meaningful tool activity before extracting —
  // a pure text reply (0 tool calls) right after system prompt is NOT a signal to extract.
  if (s.toolCallsSinceExtract >= SESSION_MEMORY_TOOL_CALLS_BETWEEN_UPDATES) return true
  // Natural breakpoint: last assistant turn had 0 tool calls —
  // the token threshold (≥10k init / ≥5k update) already prevents
  // extracting on trivial "hello" turns right after system prompt.
  if (s.lastTurnToolCalls === 0) return true
  return false
}

/** Permanently suppress session-memory extraction for this conversation (user denied). */
export function suppressSessionMemoryExtract(conversationId: string | undefined): void {
  const id = conversationId?.trim()
  if (!id) return
  const s = getState(id)
  s.suppressedByDenial = true
}

export function markSessionMemoryExtractConsumed(
  conversationId: string | undefined,
  lastMessageId?: string,
): void {
  const id = conversationId?.trim()
  if (!id) return
  const s = getState(id)
  s.tokensSinceExtract = 0
  s.toolCallsSinceExtract = 0
  s.hasCompletedExtract = true
  if (lastMessageId?.trim()) {
    s.lastSummarizedMessageId = lastMessageId.trim()
  }
}

/** Return the lastSummarizedMessageId for compaction boundary calculation. */
export function getLastSummarizedMessageId(conversationId: string | undefined): string | undefined {
  const id = conversationId?.trim()
  if (!id) return undefined
  return byConversation.get(id)?.lastSummarizedMessageId
}

export function resetSessionMemoryTriggerForTests(): void {
  byConversation.clear()
}
