/**
 * Lifecycle + top-level log bridge.
 *
 * Owns:
 *   - `lifecycle.setBeforeQuitFlushHandler()` — renderer registers a
 *     flush callback; main broadcasts `lifecycle:before-quit-flush`
 *     during quit and waits (up to 2 s) for a `lifecycle:renderer-flush-done`
 *     reply before tearing down services. Registering/clearing is an
 *     atomic swap on a single module-scoped slot.
 *   - `onLifecycleLog(cb)` — subscribe to the "应用" Output tab's
 *     structured log stream forwarded from the bundle logger in main.
 */
import { ipcRenderer, type IpcRendererEvent } from 'electron'

let beforeQuitFlushHandler: (() => Promise<void> | void) | null = null

/**
 * Wire the main-process `lifecycle:before-quit-flush` → renderer handler
 * round-trip. Must be called once at preload load-time.
 */
export function installBeforeQuitFlushBridge(): void {
  ipcRenderer.on('lifecycle:before-quit-flush', async () => {
    try {
      if (beforeQuitFlushHandler) await beforeQuitFlushHandler()
    } catch (err) {
      console.error('[preload] before-quit flush failed', err)
    } finally {
      ipcRenderer.send('lifecycle:renderer-flush-done')
    }
  })
}

export interface LifecycleApi {
  setBeforeQuitFlushHandler: (fn: () => Promise<void> | void) => () => void
}

export function buildLifecycleApi(): LifecycleApi {
  return {
    setBeforeQuitFlushHandler: (fn) => {
      beforeQuitFlushHandler = fn
      return () => {
        beforeQuitFlushHandler = null
      }
    },
  }
}

export type LifecycleLogPayload = {
  channelId: string
  message: string
  type?: 'info' | 'warning' | 'error'
}

export type OnLifecycleLog = (
  callback: (payload: LifecycleLogPayload) => void,
) => () => void

export function buildOnLifecycleLog(): OnLifecycleLog {
  return (callback) => {
    const handler = (
      _event: IpcRendererEvent,
      payload: { channelId: string; message: string; type?: string },
    ) => {
      const type =
        payload.type === 'error'
          ? ('error' as const)
          : payload.type === 'warning'
            ? ('warning' as const)
            : ('info' as const)
      callback({
        channelId: payload.channelId,
        message: payload.message,
        type,
      })
    }
    ipcRenderer.on('lifecycle-log', handler)
    return () => ipcRenderer.removeListener('lifecycle-log', handler)
  }
}
