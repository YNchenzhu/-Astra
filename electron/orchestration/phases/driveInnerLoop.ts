/**
 * Drive-mode inner loop — kernel-owned equivalent of `runAgenticLoop`'s internal
 * `while`, with three extra integration points at every iteration boundary:
 *
 *   1. {@link DriveInnerLoopHooks.abortSignal} — aborted → graceful
 *      `aborted_streaming` exit (SA-2 fix 3: the next step would have been a
 *      stream pass, so the boundary abort uses the pre-stream reason — same
 *      as `runAgenticIteration`'s own pre-stream gate; no spurious `onError`).
 *   2. {@link DriveInnerLoopHooks.pauseGate} — paused → await resume before
 *      starting the next iteration. Lets operator UI pause mid-turn without
 *      hard-killing the loop.
 *   3. {@link DriveInnerLoopHooks.snapshot} — auto-snapshot at each iteration
 *      boundary so rewind/fork can land back at the start of any individual
 *      iteration.
 *
 * Kernel callers wrap this as the `runCallModel` override passed to
 * `runLegacyDelegateMainChat`. The outer turn FSM stays in
 * `kernel.runDriveMainChat`; the inner iteration control lives here.
 *
 * # Why this is its own file (not in iteration.ts)
 *
 * `driveInnerLoop` consumes `setupAgenticLoopForRun` / `runAgenticIteration` /
 * `finaliseMaxIterations` from `./iteration`. If it lived in the same file as
 * those functions, same-file function calls would bypass `vi.mock` — drive-mode
 * tests would always hit the real implementations even when stubbing the
 * primitives. Splitting into its own module makes those calls cross a module
 * boundary, so mocks can intercept them.
 */

import { createTerminalResult, runTerminationCleanup } from '../../ai/queryTermination'
import type { AgenticLoopCallbacks, AgenticLoopParams } from '../../ai/agenticLoopTypes'
import { advanceIterationBoundary } from './loopDriverChores'
import type { AgenticLoopResult } from '../../ai/loopEvents'
import { fingerprintTranscript } from '../kernelTypes'
import type { PauseGate } from '../pauseResume'
import {
  finaliseMaxIterations,
  runAgenticIteration,
  setupAgenticLoopForRun,
} from './iteration'

export interface DriveInnerLoopHooks {
  /** Kernel-owned abort signal checked at iteration boundaries. */
  abortSignal: AbortSignal
  /** Cooperative pause gate awaited at iteration boundaries. */
  pauseGate: PauseGate
  /** Auto-snapshot helper called once per iteration (no-op when no checkpoint port). */
  snapshot: (tag: string) => void
  /**
   * 阶段 1 — injected kernel-loop port. Forwarded onto `agenticParams` so the
   * inner iteration's mid-iteration persistence calls the kernel through this
   * explicit contract instead of the global
   * `getOrchestrationKernelForConversation` service-locator. Optional so
   * existing drive-mode callers / tests that don't wire it keep working (the
   * inner loop then skips mid-iteration persistence).
   */
  kernelLoopPort?: AgenticLoopParams['kernelLoopPort']
  /**
   * 阶段 2/3 — outcome capture. Forwarded as the `onTerminate` option to
   * {@link setupAgenticLoopForRun}, so callers that need the typed
   * {@link AgenticLoopResult} (terminationResult + transition) — e.g.
   * orchestrated sub-agents that drive their retry policy off the termination
   * reason — receive it once the run terminates. Main chat omits it (the kernel
   * owns termination differently).
   */
  onTerminate?: (result: AgenticLoopResult) => void
  /**
   * Contract audit (2026-07) — per-iteration transcript invariant tracer.
   * Called once at every iteration boundary with the loop-side transcript
   * length; the kernel implementation compares it against its own transcript
   * and emits a `transcript_drift` phase event on mismatch (a producer
   * skipped `syncConversation`). May THROW in strict mode
   * (`POLE_TRANSCRIPT_INVARIANT_STRICT=1`) — the throw propagates out of the
   * loop like any CallModel failure, turning silent drift into a hard stop.
   */
  assertTranscriptInvariant?: (info: {
    iteration: number
    loopTranscriptLength: number
    loopTranscriptFingerprint: string
  }) => Array<Record<string, unknown>> | undefined
}

export async function driveInnerLoop(
  agenticParams: AgenticLoopParams,
  callbacks: AgenticLoopCallbacks,
  hooks: DriveInnerLoopHooks,
): Promise<void> {
  // Inject the kernel-loop port onto the params the inner iteration reads from
  // `state.kernelLoopPort`. Done here (not by the caller) so every drive-mode
  // run routes mid-iteration persistence through the injected contract.
  const paramsWithPort: AgenticLoopParams = hooks.kernelLoopPort
    ? { ...agenticParams, kernelLoopPort: hooks.kernelLoopPort }
    : agenticParams
  const { state, systemPrompt, fireOnTerminate, finaliseTransitionHistory } =
    setupAgenticLoopForRun(
      paramsWithPort,
      callbacks,
      hooks.onTerminate ? { onTerminate: hooks.onTerminate } : undefined,
    )
  try {
    while (state.iteration < state.maxIterations) {
      // Pre-iteration cooperative pause + abort gate. Two abort checks bracket
      // the pause await so a kernel that's interrupted while awaiting resume
      // also exits cleanly. SA-2 fix 3 — the boundary abort happens BEFORE
      // the next iteration's stream pass, so it reports `aborted_streaming`
      // (matching `runAgenticIteration`'s pre-stream gate), not
      // `aborted_tools`.
      if (hooks.abortSignal.aborted) {
        state.callbacks.onMessageEnd(state.totalUsage)
        state.terminationResult = createTerminalResult('aborted_streaming', {
          turnCount: state.iteration,
          totalUsage: state.totalUsage,
        })
        await runTerminationCleanup(state.terminationResult)
        state.profiler.flush()
        return
      }
      if (hooks.pauseGate.isPaused()) {
        await hooks.pauseGate.awaitResume()
      }
      if (hooks.abortSignal.aborted) {
        state.callbacks.onMessageEnd(state.totalUsage)
        state.terminationResult = createTerminalResult('aborted_streaming', {
          turnCount: state.iteration,
          totalUsage: state.totalUsage,
        })
        await runTerminationCleanup(state.terminationResult)
        state.profiler.flush()
        return
      }

      // Shared boundary chores (P1-1) — increment + profiler + periodic
      // spilled-tool-result janitor, single implementation with the legacy
      // driver (the janitor drifted between the two whiles once before;
      // see loopDriverChores.ts).
      advanceIterationBoundary(state)
      hooks.snapshot(`iteration_${state.iteration}_boundary`)
      // Contract audit (2026-07) — transcript invariant check at the same
      // boundary the snapshot lands on, so a checkpoint taken from drifted
      // state is at least accompanied by a visible diagnostic. Strict mode
      // throws (see hook doc); default restores the kernel-accepted
      // transcript before the next model call. The
      // Array guard skips partial LoopState stubs (tests / worker contexts)
      // that don't carry an apiMessages array.
      if (hooks.assertTranscriptInvariant && Array.isArray(state.apiMessages)) {
        const acceptedTranscript = hooks.assertTranscriptInvariant({
          iteration: state.iteration,
          loopTranscriptLength: state.apiMessages.length,
          loopTranscriptFingerprint: fingerprintTranscript(
            state.apiMessages as Array<Record<string, unknown>>,
          ),
        })
        if (
          acceptedTranscript &&
          typeof state.acceptHostTranscript === 'function'
        ) {
          state.acceptHostTranscript(acceptedTranscript)
        }
      }

      const outcome = await runAgenticIteration(state, agenticParams, systemPrompt)
      if (outcome.kind === 'terminate') {
        state.profiler.flush()
        return
      }
    }
    // Exhausted maxIterations — same finaliser as the legacy path.
    await finaliseMaxIterations(state, systemPrompt)
    state.profiler.flush()
  } finally {
    finaliseTransitionHistory()
    fireOnTerminate()
  }
}
