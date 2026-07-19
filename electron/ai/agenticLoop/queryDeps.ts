/**
 * `QueryDeps` — dependency-injection container for the agentic loop.
 *
 * upstream parity (with deliberate divergence — see below). The loop has
 * historically reached directly into module singletons for external
 * effects — calling the model, allocating ids, reading the wall clock —
 * which makes the body untestable in isolation (every test has to mock
 * the singleton). Passing these dependencies in explicitly means:
 *
 *   1. Tests can substitute fakes (`fakeCallModel`, `uuid: () => 'fixed'`).
 *   2. Type checking flags missing deps at the call site rather than at
 *      runtime when a singleton is unexpectedly not yet initialised.
 *   3. The set of "external effects" the loop performs is enumerable at
 *      a single point.
 *
 * ## Members
 *
 *   - `callModel`           — invoke the streaming HTTP client.
 *   - `now`                 — clock (overridable for deterministic tests).
 *   - `signal`              — outer cancellation. Lives here NOT on
 *                             `QueryConfig` because its `aborted` state
 *                             changes mid-run — it isn't a stable config.
 *
 * ## Why no `microcompact` / `autocompact` slot (upstream divergence)
 *
 * upstream's `src/query/deps.ts` exposes `microcompact` / `autocompact`
 * because upstream's query loop calls them **directly**. Our architecture
 * is different: the agentic loop only ever calls
 * `ContextManager.handleContext(...)` and `reactiveCompactAfterApiError(...)`
 * — both **wrappers** around the raw `microCompact` / `autoCompact`
 * functions in `electron/context/compact.ts`. The loop neither knows nor
 * cares that compaction exists as a primitive.
 *
 * Putting microcompact/autocompact slots on `QueryDeps` would therefore
 * mean threading a loop-owned DI container into a context-layer module
 * just so the context layer could read its tools back out — backwards.
 * If a future refactor needs compaction injection, the right home is
 * `ContextManager`'s own constructor, not this file.
 *
 * Removed in the §A3 cleanup pass to avoid the audit Finding 8 (A)
 * trap (slots with no consumer = dead scaffolding masquerading as
 * "future migration").
 *
 * ## Status (honest assessment — see audit-report Findings 4 / 7)
 *
 *   - **callModel** — ✅ **WIRED**. `setup.ts` builds `state.queryDeps`
 *     with `streamText` as the default `callModel`, and `stream.ts`
 *     reads `state.queryDeps.callModel(...)` instead of importing
 *     `streamText` directly. Tests can override via
 *     {@link defaultQueryDeps} at state-init time without spinning a
 *     module-level `vi.mock`.
 *   - **now** — ✅ **WIRED on both sides of the read/write boundary**:
 *       · Read side: `preModel.ts#applyIdleToolClear` (idle-tool-clear
 *         decision gate).
 *       · Write side: `stream.ts` writes to `localStreamEndMs` at three
 *         points (init, `onMessageEnd`, `onError`); the value flows
 *         into `state.lastStreamEndMs` which the read side compares
 *         against next iteration.
 *     Deterministic-clock tests can therefore pin `queryDeps.now` and
 *     get consistent timestamps across iterations.
 *   - **signal** — passthrough of the loop's outer abort signal.
 *
 * Note: `setup.ts:lastStreamEndMs` still initialises from bare
 * `Date.now()` rather than `queryDeps.now()`. The two are mechanically
 * equivalent today (no override path reaches `defaultQueryDeps.now`
 * from `AgenticLoopParams`), so the bare call is correct but not
 * future-proof; the audit's Finding 7 notes this as a partial seam.
 */

import type { streamText } from '../client'

/**
 * Provider streaming call. Pinned to {@link streamText}'s real signature
 * so the DI seam is type-safe — fakes / spies in tests must respect the
 * same `(config, params, callbacks, signal)` arity that production uses.
 *
 * Wired since the §A3 (callModel slot) integration — production code
 * (`stream.ts`) reads `state.queryDeps.callModel(...)` instead of the
 * bare `streamText` import. Test code can substitute a fake at
 * {@link initialiseLoopState} time without spinning a full HTTP mock.
 */
export type CallModelFn = typeof streamText

export interface QueryDeps {
  /**
   * Provider streaming call. Real implementation: `streamText` from
   * `electron/ai/client.ts`. Replaceable via {@link defaultQueryDeps}
   * for tests.
   */
  readonly callModel: CallModelFn
  /** Clock. Default: `() => Date.now()`. */
  readonly now: () => number
  /** Outer abort signal. */
  readonly signal: AbortSignal
}

export interface DefaultQueryDepsInput {
  callModel: CallModelFn
  signal: AbortSignal
  /** Optional override (test seam). Defaults to `Date.now`. */
  now?: () => number
}

/**
 * Build a `QueryDeps` from production wiring. Test code should construct
 * a literal `QueryDeps` object directly with fakes — the helper isn't
 * required for tests.
 */
export function defaultQueryDeps(input: DefaultQueryDepsInput): QueryDeps {
  return {
    callModel: input.callModel,
    now: input.now ?? (() => Date.now()),
    signal: input.signal,
  }
}
