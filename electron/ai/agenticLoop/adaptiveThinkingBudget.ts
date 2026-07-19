/**
 * Adaptive thinking budget — per-iteration throttle for the extended-
 * thinking token budget (2026-07 deep-loop uplift, item #14).
 *
 * ## Why
 *
 * The thinking budget used to be a SESSION constant (renderer override >
 * disk setting > alwaysThinking cap — see `mainSessionThinkingBudget.ts`),
 * resolved once at SendMessage and passed unchanged into every stream
 * request of the run. That wastes budget in exactly the wrong places: a
 * routine read→edit→read pipeline iteration burns the same thinking
 * allowance as the first planning pass, while compat gateways with no
 * explicit budget fall back to `min(maxTokens*4, 32768)` on EVERY
 * iteration (see `compatibleClient.ts`).
 *
 * ## Shape: throttle, never boost
 *
 * The adaptive layer NEVER exceeds the caller's base budget — the user's
 * explicit setting stays the ceiling, so this is pure savings with no
 * surprise cost increase. Phases:
 *
 *   - **Full budget** (base unchanged) when deep reasoning is likely
 *     needed:
 *       - the FIRST iteration of a turn (planning / task decomposition);
 *       - the iteration right after a tool batch that was ENTIRELY
 *         errors (`state.lastToolBatchAllErrors` — the model must reason
 *         about what went wrong, not pattern-match another attempt).
 *   - **Routine throttle** from iteration {@link ROUTINE_MIN_ITERATION}
 *     onward with no full-budget signal: `base × routineFactor` (default
 *     0.75), floored at {@link MIN_ADAPTIVE_THINKING_TOKENS} (1024 — the
 *     Anthropic minimum). When the session has NO explicit base budget
 *     (alwaysThinking with provider-side fallback), the throttle supplies
 *     {@link DEFAULT_ROUTINE_TOKENS_WITHOUT_BASE} instead of letting the
 *     provider fall back to the 32k ceiling.
 *   - Everything else (iteration 2, or adaptive disabled, or thinking
 *     off) → base unchanged.
 *
 * Consumers: the per-request `thinkingBudgetTokens` param assembled in
 * `agenticLoop/stream.ts`. The official Anthropic SDK path computes its
 * own per-model cap in `anthropicExtendedThinking.ts` and ignores this
 * param — unaffected by design.
 *
 * Operator tuning:
 *   - `POLE_ADAPTIVE_THINKING=0`                     disable (legacy constant budget)
 *   - `POLE_ADAPTIVE_THINKING_ROUTINE_FACTOR`        default 0.75
 *   - `POLE_ADAPTIVE_THINKING_ROUTINE_MIN_ITERATION` default 3
 *   - `POLE_ADAPTIVE_THINKING_ROUTINE_TOKENS`        default 4096 (no-base sessions)
 */

/** Anthropic-documented minimum `budget_tokens` (parity with
 *  `anthropicExtendedThinking.MIN_THINKING_BUDGET`). */
export const MIN_ADAPTIVE_THINKING_TOKENS = 1024

/** Routine throttle for sessions with no explicit base budget. Chosen so
 *  a compat gateway stops falling back to `min(maxTokens*4, 32768)` on
 *  routine iterations while still leaving usable reasoning room.
 *  2026-07 quality uplift: raised 2048 → 4096 — mid-task iterations are
 *  where implementation/verification reasoning happens, and 2048 measurably
 *  starved it (shallow edits, rubber-stamp verification). */
export const DEFAULT_ROUTINE_TOKENS_WITHOUT_BASE = 4096

/** First iteration at which the routine throttle may kick in. Iterations
 *  1..(N-1) always keep the full budget. */
export const DEFAULT_ROUTINE_MIN_ITERATION = 3

/** 2026-07 quality uplift: 0.5 → 0.75. Halving the budget mid-run cut too
 *  deep into implementation/verification reasoning; 0.75 keeps most of the
 *  savings on trivial iterations without flattening deliberation. */
const DEFAULT_ROUTINE_FACTOR = 0.75

export function isAdaptiveThinkingEnabled(): boolean {
  const raw = process.env.POLE_ADAPTIVE_THINKING?.trim().toLowerCase()
  return !(raw === '0' || raw === 'false' || raw === 'no' || raw === 'off')
}

function parseFactorEnv(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback
  const n = Number.parseFloat(raw)
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : fallback
}

function parsePositiveIntEnv(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export interface AdaptiveThinkingSignals {
  /** Inner-loop iteration, 1-based (`state.iteration`). */
  iteration: number
  /** Extended thinking requested for this session (`state.alwaysThinking`). */
  alwaysThinking: boolean
  /** Session-level resolved budget (agent context), or undefined when the
   *  provider-side fallback would apply. */
  baseBudgetTokens: number | undefined
  /** The PREVIOUS tool batch was entirely errors — reasoning-heavy moment. */
  lastToolBatchAllErrors: boolean
  /**
   * P2-2 audit fix (2026-07) — anti-oscillation latch. Once ANY all-errors
   * tool batch has occurred in this run, the caller sets this and the
   * throttle stays permanently off for the remainder of the run.
   *
   * Why: Anthropic invalidates the message-level prompt cache when the
   * `thinking.budget_tokens` value changes between requests. Without the
   * latch, a "throttled → all-errors full → throttled → …" sequence flips
   * the budget back and forth, paying a full cache miss on every flip. With
   * the latch the budget changes AT MOST ONCE per run (the designed
   * full→routine downshift at {@link DEFAULT_ROUTINE_MIN_ITERATION}), and a
   * failure-bearing run simply keeps the full budget — which is also the
   * safer reasoning posture for a run that is already hitting errors.
   */
  latchedFullBudget?: boolean
}

/**
 * Resolve the effective per-request thinking budget. Pure. Returns the
 * base unchanged whenever adaptation does not apply, so callers can pass
 * the result straight through.
 */
export function resolveAdaptiveThinkingBudget(
  signals: AdaptiveThinkingSignals,
): number | undefined {
  const base = signals.baseBudgetTokens
  if (!signals.alwaysThinking) return base
  if (!isAdaptiveThinkingEnabled()) return base

  // Full-budget signals — deep reasoning likely needed right now.
  if (signals.iteration <= 1) return base
  if (signals.lastToolBatchAllErrors) return base
  // P2-2 — once a failure forced the budget back to full, stay there for
  // the rest of the run so budget_tokens doesn't oscillate (each flip is
  // an Anthropic message-cache invalidation). See the field docstring.
  if (signals.latchedFullBudget) return base

  const routineMinIteration = parsePositiveIntEnv(
    process.env.POLE_ADAPTIVE_THINKING_ROUTINE_MIN_ITERATION,
    DEFAULT_ROUTINE_MIN_ITERATION,
  )
  if (signals.iteration < routineMinIteration) return base

  // Routine phase — throttle.
  if (base === undefined) {
    return parsePositiveIntEnv(
      process.env.POLE_ADAPTIVE_THINKING_ROUTINE_TOKENS,
      DEFAULT_ROUTINE_TOKENS_WITHOUT_BASE,
    )
  }
  const factor = parseFactorEnv(
    process.env.POLE_ADAPTIVE_THINKING_ROUTINE_FACTOR,
    DEFAULT_ROUTINE_FACTOR,
  )
  return Math.max(MIN_ADAPTIVE_THINKING_TOKENS, Math.floor(base * factor))
}
