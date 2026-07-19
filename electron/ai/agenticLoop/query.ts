/**
 * `query/` 5-piece set — the upstream-parity contracts that make the
 * agentic loop a state machine instead of a 1500-line procedural body.
 *
 *   1. `queryConfig.ts`     — immutable per-invocation snapshot.
 *      **WIRED** (§A2): `LoopState.queryConfig` is built by
 *      `initialiseLoopState` and consumed by the blocking-limit gate
 *      in `agenticLoop.ts`. Additional flag-fields migrate
 *      incrementally as phase modules adopt the config snapshot.
 *   2. `queryDeps.ts`       — dependency-injection container.
 *      **WIRED** (§A3): `callModel` references the production
 *      `streamText`; `uuid` / `now` default to `crypto.randomUUID` /
 *      `Date.now`. No `microcompact` / `autocompact` slots — see
 *      `queryDeps.ts` for why our architecture diverges from
 *      upstream's on this point (compaction is a ContextManager
 *      internal, not a loop dependency).
 *   3. `tokenBudget.ts`     — pure state machine (lives at
 *                             `electron/context/tokenBudget.ts`,
 *                             pre-existing; re-exported here for parity).
 *      **WIRED**: consumed by `noTools.ts` continuation logic.
 *   4. `queryStopHooks.ts`  — priority-ordered post-termination hooks.
 *      **WIRED** (§A1): every call to `runTerminationCleanup` drains
 *      this pipeline. `registerTerminationCleanup` is now a thin
 *      compatibility shim that lands callbacks at priority 100;
 *      `cacheSafeParams.installCacheSafeParamsSnapshotHook` registers
 *      directly at priority 10 so state capture beats memory / dream
 *      / UI hooks deterministically.
 *   5. `iterationDecision.ts` — the unified continue/terminate decision
 *      table (17 rows). **WIRED**: consumed by `noTools.ts` +
 *      `orchestration/phases/iteration.ts` on every model turn. (P3-1:
 *      replaced the deleted legacy `queryLoopStepper.ts` in this set.)
 *
 * This file is a façade — no logic of its own. Callers can either import
 * directly from each module, or pull everything via this index when they
 * need more than one piece (`import * as Query from './agenticLoop/query'`).
 */

export {
  freezeQueryConfig,
  type QueryConfig,
} from './queryConfig'

export {
  defaultQueryDeps,
  type CallModelFn,
  type QueryDeps,
  type DefaultQueryDepsInput,
} from './queryDeps'

export {
  registerQueryStopHook,
  listQueryStopHooks,
  runQueryStopHooks,
  __resetQueryStopHooksForTests,
  type QueryStopHook,
} from './queryStopHooks'

// Pre-existing pieces — re-exported so the 5-piece set is one import.
export {
  createTokenBudgetState,
  checkTokenBudget,
  recordOutputTokens,
  isTokenBudgetEnabled,
  parseTokenBudgetFromEnv,
  getTokenBudgetConfigFromEnv,
  type TokenBudgetConfig,
  type TokenBudgetState,
  type TokenBudgetCheckResult,
} from '../../context/tokenBudget'

// P3-1 (2026-07 核心层做深) — the legacy `queryLoopStepper` re-export was
// removed together with the module itself: `deriveQueryLoopContinuationDecision`
// had zero production consumers (grep-verified; P1 2026-05 absorbed its four
// decision points into the unified table below).

// P1 — primary unified decision surface.
export {
  decideIterationOutcome,
  type IterationOutcome,
  type IterationDecisionSignals,
} from './iterationDecision'
