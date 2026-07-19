/**
 * FileChanged hook watcher.
 *
 * Uses chokidar to watch filesystem changes and trigger FileChanged hooks.
 * Supports static matchers from hook config and dynamic watchPaths from hook responses.
 *
 * Events are batched with a trailing-edge debounce (BATCH_DEBOUNCE_MS) and
 * processed with a concurrency limit (MAX_CONCURRENT_HOOKS) to prevent hook
 * storms during large operations like git checkout or npm install.
 */

import type { FSWatcher } from 'chokidar'
import { hasHooksForEvent } from './config'
import { runFileChangedHooks } from './engine'

const BATCH_DEBOUNCE_MS = 300
const MAX_CONCURRENT_HOOKS = 3
const MAX_BATCH_SIZE = 50

let currentWatcher: FSWatcher | null = null
let currentWatchPaths: Set<string> = new Set()

type FileEvent = 'change' | 'add' | 'unlink'

const pendingEvents = new Map<string, FileEvent>()
let flushTimer: ReturnType<typeof setTimeout> | null = null
let batchCwd: string | null = null

/**
 * Enqueue a file event for batched processing.
 * Same-file events within a batch window are deduplicated (last event wins).
 */
function enqueueEvent(filePath: string, event: FileEvent, cwd: string): void {
  pendingEvents.set(filePath, event)
  batchCwd = cwd

  if (flushTimer) clearTimeout(flushTimer)
  flushTimer = setTimeout(() => void flushBatch(), BATCH_DEBOUNCE_MS)
}

/**
 * Drain pending events and run hooks with concurrency control.
 */
async function flushBatch(): Promise<void> {
  flushTimer = null
  const cwd = batchCwd
  if (!cwd || pendingEvents.size === 0) return

  const allEntries = [...pendingEvents.entries()]
  pendingEvents.clear()

  if (allEntries.length > MAX_BATCH_SIZE) {
    console.warn(
      `[FileWatcher] Batch truncated: ${allEntries.length} events → ${MAX_BATCH_SIZE}. ` +
      'Excess events discarded to prevent hook storm.',
    )
  }
  const batch = allEntries.slice(0, MAX_BATCH_SIZE)

  console.log(`[FileWatcher] Flushing batch: ${batch.length} file events`)

  // Process with concurrency limit using a simple semaphore
  let running = 0
  let idx = 0
  await new Promise<void>((resolve) => {
    const next = (): void => {
      while (running < MAX_CONCURRENT_HOOKS && idx < batch.length) {
        const [filePath, event] = batch[idx++]
        running++
        handleFileEvent(filePath, event, cwd).finally(() => {
          running--
          next()
        })
      }
      if (running === 0 && idx >= batch.length) resolve()
    }
    next()
  })
}

/**
 * Start or restart the file watcher for FileChanged hooks.
 * Watches files that match hook matchers, plus any dynamic watchPaths.
 */
export async function startFileWatcher(
  workspacePath: string,
  extraWatchPaths?: string[],
): Promise<void> {
  // Stop existing watcher
  await stopFileWatcher()

  if (!hasHooksForEvent('FileChanged')) {
    return
  }

  // Collect watch targets
  const targets = new Set<string>()

  // Add extra paths (from hook responses or session state)
  if (extraWatchPaths) {
    for (const p of extraWatchPaths) {
      targets.add(p)
    }
  }

  // For FileChanged hooks, the matcher is used as filename pattern
  // We watch the workspace root and filter by matcher at hook execution time
  targets.add(workspacePath)

  currentWatchPaths = targets

  try {
    const chokidar = await import('chokidar')
    currentWatcher = chokidar.watch(Array.from(targets), {
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 500,
        pollInterval: 200,
      },
      cwd: workspacePath,
    })

    currentWatcher.on('change', (filePath) => {
      enqueueEvent(pathJoin(workspacePath, filePath), 'change', workspacePath)
    })

    currentWatcher.on('add', (filePath) => {
      enqueueEvent(pathJoin(workspacePath, filePath), 'add', workspacePath)
    })

    currentWatcher.on('unlink', (filePath) => {
      enqueueEvent(pathJoin(workspacePath, filePath), 'unlink', workspacePath)
    })

    console.log(`[FileWatcher] Started watching: ${workspacePath}`)
  } catch (err) {
    console.error('[FileWatcher] Failed to start file watcher:', err)
  }
}

/**
 * Stop the current file watcher.
 */
export async function stopFileWatcher(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  pendingEvents.clear()
  batchCwd = null

  if (currentWatcher) {
    try {
      await currentWatcher.close()
    } catch {
      // ignore
    }
    currentWatcher = null
    currentWatchPaths.clear()
  }
}

/**
 * Handle a file change event and run matching hooks.
 */
async function handleFileEvent(
  filePath: string,
  event: FileEvent,
  cwd: string,
): Promise<void> {
  const { response, results } = await runFileChangedHooks(filePath, cwd)

  if (results.length > 0) {
    console.log(`[FileWatcher] ${event}: ${filePath} — ${results.length} hooks triggered`)
  }

  // Collect dynamic watchPaths from hook responses
  if (response?.systemMessage) {
    console.log(`[FileWatcher] Hook message: ${response.systemMessage}`)
  }
}

/**
 * Simple path join that handles Windows backslash conversion.
 */
function pathJoin(a: string, b: string): string {
  const sep = process.platform === 'win32' ? '\\' : '/'
  return a.endsWith(sep) ? a + b : a + sep + b
}
