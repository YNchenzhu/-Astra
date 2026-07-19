/**
 * Stage 2.2 — IPC handlers for the OrchestrationKernel checkpoint + persistence
 * control surface. Companion to `agents:pause-active` / `agents:resume-active`
 * in `agentsHandlers.ts` (which cover the cooperative pause/resume gate).
 *
 * Channels exposed:
 *   - `orchestration:snapshot`         take a manual checkpoint, returns checkpoint id
 *   - `orchestration:rewind`           restore a prior checkpoint by id
 *   - `orchestration:list-checkpoints` list all checkpoints for a conversation
 *   - `orchestration:persist`          force a disk-write of the current kernel state
 *
 * All channels resolve the kernel via `activeKernelRegistry` keyed on
 * `conversationId`; the renderer is expected to pass the currently-active
 * chat session's id. Returns `{ ok: false }` when the conversation has no
 * registered kernel (e.g. legacy path / session already ended) — this is a
 * normal condition, not an error.
 */

import { type IpcMain } from 'electron'
import { validatedHandle } from '../validatedHandle'
import {
  orchestrationSnapshotArgs,
  orchestrationRewindArgs,
  orchestrationListCheckpointsArgs,
  orchestrationPersistArgs,
  orchestrationListCheckpointTreeArgs,
  orchestrationPeekCheckpointArgs,
  orchestrationBranchHeadArgs,
} from '../schemas'
import {
  snapshotOrchestrationKernelForConversation,
  rewindOrchestrationKernelForConversation,
  listOrchestrationKernelCheckpoints,
  persistOrchestrationKernelForConversation,
  listOrchestrationKernelCheckpointTree,
  peekOrchestrationKernelCheckpoint,
  getOrchestrationKernelBranchHead,
} from '../../orchestration/activeKernelRegistry'

export function registerOrchestrationHandlers(_ipcMain: IpcMain): void {
  validatedHandle(
    'orchestration:snapshot',
    orchestrationSnapshotArgs,
    async (_event, [{ conversationId, tag }]) => {
      const id = snapshotOrchestrationKernelForConversation(conversationId, tag)
      if (!id) return { ok: false as const, error: 'no kernel or no checkpoint port' }
      return { ok: true as const, checkpointId: id }
    },
  )

  validatedHandle(
    'orchestration:rewind',
    orchestrationRewindArgs,
    async (_event, [{ conversationId, checkpointId }]) => {
      const ok = rewindOrchestrationKernelForConversation(conversationId, checkpointId)
      return { ok }
    },
  )

  validatedHandle(
    'orchestration:list-checkpoints',
    orchestrationListCheckpointsArgs,
    async (_event, [{ conversationId }]) => {
      // Strip kernel state from the response — the renderer only needs id/tag/at/parentId
      // for the timeline UI; sending the full deep-cloned state would balloon IPC traffic.
      const checkpoints = listOrchestrationKernelCheckpoints(conversationId).map((c) => ({
        id: c.id,
        tag: c.tag,
        at: c.at,
        ...(c.parentId ? { parentId: c.parentId } : {}),
      }))
      return { ok: true as const, checkpoints }
    },
  )

  validatedHandle(
    'orchestration:persist',
    orchestrationPersistArgs,
    async (_event, [{ conversationId }]) => {
      const blob = await persistOrchestrationKernelForConversation(conversationId)
      if (!blob) return { ok: false as const, error: 'no kernel or no persistence adapter' }
      return { ok: true as const, savedAt: blob.savedAt }
    },
  )

  // Audit §3.2 wire-up — tree-ordered checkpoint listing. Returns
  // branch-root-first depth-first walk, identical to `list-checkpoints`
  // for linear histories but groups branches by parent for forks.
  validatedHandle(
    'orchestration:list-checkpoint-tree',
    orchestrationListCheckpointTreeArgs,
    async (_event, [{ conversationId }]) => {
      const checkpoints = listOrchestrationKernelCheckpointTree(conversationId).map((c) => ({
        id: c.id,
        tag: c.tag,
        at: c.at,
        ...(c.parentId ? { parentId: c.parentId } : {}),
      }))
      return { ok: true as const, checkpoints }
    },
  )

  // Audit §3.2 wire-up — single-checkpoint peek for fork flows. Returns
  // the full `state` so the renderer can preview / hydrate a sibling
  // kernel from a specific point.
  validatedHandle(
    'orchestration:peek-checkpoint',
    orchestrationPeekCheckpointArgs,
    async (_event, [{ conversationId, checkpointId }]) => {
      const c = peekOrchestrationKernelCheckpoint(conversationId, checkpointId)
      if (!c) return { ok: false as const, error: 'no kernel or checkpoint id not found' }
      return {
        ok: true as const,
        checkpoint: {
          id: c.id,
          tag: c.tag,
          at: c.at,
          ...(c.parentId ? { parentId: c.parentId } : {}),
          state: c.state,
        },
      }
    },
  )

  // Audit §3.2 wire-up — current branch head id. Used by the Timeline
  // renderer to mark "you are here" in the branch tree without a
  // separate state walk.
  validatedHandle(
    'orchestration:branch-head',
    orchestrationBranchHeadArgs,
    async (_event, [{ conversationId }]) => {
      const head = getOrchestrationKernelBranchHead(conversationId)
      if (head === undefined) {
        return { ok: false as const, error: 'no kernel or no checkpoints yet' }
      }
      return { ok: true as const, branchHead: head }
    },
  )
}
