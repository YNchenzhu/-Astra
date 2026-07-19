/**
 * History-snip nudge tracker — observes context growth between
 * snip events to drive the `context_efficiency` host attachment.
 *
 * ## Difference vs upstream
 *
 * upstream's `shouldNudgeForSnips` is **action-demanding**: it tells
 * the model "consider using SnipTool to free context". The model is
 * expected to call SnipTool (a model-facing tool that upstream
 * exposes). We do NOT expose SnipTool — context management is the
 * host's responsibility (auto-compact / history-snip / micro-compact),
 * not the model's. An action-demanding nudge here would directly
 * contradict our `compaction_reminder` collector's "no need to rush,
 * the host handles compaction" message.
 *
 * Our nudge is therefore **informational only**: "context has grown
 * N tokens since the last snip; the host will manage when needed".
 * The model receives the signal but isn't asked to act.
 *
 * ## State model
 *
 * Per-conversation snapshot of:
 *
 *   - `tokensAtLastSnipOrNudge` — baseline for the growth calc
 *   - `lastSnipFreedTokens` — for the nudge to mention the most
 *     recent free
 *   - `nudgeCount` — bounds the total nudges per session so a
 *     long stationary conversation doesn't get N "context grew"
 *     messages
 *
 * ## When to call
 *
 * - `recordSnipEvent` — called by host-side compact paths (history
 *   snip / micro-compact / auto-compact) when they actually free
 *   tokens. Resets the growth baseline.
 * - `shouldEmitContextEfficiencyNudge` — called by the collector
 *   at post_tool; returns the descriptive payload when the
 *   conversation has grown past the threshold without intervention
 *   AND the per-session nudge cap hasn't been hit.
 */

/** Min growth (in tokens) since last snip / nudge to trigger emission. */
export const DEFAULT_GROWTH_THRESHOLD_TOKENS = 15_000

/** Hard cap on how many times we'll emit per conversation. */
export const DEFAULT_MAX_NUDGES_PER_CONVERSATION = 5

interface SnipNudgeState {
  tokensAtLastSnipOrNudge: number
  lastSnipFreedTokens: number
  nudgeCount: number
}

const stateByConversation = new Map<string, SnipNudgeState>()

function getOrInit(conversationId: string): SnipNudgeState {
  let s = stateByConversation.get(conversationId)
  if (!s) {
    s = {
      tokensAtLastSnipOrNudge: 0,
      lastSnipFreedTokens: 0,
      nudgeCount: 0,
    }
    stateByConversation.set(conversationId, s)
  }
  return s
}

/**
 * Record a host-side compact event so the growth baseline resets.
 *
 * @param currentTokenEstimate post-snip token estimate.
 * @param freedTokens how many tokens this snip freed (informational;
 *                    surfaced in the next nudge if applicable).
 */
export function recordSnipEvent(
  conversationId: string,
  currentTokenEstimate: number,
  freedTokens: number,
): void {
  if (!conversationId) return
  const s = getOrInit(conversationId)
  s.tokensAtLastSnipOrNudge = Math.max(0, currentTokenEstimate)
  s.lastSnipFreedTokens = Math.max(0, freedTokens)
}

export interface ContextEfficiencyNudgePayload {
  /** Tokens grown since the last snip / nudge. */
  readonly grownTokens: number
  /** Total estimated tokens right now. */
  readonly currentTokens: number
  /**
   * Tokens freed by the most recent snip event (`recordSnipEvent`).
   * Zero on the first nudge for a conversation that hasn't seen a
   * snip yet.
   */
  readonly lastSnipFreedTokens: number
  /** Nudge index within this conversation (1-based). */
  readonly nudgeIndex: number
}

/**
 * Decide whether to emit a `context_efficiency` nudge. Atomic: when
 * returning a payload (truthy), the internal baseline is advanced
 * so the next call doesn't re-fire until another `growthThreshold`
 * tokens accumulate.
 *
 * @returns the payload to format, or `null` to skip.
 */
export function shouldEmitContextEfficiencyNudge(args: {
  conversationId: string
  currentTokenEstimate: number
  growthThreshold?: number
  maxNudges?: number
}): ContextEfficiencyNudgePayload | null {
  const {
    conversationId,
    currentTokenEstimate,
    growthThreshold = DEFAULT_GROWTH_THRESHOLD_TOKENS,
    maxNudges = DEFAULT_MAX_NUDGES_PER_CONVERSATION,
  } = args
  if (!conversationId) return null
  if (!Number.isFinite(currentTokenEstimate) || currentTokenEstimate <= 0) {
    return null
  }

  const s = getOrInit(conversationId)
  if (s.nudgeCount >= maxNudges) return null

  // First observation for a fresh conversation: prime the baseline
  // and skip — we want to nudge on GROWTH, not on initial size.
  if (s.tokensAtLastSnipOrNudge === 0) {
    s.tokensAtLastSnipOrNudge = currentTokenEstimate
    return null
  }

  // Implicit-compact detection: if the current estimate is BELOW the
  // baseline, the conversation must have just shrunk — i.e. some
  // host-side compact path (auto_compact / micro_compact / reactive_compact
  // / collapse_drain — any path we don't explicitly hook via
  // `recordSnipEvent`) ran and freed tokens. Reset the baseline to
  // the new "after-compact" floor so the next nudge measures growth
  // from THIS point, not the pre-compact value (which would inflate
  // the "grown N tokens" number reported to the model).
  if (currentTokenEstimate < s.tokensAtLastSnipOrNudge) {
    s.tokensAtLastSnipOrNudge = currentTokenEstimate
    return null
  }

  const grown = currentTokenEstimate - s.tokensAtLastSnipOrNudge
  if (grown < growthThreshold) return null

  s.nudgeCount += 1
  s.tokensAtLastSnipOrNudge = currentTokenEstimate
  return {
    grownTokens: grown,
    currentTokens: currentTokenEstimate,
    lastSnipFreedTokens: s.lastSnipFreedTokens,
    nudgeIndex: s.nudgeCount,
  }
}

/** Test seam — drop a single conversation's tracker. */
export function __resetSnipNudgeTrackerForTests(conversationId?: string): void {
  if (conversationId) stateByConversation.delete(conversationId)
  else stateByConversation.clear()
}
