/**
 * Skill directory change detector — migrated to use fileWatcherManager.
 *
 * Watches user/project skill directories for file changes and triggers
 * cache invalidation + notifies subscribers. Uses debouncing to merge
 * batch changes (e.g. git checkout touching many files at once).
 *
 * Migration note: Uses fileWatcherManager (worker_threads) instead of direct
 * chokidar instance to keep the main process event loop responsive.
 */

import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { fileWatcherManager } from '../watchers/fileWatcherManager'

/** Debounce window for rapid skill changes (ms) */
const RELOAD_DEBOUNCE_MS = 300

const WATCHER_ID = 'skill-detector'

let reloadTimer: ReturnType<typeof setTimeout> | null = null
const pendingChangedPaths = new Set<string>()
let initialized = false
let disposed = false

const listeners = new Set<() => void>()

/**
 * Get skill directory paths to watch.
 * Checks multiple conventions: .cursor/skills, .claude/skills, .agents/skills
 * at both user and project levels.
 */
async function getWatchablePaths(workspaceDir: string): Promise<string[]> {
  const paths: string[] = []
  const homeDir = os.homedir()

  // User-level skill directories
  const userPaths = [
    path.join(homeDir, '.cursor', 'skills'),
    path.join(homeDir, '.claude', 'skills'),
  ]
  for (const p of userPaths) {
    try {
      await fs.promises.stat(p)
      paths.push(p)
    } catch {
      // Directory doesn't exist, skip
    }
  }

  // Project-level skill directories (relative to workspace)
  const projectPaths = [
    path.join(workspaceDir, '.cursor', 'skills'),
    path.join(workspaceDir, '.agents', 'skills'),
    path.join(workspaceDir, '.claude', 'skills'),
  ]
  for (const p of projectPaths) {
    try {
      await fs.promises.stat(p)
      paths.push(p)
    } catch {
      // Directory doesn't exist, skip
    }
  }

  return paths
}

/**
 * Debounce rapid skill changes into a single reload event.
 */
function scheduleReload(changedPath: string): void {
  pendingChangedPaths.add(changedPath)
  if (reloadTimer) clearTimeout(reloadTimer)
  reloadTimer = setTimeout(() => {
    reloadTimer = null
    const changedPaths = [...pendingChangedPaths]
    pendingChangedPaths.clear()

    console.log(`[skill-watcher] ${changedPaths.length} file(s) changed, notifying listeners`)

    // Notify all subscribers
    for (const listener of listeners) {
      try {
        listener()
      } catch (err) {
        console.error('[skill-watcher] listener error:', err)
      }
    }
  }, RELOAD_DEBOUNCE_MS)
}

/**
 * Initialize file watching for skill directories.
 * @param workspaceDir - The project workspace root
 */
export async function initialize(workspaceDir: string): Promise<void> {
  if (initialized || disposed) return

  const watchPaths = await getWatchablePaths(workspaceDir)
  if (watchPaths.length === 0) {
    initialized = false
    return
  }

  console.log(`[skill-watcher] Watching: ${watchPaths.join(', ')}`)

  await fileWatcherManager.startWatcher({
    id: WATCHER_ID,
    paths: watchPaths,
    debounceMs: RELOAD_DEBOUNCE_MS,
    options: {
      ignoreInitial: true,
      persistent: true,
      depth: 2,
      awaitWriteFinish: { stabilityThreshold: 1000, pollInterval: 500 },
      ignorePermissionErrors: true,
      usePolling: process.platform === 'win32',
      interval: 2000,
      atomic: true,
    },
    onChange: (event) => {
      scheduleReload(event.filePath)
    },
    onError: (error) => {
      console.error('[skill-watcher] watcher error:', error)
    },
  })

  initialized = true
}

/**
 * Subscribe to skill change events.
 * @returns Unsubscribe function
 */
export function subscribe(callback: () => void): () => void {
  listeners.add(callback)
  return () => {
    listeners.delete(callback)
  }
}

/**
 * Dispose of the file watcher.
 */
export async function dispose(): Promise<void> {
  disposed = true
  if (reloadTimer) {
    clearTimeout(reloadTimer)
    reloadTimer = null
  }
  pendingChangedPaths.clear()
  listeners.clear()
  initialized = false
  await fileWatcherManager.stopWatcher(WATCHER_ID)
}
