/**
 * Loop-driver boundary chores — P1-1 (2026-07 核心层做深).
 *
 * TWO drivers own a `while (state.iteration < state.maxIterations)` over
 * the same iteration primitive:
 *
 *   - `runAgenticLoop` (phases/iteration.ts) — legacy / sub-agent /
 *     teammate / skill-fork path;
 *   - `driveInnerLoop` (phases/driveInnerLoop.ts) — kernel drive mode,
 *     with pause/abort/snapshot/invariant extras at each boundary.
 *
 * The per-boundary chores (iteration increment, profiler bookkeeping,
 * periodic spilled-tool-result janitor) used to be COPIED between the two
 * whiles, and drifted once already: the janitor originally existed only
 * on the legacy path, so the production main-chat (drive mode since F1)
 * ran long sessions with no cleanup until a 2026-06 audit re-copied it.
 * This module is the single home for those chores; each driver calls
 * {@link advanceIterationBoundary} once per boundary and keeps only its
 * OWN semantics (pause gate / snapshot / invariant) inline.
 *
 * Kept separate from `iteration.ts` on purpose: drive-mode tests
 * `vi.mock('../iteration')` to stub the primitives — chores living there
 * would be swallowed by the mock, while a dedicated module keeps them
 * real (and independently testable).
 */

import { cleanupOldToolResults } from '../../ai/toolResultBudget'
import { setImmediateBound } from '../../agents/agentContextBind'
import type { LoopState } from '../../ai/agenticLoop/loopShared'

/**
 * Cadence of the fire-and-forget spilled-tool-result janitor. Spilled
 * files accumulate during long sessions; every N inner iterations we
 * schedule a best-effort cleanup that never blocks the loop.
 */
export const TOOL_RESULT_JANITOR_EVERY_N_ITERATIONS = 50

/**
 * Advance one iteration boundary: increment the counter, point the
 * profiler at it, and (every {@link TOOL_RESULT_JANITOR_EVERY_N_ITERATIONS}
 * iterations) schedule the janitor.
 *
 * The janitor callback runs via `setImmediateBound` so it restores this
 * iteration's AgentContext / ALS chain (audit P3 — defensive shield for
 * future modifications that read ambient context).
 */
export function advanceIterationBoundary(
  state: Pick<LoopState, 'iteration' | 'profiler'>,
): void {
  state.iteration++
  state.profiler.setIteration(state.iteration)
  if (state.iteration % TOOL_RESULT_JANITOR_EVERY_N_ITERATIONS === 0) {
    setImmediateBound(() => {
      try {
        cleanupOldToolResults()
      } catch {
        /* best-effort */
      }
    })
  }
}
