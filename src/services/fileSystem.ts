import type { FileNode, SearchResult } from '../types'

function getFS() {
  return typeof window !== 'undefined' && window.electronAPI?.fs ? window.electronAPI.fs : null
}

export async function readFile(filePath: string): Promise<string> {
  const fs = getFS()
  if (!fs) throw new Error('Not running in Electron')
  const result = await fs.readFile(filePath)
  if (!result.success) throw new Error(result.error)
  return result.content!
}

/** 读取二进制字节 —— 用于 docx/xlsx 的原格式预览等需要 ArrayBuffer 的场景。 */
export async function readFileBinary(filePath: string): Promise<Uint8Array> {
  const fs = getFS()
  if (!fs) throw new Error('Not running in Electron')
  const result = await fs.readFileBinary(filePath)
  if (!result.success) throw new Error(result.error)
  if (!result.bytes) throw new Error('readFileBinary: empty response')
  // IPC 透传后如果是普通对象,按原样包一层;大多数情况下它已经是 Uint8Array
  return result.bytes instanceof Uint8Array ? result.bytes : new Uint8Array(result.bytes)
}

/** 字节级复制(fs.copyFileSync)—— 二进制安全,文件树"复制/粘贴"专用。 */
export async function copyFileBinary(srcPath: string, destPath: string): Promise<void> {
  const fs = getFS()
  if (!fs) throw new Error('Not running in Electron')
  const result = await fs.copyFile(srcPath, destPath)
  if (!result.success) throw new Error(result.error)
}

export async function writeFile(filePath: string, content: string): Promise<void> {
  const fs = getFS()
  if (!fs) throw new Error('Not running in Electron')
  const result = await fs.writeFile(filePath, content)
  if (!result.success) throw new Error(result.error)
}

export async function getFileTree(dirPath: string, maxDepth: number = 3): Promise<FileNode[]> {
  const fs = getFS()
  if (!fs) {
    // Previously returned `[]` which the explorer rendered as "未找到文件" —
    // indistinguishable from an empty workspace. Throw so the workspace store
    // / sidebar shows the real "preload bridge missing" reason.
    throw new Error(
      'getFileTree: window.electronAPI.fs is not available (preload bridge missing).',
    )
  }
  const result = await fs.fileTree(dirPath, maxDepth)
  if (!result.success) throw new Error(result.error)
  return result.tree!
}

export async function statFile(filePath: string): Promise<{
  isFile: boolean
  isDirectory: boolean
  size: number
  mtime: string
}> {
  const fs = getFS()
  if (!fs) throw new Error('Not running in Electron')
  const result = await fs.stat(filePath)
  if (!result.success) throw new Error(result.error)
  return {
    isFile: result.isFile!,
    isDirectory: result.isDirectory!,
    size: result.size!,
    mtime: result.mtime!,
  }
}

export async function fileExists(filePath: string): Promise<boolean> {
  const fs = getFS()
  if (!fs) return false
  const result = await fs.exists(filePath)
  if (!result.success) return false
  return Boolean(result.exists)
}

export async function deleteFile(filePath: string): Promise<void> {
  const fs = getFS()
  if (!fs) throw new Error('Not running in Electron')
  const result = await fs.delete(filePath)
  if (!result.success) throw new Error(result.error)
}

export async function createDir(dirPath: string): Promise<void> {
  const fs = getFS()
  if (!fs) throw new Error('Not running in Electron')
  const result = await fs.createDir(dirPath)
  if (!result.success) throw new Error(result.error)
}

export async function renameInWorkspace(
  workspaceRoot: string,
  fromRelative: string,
  toRelative: string,
): Promise<void> {
  const fs = getFS()
  if (!fs?.renameInWorkspace) throw new Error('Not running in Electron')
  const result = await fs.renameInWorkspace(workspaceRoot, fromRelative, toRelative)
  if (!result.success) throw new Error(result.error || '重命名失败')
}

export async function openFolderDialog(options?: {
  title?: string
  defaultPath?: string
}): Promise<string | null> {
  const fs = getFS()
  if (!fs) {
    // Surface this case loudly — otherwise the renderer silently returns null
    // and any caller (e.g. the sidebar "打开文件夹" blue button) looks broken
    // with zero feedback. This is the #1 reason that button appears dead in
    // the wild: preload failed / contextBridge disabled / running under a
    // stripped-down webview. Throw so the caller's try/catch (or the global
    // unhandled-rejection handler) can tell the user something is wrong.
    throw new Error(
      'openFolderDialog: window.electronAPI.fs is not available (preload script did not expose the fs bridge).',
    )
  }
  const result = await fs.openDialog({ ...options, properties: ['openDirectory'] })
  if (result.canceled || result.paths.length === 0) return null
  return result.paths[0]
}

export async function openFileDialog(options?: {
  title?: string
  defaultPath?: string
  filters?: { name: string; extensions: string[] }[]
}): Promise<string | null> {
  const fs = getFS()
  if (!fs) {
    throw new Error(
      'openFileDialog: window.electronAPI.fs is not available (preload script did not expose the fs bridge).',
    )
  }
  const result = await fs.openDialog({ ...options, properties: ['openFile'] })
  if (result.canceled || result.paths.length === 0) return null
  return result.paths[0]
}

/** 弹出系统"另存为"对话框,返回用户选择的绝对路径;取消返回 null。 */
export async function saveFileDialog(options?: {
  title?: string
  defaultPath?: string
  filters?: { name: string; extensions: string[] }[]
}): Promise<string | null> {
  const fs = getFS()
  if (!fs?.saveDialog) {
    throw new Error(
      'saveFileDialog: window.electronAPI.fs.saveDialog is not available (preload bridge missing or outdated).',
    )
  }
  const result = await fs.saveDialog(options)
  if (result.canceled || !result.path) return null
  return result.path
}

export async function startWorkspaceWatcher(workspacePath: string): Promise<void> {
  const fs = getFS()
  if (!fs?.startWorkspaceWatcher) return
  const result = await fs.startWorkspaceWatcher(workspacePath)
  if (!result.success) throw new Error(result.error)
}

export async function stopWorkspaceWatcher(): Promise<void> {
  const fs = getFS()
  if (!fs?.stopWorkspaceWatcher) return
  const result = await fs.stopWorkspaceWatcher()
  if (!result.success) throw new Error(result.error)
}

export function onWorkspaceFileChanged(callback: (payload: {
  workspacePath: string
  filePath: string
  relativePath: string
  changeType: 'add' | 'change' | 'unlink'
}) => void): (() => void) {
  const fs = getFS()
  if (!fs?.onWorkspaceFileChanged) return () => {}
  return fs.onWorkspaceFileChanged(callback)
}

export async function searchWorkspace(params: {
  dirPath: string
  query: string
  maxResults?: number
  maxMatchesPerFile?: number
}): Promise<{ results: SearchResult[]; truncated: boolean }> {
  const fs = getFS()
  if (!fs) {
    // Old behavior returned `{ results: [], truncated: false }` which the
    // search panel rendered as "no results" — masking preload-bridge failure
    // as "user typed a query nobody matched". Throw so the panel surfaces it.
    throw new Error(
      'searchWorkspace: window.electronAPI.fs is not available (preload bridge missing).',
    )
  }
  const result = await fs.search(params)
  if (!result.success) throw new Error(result.error)
  return {
    results: (result.results as SearchResult[]) || [],
    truncated: !!result.truncated,
  }
}
