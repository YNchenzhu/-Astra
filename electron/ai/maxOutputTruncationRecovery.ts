/**
 * upstream §5.7 / §19 — synthetic user turn after `max_tokens` / `length` stop so the model can continue.
 *
 * 2026-05 audit (anti "narrate-only end_turn" alignment with upstream-main
 * `src/query.ts:1224-1230`): both recovery message variants have been
 * rewritten to match the upstream wording. The previous astra-
 * specific "switching to summary mode → list remaining steps so a
 * follow-up turn can pick up cleanly" fallback explicitly instructed the
 * model to hand work off to a future turn, which was one of the four root
 * causes of long-run "model narrates intent then end_turn with no tool
 * use" regressions identified in the audit.
 */

/**
 * upstream-main parity (`src/query.ts:1224-1230`) — the SOLE recovery
 * message used on every cycle. upstream has no second-cycle fallback;
 * its single-message strategy keeps the model focused on resuming
 * actual work rather than producing a wrap-up summary.
 *
 * Key wording invariants:
 *   - "Resume directly — no apology, no recap" → suppresses the
 *     model's tendency to apologise / re-summarise what it did
 *   - "Pick up mid-thought" → continue at the cut point
 *   - "Break remaining work into smaller pieces" → the remaining
 *     work stays IN THIS turn (or the next agentic loop iteration
 *     within the same user turn) — NOT handed off to a future
 *     user turn
 */
export const MAX_OUTPUT_TRUNCATION_USER_MESSAGE =
  `Output token limit hit. Resume directly — no apology, no recap of what you were doing. ` +
  `Pick up mid-thought if that is where the cut happened. Break remaining work into smaller pieces.`

/**
 * @deprecated 2026-05 audit — was a astra-specific second-cycle
 * fallback ("switching to summary mode") that explicitly handed work
 * off to a "follow-up turn". upstream has no such fallback and its
 * single recovery message is enough; the fallback was traced as one
 * root cause of long-run "narrate-only end_turn" regressions.
 *
 * Kept exported as a verbatim copy of `MAX_OUTPUT_TRUNCATION_USER_MESSAGE`
 * for binary compatibility with downstream callers / tests that still
 * import this symbol. The `stream.ts` recovery loop no longer
 * differentiates between cycles.
 */
export const MAX_OUTPUT_TRUNCATION_SUMMARY_FALLBACK_MESSAGE =
  MAX_OUTPUT_TRUNCATION_USER_MESSAGE
