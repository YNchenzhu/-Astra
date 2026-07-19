/**
 * DiffTransaction renderer bridge.
 *
 *   - `diff-tx:request-snapshot`      hydrate the renderer store on mount
 *   - `diff-tx:broadcast`             live authoritative deltas from main
 *   - `diff-tx:intent-{retry,abort,rebase,undo}`  per-intent operations
 */
import { ipcRenderer, type IpcRendererEvent } from 'electron'

export interface DiffTxApi {
  requestSnapshot: () => Promise<unknown>
  onBroadcast: (callback: (data: unknown) => void) => () => void
  intentRetry: (id: string) => Promise<unknown>
  intentAbort: (id: string, reason?: string) => Promise<unknown>
  intentRebase: (id: string) => Promise<unknown>
  intentUndo: (id: string) => Promise<unknown>
}

export function buildDiffTxApi(): DiffTxApi {
  return {
    requestSnapshot: () => ipcRenderer.invoke('diff-tx:request-snapshot'),
    onBroadcast: (callback) => {
      const handler = (_event: IpcRendererEvent, data: unknown) => callback(data)
      ipcRenderer.on('diff-tx:broadcast', handler)
      return () => ipcRenderer.removeListener('diff-tx:broadcast', handler)
    },
    intentRetry: (id) => ipcRenderer.invoke('diff-tx:intent-retry', id),
    intentAbort: (id, reason) => ipcRenderer.invoke('diff-tx:intent-abort', id, reason),
    intentRebase: (id) => ipcRenderer.invoke('diff-tx:intent-rebase', id),
    intentUndo: (id) => ipcRenderer.invoke('diff-tx:intent-undo', id),
  }
}
