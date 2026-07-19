/**
 * Iteration Stall Guard — token-delta based "model is spinning" detector.
 *
 * ──────────────────────────── Why a NEW guard ────────────────────────────
 *
 * `RepetitionGuard` (in this same folder) catches "model issued the same
 * tool call N times in a row." That's the tool-level degenerate-loop signal.
 *
 * This module catches a different failure mode: the model produces
 * thinking tokens but no useful output, iteration after iteration. No tool
 * use, no real text, tiny token delta. Today the `STOP_HOOK_BLOCK_CAP`
 * (default 8) only fires when stop hooks keep saying "continue", and the
 * `RepetitionGuard` only fires on tool-level repetition. Neither catches
 * the pure "model stalling on its own thinking budget" case, which is
 * exactly what burns quota silently and frustrates users who don't see
 * any progress indicators move.
 *
 * Inspired by upstream-main `checkTokenBudget` "diminishing returns" mode
 * (`src/query/tokenBudget.ts:59-62`): ≥3 continuations AND last two deltas
 * each < 500 tokens → early stop. We adopt the same shape but as an
 * orthogonal signal (it doesn't require a token budget feature flag, and
 * it fires off iteration metrics that the loop already computes).
 *
 * ────────────────────────────── Algorithm ────────────────────────────────
 *
 * Track a small per-conversation window of recent iteration metrics:
 *   - hadToolUse  — model called any tool this iteration
 *   - textLength  — non-thinking text length produced
 *   - tokenDelta  — input+output token delta vs prior iteration
 *
 * A "stalled iteration" is one where ALL of:
 *   - !hadToolUse
 *   - textLength < textCharFloor (default 100)
 *   - tokenDelta  < tokenDeltaFloor (default 800)
 *
 * After `consecutiveStallThreshold` (default 3) stalled iterations in a
 * row, `check()` returns `{ stalled: true }`. Any non-stalled iteration
 * resets the streak. The guard is per-conversation so a sub-agent's stall
 * does not poison the main chat (parallel to how token-budget tracks per
 * agent).
 *
 * upstream parity:
 *   - threshold of 3 mirrors upstream's `tokenBudget.ts:59` "≥3 continuations"
 *   - the < 500 token floor maps to our `tokenDeltaFloor` (we default 800
 *     to be a touch more conservative since we don't have a token-budget
 *     guard to back-stop us).
 *
 * ──────────────────────────── Threshold tuning ────────────────────────────
 *
 * Operators tune via env (read once at module load):
 *   - `POLE_ITERATION_STALL_THRESHOLD`     consecutive count (default 3)
 *   - `POLE_ITERATION_STALL_TEXT_FLOOR`    non-thinking text char floor (default 100)
 *   - `POLE_ITERATION_STALL_TOKEN_FLOOR`   token delta floor (default 800)
 *
 * Thinking-heavy reasoning models (e.g. o1-style) may legitimately produce
 * many low-text iterations as they reason. Tune the text floor UP for those
 * conversations (operators can swap the singleton via `createIterationStallGuard`
 * and inject manually into the loop in future work).
 *
 * The guard is per-conversation so independent conversations / sub-agents
 * keep independent streaks.
 */

const DEFAULT_THRESHOLD = 3
const DEFAULT_TEXT_FLOOR = 100
const DEFAULT_TOKEN_FLOOR = 800

function parseIntEnv(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export interface IterationStallGuardOptions {
  /** Consecutive stalled iterations to trip. Default 3 (upstream parity). */
  consecutiveStallThreshold?: number
  /** Non-thinking text length floor below which the iteration counts as low-text. Default 100. */
  textCharFloor?: number
  /** Input+output token delta floor below which the iteration counts as low-delta. Default 800. */
  tokenDeltaFloor?: number
}

export interface IterationStallMetrics {
  /** True when the model emitted any tool_use block this iteration. */
  hadToolUse: boolean
  /**
   * Non-thinking text length. Callers should compute this from
   * `accumulatedText` (NOT thinking blocks).
   */
  textLength: number
  /**
   * Output-token delta for THIS iteration's stream. Audit Bug-6 fix: the
   * previous comment claimed "input + output" but every production caller
   * (see `noTools.ts:lastStreamOutputTokens` invocation) passes the
   * output-only count from the most recent stream pass — and that's the
   * intended signal. upstream's `tokenBudget.ts` diminishing-returns rule
   * is also output-only for the same reason: input tokens grow naturally
   * each turn from accumulated transcript, so an input-inclusive delta
   * never trips the "small" floor.
   *
   * `tokenDeltaFloor` defaults to 800 to be slightly more conservative
   * than upstream's 500 since we don't have a separate token-budget guard
   * backstopping us.
   */
  tokenDelta: number
}

export interface IterationStallAdvice {
  stalled: boolean
  /** Length of the consecutive-stall streak as of the most recent record. */
  consecutiveCount: number
  /** Human-readable diagnostic for telemetry / termination errorDetail. */
  message?: string
}

export interface IterationStallGuard {
  /**
   * Record an iteration's metrics. Returns the resulting advice so the
   * caller can act on the same `record()` call. (Combining record+check
   * keeps the API small and avoids races.)
   */
  record(conversationId: string, metrics: IterationStallMetrics): IterationStallAdvice
  /** Reset the streak for one conversation. Called on genuine forward progress. */
  resetFor(conversationId: string): void
  /**
   * Audit Bug-3 fix — completely remove a conversation's entry from the
   * internal Map. Called from `unregisterOrchestrationKernelForConversation`
   * on session teardown so the Map doesn't accumulate entries forever in
   * long-uptime processes (multi-tab users, daemon mode).
   *
   * Distinct from `resetFor`: `resetFor` keeps the entry with `streak=0`
   * (used for in-session forward-progress signal); `deleteFor` drops the
   * entry entirely (used at session end).
   */
  deleteFor(conversationId: string): void
  /** Pure peek for tests / telemetry. */
  snapshot(conversationId: string): { streak: number } | null
  /** Wipe all conversations. Test-only. */
  reset(): void
}

interface ConversationState {
  streak: number
}

function buildMessage(streak: number, threshold: number): string {
  return (
    `[Iteration stall guard] Detected ${streak} consecutive iterations ` +
    `with no tool use, tiny output text, and minimal token delta. The ` +
    `model appears stuck in a thinking loop. Terminating to prevent ` +
    `further quota burn — pick a different approach or end the turn ` +
    `with a concrete answer to the user. Tunable via ` +
    `POLE_ITERATION_STALL_THRESHOLD (current: ${threshold}).`
  )
}

export function createIterationStallGuard(
  options?: IterationStallGuardOptions,
): IterationStallGuard {
  const threshold = Math.max(
    2,
    options?.consecutiveStallThreshold ??
      parseIntEnv(process.env.POLE_ITERATION_STALL_THRESHOLD, DEFAULT_THRESHOLD),
  )
  const textFloor = Math.max(
    0,
    options?.textCharFloor ??
      parseIntEnv(process.env.POLE_ITERATION_STALL_TEXT_FLOOR, DEFAULT_TEXT_FLOOR),
  )
  const tokenFloor = Math.max(
    0,
    options?.tokenDeltaFloor ??
      parseIntEnv(process.env.POLE_ITERATION_STALL_TOKEN_FLOOR, DEFAULT_TOKEN_FLOOR),
  )

  const byConversation = new Map<string, ConversationState>()

  const getState = (cid: string): ConversationState => {
    let s = byConversation.get(cid)
    if (!s) {
      s = { streak: 0 }
      byConversation.set(cid, s)
    }
    return s
  }

  const isStalledIteration = (m: IterationStallMetrics): boolean => {
    if (m.hadToolUse) return false
    if (m.textLength >= textFloor) return false
    if (m.tokenDelta >= tokenFloor) return false
    return true
  }

  return {
    record(conversationId, metrics) {
      const cid = conversationId.trim()
      if (!cid) {
        return { stalled: false, consecutiveCount: 0 }
      }
      const s = getState(cid)
      if (isStalledIteration(metrics)) {
        s.streak += 1
      } else {
        s.streak = 0
      }
      if (s.streak >= threshold) {
        return {
          stalled: true,
          consecutiveCount: s.streak,
          message: buildMessage(s.streak, threshold),
        }
      }
      return { stalled: false, consecutiveCount: s.streak }
    },
    resetFor(conversationId) {
      const cid = conversationId.trim()
      if (!cid) return
      const s = byConversation.get(cid)
      if (s) s.streak = 0
    },
    deleteFor(conversationId) {
      const cid = conversationId.trim()
      if (!cid) return
      byConversation.delete(cid)
    },
    snapshot(conversationId) {
      const cid = conversationId.trim()
      if (!cid) return null
      const s = byConversation.get(cid)
      return s ? { streak: s.streak } : null
    },
    reset() {
      byConversation.clear()
    },
  }
}

let instance: IterationStallGuard | undefined

/**
 * Process-wide singleton. Options are honored only on the FIRST call (matches
 * `getRepetitionGuard` semantics). Tests use {@link resetIterationStallGuardForTests}.
 */
export function getIterationStallGuard(
  options?: IterationStallGuardOptions,
): IterationStallGuard {
  if (!instance) {
    instance = createIterationStallGuard(options)
  }
  return instance
}

export function resetIterationStallGuardForTests(): void {
  instance = undefined
}
