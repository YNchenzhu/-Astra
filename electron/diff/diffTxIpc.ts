/**
 * IPC bridge between the main-process DiffTransactionStore and renderer subscribers.
 *
 * Channel contract:
 *   • `diff-tx:broadcast` — main → renderer. Carries a single `DtBroadcast` payload.
 *     The renderer mirror store treats the event stream as authoritative; on window reload
 *     it calls `diff-tx:request-snapshot` to get a full resync.
 *   • `diff-tx:request-snapshot` — renderer → main. Returns the current full snapshot.
 *
 * Intentionally no renderer-originated mutation channels yet: P1 is strictly read-only.
 * P2 will introduce `diff-tx:intent` (approve/reject/retry/rebase) with typed commands.
 */

import type { BrowserWindow, IpcMain } from 'electron'
import { getDiffTxStore } from './DiffTransactionStore'
import type { DtBroadcast } from './DiffTransactionTypes'

let currentWindow: BrowserWindow | null = null
let initialized = false
let unsubscribeStore: (() => void) | null = null

/**
 * Register IPC handlers and begin broadcasting. Safe to call multiple times (e.g. window
 * re-creation during HMR); later calls just swap the target window.
 */
export function initDiffTxIpc(ipcMain: IpcMain, mainWindow: BrowserWindow): void {
  currentWindow = mainWindow

  if (initialized) return
  initialized = true

  ipcMain.handle('diff-tx:request-snapshot', () => {
    return { transactions: getDiffTxStore().snapshot() }
  })

  unsubscribeStore = getDiffTxStore().addListener((event: DtBroadcast) => {
    sendToRenderer(event)
  })
}

/** Replace the current target window without re-registering handlers. */
export function setDiffTxIpcWindow(win: BrowserWindow): void {
  currentWindow = win
}

/** Send one broadcast event to the renderer, guarding against destroyed windows. */
function sendToRenderer(event: DtBroadcast): void {
  const win = currentWindow
  if (!win || win.isDestroyed()) return
  try {
    win.webContents.send('diff-tx:broadcast', event)
  } catch (e) {
    // Window lifecycle races (closing during send) are expected — avoid crashing the store.
    console.warn('[diffTxIpc] send failed (non-fatal):', e)
  }
}

/** Teardown hook for tests / app exit. */
export function shutdownDiffTxIpc(): void {
  if (unsubscribeStore) {
    unsubscribeStore()
    unsubscribeStore = null
  }
  currentWindow = null
  initialized = false
}
