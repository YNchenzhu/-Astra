/**
 * P3.1 — Compact diminishing-returns detection (upstream parity).
 *
 * When the loop has run multiple consecutive compactions and each one
 * reclaims only a tiny fraction of the input window, additional compact
 * attempts are wasted work — they re-summarise an already-tight context.
 * upstream's `services/compact/autoCompact.ts` tracks this via
 * `consecutiveFailures` (compact threw N times in a row) and stops
 * trying. The diminishing-returns logic captured here is a more
 * permissive variant: we also stop trying when compact SUCCEEDS but
 * doesn't actually free meaningful tokens — the "we already compacted
 * everything we can" state.
 *
 * Pure function — no I/O, no state mutation. The caller threads a
 * rolling history of compact attempts in and asks "should I bother
 * trying again?".
 *
 * Threshold semantics (defaults align with upstream's tokenBudget
 * `DIMINISHING_THRESHOLD = 500`-style heuristic, scaled to compact
 * sizes):
 *
 *   - Need at least `minHistoryToTriggerDiminishing` recent attempts
 *     (default 3) before we even consider stopping. A single weak
 *     compact is normal at session start when there isn't much to
 *     compact away yet.
 *   - "Weak" = `(preTokens - postTokens) / preTokens < minReclaimRatio`
 *     (default 0.05 = 5%). The ratio is more stable than absolute
 *     numbers — a 5% reclaim on a 200k context is meaningful, a 5k
 *     reclaim on a 1M context is noise.
 *   - All `minHistoryToTriggerDiminishing` most-recent attempts must
 *     be weak for the gate to fire. A single recent BIG win resets
 *     the "weakness streak".
 *
 * upstream reference: `src/query/tokenBudget.ts` L59-90 (the
 * diminishingReturns logic for token budget, same shape adapted here
 * for compact attempts).
 */

export interface CompactAttempt {
  /** Estimated tokens BEFORE the compact pass. */
  preTokens: number
  /** Estimated tokens AFTER the compact pass. 0 ≤ postTokens ≤ preTokens. */
  postTokens: number
  /** Wall-clock timestamp; preserved for telemetry but not consulted by the gate. */
  ranAt: number
}

export type CompactHistory = ReadonlyArray<CompactAttempt>

export interface CompactDiminishingConfig {
  /**
   * Minimum number of recent compact attempts required before the gate
   * can fire. Below this, `isCompactDiminishing` always returns false.
   * upstream parity: their tokenBudget uses 3.
   */
  minHistoryToTriggerDiminishing?: number
  /**
   * Reclamation fraction below which a compact attempt is considered
   * "weak". The default 0.05 means a compact that frees less than 5%
   * of the pre-compact tokens does not count as meaningful progress.
   */
  minReclaimRatio?: number
}

const DEFAULT_MIN_HISTORY = 3
const DEFAULT_MIN_RECLAIM_RATIO = 0.05

/**
 * @returns true when the N most-recent compact attempts all reclaimed
 * less than `minReclaimRatio` of their input — i.e. the loop is
 * spinning on compacts that don't free meaningful context.
 */
export function isCompactDiminishing(
  history: CompactHistory,
  config: CompactDiminishingConfig = {},
): boolean {
  const minHistory = config.minHistoryToTriggerDiminishing ?? DEFAULT_MIN_HISTORY
  const minRatio = config.minReclaimRatio ?? DEFAULT_MIN_RECLAIM_RATIO

  if (history.length < minHistory) return false

  // Walk the N most-recent entries; if ANY reclaimed enough, the
  // streak is broken and we should keep trying.
  const recent = history.slice(-minHistory)
  for (const attempt of recent) {
    if (attempt.preTokens <= 0) {
      // Degenerate input — treat as "no signal" (the alternative is
      // dividing by zero and flagging it as weak, which would be too
      // aggressive).
      return false
    }
    const reclaim = attempt.preTokens - attempt.postTokens
    const ratio = reclaim / attempt.preTokens
    if (ratio >= minRatio) {
      return false // not diminishing — this attempt was meaningful
    }
  }

  return true
}

/**
 * Append a new attempt to a rolling history, dropping the oldest
 * entries if the size exceeds `maxRetention`. Pure — returns a new
 * array; never mutates `history`.
 *
 * `maxRetention` defaults to 2 × `minHistoryToTriggerDiminishing` so
 * the gate has enough lookback without growing unbounded across a
 * long session.
 */
export function recordCompactAttempt(
  history: CompactHistory,
  attempt: CompactAttempt,
  maxRetention: number = DEFAULT_MIN_HISTORY * 2,
): CompactHistory {
  const next = [...history, attempt]
  if (next.length > maxRetention) {
    return next.slice(next.length - maxRetention)
  }
  return next
}
