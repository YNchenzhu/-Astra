/**
 * IPC bridge between the DiagnosticsHub and renderer subscribers.
 *
 *   Renderer invokes `diagnostics:get-snapshot` on startup (and after any
 *   gap in the revision stream) to rebuild its mirror state.
 *
 *   Main broadcasts `diagnostics:patch` events (debounced inside the Hub)
 *   to every non-destroyed BrowserWindow.
 *
 * Adaptive backpressure: when a window is blurred / hidden / minimized,
 * we withhold individual patches and instead accumulate the latest known
 * revision per window. On focus / show, we push the single freshest
 * snapshot and the renderer mirror jumps back to consistent state via its
 * built-in revision-gap detection. This keeps IDE operations (terminal,
 * settings dialog) responsive when the user isn't looking at Problems.
 */

import type { BrowserWindow, IpcMain } from 'electron'
import type { DiagnosticsHub, HubPatch, HubSnapshot } from './DiagnosticsHub'
import { getDiagnosticsHub } from './DiagnosticsHub'

interface BridgeOptions {
  getWindows: () => BrowserWindow[]
  hub?: DiagnosticsHub
}

export interface DiagnosticsIpcBridge {
  dispose(): void
}

/**
 * A window is "foreground" when it's focused AND visible. Blurred but visible
 * still counts as foreground (developer often has chat + IDE side-by-side).
 * Only when a window is minimized OR explicitly hidden do we throttle.
 */
function isForegroundWindow(win: BrowserWindow): boolean {
  try {
    if (win.isDestroyed()) return false
    if (win.isMinimized()) return false
    if (typeof win.isVisible === 'function' && !win.isVisible()) return false
    return true
  } catch {
    return true // fail-open: worst case we send an extra patch
  }
}

export function registerDiagnosticsIpcBridge(
  ipcMain: IpcMain,
  options: BridgeOptions,
): DiagnosticsIpcBridge {
  const hub = options.hub ?? getDiagnosticsHub()

  /**
   * Per-window backpressure state: the last revision we *successfully*
   * delivered, and a flag saying "there's a newer revision we withheld".
   */
  const deliveryState = new WeakMap<
    BrowserWindow,
    { lastDeliveredRevision: number; pending: boolean }
  >()
  /** Track windows we've wired focus listeners onto so we don't double-bind. */
  const wiredWindows = new WeakSet<BrowserWindow>()

  const snapshotHandler = async (): Promise<HubSnapshot> => {
    return hub.getSnapshot()
  }
  ipcMain.handle('diagnostics:get-snapshot', snapshotHandler)

  function flushPendingToWindow(win: BrowserWindow): void {
    const state = deliveryState.get(win)
    if (!state || !state.pending) return
    if (!isForegroundWindow(win)) return
    try {
      const snap = hub.getSnapshot()
      win.webContents.send('diagnostics:patch', {
        revision: snap.revision,
        updates: snap.files.map((f) => ({ uri: f.uri, diagnostics: f.diagnostics })),
        providerHealth: snap.providerHealth,
      } satisfies HubPatch)
      state.lastDeliveredRevision = snap.revision
      state.pending = false
    } catch (err) {
      console.warn(
        '[DiagnosticsBridge] pending flush on focus failed:',
        (err as Error).message,
      )
    }
  }

  function wireWindow(win: BrowserWindow): void {
    if (wiredWindows.has(win) || win.isDestroyed()) return
    wiredWindows.add(win)
    // Attaching to both 'focus' and 'restore' covers minimize-then-focus as
    // well as simple alt-tab returns.
    const onFocus = (): void => flushPendingToWindow(win)
    win.on('focus', onFocus)
    win.on('restore', onFocus)
    win.on('show', onFocus)
    win.once('closed', () => {
      win.removeListener('focus', onFocus)
      win.removeListener('restore', onFocus)
      win.removeListener('show', onFocus)
    })
  }

  const unsubscribe = hub.subscribe((patch: HubPatch) => {
    for (const win of options.getWindows()) {
      if (!win || win.isDestroyed()) continue
      wireWindow(win)
      let state = deliveryState.get(win)
      if (!state) {
        state = { lastDeliveredRevision: -1, pending: false }
        deliveryState.set(win, state)
      }
      if (!isForegroundWindow(win)) {
        // Skip delivery; mark pending — next focus will coalesce to the
        // freshest snapshot.
        state.pending = true
        continue
      }
      try {
        win.webContents.send('diagnostics:patch', patch)
        state.lastDeliveredRevision = patch.revision
        state.pending = false
      } catch (err) {
        console.warn('[DiagnosticsBridge] failed to send patch:', (err as Error).message)
      }
    }
  })

  return {
    dispose: () => {
      unsubscribe()
      ipcMain.removeHandler('diagnostics:get-snapshot')
    },
  }
}
