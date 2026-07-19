/**
 * Frameless-window chrome controls invoked from the custom TitleBar
 * component (`src/components/TitleBar`).
 *
 *   - `window:minimize`
 *   - `window:maximize`  (toggles maximize ↔ unmaximize)
 *   - `window:close`     flushes any pending settings save first so the
 *                        final window-closed event doesn't race against
 *                        writeJsonFileAtomic fsync.
 */
import type { IpcMain } from 'electron'
import { getMainWindow } from '../../window/mainWindow'
import { waitForPendingSaves } from '../../settings/settingsStore'

export function registerWindowHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('window:minimize', () => {
    getMainWindow()?.minimize()
  })

  ipcMain.handle('window:maximize', () => {
    const mainWindow = getMainWindow()
    if (mainWindow?.isMaximized()) {
      mainWindow.unmaximize()
    } else {
      mainWindow?.maximize()
    }
  })

  ipcMain.handle('window:close', async () => {
    await waitForPendingSaves()
    getMainWindow()?.close()
  })
}
