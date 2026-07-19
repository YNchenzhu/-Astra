/**
 * Stage 3.1 — OrchestrationKernel telemetry mirror.
 *
 * State + setters consumed by:
 *   - `OrchestrationTimeline.tsx` — phase / iteration / paused
 *   - `PreflightDenialToast.tsx`  — permissionDenials
 *   - `ArtifactDrawer.tsx`         — artifactManifests
 *   - `AskUserQuestionDialog`     — hitlPaused
 *   - `OrchestrationTimeline.tsx` (rewind menu) — checkpointList
 *
 * Updates land via `mainStreamRouter.ts:case 'orchestration_phase'` dispatch.
 * Per-session mirror lives on {@link ChatSessionSlice}; the top-level fields
 * here track the active conversation only.
 */
import type { StateCreator } from 'zustand'
import type {
  ChatState,
  OrchestrationCheckpointSummary,
} from '../types'

export type OrchestrationSlice = Pick<ChatState,
  | 'orchestrationPhase'
  | 'orchestrationIteration'
  | 'orchestrationInnerIteration'
  | 'orchestrationPaused'
  | 'permissionDenials'
  | 'artifactManifests'
  | 'checkpointList'
  | 'hitlPaused'
  | 'toolPreemptions'
  | 'hitlPersistenceFailures'
  | 'interruptNotices'
  | 'lastTranscriptCloneDegradation'
  | 'lastOuterLoopStats'
  | 'kernelDiagnostics'
  | 'dismissKernelDiagnostic'
  | 'pushKernelDiagnostic'
  | 'dismissPermissionDenial'
  | 'dismissToolPreemption'
  | 'dismissHitlPersistenceFailure'
  | 'dismissInterruptNotice'
  | 'clearHitlPause'
  | 'setCheckpointList'
>

export const createOrchestrationSlice: StateCreator<
  ChatState, [], [], OrchestrationSlice
> = (set) => ({
  orchestrationPhase: null,
  orchestrationIteration: 0,
  orchestrationInnerIteration: 0,
  orchestrationPaused: false,
  permissionDenials: [],
  artifactManifests: [],
  checkpointList: [],
  hitlPaused: null,
  toolPreemptions: [],
  hitlPersistenceFailures: [],
  interruptNotices: [],
  lastTranscriptCloneDegradation: null,
  lastOuterLoopStats: null,
  kernelDiagnostics: [],

  dismissKernelDiagnostic: (id: string) =>
    set((s) => ({
      kernelDiagnostics: s.kernelDiagnostics.filter((d) => d.id !== id),
    })),

  pushKernelDiagnostic: (kind, detail) =>
    set((s) => {
      const now = Date.now()
      const diag = { id: `${kind}:${now}`, kind, detail, at: now }
      // Same bounded-buffer cap as the stream-router side (30).
      const cap = (arr: typeof s.kernelDiagnostics) =>
        arr.length > 30 ? arr.slice(arr.length - 30) : arr
      const patch: Partial<ChatState> = {
        kernelDiagnostics: cap([...s.kernelDiagnostics, diag]),
      }
      // Audit R2 (2026-07) — mirror into the current conversation's session
      // buffer so a renderer-originated diagnostic (e.g. `pause_partial`)
      // survives a tab switch. The stream-router side writes slice + active
      // mirror; this action previously wrote only the top-level mirror, which
      // `loadConversation` rebuilds from the buffer — dropping the toast.
      const cid = s.currentConversationId
      const buf = cid ? s.sessionBuffers[cid] : undefined
      if (cid && buf) {
        patch.sessionBuffers = {
          ...s.sessionBuffers,
          [cid]: {
            ...buf,
            kernelDiagnostics: cap([...(buf.kernelDiagnostics ?? []), diag]),
          },
        }
      }
      return patch
    }),

  dismissPermissionDenial: (toolUseId: string) =>
    set((s) => ({
      permissionDenials: s.permissionDenials.filter((d) => d.toolUseId !== toolUseId),
    })),

  dismissToolPreemption: (id: string) =>
    set((s) => ({
      toolPreemptions: s.toolPreemptions.filter((p) => p.id !== id),
    })),

  dismissHitlPersistenceFailure: (id: string) =>
    set((s) => ({
      hitlPersistenceFailures: s.hitlPersistenceFailures.filter((f) => f.id !== id),
    })),

  dismissInterruptNotice: (id: string) =>
    set((s) => ({
      interruptNotices: s.interruptNotices.filter((n) => n.id !== id),
    })),

  clearHitlPause: () => set({ hitlPaused: null }),

  setCheckpointList: (checkpoints: OrchestrationCheckpointSummary[]) =>
    set({ checkpointList: checkpoints }),
})
