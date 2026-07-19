/**
 * LSP Server Instance — lifecycle management for a single language server.
 *
 * Manages start/stop/restart with health monitoring, automatic retry on
 * transient "content modified" errors, and crash recovery.
 *
 * Ported from upstream's LSPServerInstance.ts.
 */

import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import type {
  InitializeParams,
  ServerCapabilities,
} from 'vscode-languageserver-protocol'
import { createLSPClient } from './LSPClient'
import type { LSPClient } from './LSPClient'
import { resolveBundledLspSpawn } from './bundledLspLaunch'
import type { LspServerState, ScopedLspServerConfig } from './types'

/** LSP error code for "content modified" — transient, retriable */
const LSP_ERROR_CONTENT_MODIFIED = -32801
const MAX_RETRIES = 3
const RETRY_BASE_DELAY_MS = 500

/** Default per-request timeout. Long-running requests can opt out via options. */
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000

/** Quarantine policy — after this many crashes in this window, stop auto-starting. */
const CRASH_WINDOW_MS = 60_000
const CRASH_COUNT_THRESHOLD = 3

export interface LSPSendRequestOptions {
  /** Max time to wait for a server response. Defaults to 10 s. Pass `0` to disable. */
  timeoutMs?: number
}

export interface LSPServerInstance {
  readonly name: string
  readonly config: ScopedLspServerConfig
  readonly state: LspServerState
  readonly lastError: Error | undefined
  start(): Promise<void>
  stop(): Promise<void>
  restart(): Promise<void>
  isHealthy(): boolean
  sendRequest<T>(method: string, params: unknown, options?: LSPSendRequestOptions): Promise<T>
  sendNotification(method: string, params: unknown): Promise<void>
  onNotification(method: string, handler: (params: unknown) => void): void
  onRequest<TParams, TResult>(
    method: string,
    handler: (params: TParams) => TResult | Promise<TResult>,
  ): void
  /** Latest server capabilities (post-initialize). `undefined` before handshake. */
  getServerCapabilities(): ServerCapabilities | undefined
  /**
   * Position encoding the server agreed to. Defaults to 'utf-16' when the
   * server doesn't answer (LSP 3.17 default). Recorded at initialize time.
   */
  getPositionEncoding(): 'utf-8' | 'utf-16' | 'utf-32'
  /**
   * Register a callback invoked whenever this server's LSP client reports
   * an unexpected exit. Multiple callbacks are supported. Safe to call before
   * or after `start()`.
   */
  onCrash(listener: (error: Error) => void): () => void
  /** Total crash events this process has seen for this server. */
  getCrashCount(): number
  /** True when the server has hit the short-window crash threshold. */
  isQuarantined(): boolean
  /** Clear quarantine state (user pressed "Resume"); safe to call any time. */
  clearQuarantine(): void
  /** Tail of recent stderr. */
  getStderrTail(maxBytes?: number): string
  /** Enable trace logging. Pass `null` to disable. Returns active file path. */
  setTraceLog(filePath: string | null): string | null
}

/**
 * Create an LSP server instance with lifecycle management.
 */
export function createLSPServerInstance(
  name: string,
  config: ScopedLspServerConfig,
): LSPServerInstance {
  let state: LspServerState = 'stopped'
  let lastError: Error | undefined
  let restartCount = 0
  let crashRecoveryCount = 0
  let negotiatedPositionEncoding: 'utf-8' | 'utf-16' | 'utf-32' = 'utf-16'
  /**
   * Shared in-flight promise for `start()` — concurrent callers await this
   * same promise instead of the first call synchronously setting `state =
   * 'starting'` and subsequent callers then short-circuiting out with the
   * server not actually ready (which used to trigger "Cannot send
   * notification to '<server>': state is starting" from pre-warm / the FS
   * watcher bridge when they fired 30+ `didOpen` calls in the same tick).
   */
  let startPromise: Promise<void> | undefined

  /** Crash-event ring — only timestamps within the window matter. */
  const crashEvents: number[] = []
  /** True once we've tripped the short-window crash threshold. */
  let quarantined = false
  const crashListeners = new Set<(error: Error) => void>()

  function registerCrash(error: Error): void {
    const now = Date.now()
    crashEvents.push(now)
    // Prune entries outside the window so `crashEvents.length` is an accurate
    // "crashes in the last `CRASH_WINDOW_MS`" counter.
    while (crashEvents.length > 0 && now - crashEvents[0] > CRASH_WINDOW_MS) {
      crashEvents.shift()
    }
    if (crashEvents.length >= CRASH_COUNT_THRESHOLD) {
      quarantined = true
      console.warn(
        `[LSP ${name}] quarantined after ${crashEvents.length} crashes in the last ` +
          `${Math.round(CRASH_WINDOW_MS / 1000)}s — auto-start is paused until the user ` +
          `resumes this server from the Settings panel.`,
      )
    }
    for (const listener of crashListeners) {
      try {
        listener(error)
      } catch (listenerErr) {
        console.error(`[LSP ${name}] crash listener threw: ${(listenerErr as Error).message}`)
      }
    }
  }

  const client: LSPClient = createLSPClient(name, (error) => {
    state = 'error'
    lastError = error
    crashRecoveryCount++
    registerCrash(error)
  })

  async function start(): Promise<void> {
    if (state === 'running') return
    // Concurrent callers reuse the in-flight promise so they all finish
    // together when the server is actually ready. Without this, pre-warm /
    // FS-watcher bulk `openFile` calls would race: the 1st call flips
    // `state` to 'starting' synchronously, calls 2..N then see 'starting'
    // and returned immediately, only to hit `sendNotification` while the
    // server was still initializing.
    if (startPromise) return startPromise

    if (quarantined) {
      const error = new Error(
        `LSP server '${name}' is quarantined after repeated crashes. ` +
          `Resume it from Settings → 语言服务器 to try again.`,
      )
      lastError = error
      throw error
    }

    const maxRestarts = config.maxRestarts ?? 3
    if (state === 'error' && crashRecoveryCount > maxRestarts) {
      const error = new Error(
        `LSP server '${name}' exceeded max crash recovery attempts (${maxRestarts})`,
      )
      lastError = error
      throw error
    }

    startPromise = doStart().finally(() => {
      startPromise = undefined
    })
    return startPromise
  }

  async function doStart(): Promise<void> {
    try {
      state = 'starting'

      // Resolve bundled-LSP launch (audit #16): if the command is a known
      // Node-based LSP shipped under `bundled-lsp/node_modules/`, rewrite the
      // spawn to `electron --as-node <script>` (packaged) or `node <script>`
      // (dev/tests) so users don't need a global PATH install of tsserver /
      // pyright. Absolute + existing commands, and commands without a bundled
      // entry, are passed through unchanged.
      const resolved = resolveBundledLspSpawn(
        config.command,
        config.args || [],
        config.env,
        {
          bundledPackage: config.bundledPackage,
          bundledScript: config.bundledScript,
        },
      )
      await client.start(resolved.command, resolved.args, {
        env: resolved.env,
        cwd: config.workspaceFolder,
      })

      // Build initialization params
      const workspaceFolder = config.workspaceFolder || process.cwd()
      const workspaceUri = pathToFileURL(workspaceFolder).href

      const initParams: InitializeParams = {
        processId: process.pid,
        initializationOptions: config.initializationOptions ?? {},
        workspaceFolders: [
          { uri: workspaceUri, name: path.basename(workspaceFolder) },
        ],
        rootPath: workspaceFolder,
        rootUri: workspaceUri,
        capabilities: {
          workspace: {
            configuration: false,
            workspaceFolders: false,
          },
          textDocument: {
            synchronization: {
              dynamicRegistration: false,
              willSave: false,
              willSaveWaitUntil: false,
              didSave: true,
            },
            publishDiagnostics: {
              relatedInformation: true,
              tagSupport: { valueSet: [1, 2] },
            },
            hover: {
              dynamicRegistration: false,
              contentFormat: ['markdown', 'plaintext'],
            },
            definition: {
              dynamicRegistration: false,
              linkSupport: true,
            },
            references: { dynamicRegistration: false },
            documentSymbol: {
              dynamicRegistration: false,
              hierarchicalDocumentSymbolSupport: true,
            },
            callHierarchy: { dynamicRegistration: false },
          },
          general: {
            positionEncodings: ['utf-16'],
          },
        },
      }

      let initResult
      if (config.startupTimeout !== undefined) {
        initResult = await withTimeout(
          client.initialize(initParams),
          config.startupTimeout,
          `LSP server '${name}' timed out after ${config.startupTimeout}ms`,
        )
      } else {
        initResult = await client.initialize(initParams)
      }

      // Position encoding correctness gate. We always *request* utf-16 (what
      // Monaco models natively use); if the server negotiated anything else
      // the renderer would display diagnostics at the wrong column for any
      // non-ASCII character. Log a loud warning so the symptom is traceable
      // — we keep operating under the assumption that utf-16 is safe, since
      // every modern server either honors utf-16 or falls back silently.
      const serverEncoding = (initResult as { capabilities?: { positionEncoding?: string } })
        ?.capabilities?.positionEncoding
      if (
        typeof serverEncoding === 'string' &&
        serverEncoding !== 'utf-16'
      ) {
        console.warn(
          `[LSP ${name}] server negotiated positionEncoding='${serverEncoding}', ` +
            `which we don't convert yet. Non-ASCII column offsets may be off by a few.`,
        )
      }
      negotiatedPositionEncoding =
        serverEncoding === 'utf-8' || serverEncoding === 'utf-32'
          ? serverEncoding
          : 'utf-16'

      state = 'running'
      crashRecoveryCount = 0
    } catch (error) {
      client.stop().catch(() => {})
      state = 'error'
      lastError = error as Error
      throw error
    }
  }

  async function stop(): Promise<void> {
    if (state === 'stopped' || state === 'stopping') return
    try {
      state = 'stopping'
      await client.stop()
      state = 'stopped'
    } catch (error) {
      state = 'error'
      lastError = error as Error
      throw error
    }
  }

  async function restart(): Promise<void> {
    await stop()
    restartCount++
    const maxRestarts = config.maxRestarts ?? 3
    if (restartCount > maxRestarts) {
      throw new Error(
        `Max restart attempts (${maxRestarts}) exceeded for server '${name}'`,
      )
    }
    await start()
  }

  function isHealthy(): boolean {
    return state === 'running' && client.isInitialized
  }

  async function sendRequest<T>(
    method: string,
    params: unknown,
    options?: LSPSendRequestOptions,
  ): Promise<T> {
    if (!isHealthy()) {
      throw new Error(
        `Cannot send request to LSP server '${name}': server is ${state}` +
          `${lastError ? `, last error: ${lastError.message}` : ''}`,
      )
    }

    // Per-request timeout keeps a crashed/locked server from hanging the UI
    // forever. The renderer's Quick-Fix flow surfaces the timeout as a banner;
    // the admin panel polling is tolerant of these failures. Pass `timeoutMs:0`
    // explicitly to opt out (useful for `initialize` variants or very slow
    // codeAction providers in huge repos).
    const timeoutMs = options?.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS

    let lastAttemptError: Error | undefined
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const promise = client.sendRequest<T>(method, params)
        if (timeoutMs > 0) {
          return await withTimeout(
            promise,
            timeoutMs,
            `LSP request '${method}' on '${name}' timed out after ${timeoutMs}ms`,
          )
        }
        return await promise
      } catch (error) {
        lastAttemptError = error as Error
        const errorCode = (error as { code?: number }).code
        if (
          typeof errorCode === 'number' &&
          errorCode === LSP_ERROR_CONTENT_MODIFIED &&
          attempt < MAX_RETRIES
        ) {
          const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt)
          console.log(
            `[LSP ${name}] ContentModified error, retrying in ${delay}ms (${attempt + 1}/${MAX_RETRIES})`,
          )
          await new Promise(resolve => setTimeout(resolve, delay))
          continue
        }
        break
      }
    }
    throw new Error(
      `LSP request '${method}' failed for '${name}': ${lastAttemptError?.message ?? 'unknown'}`,
    )
  }

  async function sendNotification(method: string, params: unknown): Promise<void> {
    if (!isHealthy()) {
      throw new Error(`Cannot send notification to '${name}': state is ${state}`)
    }
    await client.sendNotification(method, params)
  }

  function onNotification(method: string, handler: (params: unknown) => void): void {
    client.onNotification(method, handler)
  }

  function onRequest<TParams, TResult>(
    method: string,
    handler: (params: TParams) => TResult | Promise<TResult>,
  ): void {
    client.onRequest(method, handler)
  }

  function getServerCapabilities(): ServerCapabilities | undefined {
    return client.capabilities
  }

  function getPositionEncoding(): 'utf-8' | 'utf-16' | 'utf-32' {
    return negotiatedPositionEncoding
  }

  function onCrash(listener: (error: Error) => void): () => void {
    crashListeners.add(listener)
    return () => crashListeners.delete(listener)
  }

  function getCrashCount(): number {
    return crashRecoveryCount
  }

  function isQuarantined(): boolean {
    return quarantined
  }

  function clearQuarantine(): void {
    quarantined = false
    crashEvents.length = 0
    // Reset `crashRecoveryCount` to zero so the next `start()` passes the
    // `crashRecoveryCount > maxRestarts` check. We intentionally keep the
    // historical `getCrashCount()` unchanged — wait, we're resetting it here
    // since the admin panel shows it as "since last resume" not lifetime.
    crashRecoveryCount = 0
  }

  function getStderrTail(maxBytes?: number): string {
    return client.getStderrTail(maxBytes)
  }

  function setTraceLog(filePath: string | null): string | null {
    return client.setTraceLog(filePath)
  }

  return {
    name,
    config,
    get state() { return state },
    get lastError() { return lastError },
    start,
    stop,
    restart,
    isHealthy,
    sendRequest,
    sendNotification,
    onNotification,
    onRequest,
    getServerCapabilities,
    getPositionEncoding,
    onCrash,
    getCrashCount,
    isQuarantined,
    clearQuarantine,
    getStderrTail,
    setTraceLog,
  }
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  return Promise.race([promise, timeoutPromise]).finally(() =>
    clearTimeout(timer!),
  )
}
