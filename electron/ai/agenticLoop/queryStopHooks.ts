/**
 * `QueryStopHooks` — orderly, configurable post-turn side-effect pipeline.
 *
 * upstream parity: `src/query/stopHooks.ts`. The agentic loop terminates
 * through many paths (`completed`, `aborted_streaming`, `aborted_tools`,
 * `prompt_too_long`, `max_turns`, …). Several side effects need to fire
 * **once** when the loop exits, in a defined order:
 *
 *   1. Save the {@link CacheSafeParams} snapshot (main thread only) —
 *      done by the hook installed in `installCacheSafeParamsSnapshotHook`.
 *   2. Session-memory extraction (if signals say so).
 *   3. Auto-dream / proactive idle agent kickoff.
 *   4. Computer-use teardown (when the run was CU-driven).
 *   5. UI prompt suggestion (renderer-only).
 *
 * Today these live in a mix of `agenticLoop.ts`, `queryTermination.ts`'s
 * cleanup callback list, and ad-hoc IPC dispatches. The cleanup-callback
 * registry already gives us the right primitive — but it lacks **ordering
 * guarantees** between callbacks and lacks the **async generator** shape
 * upstream uses to let UI consumers observe each hook's emission.
 *
 * This module is the contract layer for the planned migration:
 *
 *   - {@link QueryStopHook} is the shape a hook implements (name +
 *     priority + async function).
 *   - {@link registerQueryStopHook} mirrors `registerTerminationCleanup`
 *     but tracks a priority used to deterministically order execution.
 *   - {@link runQueryStopHooks} drains the registered hooks in priority
 *     order on a given termination result.
 *
 * The existing `registerTerminationCleanup` / `runTerminationCleanup`
 * pipeline is unchanged so consumers that need the old surface keep
 * working. A future PR can migrate them onto this priority-aware
 * variant; today the new surface ships in parallel.
 */

import type { QueryTerminalResult } from '../queryTermination'

export interface QueryStopHook {
  /** Human-readable hook identifier (telemetry / debugging). */
  readonly name: string
  /**
   * Lower = runs first. upstream runs snapshot before session-memory before
   * dream, matching the "preserve state → extract → schedule next" order.
   * Suggested ranges:
   *   - 0–99    snapshot / state capture
   *   - 100–199 memory / persistence
   *   - 200–299 proactive agents (dream / cron)
   *   - 300+    UI surface (renderer toast, suggestion)
   */
  readonly priority: number
  /** Fired with the termination result; may be async. Errors are isolated. */
  readonly run: (result: QueryTerminalResult) => void | Promise<void>
}

const hooks: QueryStopHook[] = []

/**
 * Register a hook. Returns an `unregister` function so the caller can
 * detach during teardown / test cleanup.
 *
 * Hooks are sorted by priority on registration. Ties are resolved by
 * insertion order (registration earlier wins). Sorting on registration
 * (vs on `runQueryStopHooks` call) is cheap given hooks are typically
 * O(10) and registered at module load, and it lets `runQueryStopHooks`
 * stay a simple drain.
 */
export function registerQueryStopHook(hook: QueryStopHook): () => void {
  hooks.push(hook)
  hooks.sort((a, b) => a.priority - b.priority)
  return () => {
    const i = hooks.indexOf(hook)
    if (i >= 0) hooks.splice(i, 1)
  }
}

/**
 * Snapshot the currently-registered hooks for inspection (tests).
 * Read-only view; mutating the returned array does not affect storage.
 */
export function listQueryStopHooks(): ReadonlyArray<QueryStopHook> {
  return [...hooks]
}

/**
 * Async generator: yields the name of each hook AFTER it executes. UI /
 * telemetry consumers can `for await` on it to surface "running session
 * memory extract…" → "scheduling dream…" status updates.
 *
 * Errors thrown by a hook are caught and logged (matching
 * `runTerminationCleanup` semantics) so a misbehaving hook can never
 * abort the rest of the pipeline. The generator yields the failed
 * hook's name with an `error` field so observers can react if needed.
 */
export async function* runQueryStopHooks(
  result: QueryTerminalResult,
): AsyncGenerator<{ name: string; ok: boolean; error?: unknown }> {
  // Iterate on a snapshot — a hook that registers another hook mid-run
  // must not influence the current drain (matches upstream's invariant).
  const snapshot = [...hooks]
  for (const hook of snapshot) {
    try {
      await hook.run(result)
      yield { name: hook.name, ok: true }
    } catch (err) {
      console.warn(`[QueryStopHooks] ${hook.name} failed:`, err)
      yield { name: hook.name, ok: false, error: err }
    }
  }
}

/** Test-only: wipe every registered hook so tests don't bleed into one another. */
export function __resetQueryStopHooksForTests(): void {
  hooks.length = 0
}
