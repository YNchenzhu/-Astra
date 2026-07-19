/**
 * `QueryConfig` — immutable per-invocation snapshot of values the agentic
 * loop needs but must never let change mid-run.
 *
 * upstream parity: `src/query/config.ts`. Pulling these into a frozen
 * object up-front means the pure transition / stop-hook helpers can
 * accept a `QueryConfig` argument instead of reaching into module-level
 * state (env, ALS) every time they need a feature flag. That clean
 * boundary is what lets the rest of the query loop look like a state
 * machine.
 *
 * ## What belongs here
 *
 *   - Stable session identity (sessionId, queryChainId, conversation id)
 *   - Runtime feature flags captured once at entry (`POLE_FORK_CACHE_TIGHT`,
 *     coordinator mode toggle, prompt-cache write skip, etc.)
 *   - Sub-agent depth + parent agent id (frozen at spawn)
 *   - Model + provider config snapshot (so a mid-flight settings change
 *     doesn't switch providers between turns)
 *
 * ## What does NOT belong here
 *
 *   - The live `messages` array (mutates every turn — see `QueryDeps`).
 *   - `AbortSignal` (its `aborted` state changes; pass through `QueryDeps`).
 *   - The current iteration count (mutable loop state).
 *
 * ## Migration plan
 *
 * The 1559-line `agenticLoop.ts` currently reaches into ALS, env, and
 * settings repeatedly. The intended migration is:
 *
 *   1. At the top of `runAgenticLoop`, build a `QueryConfig` once
 *      (`freezeQueryConfig({ ... })`).
 *   2. Pass it through to the phase modules (setup / preModel / stream /
 *      noTools / toolExec) as a new argument.
 *   3. Phase modules read feature flags from the config instead of env.
 *   4. Tests can construct a `QueryConfig` directly and exercise the
 *      pure helpers without spinning a full loop.
 *
 * This file ships the contract today; phase modules adopt incrementally.
 */

import type { AgentId } from '../../tools/ids'

export interface QueryConfig {
  /** Sub-agent / main thread identifier. */
  readonly agentId: AgentId
  /** Stable id for this query chain (one per top-level send / fork). */
  readonly queryChainId?: string
  /** Renderer chat session id for parallel main streams. */
  readonly streamConversationId?: string
  /** Effective model id post alias resolution. */
  readonly model: string
  /** Provider config name (provider lookup key). */
  readonly providerConfigName?: string

  /** REPL/agent nesting depth at spawn time. */
  readonly replDepth: number
  /** Parent agent id; `undefined` for the main thread. */
  readonly parentAgentId?: string

  // ── Feature flags captured at invocation time ──
  //
  // P3-1 (2026-07 核心层做深) — `coordinatorMode` and `skipPromptCacheWrite`
  // REMOVED from this snapshot: both were hardcoded placeholders with zero
  // production readers (grep-verified). `skipPromptCacheWrite` remains a
  // live mechanism on `AgentContext` (anthropic.ts reads the ALS value);
  // re-add a snapshot field here only together with the read-site
  // migration that consumes it.
  readonly forkCacheStrategy: 'legacy' | 'tight'
  /**
   * `POLE_BLOCKING_LIMIT_HARD` snapshot — when true the loop treats the
   * blocking-context threshold as a hard termination instead of an
   * opportunistic soft warning. Reading this once at loop start (rather
   * than re-reading env every iteration) keeps the behaviour stable
   * across the entire run; a settings flip mid-conversation does not
   * abort the in-flight turn.
   *
   * Production consumer: `agenticLoop.ts` blocking-limit gate (the
   * single check that decides between `blocking_limit` termination
   * vs. continue-with-warning). Wired since 5-piece-set §A2.
   */
  readonly blockingLimitHard: boolean
  /** Effective wall-clock budget (ms) for nested sub-agents (§7.5). */
  readonly taskBudgetMs?: number
  /**
   * Thinking token budget forwarded to extended-thinking payloads.
   * Production consumer: `agenticLoop/stream.ts` uses this as the
   * adaptive-thinking base budget (P3 audit fix 2026-07). Captured from
   * `AgentContext.thinkingBudgetTokens` at loop init — the ALS value is
   * only written at context construction, so the snapshot never drifts.
   */
  readonly thinkingBudgetTokens?: number
}

/**
 * Construct + freeze a `QueryConfig`. Caller passes the live values; the
 * returned object is a structural copy that cannot be mutated.
 *
 * `Object.freeze` is shallow but every field on `QueryConfig` is a
 * primitive, so that's enough. If new nested fields are added, audit
 * whether they need their own freeze.
 */
export function freezeQueryConfig(input: QueryConfig): Readonly<QueryConfig> {
  return Object.freeze({ ...input }) as Readonly<QueryConfig>
}
