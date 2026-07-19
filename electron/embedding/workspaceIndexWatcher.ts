/**
 * Workspace index watcher — migrated to use fileWatcherManager.
 *
 * Keeps the active workspace's semantic index warm after the user edits files:
 *   - add/change -> incremental patch of the current exact-fp namespace
 *   - unlink     -> remove that file's chunks from the namespace
 *   - current fp namespace missing? queue a lazy full rebuild instead
 *
 * This is intentionally best-effort. Errors are logged and swallowed — the user
 * can always click "重建索引" manually in Settings if the watcher misses a case.
 *
 * Migration note: Uses fileWatcherManager (worker_threads) instead of direct
 * chokidar instance to keep the main process event loop responsive.
 */

import path from 'node:path'
import { fileWatcherManager } from '../watchers/fileWatcherManager'
import {
  incrementallyUpdateWorkspaceIndex,
} from './workspaceIndex'

const WATCHER_ID = 'workspace-index'
const DEBOUNCE_MS = 1200

let watchedRoot: string | null = null
const pendingChanged = new Set<string>()
const pendingRemoved = new Set<string>()
let flushTimer: NodeJS.Timeout | null = null

function clearPending(): void {
  pendingChanged.clear()
  pendingRemoved.clear()
}

async function flushPending(): Promise<void> {
  const root = watchedRoot
  if (!root) {
    clearPending()
    return
  }
  const changed = [...pendingChanged]
  const removed = [...pendingRemoved]
  clearPending()
  if (changed.length === 0 && removed.length === 0) return
  try {
    await incrementallyUpdateWorkspaceIndex(root, changed, removed)
  } catch (err) {
    console.warn(
      '[workspaceIndexWatcher] incremental update failed:',
      err instanceof Error ? err.message : String(err),
    )
  }
}

function scheduleFlush(): void {
  if (flushTimer) clearTimeout(flushTimer)
  flushTimer = setTimeout(() => {
    flushTimer = null
    void flushPending()
  }, DEBOUNCE_MS)
}

export async function stopWorkspaceIndexWatcher(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  clearPending()
  watchedRoot = null
  await fileWatcherManager.stopWatcher(WATCHER_ID)
}

export async function startWorkspaceIndexWatcher(root: string | null | undefined): Promise<void> {
  const normalized = typeof root === 'string' && root.trim()
    ? path.resolve(root.trim())
    : null
  if (!normalized) {
    await stopWorkspaceIndexWatcher()
    return
  }
  if (watchedRoot === normalized && fileWatcherManager.isWatcherActive(WATCHER_ID)) return
  await stopWorkspaceIndexWatcher()

  watchedRoot = normalized

  await fileWatcherManager.startWatcher({
    id: WATCHER_ID,
    paths: [normalized],
    debounceMs: DEBOUNCE_MS,
    options: {
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 80 },
      // Serializable glob patterns — functions cannot cross the worker boundary.
      ignored: [
        '**/node_modules',
        '**/node_modules/**',
        '**/.git',
        '**/.git/**',
        '**/dist',
        '**/dist/**',
        '**/dist-electron',
        '**/dist-electron/**',
        '**/.next',
        '**/.next/**',
        '**/.cursor',
        '**/.cursor/**',
        '**/.claude',
        '**/.claude/**',
        '**/coverage',
        '**/coverage/**',
      ],
    },
    onChange: (event) => {
      if (event.changeType === 'unlink') {
        pendingChanged.delete(event.filePath)
        pendingRemoved.add(event.filePath)
      } else if (event.changeType === 'add' || event.changeType === 'change') {
        pendingRemoved.delete(event.filePath)
        pendingChanged.add(event.filePath)
      }
      scheduleFlush()
    },
    onError: (error) => {
      console.warn(
        '[workspaceIndexWatcher] watcher error:',
        error,
      )
    },
  })
}
