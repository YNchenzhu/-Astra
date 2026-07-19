/**
 * Unified File Watcher Worker
 * 
 * Runs in a separate worker_threads process to isolate file system watching
 * from the main process event loop. Manages multiple chokidar watchers and
 * forwards file change events via IPC.
 * 
 * Benefits:
 * - Main process event loop stays responsive
 * - Multiple watchers share one worker process
 * - File system events don't block UI
 * - Watcher errors don't crash main process
 */

import { parentPort } from 'node:worker_threads'
import chokidar, { type FSWatcher } from 'chokidar'
import path from 'node:path'

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface WatcherConfig {
  id: string
  paths: string[]
  options: Record<string, unknown>
  debounceMs?: number
}

interface WorkerMessage {
  type: 'start' | 'stop' | 'stop-all' | 'ping'
  watcherId?: string
  config?: WatcherConfig
}

interface WorkerResponse {
  type: 'started' | 'stopped' | 'error' | 'file-changed' | 'pong'
  watcherId?: string
  error?: string
  event?: {
    changeType: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir'
    filePath: string
    relativePath?: string
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────

type ChokidarChangeType = NonNullable<WorkerResponse['event']>['changeType']

const watchers = new Map<string, {
  watcher: FSWatcher
  config: WatcherConfig
  debounceTimer: NodeJS.Timeout | null
  pendingEvents: Map<string, { changeType: ChokidarChangeType; filePath: string }>
}>()

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function sendMessage(msg: WorkerResponse): void {
  if (parentPort) {
    parentPort.postMessage(msg)
  }
}

function scheduleFlush(watcherId: string): void {
  const entry = watchers.get(watcherId)
  if (!entry) return

  if (entry.debounceTimer) {
    clearTimeout(entry.debounceTimer)
  }

  const debounceMs = entry.config.debounceMs ?? 0
  if (debounceMs === 0) {
    flushPendingEvents(watcherId)
    return
  }

  entry.debounceTimer = setTimeout(() => {
    entry.debounceTimer = null
    flushPendingEvents(watcherId)
  }, debounceMs)
}

function flushPendingEvents(watcherId: string): void {
  const entry = watchers.get(watcherId)
  if (!entry || entry.pendingEvents.size === 0) return

  for (const [, event] of entry.pendingEvents) {
    sendMessage({
      type: 'file-changed',
      watcherId,
      event: {
        changeType: event.changeType,
        filePath: event.filePath,
      },
    })
  }

  entry.pendingEvents.clear()
}

function addPendingEvent(
  watcherId: string,
  changeType: ChokidarChangeType,
  filePath: string,
): void {
  const entry = watchers.get(watcherId)
  if (!entry) return

  entry.pendingEvents.set(filePath, { changeType, filePath })
  scheduleFlush(watcherId)
}

// ─────────────────────────────────────────────────────────────────────────────
// Watcher Management
// ─────────────────────────────────────────────────────────────────────────────

async function startWatcher(config: WatcherConfig): Promise<void> {
  // Stop existing watcher with same ID
  if (watchers.has(config.id)) {
    await stopWatcher(config.id)
  }

  try {
    const watcher = chokidar.watch(config.paths, {
      ...config.options,
      ignoreInitial: true, // Always ignore initial scan
    })

    const entry = {
      watcher,
      config,
      debounceTimer: null,
      pendingEvents: new Map<string, { changeType: ChokidarChangeType; filePath: string }>(),
    }

    watchers.set(config.id, entry)

    // Register event handlers
    watcher.on('add', (absPath: string) => {
      addPendingEvent(config.id, 'add', path.resolve(absPath))
    })

    watcher.on('change', (absPath: string) => {
      addPendingEvent(config.id, 'change', path.resolve(absPath))
    })

    watcher.on('unlink', (absPath: string) => {
      addPendingEvent(config.id, 'unlink', path.resolve(absPath))
    })

    watcher.on('addDir', (absPath: string) => {
      addPendingEvent(config.id, 'addDir', path.resolve(absPath))
    })

    watcher.on('unlinkDir', (absPath: string) => {
      addPendingEvent(config.id, 'unlinkDir', path.resolve(absPath))
    })

    watcher.on('error', (err: unknown) => {
      sendMessage({
        type: 'error',
        watcherId: config.id,
        error: err instanceof Error ? err.message : String(err),
      })
    })

    sendMessage({
      type: 'started',
      watcherId: config.id,
    })
  } catch (error) {
    sendMessage({
      type: 'error',
      watcherId: config.id,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

async function stopWatcher(watcherId: string): Promise<void> {
  const entry = watchers.get(watcherId)
  if (!entry) return

  if (entry.debounceTimer) {
    clearTimeout(entry.debounceTimer)
    entry.debounceTimer = null
  }

  // Flush any pending events before stopping
  flushPendingEvents(watcherId)

  try {
    await entry.watcher.close()
  } catch {
    // Ignore close errors
  }

  watchers.delete(watcherId)

  sendMessage({
    type: 'stopped',
    watcherId,
  })
}

async function stopAllWatchers(): Promise<void> {
  const ids = Array.from(watchers.keys())
  await Promise.all(ids.map(id => stopWatcher(id)))
}

// ─────────────────────────────────────────────────────────────────────────────
// Message Handler
// ─────────────────────────────────────────────────────────────────────────────

if (parentPort) {
  parentPort.on('message', async (msg: WorkerMessage) => {
    try {
      switch (msg.type) {
        case 'start':
          if (msg.config) {
            await startWatcher(msg.config)
          }
          break

        case 'stop':
          if (msg.watcherId) {
            await stopWatcher(msg.watcherId)
          }
          break

        case 'stop-all':
          await stopAllWatchers()
          break

        case 'ping':
          sendMessage({ type: 'pong' })
          break

        default: {
          // `msg` is narrowed to `never` here because every branch of the
          // discriminated union above was handled.  Treat it as an opaque
          // record purely to extract a printable `type` for diagnostics.
          const unknownType = (msg as { type?: unknown }).type
          sendMessage({
            type: 'error',
            error: `Unknown message type: ${String(unknownType)}`,
          })
        }
      }
    } catch (error) {
      sendMessage({
        type: 'error',
        watcherId: msg.watcherId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Graceful Shutdown
// ─────────────────────────────────────────────────────────────────────────────

process.on('SIGTERM', async () => {
  await stopAllWatchers()
  process.exit(0)
})

process.on('SIGINT', async () => {
  await stopAllWatchers()
  process.exit(0)
})
