/**
 * Push workspace file mutations to renderer so the explorer refreshes without relying solely on chokidar
 * (AI tools use temp+rename; watcher can miss or be delayed).
 */

import { BrowserWindow } from 'electron'
import path from 'node:path'
import { getWorkspacePath } from '../tools/workspaceState'

export function notifyWorkspaceFileMutation(
  absoluteResolvedPath: string,
  changeType: 'add' | 'change' | 'unlink',
): void {
  const root = getWorkspacePath()
  if (!root || typeof absoluteResolvedPath !== 'string' || !absoluteResolvedPath.trim()) return

  const normRoot = path.resolve(root)
  const normFile = path.resolve(absoluteResolvedPath)
  const rootWithSep = normRoot.endsWith(path.sep) ? normRoot : normRoot + path.sep
  if (normFile !== normRoot && !normFile.startsWith(rootWithSep)) {
    return
  }

  const relativePath = path.relative(normRoot, normFile).replace(/\\/g, '/')
  if (!relativePath || relativePath.startsWith('..')) {
    return
  }

  const payload = {
    workspacePath: normRoot.replace(/\\/g, '/'),
    filePath: normFile.replace(/\\/g, '/'),
    relativePath,
    changeType,
  }

  const windows = BrowserWindow?.getAllWindows?.()
  if (!windows) {
    return
  }

  for (const windowInstance of windows) {
    if (!windowInstance.isDestroyed()) {
      windowInstance.webContents.send('workspace:file-changed', payload)
    }
  }
}
