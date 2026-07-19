/**
 * Transport adapters + typed phase-event helpers.
 *
 * Split out of `defaultAdapters.ts` in Chunk 11 so the stream-event shape lives next
 * to the typed-sink contract documented in `STREAM_SINKS.md`. `defaultAdapters.ts`
 * is now a pure re-export barrel preserved for back-compat with the dozen+ test
 * files that import its exports.
 */

import type { StreamEvent } from '../ai/streamHandler'
import type {
  OrchestrationPhaseArtifactManifest,
  OrchestrationPhaseCommon,
  OrchestrationPhaseHitlFailed,
  OrchestrationPhaseInterrupt,
  OrchestrationPhaseKernelFsm,
  OrchestrationPhaseLifecycle,
  OrchestrationPhaseOuterLoop,
  OrchestrationPhasePayload,
  OrchestrationPhasePayloadVariant,
  OrchestrationPhasePermissionDenied,
  OrchestrationPhasePreempted,
  OrchestrationPhaseSchedulerBackpressure,
  OrchestrationPhaseTranscriptDegraded,
  OrchestrationPhaseTranscriptDrift,
  OrchestrationPhaseTranscriptConflict,
  TransportPort,
  HookPolicyPort,
} from './ports'

/**
 * Translate a typed phase payload into the legacy `StreamEvent` shape.
 *
 * Centralised so `createTransportAdapter` and the fallback path in {@link emitPhaseEvent}
 * produce byte-identical events (i.e. switching renderer subscribers between the typed sink
 * and the raw `emit` is observationally lossless).
 */
function buildPhaseStreamEvent(payload: OrchestrationPhasePayload): StreamEvent {
  const ev = {
    type: 'orchestration_phase' as const,
    ...(payload.conversationId?.trim()
      ? { conversationId: payload.conversationId.trim() }
      : {}),
    orchestrationPhase: payload.phase,
    orchestrationIteration: payload.iteration,
    ...(payload.innerIteration !== undefined
      ? { orchestrationInnerIteration: payload.innerIteration }
      : {}),
    ...(payload.interruptReason ? { interruptReason: payload.interruptReason } : {}),
    ...(payload.artifactManifest ? { artifactManifest: payload.artifactManifest } : {}),
    ...(payload.permissionDenial ? { permissionDenial: payload.permissionDenial } : {}),
    // Bug B fix — propagate HITL pause payload to the renderer. The legacy
    // `_hitl` cast via `as Record<string, unknown>` in toolExec.ts was being
    // silently dropped by this adapter (which only spreads known fields).
    ...(payload.hitlPending ? { hitlPending: payload.hitlPending } : {}),
    // P2-1 — HITL persistence-failure payload. Same shape as `hitlPending`:
    // only forwarded when set, so renderers that don't subscribe to this
    // phase are unaffected.
    ...(payload.hitlPersistenceFailed
      ? { hitlPersistenceFailed: payload.hitlPersistenceFailed }
      : {}),
    // Audit P2-1 — outer-loop telemetry. Forwarded only when the producer
    // populates it (currently `kernel.runDriveMainChat` at the end of each
    // outer-loop exit). Renderer / dashboards consume it to plot the
    // distribution of outer iterations per turn and alarm on overflow.
    ...(payload.outerLoopStats ? { outerLoopStats: payload.outerLoopStats } : {}),
    // Audit P2-2 — transcript clone degradation signal. Forwarded only when
    // `cloneApiMessagesForOrchestration`'s structuredClone + JSON fallbacks
    // both failed and the helper had to return a frozen shared reference.
    ...(payload.transcriptCloneDegraded
      ? { transcriptCloneDegraded: payload.transcriptCloneDegraded }
      : {}),
    // Contract audit (2026-07) — Terminal-commit dual-source length
    // divergence. Forwarded only when the Terminal phase detected that
    // AgentContext.messages and the kernel transcript disagreed on length.
    ...(payload.transcriptDrift ? { transcriptDrift: payload.transcriptDrift } : {}),
    ...(payload.transcriptConflict ? { transcriptConflict: payload.transcriptConflict } : {}),
    // P1 (audit §5.2 wire-up) — preemption telemetry. Forwarded only when
    // `DefaultToolRuntimePort.executeToolBatch` actually preempts a victim
    // to free a resource slot for a higher-priority newcomer.
    ...(payload.preemption ? { preemption: payload.preemption } : {}),
    // Contract audit (2026-07) — scheduler hold / quota backpressure wait
    // telemetry, forwarded only when a tool actually entered a wait state.
    ...(payload.schedulerBackpressure
      ? { schedulerBackpressure: payload.schedulerBackpressure }
      : {}),
  } as StreamEvent
  return ev
}

/**
 * Back-compat helper used at kernel callsites. Prefers the typed sink when present,
 * falls back to building the equivalent `StreamEvent` and calling `emit`. Lets us land the
 * sink rollout without forcing every test mock (some still use inline `{ emit: vi.fn() }`)
 * to grow an `emitPhase` member.
 *
 * Audit P2 §6.3 — accepts BOTH the legacy loose shape ({@link OrchestrationPhasePayload})
 * and the strict discriminated union ({@link OrchestrationPhasePayloadVariant}). New
 * producers should use the per-variant builders below
 * ({@link buildKernelFsmPhase} / {@link buildInterruptPhase} / etc.) so the type checker
 * prevents wrong-field-with-wrong-tag bugs; existing producers keep working unchanged.
 */
export function emitPhaseEvent(
  transport: TransportPort,
  payload: OrchestrationPhasePayload | OrchestrationPhasePayloadVariant,
): void {
  try {
    if (transport.emitPhase) {
      transport.emitPhase(payload as OrchestrationPhasePayload)
      return
    }
    transport.emit(buildPhaseStreamEvent(payload as OrchestrationPhasePayload))
  } catch {
    /* transports must never bubble errors into the kernel hot path */
  }
}

export function createTransportAdapter(emit: (ev: StreamEvent) => void): TransportPort {
  return {
    emit,
    emitPhase(payload) {
      emit(buildPhaseStreamEvent(payload))
    },
  }
}

export const noopHookPolicy: HookPolicyPort = {}

// ---------------------------------------------------------------------------
// Per-variant phase-event builders (audit P2 §6.3)
//
// Construct phase payloads with compile-time discrimination — the builder
// signature enforces "this field belongs to this phase tag". New producers
// should prefer these over hand-rolled `{ phase: '...', ... }` literals so
// extending the union later catches every callsite at compile time.
//
// All builders return both an `OrchestrationPhasePayloadVariant` (strict)
// AND an `OrchestrationPhasePayload` (loose) — the result is assignable to
// either, and `emitPhaseEvent` accepts both.
// ---------------------------------------------------------------------------

/** Build a kernel-FSM phase event (`PrepareContext` / `CallModel` / `Terminal` / `Error`). */
export function buildKernelFsmPhase(
  args: OrchestrationPhaseCommon & { phase: OrchestrationPhaseKernelFsm['phase'] },
): OrchestrationPhaseKernelFsm {
  return {
    phase: args.phase,
    iteration: args.iteration,
    ...(args.innerIteration !== undefined ? { innerIteration: args.innerIteration } : {}),
    ...(args.conversationId?.trim() ? { conversationId: args.conversationId.trim() } : {}),
  }
}

/** Build an admin lifecycle event (`paused` / `resumed` / `rewound`). */
export function buildLifecyclePhase(
  args: OrchestrationPhaseCommon & { phase: OrchestrationPhaseLifecycle['phase'] },
): OrchestrationPhaseLifecycle {
  return {
    phase: args.phase,
    iteration: args.iteration,
    ...(args.innerIteration !== undefined ? { innerIteration: args.innerIteration } : {}),
    ...(args.conversationId?.trim() ? { conversationId: args.conversationId.trim() } : {}),
  }
}

/** Build an interrupt phase event. Optionally carries the HITL pause payload. */
export function buildInterruptPhase(
  args: OrchestrationPhaseCommon & {
    interruptReason: string
    hitlPending?: OrchestrationPhaseInterrupt['hitlPending']
  },
): OrchestrationPhaseInterrupt {
  return {
    phase: 'interrupt',
    iteration: args.iteration,
    ...(args.innerIteration !== undefined ? { innerIteration: args.innerIteration } : {}),
    ...(args.conversationId?.trim() ? { conversationId: args.conversationId.trim() } : {}),
    interruptReason: args.interruptReason,
    ...(args.hitlPending ? { hitlPending: args.hitlPending } : {}),
  }
}

/** Build an outer-loop-complete telemetry phase event. */
export function buildOuterLoopPhase(
  args: OrchestrationPhaseCommon & {
    outerLoopStats: OrchestrationPhaseOuterLoop['outerLoopStats']
  },
): OrchestrationPhaseOuterLoop {
  return {
    phase: 'outer_loop_complete',
    iteration: args.iteration,
    ...(args.innerIteration !== undefined ? { innerIteration: args.innerIteration } : {}),
    ...(args.conversationId?.trim() ? { conversationId: args.conversationId.trim() } : {}),
    outerLoopStats: args.outerLoopStats,
  }
}

/** Build a HITL persistence-failure phase event. */
export function buildHitlFailedPhase(
  args: OrchestrationPhaseCommon & {
    hitlPersistenceFailed: OrchestrationPhaseHitlFailed['hitlPersistenceFailed']
  },
): OrchestrationPhaseHitlFailed {
  return {
    phase: 'hitl_persistence_failed',
    iteration: args.iteration,
    ...(args.innerIteration !== undefined ? { innerIteration: args.innerIteration } : {}),
    ...(args.conversationId?.trim() ? { conversationId: args.conversationId.trim() } : {}),
    hitlPersistenceFailed: args.hitlPersistenceFailed,
  }
}

/** Build a transcript-clone-degraded telemetry phase event. */
export function buildTranscriptDegradedPhase(
  args: OrchestrationPhaseCommon & {
    transcriptCloneDegraded: OrchestrationPhaseTranscriptDegraded['transcriptCloneDegraded']
  },
): OrchestrationPhaseTranscriptDegraded {
  return {
    phase: 'transcript_clone_degraded',
    iteration: args.iteration,
    ...(args.innerIteration !== undefined ? { innerIteration: args.innerIteration } : {}),
    ...(args.conversationId?.trim() ? { conversationId: args.conversationId.trim() } : {}),
    transcriptCloneDegraded: args.transcriptCloneDegraded,
  }
}

/** Build a transcript-drift phase event (Terminal-commit dual-source divergence). */
export function buildTranscriptDriftPhase(
  args: OrchestrationPhaseCommon & {
    transcriptDrift: OrchestrationPhaseTranscriptDrift['transcriptDrift']
  },
): OrchestrationPhaseTranscriptDrift {
  return {
    phase: 'transcript_drift',
    iteration: args.iteration,
    ...(args.innerIteration !== undefined ? { innerIteration: args.innerIteration } : {}),
    ...(args.conversationId?.trim() ? { conversationId: args.conversationId.trim() } : {}),
    transcriptDrift: args.transcriptDrift,
  }
}

/** Build a revision-CAS conflict event without exposing transcript contents. */
export function buildTranscriptConflictPhase(
  args: OrchestrationPhaseCommon & {
    transcriptConflict: OrchestrationPhaseTranscriptConflict['transcriptConflict']
  },
): OrchestrationPhaseTranscriptConflict {
  return {
    phase: 'transcript_conflict',
    iteration: args.iteration,
    ...(args.innerIteration !== undefined ? { innerIteration: args.innerIteration } : {}),
    ...(args.conversationId?.trim() ? { conversationId: args.conversationId.trim() } : {}),
    transcriptConflict: args.transcriptConflict,
  }
}

/** Build an artifact-manifest phase event (emitted at Terminal). */
export function buildArtifactManifestPhase(
  args: OrchestrationPhaseCommon & {
    artifactManifest: OrchestrationPhaseArtifactManifest['artifactManifest']
  },
): OrchestrationPhaseArtifactManifest {
  return {
    phase: 'artifact_manifest',
    iteration: args.iteration,
    ...(args.innerIteration !== undefined ? { innerIteration: args.innerIteration } : {}),
    ...(args.conversationId?.trim() ? { conversationId: args.conversationId.trim() } : {}),
    artifactManifest: args.artifactManifest,
  }
}

/** Build a permission-denied-preflight phase event. */
export function buildPermissionDeniedPhase(
  args: OrchestrationPhaseCommon & {
    permissionDenial: OrchestrationPhasePermissionDenied['permissionDenial']
  },
): OrchestrationPhasePermissionDenied {
  return {
    phase: 'permission_denied_preflight',
    iteration: args.iteration,
    ...(args.innerIteration !== undefined ? { innerIteration: args.innerIteration } : {}),
    ...(args.conversationId?.trim() ? { conversationId: args.conversationId.trim() } : {}),
    permissionDenial: args.permissionDenial,
  }
}

/** Build a scheduler-backpressure phase event (tool entered a hold / quota wait). */
export function buildSchedulerBackpressurePhase(
  args: OrchestrationPhaseCommon & {
    schedulerBackpressure: OrchestrationPhaseSchedulerBackpressure['schedulerBackpressure']
  },
): OrchestrationPhaseSchedulerBackpressure {
  return {
    phase: 'scheduler_backpressure',
    iteration: args.iteration,
    ...(args.innerIteration !== undefined ? { innerIteration: args.innerIteration } : {}),
    ...(args.conversationId?.trim() ? { conversationId: args.conversationId.trim() } : {}),
    schedulerBackpressure: args.schedulerBackpressure,
  }
}

/** Build a tool-preempted phase event (audit P1 §5.2 wire-up). */
export function buildPreemptionPhase(
  args: OrchestrationPhaseCommon & {
    preemption: OrchestrationPhasePreempted['preemption']
  },
): OrchestrationPhasePreempted {
  return {
    phase: 'tool_preempted',
    iteration: args.iteration,
    ...(args.innerIteration !== undefined ? { innerIteration: args.innerIteration } : {}),
    ...(args.conversationId?.trim() ? { conversationId: args.conversationId.trim() } : {}),
    preemption: args.preemption,
  }
}
