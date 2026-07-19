/**
 * Internal contract shared between {@link OrchestrationKernel} (the public class)
 * and the sibling helper module(s) that have been extracted from it.
 *
 * History note: the kernel was originally planned to be split into several
 * sibling files (lifecycle / checkpointing / IO / artifact / telemetry).
 * **Only `kernelTelemetry.ts` was actually extracted**; the other planned
 * siblings never materialised and the kernel still hosts those concerns
 * directly. The {@link KernelSlice} abstraction below was introduced for
 * that aspirational split and is now used solely by telemetry helpers
 * (`emitPhase`, `resetInnerIteration`, `wrapAppendixAReporterWithIterationTracking`).
 *
 * The slice is built once in the kernel constructor; helpers receive it by
 * reference and read/mutate kernel state through accessor pairs. This keeps
 * private field visibility intact (helpers only see what the slice exposes)
 * while letting each concern be unit-tested without instantiating a full kernel.
 *
 * If a future PR resumes the split, the candidate concerns to extract are:
 * (a) checkpoint / artifact / persistence wiring, (b) outer-turn FSM
 * (`runDriveMainChat`), and (c) the HITL + inbox-persistence helpers.
 */

import type { OrchestrationPorts } from './ports'
import type { OrchestrationObserver } from './observability'
import type { KernelLoopState } from './kernelTypes'
import type { CheckpointPort } from './checkpoint'
import type { ArtifactPort } from './artifact'
import type { PauseGate, KernelPersistenceAdapter } from './pauseResume'
import type { KernelInterruptReason } from './kernel'

export interface KernelSlice {
  /** Mutable kernel loop state — `set` replaces it atomically. */
  state: {
    get: () => KernelLoopState
    set: (next: KernelLoopState) => void
  }
  /** First-write-wins interrupt reason. */
  interruptReason: {
    get: () => KernelInterruptReason | undefined
    set: (reason: KernelInterruptReason) => void
  }
  readonly ports: OrchestrationPorts
  readonly streamConversationId: string | undefined
  readonly abortController: AbortController
  readonly pauseGate: PauseGate
  readonly observer: OrchestrationObserver | undefined
  readonly checkpointPort: CheckpointPort | undefined
  readonly artifactPort: ArtifactPort | undefined
  readonly persistenceAdapter: KernelPersistenceAdapter | undefined
}
