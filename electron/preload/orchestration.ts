/**
 * Stage 2.3 — OrchestrationKernel checkpoint + persistence bridge.
 *
 * Companion to {@link AgentsApi.pauseActive} / {@link AgentsApi.resumeActive}
 * (which cover the pause/resume gate). These channels operate on
 * `conversationId` rather than `agentId` because the kernel registry is keyed
 * on the conversation id (see `activeKernelRegistry.ts`).
 *
 * Channels:
 *   - `orchestration:snapshot`         take a manual checkpoint
 *   - `orchestration:rewind`           restore to a checkpoint id
 *   - `orchestration:list-checkpoints` list checkpoints for the conversation
 *   - `orchestration:persist`          force a kernel-state disk write
 */
import { ipcRenderer } from 'electron'

export interface OrchestrationCheckpointSummary {
  id: string
  tag: string
  at: number
  parentId?: string
}

export interface OrchestrationApi {
  snapshot: (payload: { conversationId: string; tag: string }) => Promise<
    | { ok: true; checkpointId: string }
    | { ok: false; error: string }
  >
  rewind: (payload: { conversationId: string; checkpointId: string }) => Promise<{
    ok: boolean
  }>
  listCheckpoints: (payload: { conversationId: string }) => Promise<{
    ok: boolean
    checkpoints: OrchestrationCheckpointSummary[]
  }>
  persist: (payload: { conversationId: string }) => Promise<
    | { ok: true; savedAt: number }
    | { ok: false; error: string }
  >
}

export function buildOrchestrationApi(): OrchestrationApi {
  return {
    snapshot: (payload) => ipcRenderer.invoke('orchestration:snapshot', payload),
    rewind: (payload) => ipcRenderer.invoke('orchestration:rewind', payload),
    listCheckpoints: (payload) => ipcRenderer.invoke('orchestration:list-checkpoints', payload),
    persist: (payload) => ipcRenderer.invoke('orchestration:persist', payload),
  }
}
