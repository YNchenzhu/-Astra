/**
 * Renderer → main "intent" channel for DiffTransaction lifecycle actions (P3b).
 *
 * In P2 the renderer was read-only: it observed DT state and reflected it in UI. P3b
 * adds three user-initiated intents that need to travel back to the main process:
 *
 *   • `retry` : user clicked "Retry" on the failure banner. We transition the DT
 *               from Failed back to Writing (reducer enforces legality) and return OK.
 *               The actual re-execution is owned by whichever module is wired to react
 *               to the `Retry` FSM event — in P3 that's just the DT state change; the
 *               agentic loop will learn to listen for it in P3.5 / P4.
 *   • `abort` : user wants to give up on this DT. If still in a non-terminal state we
 *               dispatch `PermissionRejected`. Safe to call even on already-terminal
 *               DTs (returns OK without dispatching).
 *   • `rebase`: user chose "rebase onto current disk" from the Stale banner. We read
 *               disk, rebuild the baseSnapshot, and dispatch `Rebase` with the fresh
 *               content. The proposed content stays the same (P4 might re-compute it
 *               via `computeFileEditResult` against the new base).
 *
 * Intentionally small: these handlers do only the state transition. They do NOT touch
 * disk (except the one read in `rebase`), do NOT unblock any pending permission
 * promise, and do NOT talk to the agentic loop directly. That keeps the audit surface
 * tiny and the failure mode obvious.
 */

import fs from 'node:fs'
import type { IpcMain } from 'electron'
import { getDiffTxStore } from './DiffTransactionStore'
import { hashFileContent } from '../tools/readFileState'
import type { DiffTxId } from './DiffTransactionTypes'
import { getUndoQueue } from './undoQueue'

export type IntentOk = { ok: true; state: string }
export type IntentErr = { ok: false; reason: string }
export type IntentResult = IntentOk | IntentErr

const OK = (state: string): IntentOk => ({ ok: true, state })
const ERR = (reason: string): IntentErr => ({ ok: false, reason })

/**
 * Retry: Failed → Writing. Returns the new state so the UI can update optimistically.
 * If the DT is not in Failed this refuses without touching state.
 */
export function intentRetry(id: DiffTxId): IntentResult {
  const store = getDiffTxStore()
  const dt = store.get(id)
  if (!dt) return ERR(`DiffTransaction ${id} not found`)
  if (dt.state !== 'Failed') {
    return ERR(`Cannot retry: DT is in '${dt.state}', expected 'Failed'.`)
  }
  const r = store.dispatch({ type: 'Retry', id })
  if (!r.ok) return ERR(r.reason)
  return OK(r.transaction.state)
}

/**
 * Abort: deny the DT if not terminal. Idempotent: aborting a terminal DT is OK (the
 * user may be clicking Dismiss after the banner auto-cleared).
 */
export function intentAbort(id: DiffTxId, reason = 'user aborted'): IntentResult {
  const store = getDiffTxStore()
  const dt = store.get(id)
  if (!dt) return ERR(`DiffTransaction ${id} not found`)
  if (dt.state === 'Applied' || dt.state === 'Rejected') {
    return OK(dt.state) // already terminal — nothing to do
  }
  const r = store.dispatch({ type: 'PermissionRejected', id, reason })
  if (!r.ok) return ERR(r.reason)
  return OK(r.transaction.state)
}

/**
 * Rebase: re-anchor a Stale DT onto the current on-disk content. We read the file,
 * hash it, and dispatch `Rebase` with the fresh baseSnapshot. The proposed content is
 * carried forward unchanged; P4 will optionally re-apply `computeFileEditResult` against
 * the new base to regenerate a sensible proposed.
 *
 * If the file disappeared (unlink → Stale), we can't rebase — return an error telling
 * the caller to Abort instead.
 */
export function intentRebase(id: DiffTxId): IntentResult {
  const store = getDiffTxStore()
  const dt = store.get(id)
  if (!dt) return ERR(`DiffTransaction ${id} not found`)
  if (dt.state !== 'Stale') {
    return ERR(`Cannot rebase: DT is in '${dt.state}', expected 'Stale'.`)
  }

  let freshContent: string
  let freshStat: fs.Stats
  try {
    freshContent = fs.readFileSync(dt.filePath, 'utf-8')
    freshStat = fs.statSync(dt.filePath)
  } catch (e) {
    return ERR(
      `Cannot rebase: failed to read current disk content (${String(e)}). Abort this DT instead.`,
    )
  }

  const r = store.dispatch({
    type: 'Rebase',
    id,
    newBaseSnapshot: {
      content: freshContent,
      contentHash: hashFileContent(freshContent),
      mtimeMs: freshStat.mtimeMs,
      fileExisted: true,
      readId: null,
    },
    newProposedContent: dt.proposed.content,
  })
  if (!r.ok) return ERR(r.reason)
  return OK(r.transaction.state)
}

/**
 * Undo: revert a just-Applied DT by writing `baseSnapshot.content` back to disk. The
 * actual write lives in `UndoQueue.undo()` (which uses the atomicWriter); this wrapper
 * only narrows the UndoQueue result into the IpcResult shape the renderer expects.
 *
 * Constraints (enforced by the queue, not us):
 *   • Only works for N minutes after Applied (retention window, default 5m).
 *   • Refuses if disk content no longer matches the recorded appliedContentHash
 *     (someone else — AI, user, external tool — touched the file afterwards).
 *   • One-shot: a successful undo deletes the queue entry.
 */
export function intentUndo(id: DiffTxId): IntentResult {
  const q = getUndoQueue()
  const r = q.undo(id)
  if (r.ok) return OK('Undone')
  return ERR(r.message)
}

// ---------------------------------------------------------------------------
// IPC wiring. Each handler is registered under a stable channel name; renderers use
// `window.electronAPI.diffTx.<method>()` (see preload). Handlers are thin and delegate
// to the pure functions above so unit tests can bypass IPC entirely.
// ---------------------------------------------------------------------------

let ipcInitialized = false

export function initDiffTxIntentsIpc(ipcMain: IpcMain): void {
  if (ipcInitialized) return
  ipcInitialized = true

  ipcMain.handle('diff-tx:intent-retry', (_event, id: unknown): IntentResult => {
    if (typeof id !== 'string') return ERR('id must be a string')
    return intentRetry(id as DiffTxId)
  })

  ipcMain.handle('diff-tx:intent-abort', (_event, id: unknown, reason?: unknown): IntentResult => {
    if (typeof id !== 'string') return ERR('id must be a string')
    return intentAbort(id as DiffTxId, typeof reason === 'string' ? reason : undefined)
  })

  ipcMain.handle('diff-tx:intent-rebase', (_event, id: unknown): IntentResult => {
    if (typeof id !== 'string') return ERR('id must be a string')
    return intentRebase(id as DiffTxId)
  })

  ipcMain.handle('diff-tx:intent-undo', (_event, id: unknown): IntentResult => {
    if (typeof id !== 'string') return ERR('id must be a string')
    return intentUndo(id as DiffTxId)
  })
}

/** Test-only reset. */
export function __resetDiffTxIntentsIpcForTests(): void {
  ipcInitialized = false
}
