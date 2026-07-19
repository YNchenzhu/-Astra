/**
 * Phase telemetry helpers extracted from {@link OrchestrationKernel}.
 *
 * Owns: `orchestration_phase` event emission for FSM transitions, inner-iteration
 * counter management, and the AppendixA reporter wrapper that auto-mirrors the
 * kernel's outer/inner counters into every stage event.
 */

import { emitPhaseEvent } from './transport'
import type { KernelLoopState, KernelTurnPhase } from './kernelTypes'
import type { AppendixAFlowReporter, AppendixARuntimeStageId } from './appendixAFlow'
import type { KernelSlice } from './kernelInternals'

/**
 * Emit a phase event for the current kernel state. The phase tag is stringly
 * typed so callers can also send lifecycle/admin tags (`interrupt`, `paused`,
 * `rewound`, `artifact_manifest`, `permission_denied_preflight`) — the renderer
 * subscribes to all of them via the same `orchestration_phase` channel.
 */
export function emitPhase(slice: KernelSlice, phase: KernelTurnPhase | string): void {
  const state = slice.state.get()
  emitPhaseEvent(slice.ports.transport, {
    phase,
    iteration: state.iteration,
    innerIteration: state.innerIteration,
    ...(slice.streamConversationId?.trim()
      ? { conversationId: slice.streamConversationId.trim() }
      : {}),
  })
}

/** Increment the inner counter and return the new value. */
export function bumpInnerIteration(slice: KernelSlice): number {
  const state = slice.state.get()
  const next = state.innerIteration + 1
  slice.state.set({ ...state, innerIteration: next })
  return next
}

/** Reset the inner counter at the start of a new outer turn. */
export function resetInnerIteration(slice: KernelSlice): void {
  const state = slice.state.get()
  slice.state.set({ ...state, innerIteration: 0 })
}

/**
 * Wrap an AppendixA reporter so every stage it emits carries the
 * kernel's outer/inner turn counters. Also mirrors the agentic loop's
 * `P2_Q_iteration_open` stage into the kernel's inner counter so renderer
 * timeline + AppendixA telemetry stay in lockstep.
 *
 * Returns `undefined` when no inner reporter was supplied — callers thread
 * the result back through `agenticParams.appendixAFlow` only when present.
 */
export function wrapAppendixAReporterWithIterationTracking(
  slice: KernelSlice,
  inner: AppendixAFlowReporter | undefined,
): AppendixAFlowReporter | undefined {
  if (!inner) return undefined
  return {
    report: (stage: AppendixARuntimeStageId, detail?: Record<string, unknown>): void => {
      if (stage === 'P2_Q_iteration_open') {
        const detailIter =
          detail && typeof (detail as { iteration?: unknown }).iteration === 'number'
            ? ((detail as { iteration: number }).iteration)
            : null
        if (detailIter !== null) {
          const state = slice.state.get()
          slice.state.set({ ...state, innerIteration: detailIter })
        } else {
          bumpInnerIteration(slice)
        }
      }
      try {
        const state = slice.state.get()
        inner.report(stage, {
          ...(detail ?? {}),
          outerIteration: state.iteration,
          innerIteration: state.innerIteration,
        })
      } catch {
        /* ignore reporter failures */
      }
    },
  }
}

/** Helper for kernel methods that need to set `state.phase` and immediately emit it. */
export function transitionPhase(slice: KernelSlice, phase: KernelLoopState['phase']): void {
  const state = slice.state.get()
  slice.state.set({ ...state, phase })
  emitPhase(slice, phase)
}
