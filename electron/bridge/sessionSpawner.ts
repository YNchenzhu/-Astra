/**
 * Bridge session spawner — main-process control surface for isolated
 * agentic-loop runs.
 *
 * `spawnSession(params)` returns a {@link SessionHandle}:
 *
 *   const session = spawnSession({
 *     sessionId: 'remote-1',
 *     params: { config, model, messages, systemPrompt },
 *   })
 *   for await (const event of session.events) {
 *     console.log(event.type)
 *   }
 *   const result = await session.done
 *
 * The handle owns:
 *   - the underlying Worker thread (full lifecycle — `kill()` aborts
 *     gracefully, `forceKill()` calls `worker.terminate()`)
 *   - an {@link ActivityRing} of recent tool / text events (UI peek)
 *   - a {@link StderrRing} of recent worker log lines (crash reports)
 *   - an `events` AsyncIterable that mirrors {@link runAgenticLoopAsync}'s
 *     yield surface: consumers can swap `runAgenticLoopAsync` ↔
 *     `spawnSession({...}).events` with no other code change
 *
 * Path resolution mirrors `embedding/localModel.ts`: vite-plugin-electron
 * bundles the worker as `dist-electron/sessionWorker.js`, which sits next
 * to the main bundle.
 */

import path from 'node:path'
import { Worker } from 'node:worker_threads'
import {
  parseWorkerMessage,
  type ParentMessage,
  type SessionInit,
  type TranscriptSnapshotWire,
  type WorkerMessage,
} from './sessionMessages'
import {
  activityFromLoopEvent,
  createActivityRing,
  createStderrRing,
  DEFAULT_ACTIVITY_RING_SIZE,
  DEFAULT_STDERR_RING_SIZE,
  type Activity,
  type ActivityRing,
  type StderrRing,
} from './activityRing'
import type { AgenticLoopResult, LoopEvent } from '../ai/loopEvents'
import {
  acceptRemoteTranscriptCommit,
  createEmptyAcceptedTranscript,
} from './remoteHostProtocol'

// ────────────────────────────────────────────────────────────────────────
// SessionHandle
// ────────────────────────────────────────────────────────────────────────

/** What a worker session reports back when it terminates. */
export interface SessionDoneStatus {
  /** Outcome from the agentic loop (`'completed'` / `'aborted_streaming'` / etc.) */
  result?: AgenticLoopResult
  /** Set when the worker died unexpectedly OR before a `done` was sent. */
  error?: string
  /** ms epoch — when the parent observed the terminal status. */
  terminatedAt: number
  /** Last transcript revision acknowledged by the parent before termination. */
  transcriptRevision?: number
  /** Full parent-acknowledged snapshot available for a safe worker restart. */
  transcriptSnapshot?: TranscriptSnapshotWire
}

export interface SessionHandle {
  sessionId: string
  pause(reason?: string): void
  resume(): void
  /** Resolves when the worker either sent `done` or `fail`, or exited unexpectedly. */
  done: Promise<SessionDoneStatus>
  /**
   * Streamed loop events. Mirrors {@link runAgenticLoopAsync} but
   * sourced from postMessage. Consumers can `for await` directly.
   */
  events: AsyncIterable<LoopEvent>
  /** Most-recent activities (capped at 10 by default). */
  activities: () => ReadonlyArray<Activity>
  /** Most-recent worker log lines (capped at 10 by default). */
  stderr: () => ReadonlyArray<string>
  /** Soft abort: post `abort` to worker, await graceful shutdown. */
  kill: (reason?: string) => Promise<SessionDoneStatus>
  /** Hard abort: `worker.terminate()` immediately. */
  forceKill: () => Promise<SessionDoneStatus>
  /** Refresh access token on the live worker (e.g. OAuth expiry). */
  updateAccessToken: (token: string) => void
}

// ────────────────────────────────────────────────────────────────────────
// Internal event channel — same shape as queryLoopAsyncGenerator
// ────────────────────────────────────────────────────────────────────────

type Chunk =
  | { kind: 'event'; event: LoopEvent }
  | { kind: 'end' }
  | { kind: 'error'; error: Error }

interface EventChannel {
  push(c: Chunk): void
  iterable: AsyncIterable<LoopEvent>
}

/**
 * Hard cap on un-consumed worker → parent events. Reached only when the
 * consumer (agentic loop) is itself stalled — typical worker emits are 10s
 * to low 100s of events between consumer ticks, so 5000 is well above the
 * working set while still bounding peak memory (each LoopEvent can carry a
 * tool-result up to ~250 KB → 5000 × 250 KB ≈ 1.25 GB upper bound, but
 * realistically <100 MB because most events are small).
 *
 * When breached we drop the oldest non-terminal event so terminal `end` /
 * `error` markers always survive — losing them would deadlock the consumer.
 */
const SESSION_EVENT_CHANNEL_MAX = 5000

function createEventChannel(): EventChannel {
  const queue: Chunk[] = []
  let resolver: (() => void) | null = null
  let closed = false
  let droppedSinceLastWarn = 0
  let totalDropped = 0

  function signal() {
    const r = resolver
    resolver = null
    r?.()
  }

  return {
    push(c) {
      if (closed) return
      if (c.kind !== 'event') closed = true
      // Cap breach: shed the oldest *event* chunk. Never drop end/error so
      // the iterator's terminal contract is preserved even under shedding.
      if (queue.length >= SESSION_EVENT_CHANNEL_MAX && c.kind === 'event') {
        let droppedAt = -1
        for (let i = 0; i < queue.length; i++) {
          if (queue[i].kind === 'event') {
            droppedAt = i
            break
          }
        }
        if (droppedAt >= 0) {
          queue.splice(droppedAt, 1)
          droppedSinceLastWarn++
          totalDropped++
          // Throttle warning to once per 100 drops to avoid log floods.
          if (droppedSinceLastWarn === 1 || droppedSinceLastWarn % 100 === 0) {
            console.warn(
              `[sessionSpawner] event channel overflow: dropped oldest event ` +
                `(queue >= ${SESSION_EVENT_CHANNEL_MAX}; total drops=${totalDropped}). ` +
                `Consumer is stalled or worker is producing faster than the loop drains.`,
            )
          }
        }
      }
      queue.push(c)
      signal()
    },
    iterable: {
      async *[Symbol.asyncIterator]() {
        while (true) {
          if (queue.length === 0) {
            if (closed) return
            await new Promise<void>((resolve) => {
              resolver = resolve
            })
            continue
          }
          const c = queue.shift()!
          if (c.kind === 'event') {
            yield c.event
            continue
          }
          if (c.kind === 'error') throw c.error
          // end
          return
        }
      },
    },
  }
}

// ────────────────────────────────────────────────────────────────────────
// Worker path resolution
// ────────────────────────────────────────────────────────────────────────

/** Default path; tests / specialised callers can override via `spawnSessionWith`. */
function defaultWorkerPath(): string {
  // vite-plugin-electron emits `dist-electron/sessionWorker.js` next to
  // the main bundle. `__dirname` resolves to `dist-electron/` at runtime.
  return path.join(__dirname, 'sessionWorker.js')
}

// ────────────────────────────────────────────────────────────────────────
// Spawner — public API
// ────────────────────────────────────────────────────────────────────────

export interface SpawnSessionOptions {
  /** Init payload to send the worker. */
  init: SessionInit
  /** Override worker file path (tests). */
  workerPath?: string
  /** Override ring sizes (tests / specialised use-cases). */
  activityRingSize?: number
  stderrRingSize?: number
  /**
   * Inject an alternate Worker constructor. Tests use this to substitute
   * a controllable mock; production callers should leave it
   * unspecified.
   */
  workerFactory?: (workerPath: string) => SessionWorkerLike
}

/**
 * Subset of `node:worker_threads.Worker` we actually use. Defining a
 * shim interface lets tests swap a tiny in-memory mock for a real
 * Worker without monkey-patching globals.
 */
export interface SessionWorkerLike {
  postMessage(msg: unknown): void
  on(event: 'message', cb: (msg: unknown) => void): void
  on(event: 'error', cb: (err: Error) => void): void
  on(event: 'exit', cb: (code: number) => void): void
  terminate(): Promise<number>
}

export function spawnSession(opts: SpawnSessionOptions): SessionHandle {
  const sessionId = opts.init.sessionId
  const activityRing: ActivityRing = createActivityRing(
    opts.activityRingSize ?? DEFAULT_ACTIVITY_RING_SIZE,
  )
  const stderrRing: StderrRing = createStderrRing(
    opts.stderrRingSize ?? DEFAULT_STDERR_RING_SIZE,
  )
  const channel = createEventChannel()

  const worker: SessionWorkerLike = (opts.workerFactory ?? defaultWorkerFactory)(
    opts.workerPath ?? defaultWorkerPath(),
  )

  // Done-promise plumbing. We resolve from any of three places:
  //   - worker sent `'done'`   → status.result populated
  //   - worker sent `'fail'`   → status.error populated
  //   - worker exited unexpectedly → status.error populated with last
  //     stderr lines (helpful for crash diagnosis)
  let resolveDone!: (s: SessionDoneStatus) => void
  const donePromise = new Promise<SessionDoneStatus>((resolve) => {
    resolveDone = resolve
  })
  let resolved = false
  let acceptedTranscript = opts.init.initialTranscriptSnapshot
    ? structuredClone(opts.init.initialTranscriptSnapshot)
    : createEmptyAcceptedTranscript()
  /**
   * Set when the **parent** initiated termination (forceKill / kill →
   * forceKill escalation). The worker's subsequent `exit` event is
   * **not** a crash in that case — it's the expected effect of our
   * own action. Without this gate, the exit handler would race the
   * forceKill resolver and the consumer would see misleading
   * "worker exited (code=1)" diagnostics for what was really a clean
   * user-requested stop.
   */
  let parentInitiatedTerminate = false
  const finishWith = (status: SessionDoneStatus): void => {
    if (resolved) return
    resolved = true
    resolveDone({
      ...status,
      transcriptRevision: acceptedTranscript.revision,
      transcriptSnapshot: structuredClone(acceptedTranscript),
    })
    channel.push({ kind: 'end' })
  }

  // ── Wire worker → channel + rings ──
  worker.on('message', (raw: unknown) => {
    const parsed = parseWorkerMessage(raw)
    if (!parsed.ok) {
      stderrRing.push(`[bridge] invalid worker message: ${parsed.error}`)
      return
    }
    const msg: WorkerMessage = parsed.value
    switch (msg.kind) {
      case 'ready':
        // Worker side has wired its message handler. Send the init
        // payload now (we couldn't earlier — postMessage would have
        // raced the handler attach).
        worker.postMessage({ kind: 'init', payload: opts.init } satisfies ParentMessage)
        return
      case 'started':
        return
      case 'event': {
        const ev = msg.event
        channel.push({ kind: 'event', event: ev })
        const a = activityFromLoopEvent(ev)
        if (a) activityRing.push(a)
        return
      }
      case 'log':
        stderrRing.push(`[${msg.level}] ${msg.message}`)
        return
      case 'iteration_boundary':
        return
      case 'transcript_commit': {
        const decision = acceptRemoteTranscriptCommit(
          acceptedTranscript,
          msg.snapshot,
        )
        if (decision.ok) {
          acceptedTranscript = decision.snapshot
          worker.postMessage({
            kind: 'transcript_ack',
            revision: msg.snapshot.revision,
            accepted: true,
          } satisfies ParentMessage)
        } else {
          worker.postMessage({
            kind: 'transcript_ack',
            revision: msg.snapshot.revision,
            accepted: false,
            actualRevision: decision.actualRevision,
            reason: decision.reason,
          } satisfies ParentMessage)
        }
        return
      }
      case 'done':
        finishWith({
          result: msg.result,
          terminatedAt: Date.now(),
        })
        return
      case 'fail':
        finishWith({
          error: msg.error,
          terminatedAt: Date.now(),
        })
        return
      default: {
        const _exhaustive: never = msg
        void _exhaustive
      }
    }
  })

  worker.on('error', (err) => {
    stderrRing.push(`[bridge] worker error: ${err.message}`)
    if (!resolved) {
      finishWith({
        error: `worker errored: ${err.message}`,
        terminatedAt: Date.now(),
      })
    }
  })

  worker.on('exit', (code: number) => {
    if (resolved) return
    if (parentInitiatedTerminate) {
      // The exit was the consequence of our own forceKill() call. Surface
      // it as "force-killed" with the exit code attached for traceability,
      // not as an unexpected-exit error which would mislead the caller
      // into thinking the worker crashed.
      finishWith({
        error: `force-killed by parent (worker exit code=${code})`,
        terminatedAt: Date.now(),
      })
      return
    }
    // Unexpected exit before done/fail was sent — surface stderr ring
    // alongside the exit code so callers have at least *some* signal.
    const tail = stderrRing.snapshot().slice(-3).join(' | ')
    finishWith({
      error: `worker exited (code=${code})${tail ? `: ${tail}` : ''}`,
      terminatedAt: Date.now(),
    })
  })

  // ── Public handle ──
  const handle: SessionHandle = {
    sessionId,
    pause(reason) {
      if (!resolved) worker.postMessage({ kind: 'pause', reason } satisfies ParentMessage)
    },
    resume() {
      if (!resolved) worker.postMessage({ kind: 'resume' } satisfies ParentMessage)
    },
    done: donePromise,
    events: channel.iterable,
    activities: () => activityRing.snapshot(),
    stderr: () => stderrRing.snapshot(),
    async kill(reason) {
      if (resolved) return donePromise
      worker.postMessage({ kind: 'abort', reason } satisfies ParentMessage)
      // Soft kill grace window: if the worker hasn't reported `done`
      // within 2s, escalate to terminate().
      const grace = 2000
      const result = await Promise.race([
        donePromise,
        new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), grace)),
      ])
      if (result === 'timeout') {
        return handle.forceKill()
      }
      return result
    },
    async forceKill() {
      if (!resolved) {
        parentInitiatedTerminate = true
        try {
          await worker.terminate()
        } catch (err) {
          stderrRing.push(
            `[bridge] terminate failed: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
        // After terminate(), the worker fires 'exit' which the handler
        // above will translate into a `force-killed` SessionDoneStatus.
        // We still race against an early `done`/`fail` from the worker
        // (e.g. it managed to send the message just before terminate
        // landed), in which case `resolved` is already true and the
        // exit handler short-circuits. As a defensive last-resort, if
        // the exit handler hasn't fired by the time terminate returns,
        // resolve here so the caller doesn't hang.
        if (!resolved) {
          finishWith({
            error: 'force-killed by parent',
            terminatedAt: Date.now(),
          })
        }
      }
      return donePromise
    },
    updateAccessToken(token) {
      if (resolved) return
      worker.postMessage({ kind: 'update_token', token } satisfies ParentMessage)
    },
  }

  return handle
}

// ────────────────────────────────────────────────────────────────────────
// Default Worker factory — used when no override is supplied.
// ────────────────────────────────────────────────────────────────────────

function defaultWorkerFactory(workerPath: string): SessionWorkerLike {
  // `Worker` (node:worker_threads) is a strict superset of our shim
  // interface. The cast skips re-declaring the full Worker surface.
  return new Worker(workerPath) as unknown as SessionWorkerLike
}
