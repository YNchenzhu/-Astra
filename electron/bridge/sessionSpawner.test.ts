/**
 * Tests for the bridge sessionSpawner — control surface + lifecycle.
 *
 * We don't spawn a real Worker here (vite-built workers don't exist
 * during vitest), so the tests inject a {@link MockWorker} that
 * faithfully implements {@link SessionWorkerLike} — bidirectional
 * postMessage, listener semantics, terminate Promise. The mock is
 * controlled from the test body to drive every lifecycle path:
 *
 *   - happy path: ready → init → started → events → done
 *   - stderr ring fills correctly on log lines
 *   - kill() escalates to forceKill() after 2s grace if worker silent
 *   - forceKill() resolves immediately
 *   - unexpected exit captures last stderr lines into the error message
 *   - update_token forwards through to the worker
 *   - invalid worker messages go to stderr ring without crashing
 *   - events AsyncIterable terminates on done
 */

import { describe, it, expect, vi } from 'vitest'
import type { ParentMessage, WorkerMessage } from './sessionMessages'
import { spawnSession, type SessionWorkerLike } from './sessionSpawner'
import type { LoopEvent } from '../ai/loopEvents'
import { fingerprintTranscript } from '../orchestration/kernelTypes'

// ────────────────────────────────────────────────────────────────────────
// Mock Worker — faithful to the real worker_threads.Worker contract.
// ────────────────────────────────────────────────────────────────────────

class MockWorker implements SessionWorkerLike {
  private msgListeners: Array<(msg: unknown) => void> = []
  private errListeners: Array<(err: Error) => void> = []
  private exitListeners: Array<(code: number) => void> = []
  /** All ParentMessages the spawner sent us, in order. */
  public received: ParentMessage[] = []
  public terminated = false

  postMessage(msg: unknown): void {
    this.received.push(msg as ParentMessage)
  }

  on(event: 'message', cb: (msg: unknown) => void): void
  on(event: 'error', cb: (err: Error) => void): void
  on(event: 'exit', cb: (code: number) => void): void
  on(event: string, cb: (arg: never) => void): void {
    if (event === 'message') this.msgListeners.push(cb as (m: unknown) => void)
    else if (event === 'error') this.errListeners.push(cb as (e: Error) => void)
    else if (event === 'exit') this.exitListeners.push(cb as (c: number) => void)
  }

  async terminate(): Promise<number> {
    this.terminated = true
    // Fire the standard exit notification with code 1 to mimic forced
    // termination (real Worker.terminate resolves with the exit code).
    queueMicrotask(() => {
      for (const l of this.exitListeners) l(1)
    })
    return 1
  }

  // ── Test-side helpers ──

  /** Push a message to the spawner as if the worker sent it. */
  emitMessage(msg: WorkerMessage): void {
    for (const l of this.msgListeners) l(msg)
  }

  /** Push an unstructured object (for invalid-message tests). */
  emitRawMessage(raw: unknown): void {
    for (const l of this.msgListeners) l(raw)
  }

  emitError(err: Error): void {
    for (const l of this.errListeners) l(err)
  }

  emitExit(code: number): void {
    for (const l of this.exitListeners) l(code)
  }
}

function makeInit() {
  return {
    sessionId: 'sess-test',
    params: {
      config: { id: 'anthropic', name: 'Anthropic', apiKey: 'k' },
      model: 'claude-test',
      messages: [{ role: 'user' as const, content: 'hi' }],
      enableTools: false,
    },
  }
}

// ────────────────────────────────────────────────────────────────────────
// Lifecycle tests
// ────────────────────────────────────────────────────────────────────────

describe('spawnSession — happy path', () => {
  it('resumes CAS from the initial snapshot and returns the full accepted snapshot', async () => {
    const worker = new MockWorker()
    const initialMessages = [{ role: 'user', content: 'resume' }]
    const initialSnapshot = {
      revision: 3,
      fingerprint: fingerprintTranscript(initialMessages),
      messages: initialMessages,
    }
    const session = spawnSession({
      init: { ...makeInit(), initialTranscriptSnapshot: initialSnapshot },
      workerFactory: () => worker,
    })
    worker.emitMessage({ kind: 'ready' })
    const committedMessages = [
      ...initialMessages,
      { role: 'assistant', content: 'continued' },
    ]
    worker.emitMessage({
      kind: 'transcript_commit',
      snapshot: {
        revision: 4,
        fingerprint: fingerprintTranscript(committedMessages),
        messages: committedMessages,
      },
    })
    worker.emitMessage({
      kind: 'done',
      result: {
        terminationResult: { reason: 'completed', turnCount: 1, terminatedAt: Date.now() },
        totalUsage: { inputTokens: 1, outputTokens: 1 },
        transition: 'no_tools',
        transitionHistory: ['init', 'no_tools'],
      },
    })

    const status = await session.done
    expect(status.transcriptRevision).toBe(4)
    expect(status.transcriptSnapshot?.messages).toEqual(committedMessages)
    expect(worker.received).toContainEqual({
      kind: 'transcript_ack',
      revision: 4,
      accepted: true,
    })
  })

  it('sends init only after ready, then collects events + done', async () => {
    const worker = new MockWorker()
    const session = spawnSession({
      init: makeInit(),
      workerFactory: () => worker,
    })

    // Spawner has registered listeners but not yet posted init.
    // The init is posted in response to `ready`.
    expect(worker.received.length).toBe(0)

    worker.emitMessage({ kind: 'ready' })
    expect(worker.received.length).toBe(1)
    expect(worker.received[0].kind).toBe('init')

    worker.emitMessage({ kind: 'started', sessionId: 'sess-test' })

    const events: LoopEvent[] = []
    const collect = (async () => {
      for await (const event of session.events) events.push(event)
    })()

    worker.emitMessage({ kind: 'event', event: { type: 'text_delta', text: 'hello' } })
    worker.emitMessage({
      kind: 'event',
      event: { type: 'tool_start', toolUse: { id: 't1', name: 'Bash', input: {} } },
    })
    worker.emitMessage({
      kind: 'done',
      result: {
        terminationResult: { reason: 'completed', turnCount: 1, terminatedAt: Date.now() },
        totalUsage: { inputTokens: 1, outputTokens: 1 },
        transition: 'tool_use',
        transitionHistory: ['init', 'tool_use'],
      },
    })

    await collect
    const status = await session.done
    expect(events.map((e) => e.type)).toEqual(['text_delta', 'tool_start'])
    expect(status.error).toBeUndefined()
    expect(status.result?.terminationResult.reason).toBe('completed')
  })

  it('populates activity ring from emitted events', async () => {
    const worker = new MockWorker()
    const session = spawnSession({
      init: makeInit(),
      workerFactory: () => worker,
    })
    worker.emitMessage({ kind: 'ready' })
    worker.emitMessage({
      kind: 'event',
      event: { type: 'tool_start', toolUse: { id: 't1', name: 'Bash', input: {} } },
    })
    worker.emitMessage({
      kind: 'event',
      event: {
        type: 'tool_result',
        toolResult: { id: 't1', name: 'Bash', success: true, output: 'ok' },
      },
    })
    worker.emitMessage({
      kind: 'done',
      result: {
        terminationResult: { reason: 'completed', turnCount: 1, terminatedAt: Date.now() },
        totalUsage: { inputTokens: 1, outputTokens: 1 },
        transition: 'tool_use',
        transitionHistory: ['init', 'tool_use'],
      },
    })
    await session.done
    const acts = session.activities()
    expect(acts.length).toBe(2)
    expect(acts[0].kind).toBe('tool_start')
    expect(acts[1].kind).toBe('tool_result')
  })

  it('captures log lines into the stderr ring', async () => {
    const worker = new MockWorker()
    const session = spawnSession({
      init: makeInit(),
      workerFactory: () => worker,
    })
    worker.emitMessage({ kind: 'ready' })
    worker.emitMessage({ kind: 'log', level: 'warn', message: 'something fishy' })
    worker.emitMessage({ kind: 'log', level: 'error', message: 'almost crashed' })
    const lines = session.stderr()
    expect(lines.length).toBe(2)
    expect(lines[0]).toContain('warn')
    expect(lines[0]).toContain('something fishy')
    expect(lines[1]).toContain('error')
    worker.emitMessage({
      kind: 'done',
      result: {
        terminationResult: { reason: 'completed', turnCount: 0, terminatedAt: Date.now() },
        totalUsage: { inputTokens: 0, outputTokens: 0 },
        transition: 'init',
        transitionHistory: ['init'],
      },
    })
    await session.done
  })
})

describe('spawnSession — failure modes', () => {
  it('worker `fail` becomes status.error', async () => {
    const worker = new MockWorker()
    const session = spawnSession({
      init: makeInit(),
      workerFactory: () => worker,
    })
    worker.emitMessage({ kind: 'ready' })
    worker.emitMessage({ kind: 'fail', error: 'segfault' })
    const status = await session.done
    expect(status.error).toBe('segfault')
    expect(status.result).toBeUndefined()
  })

  it('unexpected exit attaches last stderr lines to the error', async () => {
    const worker = new MockWorker()
    const session = spawnSession({
      init: makeInit(),
      workerFactory: () => worker,
    })
    worker.emitMessage({ kind: 'ready' })
    worker.emitMessage({ kind: 'log', level: 'error', message: 'syntax error in script' })
    worker.emitMessage({ kind: 'log', level: 'error', message: 'final death rattle' })
    worker.emitExit(2)
    const status = await session.done
    expect(status.error).toMatch(/exited \(code=2\)/)
    expect(status.error).toContain('final death rattle')
  })

  it('worker error event is captured even before done', async () => {
    const worker = new MockWorker()
    const session = spawnSession({
      init: makeInit(),
      workerFactory: () => worker,
    })
    worker.emitMessage({ kind: 'ready' })
    worker.emitError(new Error('worker.on(error) fired'))
    const status = await session.done
    expect(status.error).toContain('worker errored')
    expect(status.error).toContain('worker.on(error) fired')
  })

  it('invalid worker message goes to stderr ring without crashing', async () => {
    const worker = new MockWorker()
    const session = spawnSession({
      init: makeInit(),
      workerFactory: () => worker,
    })
    worker.emitMessage({ kind: 'ready' })
    worker.emitRawMessage({ kind: 'mystery_event' })
    const lines = session.stderr()
    expect(lines.length).toBe(1)
    expect(lines[0]).toContain('invalid worker message')
    worker.emitMessage({
      kind: 'done',
      result: {
        terminationResult: { reason: 'completed', turnCount: 0, terminatedAt: Date.now() },
        totalUsage: { inputTokens: 0, outputTokens: 0 },
        transition: 'init',
        transitionHistory: ['init'],
      },
    })
    await session.done
  })
})

describe('spawnSession — cancellation', () => {
  it('forceKill() terminates the worker and resolves done with error', async () => {
    const worker = new MockWorker()
    const session = spawnSession({
      init: makeInit(),
      workerFactory: () => worker,
    })
    worker.emitMessage({ kind: 'ready' })
    const status = await session.forceKill()
    expect(worker.terminated).toBe(true)
    expect(status.error).toMatch(/force-killed/)
  })

  it('kill() posts abort and resolves on graceful done', async () => {
    const worker = new MockWorker()
    const session = spawnSession({
      init: makeInit(),
      workerFactory: () => worker,
    })
    worker.emitMessage({ kind: 'ready' })
    const killPromise = session.kill('user-stop')
    // Spawner posted 'init' then 'abort'.
    expect(worker.received.find((m) => m.kind === 'abort')).toBeTruthy()
    // Worker reports done; kill should resolve to that.
    worker.emitMessage({
      kind: 'done',
      result: {
        terminationResult: { reason: 'aborted_streaming', turnCount: 0, terminatedAt: Date.now() },
        totalUsage: { inputTokens: 0, outputTokens: 0 },
        transition: 'init',
        transitionHistory: ['init'],
      },
    })
    const status = await killPromise
    expect(status.result?.terminationResult.reason).toBe('aborted_streaming')
    expect(worker.terminated).toBe(false)
  })

  it('kill() escalates to forceKill after 2s grace if worker silent', async () => {
    vi.useFakeTimers()
    try {
      const worker = new MockWorker()
      const session = spawnSession({
        init: makeInit(),
        workerFactory: () => worker,
      })
      worker.emitMessage({ kind: 'ready' })
      const killPromise = session.kill()
      // Advance past the 2s grace window — spawner should call worker.terminate().
      await vi.advanceTimersByTimeAsync(2_500)
      const status = await killPromise
      expect(worker.terminated).toBe(true)
      expect(status.error).toMatch(/force-killed/)
    } finally {
      vi.useRealTimers()
    }
  })

  it('updateAccessToken posts update_token to worker', async () => {
    const worker = new MockWorker()
    const session = spawnSession({
      init: makeInit(),
      workerFactory: () => worker,
    })
    worker.emitMessage({ kind: 'ready' })
    session.updateAccessToken('fresh-token')
    const tok = worker.received.find((m) => m.kind === 'update_token')
    expect(tok).toBeDefined()
    if (tok && tok.kind === 'update_token') {
      expect(tok.token).toBe('fresh-token')
    }
    // Tear down cleanly.
    worker.emitMessage({
      kind: 'done',
      result: {
        terminationResult: { reason: 'completed', turnCount: 0, terminatedAt: Date.now() },
        totalUsage: { inputTokens: 0, outputTokens: 0 },
        transition: 'init',
        transitionHistory: ['init'],
      },
    })
    await session.done
  })
})
