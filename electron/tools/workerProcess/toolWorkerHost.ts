/**
 * Main-process side manager for the tool execution utilityProcess.
 *
 * Owns the worker lifecycle (spawn / respawn on crash), the RPC pool
 * (reqId allocation + pending-promise table) and abort routing. The
 * public surface is the singleton {@link toolWorkerHost} below — call
 * `.dispatch(name, input)` from {@link import('../registry').ToolRegistry}
 * when the tool is flagged `runIn: 'worker'`.
 *
 * Design notes:
 *   - **Crash semantics**: when the utilityProcess exits unexpectedly
 *     we reject every in-flight RPC with a structured
 *     `tool_worker_crashed` error and spawn a fresh worker. The
 *     agentic loop interprets that error the same way it interprets
 *     any other `success:false` tool result, so recovery is automatic.
 *   - **No prewarm dependency**: the worker is spawned lazily on the
 *     first dispatch. Prewarming is a separate `prewarm()` call you
 *     can wire into `app.whenReady()` to amortize the ~100ms boot.
 *   - **Test seam**: the constructor accepts a `workerFactory` so
 *     unit tests can inject a fake worker (an EventEmitter pretending
 *     to be a utilityProcess) without booting Electron.
 */

import { EventEmitter } from 'node:events'
import path from 'node:path'

import { readDiskSettings } from '../../settings/settingsAccess'
import type { ToolProgressEvent } from '../toolExecContext'
import type { ToolResult } from '../types'
import { exportReceiptsForPath } from '../readFileState'
import { resolvePathForTool } from '../workspaceState'
import {
  isWorkerToHost,
  type HostToWorker,
  type ToolRpcReadReceipt,
  type ToolRpcRequest,
} from './wireProtocol'
import { isToolWorkerDispatchEnabled } from './toolWorkerEnv'

// ─── File-mutation worker tools (SA-5) ───
//
// The worker-routable tools that mutate a single file, identified by their
// `filePath` input. These get two extra protections at the main/worker
// boundary:
//   1. `ToolRegistry.execute` wraps their dispatch in main's per-file lock
//      so main-process mutators (e.g. NotebookEdit) and worker-process
//      mutators are mutually exclusive on the same path.
//   2. `dispatch()` forwards main's read receipts for the target path so
//      the worker's read-before-write gates see them.
// Read-only worker tools (read_file/glob/grep/web_fetch/WebSearch) are
// deliberately excluded — locking them would serialize safe parallel reads.

const WORKER_FILE_MUTATION_TOOLS: ReadonlySet<string> = new Set([
  'write_file',
  'edit_file',
  'multi_edit_file',
])

/**
 * Hard deadline for a single worker RPC (audit A-P1-1): an executor that
 * ignores its AbortSignal and hangs (dead network fetch, wedged fs call)
 * used to leave the dispatch promise pending forever — the agentic loop
 * stalled with no error. 10 min default comfortably exceeds every
 * legitimate worker tool (read/glob/grep/web_fetch/write); override via
 * `ASTRA_TOOL_WORKER_RPC_TIMEOUT_MS` (0 disables).
 */
function workerRpcTimeoutMs(): number {
  const raw = process.env.ASTRA_TOOL_WORKER_RPC_TIMEOUT_MS?.trim()
  if (raw !== undefined && raw !== '') {
    const n = Number(raw)
    if (Number.isFinite(n)) return Math.max(0, Math.floor(n))
  }
  return 10 * 60 * 1000
}

/** True for worker-routed tools that mutate the file named by `input.filePath`. */
export function isWorkerFileMutationTool(name: string): boolean {
  return WORKER_FILE_MUTATION_TOOLS.has(name)
}

/**
 * Snapshot the main-process read receipts a worker-side mutation gate will
 * need (target-path receipt + `baseReadId` anchor). Returns `undefined` for
 * non-mutation tools, on resolution failure, or when main has no receipts —
 * the worker then falls back to its own local state, exactly as before.
 */
function collectReadReceiptsForDispatch(
  name: string,
  input: Record<string, unknown>,
): ToolRpcReadReceipt[] | undefined {
  if (!isWorkerFileMutationTool(name)) return undefined
  try {
    const rawPath =
      typeof input.filePath === 'string'
        ? input.filePath
        : typeof input.file_path === 'string'
          ? input.file_path
          : ''
    const rawAnchor = input.baseReadId ?? input.base_read_id
    const baseReadId =
      typeof rawAnchor === 'string' && rawAnchor.trim() ? rawAnchor.trim() : undefined
    let resolved = ''
    if (rawPath.trim()) {
      const r = resolvePathForTool(rawPath)
      if (r.ok) resolved = r.resolved
    }
    if (!resolved && !baseReadId) return undefined
    const receipts = exportReceiptsForPath(resolved, { baseReadId })
    return receipts.length > 0 ? receipts : undefined
  } catch {
    // Never block the dispatch on receipt export — worst case the worker
    // behaves exactly as it did before this fix.
    return undefined
  }
}

// ─── Worker shim ───
//
// Electron's `utilityProcess.fork()` returns an EventEmitter with
// `postMessage(msg)`, `kill()`, `pid`, and `on('exit', cb)`. We model
// only that subset so tests can inject a stub.

/**
 * Single-shot listener registration. Tests + the Electron child share
 * this surface — the union-typed handler keeps the interface narrow
 * enough that both shapes (real utilityProcess child, fake
 * EventEmitter) implement it without overload gymnastics. Internal
 * callers narrow the argument based on `event` before use.
 */
export interface ToolWorkerHandle {
  readonly pid: number | undefined
  postMessage(msg: HostToWorker): void
  kill(): boolean
  on(event: 'message' | 'exit', handler: (arg: unknown) => void): void
}

export type ToolWorkerFactory = () => ToolWorkerHandle | Promise<ToolWorkerHandle>

// ─── Default Electron spawn ───

/**
 * Default factory: forks the bundled `toolWorker.js` next to
 * `main.js` in `dist-electron/`. Lazy-imports `electron` so that
 * test code (which sets `workerFactory` first) never triggers the
 * Electron import.
 */
function defaultElectronFactory(): ToolWorkerHandle {
  // Lazy require so non-Electron contexts (vitest) never load it.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const electron = require('electron') as typeof import('electron')
  const { utilityProcess } = electron
  if (!utilityProcess) {
    throw new Error('utilityProcess is not available in this process')
  }
  const entry = path.join(__dirname, 'toolWorkerEntry.js')
  const child = utilityProcess.fork(entry, [], {
    serviceName: 'astra-tool-worker',
    // Inherit stdio so worker logs surface in the main log.
    stdio: 'inherit',
  })
  return {
    get pid() {
      return child.pid
    },
    postMessage(msg) {
      child.postMessage(msg)
    },
    kill() {
      return child.kill()
    },
    on(event: 'message' | 'exit', handler: (arg: unknown) => void) {
      if (event === 'message') {
        child.on('message', handler as (msg: unknown) => void)
      } else {
        child.on('exit', handler as (code: number | null) => void)
      }
    },
  }
}

// ─── Host ───

interface PendingRpc {
  resolve(result: ToolResult): void
  /** Rejection uses a Result-like structure so callers can branch on `success`. */
  rejectAsResult(error: string, errorClass?: string, telemetryHint?: string): void
  /** AbortSignal to forward to the worker. */
  abortHandler?: () => void
  /** Tool name — only used for telemetry / logs. */
  toolName: string
  /** Forward `tool_progress` frames from the worker (e.g. `web_fetch`). */
  emitToolProgress?: (e: ToolProgressEvent) => void
}

export class ToolWorkerHost extends EventEmitter {
  private worker: ToolWorkerHandle | null = null
  private workerReady: Promise<void> | null = null
  private nextReqId = 1
  private pending = new Map<number, PendingRpc>()
  private restartCount = 0
  private disposed = false
  /**
   * Spawn mutex (audit A-P1-2): two concurrent dispatches arriving while no
   * worker exists both passed the `if (this.worker && this.workerReady)`
   * check and spawned two children — the loser leaked. All spawns now
   * funnel through this single in-flight promise.
   */
  private spawnInFlight: Promise<void> | null = null
  /** Crash-loop backoff state (audit A-P1-3). */
  private consecutiveCrashes = 0
  private lastCrashAt = 0
  private bootPending: {
    resolve: () => void
    reject: (err: Error) => void
    handle: ToolWorkerHandle
  } | null = null
  /**
   * Callback returning the latest workspace path; resolved on every
   * worker boot / respawn. Defaults to `null` — wire from
   * `electron/lifecycle/appBootstrap.ts` (or the test) when the
   * workspace state singleton exists.
   */
  private workspacePathProvider: () => string | null = () => null

  /** Wire a workspace-path source — called once during app bootstrap. */
  setWorkspacePathProvider(fn: () => string | null): void {
    this.workspacePathProvider = fn
  }

  private readonly workerFactory: ToolWorkerFactory

  constructor(workerFactory: ToolWorkerFactory = defaultElectronFactory) {
    super()
    this.workerFactory = workerFactory
  }

  /**
   * Eager spawn — call from `app.whenReady()` to amortize first-call
   * latency. Idempotent and safe to call before any dispatch.
   */
  async prewarm(): Promise<void> {
    await this.ensureWorker()
  }

  /**
   * Push a fresh settings snapshot to a **running** worker (e.g. after
   * `settings:set`). No-op when no child is alive.
   */
  postLiveSettingsSnapshot(diskSettingsSnapshot: Record<string, unknown>): void {
    const w = this.worker
    if (!w || this.disposed) return
    let workspacePath: string | null = null
    try {
      workspacePath = this.workspacePathProvider()
    } catch {
      workspacePath = null
    }
    try {
      w.postMessage({
        kind: 'tool_init',
        workspacePath,
        diskSettingsSnapshot,
      })
    } catch {
      /* child exiting */
    }
  }

  /**
   * Send a tool request to the worker and resolve with the
   * `ToolResult` it returns. Never throws — a worker crash, unknown
   * tool, abort, or exception inside the executor all surface as
   * `{ success: false, error, toolErrorClass }`.
   */
  async dispatch(
    name: string,
    input: Record<string, unknown>,
    ctx?: ToolRpcRequest['ctx'],
    signal?: AbortSignal,
    emitToolProgress?: (e: ToolProgressEvent) => void,
  ): Promise<ToolResult> {
    if (this.disposed) {
      return { success: false, error: 'tool worker host disposed', toolErrorClass: 'host_disposed' }
    }
    if (signal?.aborted) {
      return { success: false, error: 'aborted before dispatch', toolErrorClass: 'aborted' }
    }
    try {
      await this.ensureWorker()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { success: false, error: `tool worker spawn failed: ${msg}`, toolErrorClass: 'spawn_failed' }
    }
    const worker = this.worker
    if (!worker) {
      return { success: false, error: 'tool worker unavailable after spawn', toolErrorClass: 'spawn_failed' }
    }

    const reqId = this.nextReqId++
    const req: ToolRpcRequest = {
      kind: 'tool_request',
      reqId,
      name,
      input,
      diskSettingsSnapshot: readDiskSettings(),
      enableHostProgress:
        typeof emitToolProgress === 'function' && name === 'web_fetch',
      readReceipts: collectReadReceiptsForDispatch(name, input),
      ctx,
    }

    let rpcDeadlineTimer: ReturnType<typeof setTimeout> | null = null
    return new Promise<ToolResult>((resolve) => {
      const pending: PendingRpc = {
        toolName: name,
        resolve,
        rejectAsResult: (error, errorClass, telemetryHint) =>
          resolve({
            success: false,
            error,
            toolErrorClass: errorClass ?? 'worker_error',
            ...(telemetryHint ? { telemetryHint } : {}),
          }),
        emitToolProgress,
      }
      if (signal) {
        pending.abortHandler = () => {
          if (this.worker === worker) {
            try {
              worker.postMessage({ kind: 'tool_abort', reqId, reason: 'host_abort' })
            } catch {
              // Worker is dying — the exit handler will clean up.
            }
          }
        }
        signal.addEventListener('abort', pending.abortHandler, { once: true })
      }
      // RPC deadline (audit A-P1-1) — fail the pending promise with a
      // structured timeout and ask the worker to abort the executor. A
      // late response after this fires is silently dropped by
      // handleMessage (reqId no longer pending).
      const deadline = workerRpcTimeoutMs()
      if (deadline > 0) {
        rpcDeadlineTimer = setTimeout(() => {
          const p = this.pending.get(reqId)
          if (!p) return
          this.pending.delete(reqId)
          try {
            if (this.worker === worker) {
              worker.postMessage({ kind: 'tool_abort', reqId, reason: 'rpc_timeout' })
            }
          } catch {
            /* worker dying */
          }
          p.rejectAsResult(
            `tool worker RPC timed out after ${deadline}ms (tool: ${name})`,
            'worker_rpc_timeout',
          )
        }, deadline)
        if (typeof rpcDeadlineTimer.unref === 'function') rpcDeadlineTimer.unref()
      }
      this.pending.set(reqId, pending)
      try {
        worker.postMessage(req)
      } catch (e) {
        this.pending.delete(reqId)
        const msg = e instanceof Error ? e.message : String(e)
        resolve({ success: false, error: `failed to post to worker: ${msg}`, toolErrorClass: 'post_failed' })
      }
    }).finally(() => {
      if (rpcDeadlineTimer) clearTimeout(rpcDeadlineTimer)
      const p = this.pending.get(reqId)
      if (p && signal && p.abortHandler) {
        signal.removeEventListener('abort', p.abortHandler)
      }
      this.pending.delete(reqId)
    })
  }

  /**
   * Kill the current worker (if any) and clear pending RPCs. Used by
   * tests and shutdown. The next dispatch will lazily spawn a new one.
   */
  async dispose(): Promise<void> {
    this.disposed = true
    await this.killWorker('host_dispose')
  }

  /** Diagnostics: return the current child's PID, or null. */
  getCurrentPid(): number | null {
    return this.worker?.pid ?? null
  }

  /** Diagnostics: number of crashes survived so far. */
  getRestartCount(): number {
    return this.restartCount
  }

  // ─── Internals ───

  private async ensureWorker(): Promise<void> {
    // Spawn mutex — concurrent callers await the SAME in-flight boot
    // promise. Checked before the ready fast-path so dispatches that race
    // the boot all resume in FIFO order (same promise instance ⇒ same
    // microtask hop count ⇒ request post order matches dispatch order).
    if (this.spawnInFlight) {
      return this.spawnInFlight
    }
    if (this.worker && this.workerReady) {
      return this.workerReady
    }
    this.spawnInFlight = this.spawnWorker().finally(() => {
      this.spawnInFlight = null
    })
    return this.spawnInFlight
  }

  private async spawnWorker(): Promise<void> {
    // Crash-loop backoff: after repeated fast crashes, delay the respawn
    // (exponential, capped) so a deterministic boot crash doesn't spin.
    if (this.consecutiveCrashes >= 2) {
      const delayMs = Math.min(
        30_000,
        500 * 2 ** Math.min(this.consecutiveCrashes - 2, 6),
      )
      const sinceCrash = Date.now() - this.lastCrashAt
      if (sinceCrash < delayMs) {
        await new Promise((r) => setTimeout(r, delayMs - sinceCrash))
      }
    }
    const factoryResult = this.workerFactory()
    const handle =
      factoryResult instanceof Promise ? await factoryResult : factoryResult
    this.worker = handle

    // Two-phase wiring: we attach the permanent handlers up front (so a
    // crash during boot also routes through `handleExit`), and use a
    // boot-only `Promise` to gate the first dispatch on the `tool_ready`
    // frame. Late `ready` frames are ignored by `handleMessage`.
    let bootResolve: () => void = () => {}
    let bootReject: (err: Error) => void = () => {}
    const ready = new Promise<void>((res, rej) => {
      bootResolve = res
      bootReject = rej
    })
    this.bootPending = { resolve: bootResolve, reject: bootReject, handle }

    handle.on('message', (msg) => this.handleMessage(msg))
    handle.on('exit', (code) => {
      const exitCode = typeof code === 'number' || code === null ? code : null
      this.handleExit(exitCode, handle)
    })

    this.workerReady = ready
    try {
      await ready
      // Healthy boot — reset the crash-loop backoff window.
      this.consecutiveCrashes = 0
      // Hydrate worker-side singletons before any dispatch lands.
      const workspacePath = (() => {
        try {
          return this.workspacePathProvider()
        } catch {
          return null
        }
      })()
      try {
        handle.postMessage({
          kind: 'tool_init',
          workspacePath,
          diskSettingsSnapshot: readDiskSettings(),
        })
      } catch (e) {
        console.warn(
          `[toolWorkerHost] tool_init post failed: ${e instanceof Error ? e.message : String(e)}`,
        )
      }
      console.log(
        `[toolWorkerHost] worker ready pid=${handle.pid ?? '?'} (restart #${this.restartCount})`,
      )
    } catch (e) {
      // Boot failed — clear state so the next dispatch tries again.
      this.worker = null
      this.workerReady = null
      this.bootPending = null
      throw e
    }
  }

  private handleMessage(raw: unknown): void {
    if (!isWorkerToHost(raw)) {
      this.handleMalformedFrame(raw)
      return
    }
    if (raw.kind === 'tool_ready') {
      if (this.bootPending) {
        this.bootPending.resolve()
        this.bootPending = null
      }
      return
    }
    if (raw.kind === 'tool_progress') {
      const pending = this.pending.get(raw.reqId)
      pending?.emitToolProgress?.(raw.event)
      return
    }
    const pending = this.pending.get(raw.reqId)
    if (!pending) {
      // Late response after abort or restart — silently drop.
      return
    }
    if (raw.kind === 'tool_response') {
      pending.resolve(raw.result)
      return
    }
    if (raw.kind === 'tool_error') {
      pending.rejectAsResult(raw.error, raw.errorClass, raw.telemetryHint)
      return
    }
  }

  /**
   * A frame failed {@link isWorkerToHost} validation. If it still carries a
   * numeric `reqId` matching an in-flight RPC, fail that RPC with a structured
   * protocol-violation result so the caller doesn't hang forever waiting for a
   * well-formed response. Otherwise drop it (e.g. a late frame after restart).
   */
  private handleMalformedFrame(raw: unknown): void {
    if (!raw || typeof raw !== 'object') return
    const reqId = (raw as { reqId?: unknown }).reqId
    if (typeof reqId !== 'number') return
    const pending = this.pending.get(reqId)
    if (!pending) return
    console.warn(
      `[toolWorkerHost] dropping malformed worker frame for reqId=${reqId} ` +
        `kind=${String((raw as { kind?: unknown }).kind)}`,
    )
    pending.rejectAsResult(
      'tool worker returned a malformed frame',
      'worker_protocol_violation',
    )
  }

  private handleExit(code: number | null, handle: ToolWorkerHandle): void {
    if (this.worker !== handle) return // stale exit from a respawned worker
    const inflight = this.pending.size
    console.warn(
      `[toolWorkerHost] worker exited code=${code} inflight=${inflight} restart=${this.restartCount}`,
    )
    // If boot hadn't completed, surface the failure to the pending
    // `ensureWorker()` promise so the first dispatch returns a clean
    // structured error instead of hanging forever.
    if (this.bootPending && this.bootPending.handle === handle) {
      this.bootPending.reject(
        new Error(`tool worker exited during boot (code=${code})`),
      )
      this.bootPending = null
    }
    this.worker = null
    this.workerReady = null
    // Drain every in-flight RPC with a structured crash result.
    for (const [, pending] of this.pending) {
      pending.rejectAsResult(
        `tool worker crashed: code=${code}`,
        'worker_crashed',
      )
    }
    this.pending.clear()
    if (!this.disposed) {
      this.restartCount += 1
      // Don't eagerly respawn — next dispatch will trigger
      // `ensureWorker()`, which applies exponential backoff after
      // repeated crashes (audit A-P1-3).
      this.consecutiveCrashes += 1
      this.lastCrashAt = Date.now()
    }
    this.emit('crash', { code, inflight })
  }

  private async killWorker(reason: string): Promise<void> {
    const w = this.worker
    if (!w) return
    try {
      w.postMessage({ kind: 'tool_shutdown' })
    } catch {
      // Worker may already be dead.
    }
    try {
      w.kill()
    } catch {
      // ignore
    }
    this.worker = null
    this.workerReady = null
    for (const [, pending] of this.pending) {
      pending.rejectAsResult(
        `tool worker killed: ${reason}`,
        'host_killed',
      )
    }
    this.pending.clear()
  }
}

// ─── Singleton ───

let _singleton: ToolWorkerHost | null = null

/**
 * Lazily create / return the process-wide singleton. Tests that need
 * isolation should construct their own {@link ToolWorkerHost}
 * instance instead.
 */
export function getToolWorkerHost(): ToolWorkerHost {
  if (!_singleton) {
    _singleton = new ToolWorkerHost()
  }
  return _singleton
}

export async function disposeToolWorkerHostIfCreated(): Promise<void> {
  if (_singleton) await _singleton.dispose()
}

/** Replace the singleton — only for tests. */
export function __setToolWorkerHostForTests(host: ToolWorkerHost | null): void {
  _singleton = host
}

/**
 * After settings persist, refresh the utilityProcess view so WebSearch keys
 * (and anything else read via `readDiskSettings`) stay aligned. No-op when
 * tool-worker routing is disabled or no child is running.
 */
export function refreshToolWorkerFromMainDiskSettingsIfEnabled(): void {
  if (!isToolWorkerDispatchEnabled()) return
  try {
    getToolWorkerHost().postLiveSettingsSnapshot(readDiskSettings())
  } catch {
    /* ignore */
  }
}
