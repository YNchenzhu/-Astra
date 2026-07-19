/**
 * Watches the open workspace and notifies all BrowserWindows via `workspace:file-changed`
 * so the renderer file tree can refresh (same channel as workspaceFileNotify).
 *
 * Migration note: Uses fileWatcherManager (worker_threads) instead of direct
 * chokidar instance to keep the main process event loop responsive.
 */

import { BrowserWindow } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { fileWatcherManager } from '../watchers/fileWatcherManager'

const WATCHER_ID = 'workspace-explorer'

const IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  '.vscode',
  '.idea',
  'dist',
  'dist-electron',
  '.next',
  '.nuxt',
  '__pycache__',
  '.cache',
  'coverage',
  '.turbo',
])

let watchedRoot: string | null = null

function isIgnoredRelative(relPosix: string): boolean {
  if (!relPosix) return false
  for (const part of relPosix.split('/')) {
    if (IGNORE_DIRS.has(part)) return true
    if (part.startsWith('.') && part !== '.env.example') return true
  }
  return false
}

function broadcast(payload: {
  workspacePath: string
  filePath: string
  relativePath: string
  changeType: 'add' | 'change' | 'unlink'
}): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('workspace:file-changed', payload)
    }
  }
}

function emitChange(absPath: string, changeType: 'add' | 'change' | 'unlink'): void {
  if (!watchedRoot) return
  const normRoot = watchedRoot
  const normFile = path.resolve(absPath)
  const rootWithSep = normRoot.endsWith(path.sep) ? normRoot : normRoot + path.sep
  if (normFile !== normRoot && !normFile.startsWith(rootWithSep)) {
    return
  }
  const relativePath = path.relative(normRoot, normFile).replace(/\\/g, '/')
  if (!relativePath || relativePath.startsWith('..') || isIgnoredRelative(relativePath)) {
    return
  }
  broadcast({
    workspacePath: normRoot.replace(/\\/g, '/'),
    filePath: normFile.replace(/\\/g, '/'),
    relativePath,
    changeType,
  })
}

export async function startWorkspaceExplorerWatcher(
  workspacePath: string,
): Promise<{ success: boolean; error?: string }> {
  await stopWorkspaceExplorerWatcher()

  const trimmed = typeof workspacePath === 'string' ? workspacePath.trim() : ''
  if (!trimmed) {
    return { success: false, error: 'Workspace path is required' }
  }

  const normRoot = path.resolve(trimmed)
  if (!fs.existsSync(normRoot)) {
    return { success: false, error: `Directory not found: ${normRoot}` }
  }
  const st = fs.statSync(normRoot)
  if (!st.isDirectory()) {
    return { success: false, error: 'Workspace path must be a directory' }
  }

  try {
    watchedRoot = normRoot

    await fileWatcherManager.startWatcher({
      id: WATCHER_ID,
      paths: [normRoot],
      debounceMs: 300,
      options: {
        ignoreInitial: true,
        persistent: true,
        awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
        // ignored filtering is handled by emitChange's isIgnoredRelative check.
        // Functions cannot be cloned across postMessage (worker boundary).
      },
      onChange: (event) => {
        // chokidar emits five change types: add / change / unlink for files
        // and addDir / unlinkDir for directories.  Earlier code dropped the
        // `*Dir` events entirely, which meant terminal-side `mkdir foo`
        // (creating an empty directory) and `rmdir foo` were invisible to
        // the file tree until the next manual refresh.  We project the dir
        // events onto the existing `add` / `unlink` IPC channel so the
        // renderer-side subscriber type signature does not need to widen
        // (`'add' | 'change' | 'unlink'`) and downstream consumers that
        // only care about *files* (e.g. open-tab content reload in
        // useFileStore) keep ignoring them via the existing `change`
        // filter.
        switch (event.changeType) {
          case 'add':
          case 'change':
          case 'unlink':
            emitChange(event.filePath, event.changeType)
            return
          case 'addDir':
            emitChange(event.filePath, 'add')
            return
          case 'unlinkDir':
            emitChange(event.filePath, 'unlink')
            return
          default:
            return
        }
      },
      onError: (error) => {
        console.warn('[workspaceExplorerWatcher] watcher error:', error)
      },
    })

    return { success: true }
  } catch (e) {
    watchedRoot = null
    const msg = e instanceof Error ? e.message : String(e)
    return { success: false, error: msg }
  }
}

export async function stopWorkspaceExplorerWatcher(): Promise<{ success: boolean; error?: string }> {
  watchedRoot = null
  await fileWatcherManager.stopWatcher(WATCHER_ID)
  return { success: true }
}
