/**
 * Barrel file for core file tools.
 *
 * Implementations have been split into per-tool modules:
 *   - toolReadFile.ts
 *   - toolWriteFile.ts
 *   - toolEditFile.ts
 *   - toolListFiles.ts
 *   - fileEditSemantics.ts (shared edit logic)
 *
 * This file re-exports their public APIs for backward compatibility and
 * hosts the IPC handler registration (`registerToolHandlers`).
 */

export type { ToolResult } from '../tools/types'

export {
  computeFileEditResult,
  computeFileEditResultMulti,
  MAX_EDIT_FILE_BYTES,
  formatFileSize,
  normalizeFileEditInput,
  normalizeOneFileEdit,
  stripTrailingWhitespace,
  desanitizeMatchString,
} from './fileEditSemantics'

export { toolReadFile } from './toolReadFile'
export { toolWriteFile } from './toolWriteFile'
export { toolEditFile } from './toolEditFile'
export { toolMultiEditFile } from './toolMultiEditFile'
export { toolListFiles } from './toolListFiles'

import { toolReadFile } from './toolReadFile'
import { toolWriteFile } from './toolWriteFile'
import { toolEditFile } from './toolEditFile'
import { toolListFiles } from './toolListFiles'

// ========== Register as IPC handlers ==========

export function registerToolHandlers(ipcMain: Electron.IpcMain): void {
  ipcMain.handle('tool:read-file', (_event, filePath: string, options?: { offset?: number; limit?: number }) => {
    return toolReadFile(filePath, options)
  })

  ipcMain.handle('tool:write-file', (_event, filePath: string, content: string) => {
    return toolWriteFile(filePath, content)
  })

  ipcMain.handle(
    'tool:edit-file',
    (
      _event,
      filePath: string,
      oldString: string,
      newString: string,
      options?: {
        replaceAll?: boolean
        baseReadId?: string
        expectedLineRange?: readonly [number, number]
        hashAnchor?: { startLine: number; startHash: string; endLine?: number; endHash?: string }
      },
    ) => {
      return toolEditFile(filePath, oldString, newString, options)
    },
  )

  ipcMain.handle('tool:list-files', (_event, dirPath: string) => {
    return toolListFiles(dirPath)
  })
}
