/**
 * Audit SA-6 (P1) — per-iteration model-call budget.
 *
 * Why: a single stream-phase iteration can launch model calls from several
 * stacked retry/recovery layers — the initial pass, anthropic overload →
 * fallback-model rounds (`MAX_OVERLOAD_FALLBACK_ATTEMPTS`), max-output
 * recovery cycles (`MAX_OUTPUT_TOKENS_RECOVERY_ATTEMPTS`), drain-only
 * context recovery, reactive compact retry, and image strip-retry. Each
 * layer is individually bounded, but their WORST-CASE product had no
 * global ceiling, so a pathological provider could burn through
 * `3 × 3 × …` requests inside one iteration. This module adds a single
 * total-budget gate consulted before EVERY loop-level model call.
 *
 * Boundary (intentional): the budget counts only calls launched by
 * `stream.ts`'s `runStreamWithRetry` (i.e. each `streamPass` entry). The
 * provider layer's inner HTTP retries (`withRetry` /
 * `streamWithMidStreamRetry`) happen INSIDE one counted call and are NOT
 * individually counted — they have their own caps and re-counting them
 * here would double-charge a single logical attempt. The budget is a
 * final backstop over the loop-level multiplication, not a replacement
 * for any layer's own limit.
 */

export const DEFAULT_MAX_MODEL_CALL_ATTEMPTS_PER_ITERATION = 10

/** Env override knob; parse failures fall back to the default. */
export const MODEL_CALL_BUDGET_ENV_VAR = 'POLE_MAX_MODEL_ATTEMPTS_PER_ITERATION'

/**
 * Resolve the per-iteration budget. Accepts any integer ≥ 1 from the env
 * var; anything unparsable / non-finite / < 1 silently falls back to the
 * default (a budget of 0 would deadlock the very first pass).
 */
export function resolveMaxModelCallAttemptsPerIteration(
  envValue: string | undefined = process.env[MODEL_CALL_BUDGET_ENV_VAR],
): number {
  if (typeof envValue === 'string' && envValue.trim() !== '') {
    const parsed = Number.parseInt(envValue.trim(), 10)
    if (Number.isFinite(parsed) && parsed >= 1) return parsed
  }
  return DEFAULT_MAX_MODEL_CALL_ATTEMPTS_PER_ITERATION
}

export interface ModelCallBudget {
  readonly maxAttempts: number
  /** Attempts consumed so far. */
  readonly used: number
  /** True once a consume was refused; sticky for the iteration. */
  readonly exhausted: boolean
  /** Attempts per entry label (e.g. `initial` / `overload_fallback` / …). */
  readonly breakdown: Readonly<Record<string, number>>
  /**
   * Consume one attempt under `entryLabel`. Returns `false` (and marks the
   * budget exhausted) when the budget is already spent — the caller must
   * NOT launch a new model call in that case.
   */
  tryConsume(entryLabel: string): boolean
  /** Human-readable attempt distribution for error details / telemetry. */
  describeBreakdown(): string
}

export function createModelCallBudget(maxAttempts: number): ModelCallBudget {
  let used = 0
  let exhausted = false
  const breakdown: Record<string, number> = {}
  return {
    get maxAttempts() {
      return maxAttempts
    },
    get used() {
      return used
    },
    get exhausted() {
      return exhausted
    },
    get breakdown() {
      return breakdown
    },
    tryConsume(entryLabel: string): boolean {
      if (used >= maxAttempts) {
        exhausted = true
        return false
      }
      used++
      breakdown[entryLabel] = (breakdown[entryLabel] ?? 0) + 1
      return true
    },
    describeBreakdown(): string {
      const parts = Object.entries(breakdown).map(([k, v]) => `${k}=${v}`)
      return parts.length > 0 ? parts.join(', ') : 'none'
    },
  }
}
