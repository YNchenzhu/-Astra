/**
 * upstream report Phase 2 Step 20E — TOKEN_BUDGET feature flag system.
 *
 * When TOKEN_BUDGET is enabled, the query loop checks after each no-tool-use stop
 * whether the token budget has been sufficiently consumed. If < 90% used AND returns
 * are not diminishing, it injects a reminder message and continues.
 *
 * Diminishing returns detection (upstream `src/query/tokenBudget.ts` L59-63 parity):
 * - Already continued >= 3 times after no-tool-use
 * - The two most recent deltas (`lastDeltaTokens` AND the delta before it)
 *   are BOTH < `minDeltaForProgress`
 *
 * P0.1 (2026-05) — replaced the unbounded `outputDeltas: number[]` with two
 * scalar slots (`lastDeltaTokens` + `prevDeltaTokens`) to match upstream's
 * `BudgetTracker` shape exactly. The previous array would grow without bound
 * across long sessions, and the slice(-2) check semantics depended on every
 * call-site invoking record() exactly once per turn (otherwise stale 0-deltas
 * could pollute the window). The scalar version is invariant under repeated
 * record() calls — only the two most recent deltas are ever consulted.
 */

export interface TokenBudgetConfig {
  /** Total budget in output tokens for this session. */
  totalBudget: number
  /** Percentage threshold to trigger continuation (0-1). Default: 0.9 */
  consumptionThreshold?: number
  /** Min output delta to not count as diminishing. Default: 500 */
  minDeltaForProgress?: number
  /** Max continuations before stopping regardless. Default: 10 */
  maxContinuations?: number
  /** Min continuations before diminishing returns can trigger. Default: 3 */
  minContinuationsForDiminishing?: number
}

/** Sentinel meaning "never recorded". -1 cannot collide with a real token count. */
const NEVER_RECORDED = -1

export interface TokenBudgetState {
  totalBudget: number
  usedOutputTokens: number
  continuationCount: number
  /**
   * Most recently recorded delta (upstream `BudgetTracker.lastDeltaTokens`
   * equivalent). {@link NEVER_RECORDED} until the first `recordOutputTokens`
   * call. Read by the diminishing-returns check together with
   * {@link prevDeltaTokens}.
   */
  lastDeltaTokens: number
  /**
   * The delta recorded BEFORE {@link lastDeltaTokens}.
   * {@link NEVER_RECORDED} until two records have happened. Diminishing
   * returns requires BOTH of these to be below the threshold — a single
   * isolated short turn never trips it on its own.
   */
  prevDeltaTokens: number
  lastDecision: 'continue' | 'stop' | null
  config: Required<TokenBudgetConfig>
}

export type TokenBudgetCheckResult =
  | { action: 'continue'; reason: string; reminderMessage: string }
  | { action: 'stop'; reason: string }

const DEFAULT_CONSUMPTION_THRESHOLD = 0.9
const DEFAULT_MIN_DELTA = 500
const DEFAULT_MAX_CONTINUATIONS = 10
const DEFAULT_MIN_CONTINUATIONS_FOR_DIMINISHING = 3

export function createTokenBudgetState(config: TokenBudgetConfig): TokenBudgetState {
  return {
    totalBudget: config.totalBudget,
    usedOutputTokens: 0,
    continuationCount: 0,
    lastDeltaTokens: NEVER_RECORDED,
    prevDeltaTokens: NEVER_RECORDED,
    lastDecision: null,
    config: {
      totalBudget: config.totalBudget,
      consumptionThreshold: config.consumptionThreshold ?? DEFAULT_CONSUMPTION_THRESHOLD,
      minDeltaForProgress: config.minDeltaForProgress ?? DEFAULT_MIN_DELTA,
      maxContinuations: config.maxContinuations ?? DEFAULT_MAX_CONTINUATIONS,
      minContinuationsForDiminishing:
        config.minContinuationsForDiminishing ?? DEFAULT_MIN_CONTINUATIONS_FOR_DIMINISHING,
    },
  }
}

/**
 * Record output tokens from the latest model response.
 *
 * Rolls the scalar window: the old `lastDeltaTokens` becomes `prevDeltaTokens`,
 * and the new value moves into `lastDeltaTokens`. This is the upstream
 * `BudgetTracker` two-scalar window directly.
 */
export function recordOutputTokens(state: TokenBudgetState, outputTokens: number): void {
  state.prevDeltaTokens = state.lastDeltaTokens
  state.lastDeltaTokens = outputTokens
  state.usedOutputTokens += outputTokens
}

/**
 * Check whether the token budget allows continuation or should stop.
 *
 * Decision tree (upstream `src/query/tokenBudget.ts#checkTokenBudget` parity):
 * - IF >= consumptionThreshold of budget used → stop ("consumed")
 * - IF >= maxContinuations reached → stop ("max continuations")
 * - IF continuationCount >= minContinuationsForDiminishing
 *      AND prevDeltaTokens < minDeltaForProgress
 *      AND lastDeltaTokens < minDeltaForProgress → stop ("diminishing")
 * - ELSE → continue with reminder
 */
export function checkTokenBudget(state: TokenBudgetState): TokenBudgetCheckResult {
  const { config } = state
  const usageRatio = state.usedOutputTokens / config.totalBudget

  // Budget fully consumed
  if (usageRatio >= config.consumptionThreshold) {
    state.lastDecision = 'stop'
    return {
      action: 'stop',
      reason: `Token budget ${Math.round(usageRatio * 100)}% consumed (threshold: ${Math.round(config.consumptionThreshold * 100)}%)`,
    }
  }

  // Max continuations reached
  if (state.continuationCount >= config.maxContinuations) {
    state.lastDecision = 'stop'
    return {
      action: 'stop',
      reason: `Max token budget continuations reached (${config.maxContinuations})`,
    }
  }

  // Diminishing returns (upstream parity): need BOTH the most recent delta AND
  // the one before it to be below the progress threshold. A single isolated
  // short turn never trips this on its own — it must be a sustained pattern.
  if (state.continuationCount >= config.minContinuationsForDiminishing) {
    const prev = state.prevDeltaTokens
    const last = state.lastDeltaTokens
    const bothRecorded = prev !== NEVER_RECORDED && last !== NEVER_RECORDED
    if (
      bothRecorded &&
      prev < config.minDeltaForProgress &&
      last < config.minDeltaForProgress
    ) {
      state.lastDecision = 'stop'
      return {
        action: 'stop',
        reason: `Diminishing returns detected: last two continuations produced ${prev}, ${last} tokens (threshold: ${config.minDeltaForProgress})`,
      }
    }
  }

  // Continue: inject reminder
  state.continuationCount++
  state.lastDecision = 'continue'

  const remaining = config.totalBudget - state.usedOutputTokens
  const remainingPercent = Math.round((1 - usageRatio) * 100)

  return {
    action: 'continue',
    reason: `Budget ${Math.round(usageRatio * 100)}% used, ${remainingPercent}% remaining`,
    reminderMessage: `[System: Token budget reminder] You have used ${state.usedOutputTokens.toLocaleString()} of ${config.totalBudget.toLocaleString()} output tokens (${Math.round(usageRatio * 100)}%). ${remaining.toLocaleString()} tokens remaining. Continue working on the task — do not stop prematurely.`,
  }
}

/**
 * Feature flag check: whether TOKEN_BUDGET is enabled.
 */
export function isTokenBudgetEnabled(): boolean {
  const v = process.env.POLE_TOKEN_BUDGET?.trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes'
}

/**
 * Parse a token budget from environment or settings.
 * Returns null if not set or invalid.
 */
export function parseTokenBudgetFromEnv(): number | null {
  const raw = process.env.POLE_TOKEN_BUDGET_LIMIT?.trim()
  if (!raw) return null
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.floor(n)
}

/**
 * Get the effective token budget config from environment.
 * Returns null if the feature is disabled.
 */
export function getTokenBudgetConfigFromEnv(): TokenBudgetConfig | null {
  if (!isTokenBudgetEnabled()) return null
  const budget = parseTokenBudgetFromEnv()
  if (!budget) return null

  const threshold = process.env.POLE_TOKEN_BUDGET_THRESHOLD?.trim()
  const minDelta = process.env.POLE_TOKEN_BUDGET_MIN_DELTA?.trim()

  return {
    totalBudget: budget,
    consumptionThreshold: threshold ? Number(threshold) || DEFAULT_CONSUMPTION_THRESHOLD : undefined,
    minDeltaForProgress: minDelta ? Number(minDelta) || DEFAULT_MIN_DELTA : undefined,
  }
}
