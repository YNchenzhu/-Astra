/**
 * LSP Client — low-level JSON-RPC communication with a language server.
 *
 * Uses vscode-jsonrpc to manage a stdio-based connection to an LSP server
 * child process. Provides request/notification/send lifecycle management.
 *
 * Ported from upstream's LSPClient.ts with Electron-specific adaptations:
 * - Removed plugin/subprocessEnv dependency
 * - Simplified logging (console instead of custom log system)
 */

import { type ChildProcess, spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  createMessageConnection,
  type MessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  Trace,
} from 'vscode-jsonrpc/node.js'
import type {
  InitializeParams,
  InitializeResult,
  ServerCapabilities,
} from 'vscode-languageserver-protocol'

export interface LSPClient {
  readonly capabilities: ServerCapabilities | undefined
  readonly isInitialized: boolean
  start(
    command: string,
    args: string[],
    options?: { env?: Record<string, string>; cwd?: string },
  ): Promise<void>
  initialize(params: InitializeParams): Promise<InitializeResult>
  sendRequest<TResult>(method: string, params: unknown): Promise<TResult>
  sendNotification(method: string, params: unknown): Promise<void>
  onNotification(method: string, handler: (params: unknown) => void): void
  onRequest<TParams, TResult>(
    method: string,
    handler: (params: TParams) => TResult | Promise<TResult>,
  ): void
  stop(): Promise<void>
  /** Tail of recent stderr output (ring buffer, capped at ~2 MB). */
  getStderrTail(maxBytes?: number): string
  /**
   * Enable / disable trace logging to a file. When enabled, all protocol +
   * stderr logs are mirrored to `filePath` (append mode). Passing `null`
   * disables it. Returns the active path (or `null` after disabling).
   */
  setTraceLog(filePath: string | null): string | null
}

/**
 * Create an LSP client that communicates over stdio with a child process.
 *
 * @param serverName - Human-readable name for logging
 * @param onCrash - Called when the server crashes (non-zero exit during operation)
 */
/** Max bytes retained in the stderr ring buffer — big enough for pyright crashes,
 * small enough not to balloon memory for long-running servers. */
const STDERR_RING_LIMIT = 2 * 1024 * 1024

export function createLSPClient(
  serverName: string,
  onCrash?: (error: Error) => void,
): LSPClient {
  let childProcess: ChildProcess | undefined
  let connection: MessageConnection | undefined
  let capabilities: ServerCapabilities | undefined
  let initialized = false
  let startFailed = false
  let startError: Error | undefined
  let stopping = false

  // Ring buffer: append to stderr, drop from the front once we exceed the cap.
  // We keep raw string chunks (instead of Buffer) because every caller that
  // reads it — admin panel, crash reporting — wants human-readable text.
  const stderrRing: string[] = []
  let stderrRingBytes = 0

  function appendStderr(text: string): void {
    if (!text) return
    stderrRing.push(text)
    stderrRingBytes += text.length
    while (stderrRingBytes > STDERR_RING_LIMIT && stderrRing.length > 1) {
      const popped = stderrRing.shift()!
      stderrRingBytes -= popped.length
    }
  }

  // Trace log — opt-in, mirrors `log()` output to an append-only file.
  let traceFilePath: string | null = null
  let traceStream: fs.WriteStream | null = null

  function writeTrace(line: string): void {
    if (!traceStream) return
    try {
      traceStream.write(`${new Date().toISOString()} ${line}\n`)
    } catch {
      /* non-fatal — disk full / permission bumps just drop the line */
    }
  }

  // Persistent handler registries. Used to (a) queue handlers registered
  // before the first connection is ready, AND (b) re-attach every handler
  // to the FRESH connection after a stop/restart or crash recovery — the
  // previous connection's `onNotification` / `onRequest` bindings die with
  // its `dispose()`, so without this every restart would silently drop the
  // `textDocument/publishDiagnostics` listener (→ Problems panel goes
  // permanently dark after the first crash), the `workspace/configuration`
  // responder (→ pyright/tsserver fall back to built-in defaults), and the
  // `workspace/applyEdit` responder (→ rename / organize-imports silently
  // no-op). Keyed by method name; second registration of the same method
  // overwrites the first, matching vscode-jsonrpc's own per-method semantics.
  const notificationHandlers = new Map<string, (params: unknown) => void>()
  const requestHandlers = new Map<
    string,
    (params: unknown) => unknown | Promise<unknown>
  >()

  function checkStartFailed(): void {
    if (startFailed) {
      throw startError || new Error(`LSP server ${serverName} failed to start`)
    }
  }

  function log(msg: string): void {
    console.log(`[LSP ${serverName}] ${msg}`)
    writeTrace(msg)
  }

  function logError(error: Error): void {
    console.error(`[LSP ${serverName}] ${error.message}`)
    writeTrace(`ERROR ${error.message}`)
  }

  return {
    get capabilities(): ServerCapabilities | undefined {
      return capabilities
    },

    get isInitialized(): boolean {
      return initialized
    },

    async start(
      command: string,
      args: string[],
      options?: { env?: Record<string, string>; cwd?: string },
    ): Promise<void> {
      // Guard against double-start. Without this, calling `start()` while a
      // previous child process is still alive (e.g. crash-recovery path that
      // didn't go through `stop()`) would orphan the old process: the
      // childProcess variable gets overwritten, the old proc is no longer
      // reachable, but it keeps running with its stderr/stdout listeners
      // attached and its file descriptors open. Tear it down first.
      if (childProcess) {
        try {
          await this.stop()
        } catch (err) {
          log(`pre-start cleanup failed: ${(err as Error).message}`)
        }
      }
      try {
        // 1. Spawn the language server process
        childProcess = spawn(command, args, {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, ...options?.env } as Record<string, string>,
          cwd: options?.cwd,
          windowsHide: true,
        })

        if (!childProcess.stdout || !childProcess.stdin) {
          throw new Error('LSP server process stdio not available')
        }

        // 2. Wait for the process to successfully spawn
        const proc = childProcess
        await new Promise<void>((resolve, reject) => {
          const onSpawn = (): void => { cleanup(); resolve() }
          const onError = (error: Error): void => { cleanup(); reject(error) }
          const cleanup = (): void => {
            proc.removeListener('spawn', onSpawn)
            proc.removeListener('error', onError)
          }
          proc.once('spawn', onSpawn)
          proc.once('error', onError)
        })

        // 3. Capture stderr for diagnostics — both console + ring buffer so the
        // admin panel can show the tail without re-piping stderr, and trace
        // file captures everything when enabled.
        if (childProcess.stderr) {
          childProcess.stderr.on('data', (data: Buffer) => {
            const output = data.toString()
            if (!output) return
            appendStderr(output)
            const trimmed = output.trim()
            if (trimmed) log(trimmed)
          })
        }

        // 4. Handle process lifecycle events
        childProcess.on('error', (error) => {
          if (!stopping) {
            startFailed = true
            startError = error
            logError(error)
          }
        })

        childProcess.on('exit', (code) => {
          if (code !== 0 && code !== null && !stopping) {
            initialized = false
            startFailed = false
            startError = undefined
            const crashError = new Error(
              `LSP server ${serverName} crashed with exit code ${code}`,
            )
            logError(crashError)
            onCrash?.(crashError)
          }
        })

        // 5. Prevent unhandled rejections on stdin errors
        childProcess.stdin.on('error', (error: Error) => {
          if (!stopping) {
            log(`stdin error: ${error.message}`)
          }
        })

        // 6. Create JSON-RPC connection
        const reader = new StreamMessageReader(childProcess.stdout)
        const writer = new StreamMessageWriter(childProcess.stdin)
        connection = createMessageConnection(reader, writer)

        // 7. Register error/close handlers before listen()
        connection.onError(([error]) => {
          if (!stopping) {
            startFailed = true
            startError = error
            logError(error)
          }
        })

        connection.onClose(() => {
          if (!stopping) {
            initialized = false
            log('connection closed')
          }
        })

        // 8. Start listening
        connection.listen()

        // 9. Enable protocol tracing (best-effort)
        connection
          .trace(Trace.Verbose, {
            log: (message: string) => log(`[protocol] ${message}`),
          })
          .catch(() => {
            // Trace can fail if server exits early — that's fine
          })

        // 10. Re-apply every persistent handler to the new connection.
        // CRITICAL: we do NOT drain these maps — `stop()` discards the old
        // connection so the bindings inside vscode-jsonrpc go with it, and
        // the next `start()` (manual restart OR crash-recovery) needs to
        // re-attach the same handlers verbatim. Without this, the very
        // first crash of an LSP server silently kills its diagnostics +
        // request-handler wiring for the rest of the process lifetime.
        for (const [method, handler] of notificationHandlers) {
          connection.onNotification(method, handler)
        }
        for (const [method, handler] of requestHandlers) {
          connection.onRequest(method, handler)
        }

        log('client started')
      } catch (error) {
        logError(error as Error)
        throw error
      }
    },

    async initialize(params: InitializeParams): Promise<InitializeResult> {
      if (!connection) throw new Error('LSP client not started')
      checkStartFailed()

      try {
        const result: InitializeResult = await connection.sendRequest(
          'initialize',
          params,
        )
        capabilities = result.capabilities

        // Send initialized notification to complete handshake
        await connection.sendNotification('initialized', {})

        initialized = true
        log('server initialized')

        return result
      } catch (error) {
        logError(error as Error)
        throw error
      }
    },

    async sendRequest<TResult>(
      method: string,
      params: unknown,
    ): Promise<TResult> {
      if (!connection) throw new Error('LSP client not started')
      checkStartFailed()
      if (!initialized) throw new Error('LSP server not initialized')

      return connection.sendRequest(method, params)
    },

    async sendNotification(method: string, params: unknown): Promise<void> {
      if (!connection) throw new Error('LSP client not started')
      checkStartFailed()

      try {
        await connection.sendNotification(method, params)
      } catch (error) {
        // Notifications are fire-and-forget — log but don't throw
        log(`notification ${method} failed: ${(error as Error).message}`)
      }
    },

    onNotification(method: string, handler: (params: unknown) => void): void {
      // Always remember the handler so a later `start()` can re-attach it
      // to the fresh connection — even when a connection already exists.
      notificationHandlers.set(method, handler)
      if (!connection) return
      checkStartFailed()
      connection.onNotification(method, handler)
    },

    onRequest<TParams, TResult>(
      method: string,
      handler: (params: TParams) => TResult | Promise<TResult>,
    ): void {
      requestHandlers.set(
        method,
        handler as (params: unknown) => unknown | Promise<unknown>,
      )
      if (!connection) return
      checkStartFailed()
      connection.onRequest(method, handler)
    },

    getStderrTail(maxBytes?: number): string {
      if (!stderrRing.length) return ''
      const full = stderrRing.join('')
      if (!maxBytes || maxBytes <= 0 || maxBytes >= full.length) return full
      return full.slice(full.length - maxBytes)
    },

    setTraceLog(filePath: string | null): string | null {
      // Disable path.
      if (!filePath) {
        if (traceStream) {
          try { traceStream.end() } catch { /* ignore */ }
        }
        traceStream = null
        traceFilePath = null
        return null
      }
      // Already enabled and pointing at the same file? No-op.
      if (traceStream && traceFilePath === filePath) return filePath
      // Rotate if pointing at a different file.
      if (traceStream) {
        try { traceStream.end() } catch { /* ignore */ }
        traceStream = null
      }
      try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true })
        traceStream = fs.createWriteStream(filePath, { flags: 'a', encoding: 'utf8' })
        traceStream.on('error', (err) => {
          console.warn(`[LSP ${serverName}] trace stream error: ${err.message}`)
          traceStream = null
          traceFilePath = null
        })
        traceFilePath = filePath
        writeTrace(`--- trace session started pid=${process.pid} ---`)
        return filePath
      } catch (err) {
        console.warn(
          `[LSP ${serverName}] failed to open trace log '${filePath}': ${(err as Error).message}`,
        )
        traceFilePath = null
        traceStream = null
        return null
      }
    },

    async stop(): Promise<void> {
      stopping = true
      let shutdownError: Error | undefined

      try {
        if (connection) {
          // 尝试优雅关闭，500ms 超时
          await Promise.race([
            (async () => {
              await connection.sendRequest('shutdown', {})
              await connection.sendNotification('exit', {})
            })(),
            new Promise((resolve) => setTimeout(resolve, 500))
          ])
        }
      } catch (error) {
        shutdownError = error as Error
      } finally {
        if (connection) {
          try { connection.dispose() } catch { /* ignore */ }
          connection = undefined
        }

        if (childProcess) {
          childProcess.removeAllListeners('error')
          childProcess.removeAllListeners('exit')
          if (childProcess.stdin) childProcess.stdin.removeAllListeners('error')
          if (childProcess.stderr) childProcess.stderr.removeAllListeners('data')

          // 先尝试 SIGTERM，如果进程还活着，等待 200ms 后强制 SIGKILL
          try {
            if (childProcess.pid && !childProcess.killed) {
              childProcess.kill('SIGTERM')

              // 等待 200ms 后检查进程是否还活着
              await new Promise((resolve) => setTimeout(resolve, 200))

              if (childProcess.pid && !childProcess.killed) {
                log('process did not exit gracefully, forcing SIGKILL')
                childProcess.kill('SIGKILL')
              }
            }
          } catch { /* may already be dead */ }

          childProcess = undefined
        }

        initialized = false
        capabilities = undefined
        stopping = false

        if (shutdownError) {
          startFailed = true
          startError = shutdownError
        }

        // Flush the trace log if enabled so the tail-on-crash view captures
        // the shutdown reason. Don't null the path — caller may re-start
        // and expect the same sink to resume.
        if (traceStream) {
          try { traceStream.end() } catch { /* ignore */ }
          traceStream = null
          if (traceFilePath) {
            try {
              traceStream = fs.createWriteStream(traceFilePath, { flags: 'a', encoding: 'utf8' })
              traceStream.on('error', () => { traceStream = null })
            } catch {
              traceStream = null
            }
          }
        }

        log('client stopped')
      }

      if (shutdownError) throw shutdownError
    },
  }
}
