/**
 * File Watcher Manager
 * 
 * Manages the file watcher worker process and provides a clean API for
 * registering/unregistering file watchers. All file system watching is
 * delegated to a worker_threads process to keep the main process responsive.
 * 
 * Usage:
 * ```typescript
 * import { fileWatcherManager } from './fileWatcherManager'
 * 
 * // Start a watcher
 * await fileWatcherManager.startWatcher({
 *   id: 'workspace-index',
 *   paths: ['/path/to/workspace'],
 *   options: { ignored: /node_modules/ },
 *   debounceMs: 1200,
 *   onChange: (event) => {
 *     console.log('File changed:', event.filePath)
 *   },
 * })
 * 
 * // Stop a watcher
 * await fileWatcherManager.stopWatcher('workspace-index')
 * ```
 */

import { Worker } from 'node:worker_threads'
import path from 'node:path'

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface FileChangeEvent {
  changeType: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir'
  filePath: string
  relativePath?: string
}

export interface WatcherConfig {
  id: string
  paths: string[]
  options?: Record<string, unknown>
  debounceMs?: number
  onChange: (event: FileChangeEvent) => void
  onError?: (error: string) => void
}

interface WorkerMessage {
  type: 'start' | 'stop' | 'stop-all' | 'ping'
  watcherId?: string
  config?: {
    id: string
    paths: string[]
    options: Record<string, unknown>
    debounceMs?: number
  }
}

interface WorkerResponse {
  type: 'started' | 'stopped' | 'error' | 'file-changed' | 'pong'
  watcherId?: string
  error?: string
  event?: FileChangeEvent
}

// ─────────────────────────────────────────────────────────────────────────────
// Sanitize options for Worker.postMessage (structured-clone boundary)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Strip non-serializable values (functions, Symbols, class instances) from
 * chokidar options before sending them across the worker_threads boundary.
 *
 * Structured clone (used by `Worker.postMessage`) rejects:
 *   - Functions (including arrow functions and methods)
 *   - Symbols
 *   - DOM nodes (not relevant here)
 *   - Class instances with prototype chains
 *
 * Callers should pass serializable `ignored` patterns (glob strings or
 * RegExp) instead of callback functions.  This helper strips any remaining
 * function values and logs a warning so the source can be fixed.
 */
function sanitizeOptionsForWorker(
  options: Record<string, unknown>,
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(options)) {
    if (typeof value === 'function') {
      console.warn(
        `[FileWatcherManager] Stripping non-serializable option "${key}" (function) from watcher config. ` +
        `Use serializable glob strings or RegExp instead.`,
      )
      continue
    }
    sanitized[key] = value
  }
  return sanitized
}

// ─────────────────────────────────────────────────────────────────────────────
// File Watcher Manager
// ─────────────────────────────────────────────────────────────────────────────

class FileWatcherManager {
  private worker: Worker | null = null
  private watchers = new Map<string, WatcherConfig>()
  private starting = false
  private stopping = false

  /**
   * Initialize the worker process. Called automatically on first use.
   */
  private async ensureWorker(): Promise<void> {
    if (this.worker) return
    if (this.starting) {
      // Wait for worker to start
      while (this.starting) {
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      return
    }

    this.starting = true

    try {
      const workerPath = path.join(__dirname, 'fileWatcherWorker.js')
      this.worker = new Worker(workerPath)

      this.worker.on('message', (msg: WorkerResponse) => {
        this.handleWorkerMessage(msg)
      })

      this.worker.on('error', (error: Error) => {
        console.error('[FileWatcherManager] Worker error:', error)
        // Notify all watchers
        for (const config of this.watchers.values()) {
          config.onError?.(error.message)
        }
      })

      this.worker.on('exit', (code: number) => {
        if (code !== 0 && !this.stopping) {
          console.error(`[FileWatcherManager] Worker exited with code ${code}`)
        }
        this.worker = null
        // Drop watcher configs whose worker-side state died with the process.
        // Without this the Map keeps every WatcherConfig (including its
        // onChange/onError closures) alive until the manager is disposed,
        // and a subsequent ensureWorker() spawns a fresh worker that knows
        // nothing about the orphaned IDs — leaving callers permanently
        // wired to a watcher that will never fire.
        this.watchers.clear()
      })

      // Verify worker is alive
      await this.ping()
    } finally {
      this.starting = false
    }
  }

  /**
   * Handle messages from the worker process.
   */
  private handleWorkerMessage(msg: WorkerResponse): void {
    switch (msg.type) {
      case 'started':
        // Worker confirmed watcher started
        break

      case 'stopped':
        // Worker confirmed watcher stopped
        if (msg.watcherId) {
          this.watchers.delete(msg.watcherId)
        }
        break

      case 'error':
        if (msg.watcherId) {
          const config = this.watchers.get(msg.watcherId)
          if (config && msg.error) {
            config.onError?.(msg.error)
          }
        }
        console.error(`[FileWatcherManager] Error from watcher ${msg.watcherId}:`, msg.error)
        break

      case 'file-changed':
        if (msg.watcherId && msg.event) {
          const config = this.watchers.get(msg.watcherId)
          if (config) {
            config.onChange(msg.event)
          }
        }
        break

      case 'pong':
        // Worker is alive
        break

      default: {
        const unknownType = (msg as { type?: unknown }).type
        console.warn('[FileWatcherManager] Unknown message type:', unknownType)
      }
    }
  }

  /**
   * Ping the worker to verify it's alive.
   */
  private async ping(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.worker) {
        reject(new Error('Worker not initialized'))
        return
      }

      const worker = this.worker
      const handler = (msg: WorkerResponse) => {
        if (msg.type === 'pong') {
          clearTimeout(timeout)
          worker.off('message', handler)
          resolve()
        }
      }
      const timeout = setTimeout(() => {
        // On timeout the resolve path never runs, so the message listener
        // would otherwise leak onto the worker forever (every retry adds
        // another). Detach it explicitly here.
        worker.off('message', handler)
        reject(new Error('Worker ping timeout'))
      }, 5000)

      worker.on('message', handler)
      worker.postMessage({ type: 'ping' })
    })
  }

  /**
   * Start a file watcher.
   */
  async startWatcher(config: WatcherConfig): Promise<void> {
    await this.ensureWorker()

    if (this.watchers.has(config.id)) {
      await this.stopWatcher(config.id)
    }

    this.watchers.set(config.id, config)

    // Sanitize options: functions / Symbols / class instances cannot survive
    // the structured-clone boundary of Worker.postMessage.  Strip them and
    // warn so the caller (not the operator) fixes the source.
    const sanitizedOptions = sanitizeOptionsForWorker(config.options ?? {})

    const workerConfig: WorkerMessage = {
      type: 'start',
      config: {
        id: config.id,
        paths: config.paths,
        options: sanitizedOptions,
        debounceMs: config.debounceMs,
      },
    }

    this.worker!.postMessage(workerConfig)
  }

  /**
   * Stop a file watcher.
   */
  async stopWatcher(watcherId: string): Promise<void> {
    if (!this.worker) return

    const config = this.watchers.get(watcherId)
    if (!config) return

    this.worker.postMessage({
      type: 'stop',
      watcherId,
    })

    // Wait for confirmation (with timeout)
    const worker = this.worker
    await new Promise<void>((resolve) => {
      const handler = (msg: WorkerResponse) => {
        if (msg.type === 'stopped' && msg.watcherId === watcherId) {
          clearTimeout(timeout)
          worker.off('message', handler)
          this.watchers.delete(watcherId)
          resolve()
        }
      }
      const timeout = setTimeout(() => {
        // Same fix as ping(): detach the listener on the timeout path so a
        // stuck worker doesn't accumulate one zombie listener per stop call.
        worker.off('message', handler)
        this.watchers.delete(watcherId)
        resolve()
      }, 1000)

      worker.on('message', handler)
    })
  }

  /**
   * Stop all watchers and terminate the worker.
   */
  async dispose(): Promise<void> {
    if (!this.worker || this.stopping) return

    this.stopping = true

    try {
      // Stop all watchers
      this.worker.postMessage({ type: 'stop-all' })

      // Wait a bit for graceful shutdown
      await new Promise(resolve => setTimeout(resolve, 500))

      // Terminate worker
      await this.worker.terminate()
      this.worker = null
      this.watchers.clear()
    } finally {
      this.stopping = false
    }
  }

  /**
   * Get the list of active watcher IDs.
   */
  getActiveWatchers(): string[] {
    return Array.from(this.watchers.keys())
  }

  /**
   * Check if a watcher is active.
   */
  isWatcherActive(watcherId: string): boolean {
    return this.watchers.has(watcherId)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton Instance
// ─────────────────────────────────────────────────────────────────────────────

export const fileWatcherManager = new FileWatcherManager()

// ─────────────────────────────────────────────────────────────────────────────
// Graceful Shutdown
// ─────────────────────────────────────────────────────────────────────────────

process.on('beforeExit', () => {
  void fileWatcherManager.dispose()
})
