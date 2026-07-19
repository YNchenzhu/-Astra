/**
 * While a legacy-delegate {@link OrchestrationKernel} run is active, register it by conversation id
 * so {@link enqueueSyntheticUserText} and related inbox helpers can enqueue work for the **next** turn.
 */

import { clearPendingHITLForConversation } from './hitl'
import { getIterationStallGuard } from './iterationStallGuard'
import type { KernelInterruptReason, OrchestrationKernel } from './kernel'
import type { CheckpointId, KernelCheckpoint } from './checkpoint'
import { deleteFileCheckpointTree } from './checkpoint'
import path from 'node:path'
import {
  createFileKernelPersistenceAdapter,
  type PersistedKernelState,
} from './pauseResume'
import { deleteInboxFromDisk } from './inboxPersistence'

const activeByConversation = new Map<string, OrchestrationKernel>()

export function registerOrchestrationKernelForConversation(
  conversationId: string,
  kernel: OrchestrationKernel,
): void {
  const id = conversationId.trim()
  if (!id) return
  activeByConversation.set(id, kernel)
}

export function unregisterOrchestrationKernelForConversation(conversationId: string): void {
  const id = conversationId.trim()
  if (!id) return
  // Audit Bug-2 fix — dispose the kernel BEFORE we drop our reference to it
  // so its grace-promotion setTimeout doesn't fire 30s after the session
  // ended and emit a phantom `interrupt:grace_expired` event into an
  // already-completed conversation. Idempotent + safe to call on a
  // never-interrupted kernel.
  const kernel = activeByConversation.get(id)
  if (kernel) {
    // M-5 — force any pending debounced checkpoint write to disk before the
    // kernel goes out of scope, so a clean session end doesn't lose the last
    // coalesced snapshot window. No-op for in-memory / debounceMs:0 ports.
    try {
      kernel.getCheckpointPort()?.flushNow?.()
    } catch (e) {
      console.warn('[activeKernelRegistry] checkpoint flushNow threw:', e)
    }
    try {
      kernel.dispose()
    } catch (e) {
      console.warn('[activeKernelRegistry] kernel.dispose() threw:', e)
    }
  }
  activeByConversation.delete(id)
  // G3 — drop any pending HITL entry for this conversation so the registry doesn't leak
  // when a session ends without the renderer answering the question. Safe no-op when
  // nothing was pending.
  clearPendingHITLForConversation(id)
  // Audit Bug-3 fix — drop the IterationStallGuard entry for this
  // conversation. `resetFor` would leave a zeroed entry; `deleteFor`
  // removes it entirely so multi-tab / long-uptime processes don't
  // accumulate dead conversation entries.
  try {
    getIterationStallGuard().deleteFor(id)
  } catch (e) {
    console.warn('[activeKernelRegistry] iterationStallGuard.deleteFor threw:', e)
  }
}

export function getOrchestrationKernelForConversation(
  conversationId: string,
): OrchestrationKernel | undefined {
  const id = conversationId.trim()
  if (!id) return undefined
  return activeByConversation.get(id)
}

/** @internal */
export function clearOrchestrationKernelRegistryForTests(): void {
  // Mirror unregister: tests that clear the kernel registry should also see pending HITL
  // entries vanish — otherwise cross-test state bleeds through the module-level Map.
  for (const id of activeByConversation.keys()) {
    clearPendingHITLForConversation(id)
  }
  activeByConversation.clear()
}

/**
 * public entry point for operator / IPC layer to interrupt an in-flight kernel by
 * conversation id. Returns `false` when no kernel is registered (e.g., legacy path or already
 * ended). Reason is forwarded to `OrchestrationKernel.interrupt` so telemetry consumers can
 * distinguish user cancels from timeouts / shutdowns / supersede events.
 */
export function interruptOrchestrationKernelForConversation(
  conversationId: string,
  reason: KernelInterruptReason = 'user',
  opts?: { hard?: boolean },
): boolean {
  const kernel = getOrchestrationKernelForConversation(conversationId)
  if (!kernel) return false
  try {
    kernel.interrupt(reason, opts)
    return true
  } catch {
    return false
  }
}

/**
 * pause the in-flight kernel. Cooperative (takes effect at next iteration boundary).
 * Returns `false` when no kernel is registered.
 */
export function pauseOrchestrationKernelForConversation(conversationId: string): boolean {
  const kernel = getOrchestrationKernelForConversation(conversationId)
  if (!kernel) return false
  try {
    kernel.pause()
    return true
  } catch {
    return false
  }
}

/** resume a paused kernel. Returns `false` when no kernel is registered. */
export function resumeOrchestrationKernelForConversation(conversationId: string): boolean {
  const kernel = getOrchestrationKernelForConversation(conversationId)
  if (!kernel) return false
  try {
    kernel.resume()
    return true
  } catch {
    return false
  }
}

/**
 * public entry point for IPC layer to take a manual snapshot of
 * the kernel's current state. Returns the new checkpoint id, or `undefined`
 * when no kernel is registered or no checkpoint port is wired.
 */
export function snapshotOrchestrationKernelForConversation(
  conversationId: string,
  tag: string,
): CheckpointId | undefined {
  const kernel = getOrchestrationKernelForConversation(conversationId)
  if (!kernel) return undefined
  try {
    return kernel.snapshot(tag)
  } catch {
    return undefined
  }
}

/**
 * rewind a kernel to a prior checkpoint. Returns `false` when no
 * kernel is registered, no checkpoint port is wired, or the id is unknown.
 * Side effects external to the kernel (filesystem / shell) are NOT rolled back.
 */
export function rewindOrchestrationKernelForConversation(
  conversationId: string,
  checkpointId: CheckpointId,
): boolean {
  const kernel = getOrchestrationKernelForConversation(conversationId)
  if (!kernel) return false
  try {
    return kernel.rewind(checkpointId)
  } catch {
    return false
  }
}

/**
 * list checkpoints for a conversation. Returns an empty array when
 * the kernel is not registered or no checkpoint port is wired. Renderer uses
 * this to populate the Timeline's rewind menu.
 */
export function listOrchestrationKernelCheckpoints(
  conversationId: string,
): KernelCheckpoint[] {
  const kernel = getOrchestrationKernelForConversation(conversationId)
  if (!kernel) return []
  try {
    return kernel.getCheckpointPort()?.list() ?? []
  } catch {
    return []
  }
}

/**
 * Audit §3.2 wire-up — return checkpoints organised as a tree walk
 * (branch roots first, descendants depth-first). Mirrors {@link list}
 * for linear histories but groups branches by parent for histories
 * with rewinds. Renderer Timeline uses this for the branch picker UI.
 *
 * Returns an empty array when no kernel or no checkpoint port is wired.
 */
export function listOrchestrationKernelCheckpointTree(
  conversationId: string,
): KernelCheckpoint[] {
  const kernel = getOrchestrationKernelForConversation(conversationId)
  if (!kernel) return []
  try {
    return kernel.getCheckpointPort()?.listTree() ?? []
  } catch {
    return []
  }
}

/**
 * Audit §3.2 wire-up — peek a single checkpoint by id without
 * mutating history. Used by "fork from checkpoint N" flows where the
 * caller wants to seed a sibling kernel from a specific state.
 *
 * Returns `null` when the id is unknown OR no checkpoint port is wired.
 */
export function peekOrchestrationKernelCheckpoint(
  conversationId: string,
  checkpointId: CheckpointId,
): KernelCheckpoint | null {
  const kernel = getOrchestrationKernelForConversation(conversationId)
  if (!kernel) return null
  try {
    return kernel.getCheckpointPort()?.peek(checkpointId) ?? null
  } catch {
    return null
  }
}

/**
 * Audit §3.2 wire-up — current branch head id (set by most recent
 * `snapshot()` or `rewind()`). Lets the renderer highlight "you are
 * here" in the branch tree without having to walk the full history.
 *
 * Returns `undefined` when no kernel, no port, or no checkpoints yet.
 */
export function getOrchestrationKernelBranchHead(
  conversationId: string,
): CheckpointId | undefined {
  const kernel = getOrchestrationKernelForConversation(conversationId)
  if (!kernel) return undefined
  try {
    return kernel.getCheckpointPort()?.getBranchHead()
  } catch {
    return undefined
  }
}

/**
 * explicitly persist the kernel state to disk. Normally Terminal
 * phase or process exit triggers persistence implicitly; this entry point is
 * for the renderer to force a save (e.g. before user-triggered Quit).
 */
export async function persistOrchestrationKernelForConversation(
  conversationId: string,
): Promise<PersistedKernelState | undefined> {
  const kernel = getOrchestrationKernelForConversation(conversationId)
  if (!kernel) return undefined
  try {
    return await kernel.persist()
  } catch {
    return undefined
  }
}

/**
 * Audit §3.2 wire-up — full on-disk cleanup for a conversation that the user
 * just deleted from the UI. Wires {@link KernelPersistenceAdapter.delete}
 * (kernel-state blob) AND {@link deleteInboxFromDisk} (inbox JSON file) so
 * a "delete conversation" action actually drops the disk artifacts in
 * `<userData>/kernel-state/` and `<userData>/orchestration-inbox/`.
 *
 * Without this, both files stayed forever as the audit observed: the
 * `delete` methods were defined but never called from production, leaving
 * `<userData>/kernel-state/*.json` and `<userData>/orchestration-inbox/*.json`
 * to accumulate one entry per ever-existing conversation.
 *
 * Returns `{ kernelStateDeleted, inboxDeleted }` so callers can surface
 * which artifacts actually existed (informational; no error means success
 * even when the files didn't exist).
 *
 * Safe to call when no kernel is registered, when no userData path is
 * available (test env), and when the files don't exist — all branches
 * degrade to no-ops.
 *
 * IMPORTANT: this only handles editor-internal cleanup. The conversation
 * transcript JSON owned by `conversation/service.ts` is NOT touched here;
 * call this in ADDITION to `service.deleteConversation(...)`.
 */
export async function deleteOrchestrationArtifactsForConversation(
  conversationId: string,
): Promise<{ kernelStateDeleted: boolean; inboxDeleted: boolean }> {
  const id = conversationId.trim()
  if (!id) return { kernelStateDeleted: false, inboxDeleted: false }

  let kernelStateDeleted = false
  let inboxDeleted = false

  // Drop the kernel-state blob via the file-backed persistence adapter.
  // We construct an adapter on demand because the kernel that wrote the
  // blob may already be unregistered by the time the user deletes the
  // conversation. Using `tryGetUserDataDir` keeps the function safe in
  // non-Electron / test environments — when no userData is available the
  // adapter's `delete` is a no-op.
  try {
    const electronMod = (() => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        return require('electron') as typeof import('electron')
      } catch {
        return null
      }
    })()
    const userData = electronMod?.app?.getPath('userData')
    if (userData) {
      const adapter = createFileKernelPersistenceAdapter(userData)
      await Promise.resolve(adapter.delete(id))
      kernelStateDeleted = true
      // Audit fix M-2 — also drop the durable checkpoint tree file written by
      // `createFileCheckpointPort` (same userData root, `kernel-checkpoints/`).
      try {
        deleteFileCheckpointTree(path.join(userData, 'kernel-checkpoints'), id)
      } catch (e) {
        console.warn(
          '[activeKernelRegistry] deleteOrchestrationArtifacts checkpoint delete failed:',
          e,
        )
      }
    }
  } catch (e) {
    console.warn(
      '[activeKernelRegistry] deleteOrchestrationArtifacts kernel-state delete failed:',
      e,
    )
  }

  // Drop the per-conversation inbox file. `deleteInboxFromDisk` already
  // guards on userData availability and silently no-ops when the file
  // doesn't exist.
  try {
    deleteInboxFromDisk(id)
    inboxDeleted = true
  } catch (e) {
    console.warn(
      '[activeKernelRegistry] deleteOrchestrationArtifacts inbox delete failed:',
      e,
    )
  }

  return { kernelStateDeleted, inboxDeleted }
}
