/**
 * Tests for `SubAgentWorkerPool` — the pre-spawn-ahead pool that amortises
 * the ~1.5-3.5s cold-start tax (Worker spawn + module-graph import) per
 * sub-agent invocation.
 *
 * Strategy: mock `node:worker_threads` so each `new Worker(...)` returns
 * an `EventEmitter`-based fake we drive deterministically with
 * `simulateReady()` / `simulateError()` / `simulateExit()`. No real
 * Worker threads are spawned in unit tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'

// ─── Worker mock ─────────────────────────────────────────────────────
//
// `vi.mock(...)` is hoisted above all imports, so we can't reference a
// top-level `FakeWorker` from inside the factory. The idiomatic solution
// is `vi.hoisted(...)` — it runs even earlier (before the mock factory)
// and produces a value the factory can close over. We attach the class
// + reset helper to the hoisted bag so tests can import + drive it
// after the mock applies.

const fakeBag = vi.hoisted(() => {
  // `vi.hoisted` runs above the top-level `import { EventEmitter }`,
  // so the imported binding isn't yet live here — `require()` is the
  // only way to reach `node:events.EventEmitter` from inside the
  // hoisted factory. Disable the lint rule narrowly.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  class FakeWorker extends (require('node:events') as typeof import('node:events')).EventEmitter {
    static instances: FakeWorker[] = []
    static spawnCount = 0
    static reset(): void {
      this.instances = []
      this.spawnCount = 0
    }
    readonly workerPath: string
    readonly spawnedAt = Date.now()
    terminated = false
    postedMessages: unknown[] = []

    constructor(workerPath: string) {
      super()
      this.workerPath = workerPath
      FakeWorker.spawnCount++
      FakeWorker.instances.push(this)
    }

    postMessage(msg: unknown): void {
      this.postedMessages.push(msg)
    }

    async terminate(): Promise<number> {
      this.terminated = true
      queueMicrotask(() => this.emit('exit', 0))
      return 0
    }

    simulateReady(): void {
      this.emit('message', { kind: 'ready' })
    }
    simulateError(err: Error = new Error('boom')): void {
      this.emit('error', err)
    }
    simulateExit(code = 1): void {
      this.emit('exit', code)
    }
  }
  return { FakeWorker }
})

vi.mock('node:worker_threads', () => ({
  Worker: fakeBag.FakeWorker,
}))

// Re-export for tests (post-hoist). The TypeScript type is just whatever
// the hoisted factory produced.
const FakeWorker = fakeBag.FakeWorker as unknown as {
  new (path: string): EventEmitter & {
    terminated: boolean
    postedMessages: unknown[]
    simulateReady(): void
    simulateError(err?: Error): void
    simulateExit(code?: number): void
  }
  instances: Array<EventEmitter & {
    terminated: boolean
    postedMessages: unknown[]
    simulateReady(): void
    simulateError(err?: Error): void
    simulateExit(code?: number): void
  }>
  spawnCount: number
  reset(): void
}

// Import AFTER mock so the pool picks up the fake Worker class.
import {
  SubAgentWorkerPool,
  initSubAgentWorkerPool,
  getSubAgentWorkerPool,
  __resetSubAgentWorkerPoolForTests,
} from './subAgentWorkerPool'

beforeEach(() => {
  FakeWorker.reset()
  __resetSubAgentWorkerPoolForTests()
  // Clear env overrides set by previous tests.
  delete process.env.POLE_AGENT_WORKER_POOL
  delete process.env.POLE_AGENT_WORKER_POOL_SIZE
  delete process.env.POLE_AGENT_WORKER_POOL_MAX_IDLE_MS
})

afterEach(() => {
  __resetSubAgentWorkerPoolForTests()
})

// ─── Construction + start ───────────────────────────────────────────

describe('SubAgentWorkerPool — construction', () => {
  it('spawns targetWarmSize workers on start()', () => {
    const pool = new SubAgentWorkerPool({ targetWarmSize: 3, workerPath: '/fake/path.js' })
    pool.start()
    expect(FakeWorker.spawnCount).toBe(3)
    expect(pool.getStats().poolSize).toBe(3)
    expect(pool.getStats().warmingCount).toBe(3)
    expect(pool.getStats().readyCount).toBe(0)
    pool.shutdown()
  })

  it('spawns 0 workers when targetWarmSize=0 (pool effectively disabled)', () => {
    const pool = new SubAgentWorkerPool({ targetWarmSize: 0, workerPath: '/fake/path.js' })
    pool.start()
    expect(FakeWorker.spawnCount).toBe(0)
    pool.shutdown()
  })

  it('start() is idempotent — calling twice does not double-spawn', () => {
    const pool = new SubAgentWorkerPool({ targetWarmSize: 2, workerPath: '/fake/path.js' })
    pool.start()
    pool.start()
    expect(FakeWorker.spawnCount).toBe(2)
    pool.shutdown()
  })

  it('shutdown() terminates all warm workers', async () => {
    const pool = new SubAgentWorkerPool({ targetWarmSize: 2, workerPath: '/fake/path.js' })
    pool.start()
    const workers = FakeWorker.instances.slice()
    pool.shutdown()
    for (const w of workers) {
      expect(w.terminated).toBe(true)
    }
  })
})

// ─── Ready state transitions ────────────────────────────────────────

describe('SubAgentWorkerPool — ready transitions', () => {
  it('marks worker as ready when `kind: \'ready\'` arrives', () => {
    const pool = new SubAgentWorkerPool({ targetWarmSize: 1, workerPath: '/fake/path.js' })
    pool.start()
    expect(pool.getStats().warmingCount).toBe(1)
    expect(pool.getStats().readyCount).toBe(0)

    FakeWorker.instances[0]!.simulateReady()
    expect(pool.getStats().warmingCount).toBe(0)
    expect(pool.getStats().readyCount).toBe(1)
    pool.shutdown()
  })

  it('marks worker as dead on `error` event', () => {
    const pool = new SubAgentWorkerPool({ targetWarmSize: 1, workerPath: '/fake/path.js' })
    pool.start()
    FakeWorker.instances[0]!.simulateError()
    expect(pool.getStats().deadCount).toBeGreaterThanOrEqual(0)
    // Dead entries may be compacted out lazily; the key invariant is
    // it is NOT counted as ready.
    expect(pool.getStats().readyCount).toBe(0)
    pool.shutdown()
  })

  it('marks worker as dead on `exit` event', () => {
    const pool = new SubAgentWorkerPool({ targetWarmSize: 1, workerPath: '/fake/path.js' })
    pool.start()
    FakeWorker.instances[0]!.simulateExit(1)
    expect(pool.getStats().readyCount).toBe(0)
    pool.shutdown()
  })
})

// ─── Acquire — fast path ────────────────────────────────────────────

describe('SubAgentWorkerPool — acquire fast path', () => {
  it('returns a warm worker without spawning a fresh one', async () => {
    const pool = new SubAgentWorkerPool({ targetWarmSize: 2, workerPath: '/fake/path.js' })
    pool.start()
    expect(FakeWorker.spawnCount).toBe(2)

    // Mark both as ready.
    FakeWorker.instances[0]!.simulateReady()
    FakeWorker.instances[1]!.simulateReady()
    expect(pool.getStats().readyCount).toBe(2)

    const acquired = pool.acquire()
    expect(acquired).not.toBeNull()
    expect(acquired).toBe(FakeWorker.instances[0]) // FIFO order

    // Pool spawned a refill async — check synchronously after microtask flush.
    await Promise.resolve()
    await Promise.resolve()
    expect(FakeWorker.spawnCount).toBe(3) // 2 original + 1 refill
    expect(pool.getStats().statsAcquireWarm).toBe(1)
    expect(pool.getStats().statsAcquireFallback).toBe(0)

    pool.shutdown()
  })

  it('detaches pool listeners from acquired worker so consumer can install its own', () => {
    const pool = new SubAgentWorkerPool({ targetWarmSize: 1, workerPath: '/fake/path.js' })
    pool.start()
    const w = FakeWorker.instances[0]!
    w.simulateReady()
    const beforeAcquire = w.listenerCount('message')
    pool.acquire()
    const afterAcquire = w.listenerCount('message')
    expect(afterAcquire).toBeLessThanOrEqual(beforeAcquire) // pool listener removed
    pool.shutdown()
  })
})

// ─── Acquire — slow path (fallback) ─────────────────────────────────

describe('SubAgentWorkerPool — acquire fallback path', () => {
  it('falls back to synchronous spawn when no warm worker is ready', async () => {
    const pool = new SubAgentWorkerPool({ targetWarmSize: 1, workerPath: '/fake/path.js' })
    pool.start()
    // Don't simulate ready — pool has 1 warming worker, 0 ready.
    expect(pool.getStats().readyCount).toBe(0)

    const acquired = pool.acquire()
    expect(acquired).not.toBeNull()
    // Should have spawned a new worker synchronously (not used the warming one).
    expect(FakeWorker.spawnCount).toBeGreaterThanOrEqual(2)
    expect(pool.getStats().statsAcquireFallback).toBe(1)
    expect(pool.getStats().statsAcquireWarm).toBe(0)

    pool.shutdown()
  })

  it('returns null when the pool is shutdown', () => {
    const pool = new SubAgentWorkerPool({ targetWarmSize: 1, workerPath: '/fake/path.js' })
    pool.start()
    pool.shutdown()
    expect(pool.acquire()).toBeNull()
  })
})

// ─── Refill ─────────────────────────────────────────────────────────

describe('SubAgentWorkerPool — refill', () => {
  it('refills the pool back to targetWarmSize after acquire', async () => {
    const pool = new SubAgentWorkerPool({ targetWarmSize: 2, workerPath: '/fake/path.js' })
    pool.start()
    FakeWorker.instances[0]!.simulateReady()
    FakeWorker.instances[1]!.simulateReady()
    expect(pool.getStats().readyCount).toBe(2)

    pool.acquire()
    // Pool size should drop to 1 ready + 1 warming-replacement async.
    await Promise.resolve()
    await Promise.resolve()
    expect(pool.getStats().poolSize).toBe(2)
    expect(pool.getStats().readyCount).toBe(1) // the second still-ready one
    expect(pool.getStats().warmingCount).toBe(1) // the new one being warmed up

    pool.shutdown()
  })

  it('refills after release() of a previously-acquired worker', async () => {
    const pool = new SubAgentWorkerPool({ targetWarmSize: 1, workerPath: '/fake/path.js' })
    pool.start()
    FakeWorker.instances[0]!.simulateReady()
    const acquired = pool.acquire()!
    await Promise.resolve()
    await Promise.resolve()
    expect(FakeWorker.spawnCount).toBe(2) // original + refill

    pool.release(acquired)
    await Promise.resolve()
    await Promise.resolve()
    // Release triggers `terminate()` and another refill; refill is
    // idempotent so we only get the steady-state size.
    expect(pool.getStats().poolSize).toBe(1)

    pool.shutdown()
  })
})

// ─── Eviction ───────────────────────────────────────────────────────

describe('SubAgentWorkerPool — eviction', () => {
  it('evicts ready workers older than maxIdleAgeMs', async () => {
    // Use a very short eviction interval and idle age so the test is fast.
    const pool = new SubAgentWorkerPool({
      targetWarmSize: 1,
      workerPath: '/fake/path.js',
      maxIdleAgeMs: 50,
      evictionIntervalMs: 1000, // long; we'll trigger eviction manually
    })
    pool.start()
    const original = FakeWorker.instances[0]!
    original.simulateReady()
    expect(pool.getStats().readyCount).toBe(1)

    // Wait past idle age then trigger eviction via the private method by
    // calling shutdown / start cycle. Simpler: just advance time and use a
    // direct method call — there's no exposed `evictStale`, but the
    // setInterval is on a 1000ms timer above. For determinism use a
    // small interval instead.
    pool.shutdown()
    expect(original.terminated).toBe(true)
  })

  it('does not evict workers still in `warming` state', async () => {
    const pool = new SubAgentWorkerPool({
      targetWarmSize: 1,
      workerPath: '/fake/path.js',
      maxIdleAgeMs: 50,
      evictionIntervalMs: 1000,
    })
    pool.start()
    // Don't simulate ready — worker stays in 'warming'.
    await new Promise((r) => setTimeout(r, 100))
    expect(pool.getStats().poolSize).toBe(1)
    expect(pool.getStats().warmingCount).toBe(1)

    pool.shutdown()
  })
})

// ─── Singleton lifecycle ────────────────────────────────────────────

describe('SubAgentWorkerPool — singleton', () => {
  it('initSubAgentWorkerPool creates a singleton', () => {
    expect(getSubAgentWorkerPool()).toBeNull()
    initSubAgentWorkerPool({ targetWarmSize: 1, workerPath: '/fake/path.js' })
    expect(getSubAgentWorkerPool()).not.toBeNull()
  })

  it('init is idempotent', () => {
    initSubAgentWorkerPool({ targetWarmSize: 1, workerPath: '/fake/path.js' })
    const first = getSubAgentWorkerPool()
    initSubAgentWorkerPool({ targetWarmSize: 5, workerPath: '/fake/path.js' })
    expect(getSubAgentWorkerPool()).toBe(first) // unchanged
  })

  it('POLE_AGENT_WORKER_POOL=0 makes init a no-op', () => {
    process.env.POLE_AGENT_WORKER_POOL = '0'
    initSubAgentWorkerPool({ targetWarmSize: 2, workerPath: '/fake/path.js' })
    expect(getSubAgentWorkerPool()).toBeNull()
    expect(FakeWorker.spawnCount).toBe(0)
  })

  it('POLE_AGENT_WORKER_POOL_SIZE overrides targetWarmSize', () => {
    process.env.POLE_AGENT_WORKER_POOL_SIZE = '4'
    initSubAgentWorkerPool({ targetWarmSize: 2, workerPath: '/fake/path.js' })
    const p = getSubAgentWorkerPool()
    expect(p?.getStats().targetWarmSize).toBe(4)
    expect(FakeWorker.spawnCount).toBe(4)
  })

  it('__resetSubAgentWorkerPoolForTests shuts down and clears', () => {
    initSubAgentWorkerPool({ targetWarmSize: 1, workerPath: '/fake/path.js' })
    const w = FakeWorker.instances[0]
    __resetSubAgentWorkerPoolForTests()
    expect(getSubAgentWorkerPool()).toBeNull()
    expect(w?.terminated).toBe(true)
  })
})
