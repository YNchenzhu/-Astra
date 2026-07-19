/**
 * Narrow view of the OrchestrationKernel exposed to phase modules.
 *
 * Each phase function (PrepareContext / CallModel / Terminal) receives a
 * `KernelPhaseCtx` instead of the full kernel reference, so the phase's surface
 * is enumerable here in one place and phase tests can substitute fakes without
 * needing to construct a real kernel.
 *
 * The kernel implements this interface and passes `this` when delegating.
 */

import type { CheckpointId } from '../checkpoint'
import type { ArtifactManifest } from '../artifact'
import type { OrchestrationObserver } from '../observability'
import type { OrchestrationPorts } from '../ports'
import type { KernelLoopState, TranscriptSnapshot } from '../kernelTypes'
import type { AppendixAFlowReporter } from '../appendixAFlow'

export interface KernelPhaseCtx {
  /** Current loop state. Phases call {@link setState} to advance. */
  readonly state: KernelLoopState
  /** Mutate the kernel's state slot. */
  setState(next: KernelLoopState): void
  /** Effect ports the phase invokes (hooks, transport, session, tools, permission). */
  readonly ports: OrchestrationPorts
  /** Optional observer for {@link withPhaseSpan}. */
  readonly observer: OrchestrationObserver | undefined
  /** Renderer routing key — included in stream events when present. */
  readonly streamConversationId: string | undefined
  /** Kernel-owned abort controller; merged with caller's signal inside CallModel. */
  readonly abortController: AbortController
  /**
   * P0-2 — kernel-owned **hard** abort controller. Used by tools with
   * `interruptBehavior: 'block'` so a single soft user interrupt does not cancel
   * in-flight rsync / DB migration / remote polling work.
   */
  readonly hardAbortController: AbortController
  /** Emit an `orchestration_phase` event via the transport adapter. */
  emitPhase(phase: KernelLoopState['phase']): void
  /** Take a manual snapshot (no-op when no checkpoint port wired). */
  snapshot(tag: string): CheckpointId | undefined
  /** Build the artifact manifest for the current turn (used at Terminal). */
  buildArtifactManifest(): ArtifactManifest | undefined
  /** Best-effort inbox persistence (called after a PrepareContext flush). */
  persistInbox(): void
  /** Wrap an AppendixA reporter so emissions are stamped with kernel counters. */
  wrapAppendixAReporterWithIterationTracking(
    reporter: AppendixAFlowReporter | undefined,
  ): AppendixAFlowReporter | undefined
  /** Per-iteration inbox drain callback consumed by the agentic loop. */
  drainInboxForInnerIteration():
    | { injected: false }
    | { injected: true; snapshot: TranscriptSnapshot }
}
