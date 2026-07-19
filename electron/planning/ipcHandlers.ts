/**
 * Planning IPC — exposes {@link getActivePlanStatus} to the renderer.
 *
 * The renderer header (`ChatPanel.tsx`) polls this every ~3 s to show
 * a `计划 N/M` indicator + open-plan-file button. Previously the
 * renderer's `getPlanningStatus` stub returned `null` because no
 * preload/main bridge existed; this handler is the minimal wire-up.
 */
import type { IpcMain } from 'electron'
import { getActivePlanStatus } from './planRuntime'

export function registerPlanningIpcHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('planning:get-status', () => {
    try {
      return getActivePlanStatus()
    } catch (err) {
      console.warn('[planning] getActivePlanStatus failed:', err)
      return null
    }
  })
}
