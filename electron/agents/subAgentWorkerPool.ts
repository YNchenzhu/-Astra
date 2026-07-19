/**
 * Sub-agent Worker pool — pre-spawn-ahead model.
 *
 * Problem: every `runSubAgentInWorker` call does `new Worker(workerPath)`,
 * which costs **800ms-2s for the Worker thread spawn alone** plus
 * **500-1500ms for the cold module-graph import** (the worker eagerly
 * `import`s `agenticLoopAsync`, all providers, the ToolRegistry, …).
 * That's a flat 1.5-3.5s tax on every spawn. Combined with DeepSeek-class
 * gateway TTFT (~5-15s) it pushes perceived "spawn-to-first-byte" past 15s.
 *
 * Design: the pool keeps a small set of warm workers (default 2) that have
 * already finished their cold module-graph import and have posted
 * `kind: 'ready'` back to the parent. When a sub-agent spawn requests a
 * worker, the pool hands one over **immediately** (no Worker spawn cost,
 * no module-load cost) and **synchronously kicks off a refill** so the
 * next acquire is also fast.
 *
 * We deliberately do NOT reuse workers across sessions:
 *   - Worker-side state (`currentSessionId`, `abortController`,
 *     `workerToolRegistry` populated by `registerRpcTools(toolDefs)`)
 *     would need a `reset` protocol that risks state leaks if a single
 *     field is missed. Each acquired worker runs ONE session and gets
 *     `worker.terminate()`'d — same as today.
 *   - The savings come from avoiding the **module-graph cold load**,
 *     which is the dominant cost (~1.5-3.5s). Reusing the worker
 *     instance would shave at most another 100-300ms (re-init only),
 *     which doesn't justify the state-management complexity.
 *
 * Lifecycle:
 *   - `start()` spawns `targetWarmSize` workers. Each new Worker emits
 *     `kind: 'ready'` after module init; until then it sits in `warming`.
 *   - `acquire()` pops a `ready` worker if available (O(1), fast path).
 *     Otherwise it falls back to spawning synchronously (slow path,
 *     ≈ today's behaviour). After every acquire, an async `refill()`
 *     restocks the pool.
 *   - `release(worker)` terminates the worker (one-shot session model)
 *     and triggers an async refill.
 *   - `evictStale()` runs once a minute, terminating workers older than
 *     `maxIdleAgeMs` (5min default) so the pool doesn't sit on
 *     potentially-stale module graphs forever.
 *
 * Disabled by default (no-op) until {@link initSubAgentWorkerPool} is
 * called from a process bootstrap. `subAgentWorkerClient.ts` checks
 * {@link getSubAgentWorkerPool} and falls through to legacy
 * `new Worker(workerPath)` when the pool is absent — so callers and
 * tests that don't initialise the pool see the unchanged old behaviour.
 */

import { Worker } from 'node:worker_threads'
import path from 'node:path'

/** Internal pool entry shape. */
interface PooledWorker {
  worker: Worker
  /**
   * - `warming` — Worker constructor returned; awaiting `kind: 'ready'`.
   * - `ready`   — `ready` received; worker is idle and eligible for acquire.
   * - `dead`    — `error` / `exit` observed; will be discarded on next pass.
   */
  state: 'warming' | 'ready' | 'dead'
  spawnedAt: number
  /**
   * Listeners installed by the pool. Removed when the worker is acquired so
   * the consumer can install its own clean set without conflict.
   */
  readyListener: (raw: unknown) => void
  errorListener: (err: Error) => void
  exitListener: (code: number) => void
}

export interface SubAgentWorkerPoolOptions {
  /** Default 2. Set to 0 to disable warm pre-spawning entirely. */
  targetWarmSize?: number
  /** Default 5min. Warm workers older than this are evicted. */
  maxIdleAgeMs?: number
  /** Default 60_000ms. Eviction sweep interval. */
  evictionIntervalMs?: number
  /**
   * Override of where the worker entry script lives. Tests pass a no-op
   * stub here; production omits it and uses the standard resolver.
   */
  workerPath?: string
}

export class SubAgentWorkerPool {
  private readonly targetWarmSize: number
  private readonly maxIdleAgeMs: number
  private readonly evictionIntervalMs: number
  private readonly workerPath: string

  private pool: PooledWorker[] = []
  private evictionTimer: ReturnType<typeof setInterval> | null = null
  private started = false
  private shutdownRequested = false

  // Telemetry counters (read by getStats() — tests pin invariants from these).
  private statsAcquireWarm = 0
  private statsAcquireFallback = 0
  private statsSpawnAttempts = 0
  private statsSpawnFailures = 0

  constructor(opts: SubAgentWorkerPoolOptions = {}) {
    this.targetWarmSize = Math.max(0, opts.targetWarmSize ?? 2)
    this.maxIdleAgeMs = Math.max(0, opts.maxIdleAgeMs ?? 5 * 60 * 1000)
    this.evictionIntervalMs = Math.max(1000, opts.evictionIntervalMs ?? 60_000)
    this.workerPath = opts.workerPath ?? defaultWorkerPath()
  }

  /**
   * Start the pool: spawn `targetWarmSize` workers and schedule the
   * eviction sweep. Idempotent — calling twice is a no-op.
   */
  start(): void {
    if (this.started || this.shutdownRequested) return
    this.started = true
    for (let i = 0; i < this.targetWarmSize; i++) {
      this.spawnWarm()
    }
    if (this.maxIdleAgeMs > 0 && this.targetWarmSize > 0) {
      this.evictionTimer = setInterval(() => this.evictStale(), this.evictionIntervalMs)
      // Don't pin the event loop for a long-lived watcher in tests.
      this.evictionTimer.unref?.()
    }
  }

  /**
   * Acquire a worker. Returns synchronously-resolved Promise<Worker>:
   *   - Fast path: a warm worker is available → returned immediately;
   *     refill kicked off asynchronously.
   *   - Slow path: no warm worker → spawns one synchronously, returns
   *     it without waiting for `ready` (the caller's existing handshake
   *     ignores `ready` semantics, see `subAgentWorkerClient.ts`'s
   *     `case 'ready': worker.postMessage({kind:'init',...})`).
   *
   * Returns null only when the pool was shutdown — callers handle that
   * by falling back to their legacy `new Worker(workerPath)` path.
   */
  acquire(): Worker | null {
    if (this.shutdownRequested) return null

    // Skip dead entries first to keep the array compact.
    let i = 0
    while (i < this.pool.length) {
      const pw = this.pool[i]!
      if (pw.state === 'dead') {
        this.pool.splice(i, 1)
        continue
      }
      if (pw.state === 'ready') {
        // Hand off this warm worker.
        this.pool.splice(i, 1)
        this.detachPoolListeners(pw)
        this.statsAcquireWarm++
        // Refill async so the caller isn't blocked.
        queueMicrotask(() => this.refill())
        return pw.worker
      }
      i++
    }

    // No warm worker — synchronous slow-path spawn.
    this.statsAcquireFallback++
    const worker = this.trySpawnRaw()
    if (worker == null) return null
    queueMicrotask(() => this.refill())
    return worker
  }

  /**
   * Caller is done with the worker (success, failure, or abort). The pool
   * terminates it and refills asynchronously.
   */
  release(worker: Worker): void {
    worker.terminate().catch(() => { /* noop */ })
    queueMicrotask(() => this.refill())
  }

  /** Snapshot for tests / diagnostics. Read-only. */
  getStats(): {
    targetWarmSize: number
    poolSize: number
    readyCount: number
    warmingCount: number
    deadCount: number
    statsAcquireWarm: number
    statsAcquireFallback: number
    statsSpawnAttempts: number
    statsSpawnFailures: number
  } {
    let readyCount = 0
    let warmingCount = 0
    let deadCount = 0
    for (const pw of this.pool) {
      if (pw.state === 'ready') readyCount++
      else if (pw.state === 'warming') warmingCount++
      else deadCount++
    }
    return {
      targetWarmSize: this.targetWarmSize,
      poolSize: this.pool.length,
      readyCount,
      warmingCount,
      deadCount,
      statsAcquireWarm: this.statsAcquireWarm,
      statsAcquireFallback: this.statsAcquireFallback,
      statsSpawnAttempts: this.statsSpawnAttempts,
      statsSpawnFailures: this.statsSpawnFailures,
    }
  }

  /** Test / shutdown only. Terminates all warm workers and stops eviction. */
  shutdown(): void {
    this.shutdownRequested = true
    if (this.evictionTimer) {
      clearInterval(this.evictionTimer)
      this.evictionTimer = null
    }
    for (const pw of this.pool) {
      this.detachPoolListeners(pw)
      pw.worker.terminate().catch(() => { /* noop */ })
    }
    this.pool = []
  }

  // ── internals ──

  private spawnWarm(): void {
    if (this.shutdownRequested) return
    if (this.pool.filter((pw) => pw.state !== 'dead').length >= this.targetWarmSize) {
      return
    }
    this.statsSpawnAttempts++
    const worker = this.trySpawnRaw()
    if (!worker) {
      this.statsSpawnFailures++
      return
    }

    const pw: PooledWorker = {
      worker,
      state: 'warming',
      spawnedAt: Date.now(),
      readyListener: () => { /* replaced below */ },
      errorListener: () => { /* replaced below */ },
      exitListener: () => { /* replaced below */ },
    }

    // The worker posts `{ kind: 'ready' }` once its module graph is loaded
    // (see `subAgentWorker.ts` final line). We listen ONLY for this here;
    // any other early message is ignored — the worker is between cold
    // start and acquire, so there's no session-related traffic yet.
    pw.readyListener = (raw: unknown) => {
      const msg = raw as Record<string, unknown> | null
      if (msg && msg.kind === 'ready') {
        pw.state = 'ready'
        // Detach the ready listener now — once the worker is handed off,
        // the consumer installs its own `message` handler.
        try { worker.removeListener('message', pw.readyListener) } catch { /* noop */ }
      }
    }
    pw.errorListener = () => { pw.state = 'dead' }
    pw.exitListener = () => { pw.state = 'dead' }

    worker.on('message', pw.readyListener)
    worker.on('error', pw.errorListener)
    worker.on('exit', pw.exitListener)
    this.pool.push(pw)
  }

  private trySpawnRaw(): Worker | null {
    try {
      return new Worker(this.workerPath)
    } catch (err) {
      console.warn(
        '[SubAgentWorkerPool] failed to spawn worker:',
        err instanceof Error ? err.message : String(err),
      )
      return null
    }
  }

  private detachPoolListeners(pw: PooledWorker): void {
    try { pw.worker.removeListener('message', pw.readyListener) } catch { /* noop */ }
    try { pw.worker.removeListener('error', pw.errorListener) } catch { /* noop */ }
    try { pw.worker.removeListener('exit', pw.exitListener) } catch { /* noop */ }
  }

  private refill(): void {
    if (this.shutdownRequested) return
    // Compact dead entries first.
    this.pool = this.pool.filter((pw) => pw.state !== 'dead')
    while (this.pool.length < this.targetWarmSize) {
      const before = this.pool.length
      this.spawnWarm()
      if (this.pool.length === before) break // spawn failed; back off
    }
  }

  private evictStale(): void {
    if (this.shutdownRequested) return
    const now = Date.now()
    const fresh: PooledWorker[] = []
    for (const pw of this.pool) {
      if (pw.state === 'dead') continue
      // Only evict workers that have been sitting warm too long. Workers
      // still in `warming` state get a free pass — they're not stale,
      // they just haven't finished module init yet (cold disk cache).
      if (pw.state === 'ready' && now - pw.spawnedAt > this.maxIdleAgeMs) {
        this.detachPoolListeners(pw)
        pw.worker.terminate().catch(() => { /* noop */ })
        continue
      }
      fresh.push(pw)
    }
    this.pool = fresh
    this.refill()
  }
}

function defaultWorkerPath(): string {
  // Mirrors `subAgentWorkerClient.resolveWorkerPath()`. Kept duplicate
  // rather than imported to avoid a circular dep when the client uses
  // this pool.
  return path.join(__dirname, 'subAgentWorker.js')
}

// ─── Module-level singleton ───
//
// The pool is a process-wide singleton so the cost amortises across every
// sub-agent call. Tests reset via `__resetSubAgentWorkerPoolForTests`.

let singleton: SubAgentWorkerPool | null = null

/**
 * Initialise the process-wide sub-agent worker pool. Idempotent — calling
 * twice keeps the first instance. Should be called once at app
 * bootstrap (after the worker file path is resolvable). When this is
 * NOT called, {@link getSubAgentWorkerPool} returns `null` and the
 * client falls back to its legacy `new Worker()` path.
 *
 * Env-driven opt-out: setting `POLE_AGENT_WORKER_POOL=0` makes this a
 * no-op so users hitting any pool-related bug can revert to legacy
 * behaviour without rebuilding.
 */
export function initSubAgentWorkerPool(opts?: SubAgentWorkerPoolOptions): void {
  if (singleton) return
  if (process.env.POLE_AGENT_WORKER_POOL === '0') return
  const sizeOverride = parseEnvInt(process.env.POLE_AGENT_WORKER_POOL_SIZE)
  const maxIdleOverride = parseEnvInt(process.env.POLE_AGENT_WORKER_POOL_MAX_IDLE_MS)
  const effective: SubAgentWorkerPoolOptions = {
    ...opts,
    ...(sizeOverride !== undefined ? { targetWarmSize: sizeOverride } : {}),
    ...(maxIdleOverride !== undefined ? { maxIdleAgeMs: maxIdleOverride } : {}),
  }
  singleton = new SubAgentWorkerPool(effective)
  singleton.start()
}

export function getSubAgentWorkerPool(): SubAgentWorkerPool | null {
  return singleton
}

/** Test-only: reset the singleton between cases. */
export function __resetSubAgentWorkerPoolForTests(): void {
  if (singleton) {
    singleton.shutdown()
    singleton = null
  }
}

function parseEnvInt(raw: string | undefined): number | undefined {
  if (!raw) return undefined
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined
}
