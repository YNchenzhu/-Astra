/**
 * LSP Manager — singleton initialization and lifecycle.
 *
 * Global singleton that wraps the LSPServerManager with:
 * - Lazy initialization (first use)
 * - Connection status tracking
 * - Async initialization with state management
 *
 * Ported from upstream's manager.ts.
 */

import { createLSPServerManager, type LSPServerManager } from './LSPServerManager'
import { loadLspConfigs } from './config'
import { registerLSPNotificationHandlers } from './passiveFeedback'
import { getDiagnosticsHub } from '../diagnostics/DiagnosticsHub'
import { preWarmWorkspaceForLsp, type PreWarmSummary } from './workspacePreWarm'
import {
  startLspFsWatcherBridge,
  type LspFsWatcherHandle,
} from './fsWatcherBridge'
// Lazy import to avoid the cycle (adminIpc imports manager). Imported inside
// the success callback only, so the top-level dep graph stays acyclic.
type ApplyPersistedTraceFn = () => void

type InitState = 'not-started' | 'pending' | 'success' | 'failed'

let instance: LSPServerManager | undefined
let initState: InitState = 'not-started'
let initError: Error | undefined
let initGeneration = 0
let initPromise: Promise<void> | undefined
/**
 * Last workspace path passed into `initializeLspServerManager` /
 * `reinitializeLspServerManager`. Audit P1-1 (2026-05): used by
 * {@link ensureLspWorkspaceSynced} to detect a workspace switch and force a
 * reinit so pre-warm + FS watcher pick up the new root. Previously the
 * "already running → no-op" branch silently kept the old workspace's
 * pre-warm / FS watcher alive across workspace switches.
 *
 * Normalized to `undefined` when no workspace is bound (e.g. cold bootstrap
 * before the renderer opens a folder).
 */
let lastInitWorkspacePath: string | undefined
let lastInitUserDataPath: string | undefined

/** Handle for the per-init FS watcher; torn down on shutdown/reinit. */
let fsWatcherHandle: LspFsWatcherHandle | undefined
/** Latest pre-warm summary — exposed via {@link getLastPreWarmSummary}. */
let lastPreWarmSummary: PreWarmSummary | undefined
/** Abort signal wired to the running pre-warm so reinit can stop it early. */
let preWarmAbort: { aborted: boolean } | undefined

/** Get the singleton manager. Returns undefined if not initialized or failed. */
export function getLspServerManager(): LSPServerManager | undefined {
  if (initState === 'failed') return undefined
  return instance
}

/** Check if at least one server is connected. */
export function isLspConnected(): boolean {
  if (initState === 'failed') return false
  const manager = getLspServerManager()
  if (!manager) return false
  const servers = manager.getAllServers()
  if (servers.size === 0) return false
  for (const server of servers.values()) {
    if (server.state !== 'error') return true
  }
  return false
}

/** Get current initialization status. */
export function getInitializationStatus():
  | { status: 'not-started' }
  | { status: 'pending' }
  | { status: 'success' }
  | { status: 'failed'; error: Error } {
  if (initState === 'failed') {
    return { status: 'failed', error: initError || new Error('Initialization failed') }
  }
  if (initState === 'not-started') return { status: 'not-started' }
  if (initState === 'pending') return { status: 'pending' }
  return { status: 'success' }
}

/** Wait for initialization to complete. */
export async function waitForInitialization(): Promise<void> {
  if (initState === 'success' || initState === 'failed') return
  if (initState === 'pending' && initPromise) {
    await initPromise
  }
}

/**
 * Initialize the LSP manager.
 *
 * @param workspacePath - Project workspace directory
 * @param userDataPath - Electron userData directory
 */
export function initializeLspServerManager(
  workspacePath?: string,
  userDataPath?: string,
): void {
  if (instance !== undefined && initState !== 'failed') return

  if (initState === 'failed') {
    instance = undefined
    initError = undefined
  }

  // Audit P1-1 (2026-05): remember the workspace + userData paths so
  // `ensureLspWorkspaceSynced` can detect a workspace switch later and force
  // a reinit, and so `lsp:restart-typescript-server` (and other admin paths)
  // can re-init without losing the userData root.
  lastInitWorkspacePath = workspacePath?.trim() || undefined
  lastInitUserDataPath = userDataPath?.trim() || undefined

  instance = createLSPServerManager(
    () => loadLspConfigs(workspacePath, userDataPath),
  )
  initState = 'pending'
  const currentGen = ++initGeneration

  initPromise = instance
    .initialize()
    .then(() => {
      if (currentGen === initGeneration) {
        initState = 'success'
        console.log('[LSP] Server manager initialized successfully')
        // Wire every freshly spawned server's textDocument/publishDiagnostics
        // handler to the DiagnosticsHub. Without this the Hub never learns
        // about LSP-authored diagnostics and the renderer mirror falls back
        // to Monaco markers only.
        if (instance) {
          try {
            registerLSPNotificationHandlers(instance)
          } catch (err) {
            console.warn(
              `[LSP] registerLSPNotificationHandlers failed: ${(err as Error).message}`,
            )
          }
          // Replay persisted trace settings so user toggles survive restarts.
          // Lazy-require intentionally: `adminIpcHandlers` imports
          // `getLspServerManager` from this file, and resolving that back-edge
          // at ESM top-level produces a circular module graph where one side
          // sees `undefined` during evaluation. Runtime `require()` at call
          // time ensures both modules have finished initializing. An
          // ESM-compatible fix would require a 3rd "adminApi" registration
          // module; using `require` here is the lower-impact choice.
          try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const adminMod = require('./adminIpcHandlers') as {
              applyPersistedTraceSettings?: ApplyPersistedTraceFn
            }
            adminMod.applyPersistedTraceSettings?.()
          } catch (err) {
            console.warn(
              `[LSP] applyPersistedTraceSettings failed: ${(err as Error).message}`,
            )
          }
        }
        // Pre-warm + FS watcher (P2): fire-and-forget so initialize() resolves
        // promptly for waitForInitialization() callers. Abort signal lets a
        // concurrent shutdown/reinit stop the scan mid-flight — critical for
        // large monorepos where scanning can take 10s+.
        if (instance && workspacePath && workspacePath.trim()) {
          const abort = { aborted: false }
          preWarmAbort = abort
          void preWarmWorkspaceForLsp(instance, workspacePath, { signal: abort })
            .then((summary) => {
              if (currentGen !== initGeneration) return
              lastPreWarmSummary = summary
            })
            .catch((err) => {
              console.warn(
                `[LSP] Pre-warm failed: ${(err as Error).message}`,
              )
            })
            .finally(() => {
              if (preWarmAbort === abort) preWarmAbort = undefined
            })
          void startLspFsWatcherBridge(instance, workspacePath)
            .then((handle) => {
              if (currentGen !== initGeneration) {
                void handle.stop()
                return
              }
              fsWatcherHandle = handle
            })
            .catch((err) => {
              console.warn(
                `[LSP] FS watcher bridge failed to start: ${(err as Error).message}`,
              )
            })
        }
      }
    })
    .catch((error: unknown) => {
      if (currentGen === initGeneration) {
        initState = 'failed'
        initError = error as Error
        instance = undefined
        console.error(`[LSP] Failed to initialize: ${(error as Error).message}`)
      }
    })
}

/** Last completed workspace pre-warm summary (or undefined if never run). */
export function getLastPreWarmSummary(): PreWarmSummary | undefined {
  return lastPreWarmSummary
}

/** Shutdown and clean up all LSP servers. */
export async function shutdownLspServerManager(): Promise<void> {
  if (!instance) return

  // Abort any in-flight pre-warm first so the scan loop exits on its next
  // iteration and releases fs handles before we tear the manager down.
  if (preWarmAbort) preWarmAbort.aborted = true

  // Stop the FS watcher before shutting down servers — a chokidar event
  // arriving after `manager.shutdown()` would try to send notifications to
  // torn-down clients and blow up with noisy "Cannot send notification to
  // 'xxx': state is stopped" errors.
  if (fsWatcherHandle) {
    try {
      await fsWatcherHandle.stop()
    } catch (err) {
      console.warn(`[LSP] FS watcher stop failed: ${(err as Error).message}`)
    }
    fsWatcherHandle = undefined
  }

  try {
    await instance.shutdown()
    console.log('[LSP] Server manager shut down')
  } catch (error) {
    console.error(`[LSP] Shutdown failed: ${(error as Error).message}`)
  } finally {
    try {
      getDiagnosticsHub().clearAll()
    } catch (err) {
      console.warn(`[LSP] clear hub on shutdown failed: ${(err as Error).message}`)
    }
    instance = undefined
    initState = 'not-started'
    initError = undefined
    initPromise = undefined
    initGeneration++
    preWarmAbort = undefined
    lastPreWarmSummary = undefined
    lastInitWorkspacePath = undefined
    lastInitUserDataPath = undefined
  }
}

/**
 * Read-only access for callers that need to re-init with the same paths the
 * manager last booted under (e.g. `lsp:restart-typescript-server` IPC which
 * historically passed `(undefined, undefined)` and lost the userDataPath
 * root). Audit P1-5 (2026-05).
 */
export function getLastInitPaths(): {
  workspacePath: string | undefined
  userDataPath: string | undefined
} {
  return {
    workspacePath: lastInitWorkspacePath,
    userDataPath: lastInitUserDataPath,
  }
}

/**
 * Force re-initialization (e.g. after settings change).
 */
export function reinitializeLspServerManager(
  workspacePath?: string,
  userDataPath?: string,
  opts?: { bypassOpenclaudeNotStarted?: boolean },
): void {
  if (initState === 'not-started' && !opts?.bypassOpenclaudeNotStarted) return

  // Signal the old pre-warm to stop before we detach the instance so its
  // in-flight `fs.readFile` batches don't keep pointing at a zombie manager.
  if (preWarmAbort) preWarmAbort.aborted = true

  if (fsWatcherHandle) {
    void fsWatcherHandle.stop().catch(() => {})
    fsWatcherHandle = undefined
  }

  if (instance) {
    instance.shutdown().catch((err) => {
      console.warn(`[LSP] Old instance shutdown during reinit: ${(err as Error).message}`)
    })
  }

  try {
    getDiagnosticsHub().clearAll()
  } catch (err) {
    console.warn(`[LSP] clear hub on reinit failed: ${(err as Error).message}`)
  }

  instance = undefined
  initState = 'not-started'
  initError = undefined
  preWarmAbort = undefined
  lastPreWarmSummary = undefined

  initializeLspServerManager(workspacePath, userDataPath)
}

/**
 * Ensure the LSP server manager is running against the given workspace. Thin
 * wrapper around {@link initializeLspServerManager} / {@link reinitializeLspServerManager}
 * — added to satisfy `electron/ai/streamHandler.ts` which calls this before
 * dispatching a user turn.
 *
 * Options:
 *  - `bypassOpenclaudeNotStarted` — when `true`, still initialize even if the
 *    upstream policy would defer. Used by the AI hot path that explicitly
 *    wants LSP ready before tools execute.
 */
export function ensureLspWorkspaceSynced(
  workspacePath: string | undefined,
  userDataPath: string | undefined,
  _options?: { bypassOpenclaudeNotStarted?: boolean },
): void {
  const normalizedWorkspace = workspacePath?.trim() || undefined
  const normalizedUserData = userDataPath?.trim() || lastInitUserDataPath
  if (initState === 'not-started') {
    initializeLspServerManager(normalizedWorkspace, normalizedUserData)
    return
  }
  // Audit P1-1 (2026-05): the previous body was a documented no-op even when
  // the workspace had switched mid-session — the pre-warm + FS watcher were
  // still bound to the OLD root, so an open file from the new workspace would
  // miss `textDocument/publishDiagnostics` until the user manually restarted
  // a server. Reinit only when the workspace actually changed (cheap: the
  // existing instance shutdown + new instance bring-up are both fire-and-
  // forget). userData-only changes are tolerated to keep the warm instance.
  if (normalizedWorkspace && normalizedWorkspace !== lastInitWorkspacePath) {
    reinitializeLspServerManager(normalizedWorkspace, normalizedUserData)
  }
}
