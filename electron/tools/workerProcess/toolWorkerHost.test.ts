/**
 * Unit tests for {@link ToolWorkerHost}.
 *
 * These tests do **not** spawn a real `utilityProcess`. Instead we
 * inject a fake worker (an `EventEmitter` shim) that lets us
 * deterministically drive the wire protocol — so crash / abort /
 * concurrent-dispatch behavior can be tested in-process without
 * booting Electron.
 *
 * Real-process spawn / crash behavior is validated manually in dev
 * (kill -9 the utility PID, watch the host respawn on next dispatch).
 */

import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import {
  ToolWorkerHost,
  __setToolWorkerHostForTests,
  isWorkerFileMutationTool,
  type ToolWorkerFactory,
  type ToolWorkerHandle,
} from './toolWorkerHost'
import type { ToolProgressEvent } from '../toolExecContext'
import { isWorkerToHost } from './wireProtocol'
import type { HostToWorker, WorkerToHost } from './wireProtocol'
import {
  assertReadBeforeWrite,
  clearAllReadFileState,
  findReadReceiptByReadId,
  hashFileContent,
  importReceipts,
  normalizeReadStatePathKey,
  recordSelfMutationReadReceipt,
  recordSuccessfulRead,
  type ReadFileRecord,
} from '../readFileState'
import { resolvePathForTool, setWorkspacePath } from '../workspaceState'

/**
 * Minimal fake worker: an EventEmitter exposing the
 * {@link ToolWorkerHandle} surface. Tests drive the wire protocol by
 * calling `worker.emitFromWorker(msg)`; the host's `postMessage()` is
 * intercepted via the `posts` array so we can assert dispatched
 * requests / aborts.
 *
 * The `requestPosts` accessor strips the bootstrap `tool_init` frame
 * the host always sends right after `tool_ready` — tests care about
 * the per-call traffic, not the hydration handshake.
 */
class FakeWorker extends EventEmitter implements ToolWorkerHandle {
  posts: HostToWorker[] = []
  pid = 12345
  killed = false

  postMessage(msg: HostToWorker): void {
    this.posts.push(msg)
  }

  /** Posts excluding the boot `tool_init` frame. */
  get requestPosts(): HostToWorker[] {
    return this.posts.filter((m) => m.kind !== 'tool_init')
  }

  kill(): boolean {
    this.killed = true
    return true
  }

  // Simulate a frame coming from the utilityProcess.
  emitFromWorker(msg: WorkerToHost): void {
    this.emit('message', msg)
  }

  // Simulate the utilityProcess crashing / exiting.
  emitExit(code: number | null): void {
    this.emit('exit', code)
  }
}

/**
 * Build a factory that returns the same FakeWorker on first call and
 * a fresh one on each subsequent call (for crash → respawn testing).
 */
function makeRotatingFactory(): {
  factory: ToolWorkerFactory
  workers: FakeWorker[]
} {
  const workers: FakeWorker[] = []
  const factory: ToolWorkerFactory = () => {
    const w = new FakeWorker()
    workers.push(w)
    // Auto-ready on next microtask, mirroring real worker behavior.
    queueMicrotask(() =>
      w.emitFromWorker({ kind: 'tool_ready', pid: w.pid }),
    )
    return w
  }
  return { factory, workers }
}

describe('ToolWorkerHost', () => {
  let host: ToolWorkerHost
  let workers: FakeWorker[]

  beforeEach(() => {
    const f = makeRotatingFactory()
    workers = f.workers
    host = new ToolWorkerHost(f.factory)
  })

  it('routes a successful tool_response back to dispatch()', async () => {
    const promise = host.dispatch('__tool_worker_ping', { echo: 'hello' })
    // Let the boot ready frame land first.
    await new Promise((r) => setImmediate(r))
    const w = workers[0]
    expect(w.requestPosts).toHaveLength(1)
    const req = w.requestPosts[0]
    expect(req.kind).toBe('tool_request')
    if (req.kind !== 'tool_request') throw new Error('unreachable')
    expect(req.diskSettingsSnapshot).toBeDefined()
    expect(typeof req.diskSettingsSnapshot).toBe('object')
    w.emitFromWorker({
      kind: 'tool_response',
      reqId: req.reqId,
      ok: true,
      result: { success: true, output: 'pong:hello' },
    })
    const result = await promise
    expect(result).toEqual({ success: true, output: 'pong:hello' })
  })

  it('surfaces tool_error as a structured failure result', async () => {
    const promise = host.dispatch('__tool_worker_ping', { fail: true })
    await new Promise((r) => setImmediate(r))
    const w = workers[0]
    const req = w.requestPosts[0]
    if (req.kind !== 'tool_request') throw new Error('unreachable')
    w.emitFromWorker({
      kind: 'tool_error',
      reqId: req.reqId,
      ok: false,
      error: 'forced failure',
      errorClass: 'Error',
    })
    const result = await promise
    expect(result.success).toBe(false)
    expect(result.error).toBe('forced failure')
    expect(result.toolErrorClass).toBe('Error')
  })

  it('threads tool_error telemetryHint through to the result', async () => {
    const promise = host.dispatch('__tool_worker_ping', { fail: true })
    await new Promise((r) => setImmediate(r))
    const w = workers[0]
    const req = w.requestPosts[0]
    if (req.kind !== 'tool_request') throw new Error('unreachable')
    w.emitFromWorker({
      kind: 'tool_error',
      reqId: req.reqId,
      ok: false,
      error: 'ENOENT: no such file',
      errorClass: 'filesystem',
      telemetryHint: 'worker_executor_exception:Error:filesystem',
    })
    const result = await promise
    expect(result.success).toBe(false)
    expect(result.toolErrorClass).toBe('filesystem')
    expect(result.telemetryHint).toBe('worker_executor_exception:Error:filesystem')
  })

  it('fails an in-flight RPC with worker_protocol_violation on a malformed frame', async () => {
    const promise = host.dispatch('__tool_worker_ping', { echo: 'x' })
    await new Promise((r) => setImmediate(r))
    const w = workers[0]
    const req = w.requestPosts[0]
    if (req.kind !== 'tool_request') throw new Error('unreachable')
    // tool_response missing a valid `result` — must not resolve with undefined.
    w.emitFromWorker({
      kind: 'tool_response',
      reqId: req.reqId,
      ok: true,
      // @ts-expect-error intentionally malformed: result is not a ToolResult
      result: undefined,
    })
    const result = await promise
    expect(result.success).toBe(false)
    expect(result.toolErrorClass).toBe('worker_protocol_violation')
  })

  it('rejects in-flight RPCs with worker_crashed when the worker exits', async () => {
    const p1 = host.dispatch('__tool_worker_ping', { echo: 'a' })
    const p2 = host.dispatch('__tool_worker_ping', { echo: 'b' })
    await new Promise((r) => setImmediate(r))
    const w = workers[0]
    expect(w.requestPosts).toHaveLength(2)
    // Crash before any response.
    w.emitExit(137)
    const r1 = await p1
    const r2 = await p2
    expect(r1.success).toBe(false)
    expect(r1.toolErrorClass).toBe('worker_crashed')
    expect(r1.error).toContain('code=137')
    expect(r2.success).toBe(false)
    expect(r2.toolErrorClass).toBe('worker_crashed')
    expect(host.getRestartCount()).toBe(1)
  })

  it('spawns a fresh worker on the next dispatch after a crash', async () => {
    const p1 = host.dispatch('__tool_worker_ping', { echo: 'a' })
    await new Promise((r) => setImmediate(r))
    workers[0].emitExit(1)
    await p1
    expect(workers).toHaveLength(1) // no eager respawn

    const p2 = host.dispatch('__tool_worker_ping', { echo: 'after-crash' })
    await new Promise((r) => setImmediate(r))
    expect(workers).toHaveLength(2)
    const fresh = workers[1]
    const req = fresh.requestPosts[0]
    if (req.kind !== 'tool_request') throw new Error('unreachable')
    fresh.emitFromWorker({
      kind: 'tool_response',
      reqId: req.reqId,
      ok: true,
      result: { success: true, output: 'pong:after-crash' },
    })
    const r2 = await p2
    expect(r2.success).toBe(true)
    expect(r2.output).toBe('pong:after-crash')
    expect(host.getRestartCount()).toBe(1)
  })

  it('forwards AbortSignal as a tool_abort to the worker', async () => {
    const ctrl = new AbortController()
    const promise = host.dispatch(
      '__tool_worker_ping',
      { echo: 'slow' },
      undefined,
      ctrl.signal,
    )
    await new Promise((r) => setImmediate(r))
    const w = workers[0]
    expect(w.requestPosts).toHaveLength(1)
    ctrl.abort()
    await new Promise((r) => setImmediate(r))
    expect(w.requestPosts).toHaveLength(2)
    expect(w.requestPosts[1].kind).toBe('tool_abort')
    // Simulate worker honoring the abort by returning an error.
    const req = w.requestPosts[0]
    if (req.kind !== 'tool_request') throw new Error('unreachable')
    w.emitFromWorker({
      kind: 'tool_error',
      reqId: req.reqId,
      ok: false,
      error: 'aborted by host',
      errorClass: 'aborted',
    })
    const result = await promise
    expect(result.success).toBe(false)
    expect(result.toolErrorClass).toBe('aborted')
  })

  it('forwards tool_progress to emitToolProgress for web_fetch', async () => {
    const progress: ToolProgressEvent[] = []
    const promise = host.dispatch(
      'web_fetch',
      { url: 'https://example.com' },
      undefined,
      undefined,
      (e) => progress.push(e),
    )
    await new Promise((r) => setImmediate(r))
    const w = workers[0]
    const req = w.requestPosts[0]
    if (req.kind !== 'tool_request') throw new Error('unreachable')
    expect(req.enableHostProgress).toBe(true)
    const evt: ToolProgressEvent = { type: 'text', data: { text: 'hello\n' } }
    w.emitFromWorker({
      kind: 'tool_progress',
      reqId: req.reqId,
      event: evt,
    })
    w.emitFromWorker({
      kind: 'tool_response',
      reqId: req.reqId,
      ok: true,
      result: { success: true, output: 'done' },
    })
    await promise
    expect(progress).toEqual([evt])
  })

  it('returns aborted-before-dispatch when the signal is already fired', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    const result = await host.dispatch(
      '__tool_worker_ping',
      { echo: 'x' },
      undefined,
      ctrl.signal,
    )
    expect(result.success).toBe(false)
    expect(result.toolErrorClass).toBe('aborted')
    // Importantly the worker was never spawned for an aborted call.
    expect(workers).toHaveLength(0)
  })

  it('returns a clean spawn_failed result when the factory throws', async () => {
    const failing = new ToolWorkerHost(() => {
      throw new Error('factory blew up')
    })
    const result = await failing.dispatch('__tool_worker_ping', { echo: 'x' })
    expect(result.success).toBe(false)
    expect(result.toolErrorClass).toBe('spawn_failed')
    expect(result.error).toContain('factory blew up')
  })

  it('handles concurrent dispatches independently (reqId routing)', async () => {
    const p1 = host.dispatch('__tool_worker_ping', { echo: 'one' })
    const p2 = host.dispatch('__tool_worker_ping', { echo: 'two' })
    await new Promise((r) => setImmediate(r))
    const w = workers[0]
    expect(w.requestPosts).toHaveLength(2)
    const [r1, r2] = w.requestPosts as Array<HostToWorker>
    if (r1.kind !== 'tool_request' || r2.kind !== 'tool_request') {
      throw new Error('unreachable')
    }
    expect(r1.reqId).not.toBe(r2.reqId)
    // Respond out of order — host must still route correctly by reqId.
    w.emitFromWorker({
      kind: 'tool_response',
      reqId: r2.reqId,
      ok: true,
      result: { success: true, output: 'pong:two' },
    })
    w.emitFromWorker({
      kind: 'tool_response',
      reqId: r1.reqId,
      ok: true,
      result: { success: true, output: 'pong:one' },
    })
    expect((await p1).output).toBe('pong:one')
    expect((await p2).output).toBe('pong:two')
  })

  it('dispose() drains pending RPCs as host_killed', async () => {
    const p1 = host.dispatch('__tool_worker_ping', { echo: 'x' })
    await new Promise((r) => setImmediate(r))
    await host.dispose()
    const r1 = await p1
    expect(r1.success).toBe(false)
    expect(r1.toolErrorClass).toBe('host_killed')
    // After dispose, further dispatches short-circuit.
    const r2 = await host.dispatch('__tool_worker_ping', { echo: 'y' })
    expect(r2.success).toBe(false)
    expect(r2.toolErrorClass).toBe('host_disposed')
  })
})

describe('executors registry (worker side)', () => {
  it('ping executor returns pong:<echo>', async () => {
    const { getExecutor } = await import('./executors')
    const exec = getExecutor('__tool_worker_ping')
    expect(exec).toBeDefined()
    const result = await exec!({ echo: 'hi' }, new AbortController().signal)
    expect(result).toEqual({ success: true, output: 'pong:hi' })
  })

  it('ping executor honors the fail flag', async () => {
    const { getExecutor } = await import('./executors')
    const exec = getExecutor('__tool_worker_ping')
    await expect(
      exec!({ fail: true, error: 'boom' }, new AbortController().signal),
    ).rejects.toThrow('boom')
  })

  it('phase-2 executors are registered (read_file/glob/grep/web_fetch/WebSearch)', async () => {
    const { getExecutor, listExecutors } = await import('./executors')
    const names = listExecutors()
    for (const expected of ['read_file', 'glob', 'grep', 'web_fetch', 'WebSearch']) {
      expect(names, `missing executor ${expected}`).toContain(expected)
      expect(getExecutor(expected)).toBeDefined()
    }
  })

  it('phase-3 executors are registered (write_file/edit_file/multi_edit_file)', async () => {
    const { getExecutor, listExecutors } = await import('./executors')
    const names = listExecutors()
    for (const expected of ['write_file', 'edit_file', 'multi_edit_file']) {
      expect(names, `missing executor ${expected}`).toContain(expected)
      expect(getExecutor(expected)).toBeDefined()
    }
  })

  it('phase-4 executors are registered (bash/PowerShell) but tools stay on main', async () => {
    const { getExecutor, listExecutors } = await import('./executors')
    const names = listExecutors()
    for (const expected of ['bash', 'PowerShell']) {
      expect(names, `missing executor ${expected}`).toContain(expected)
      expect(getExecutor(expected)).toBeDefined()
    }
    // The registry tools must NOT be tagged with runIn:'worker' — see
    // executors.ts header comment for the background-task / stream IPC
    // reasoning. This regression-pins the default.
    const { toolRegistry } = await import('../registry')
    expect(toolRegistry.get('bash')?.runIn).not.toBe('worker')
    expect(toolRegistry.get('PowerShell')?.runIn).not.toBe('worker')
  })
})

describe('Phase 2 — tool_init handshake', () => {
  it('host sends tool_init right after tool_ready with the workspace path', async () => {
    const workers: FakeWorker[] = []
    const factory: ToolWorkerFactory = () => {
      const w = new FakeWorker()
      workers.push(w)
      queueMicrotask(() => w.emitFromWorker({ kind: 'tool_ready', pid: w.pid }))
      return w
    }
    const host = new ToolWorkerHost(factory)
    host.setWorkspacePathProvider(() => '/test/workspace')

    const p = host.dispatch('__tool_worker_ping', { echo: 'x' })
    await new Promise((r) => setImmediate(r))
    const w = workers[0]
    // First post is always tool_init; second is the dispatched request.
    expect(w.posts[0]?.kind).toBe('tool_init')
    if (w.posts[0]?.kind === 'tool_init') {
      expect(w.posts[0].workspacePath).toBe('/test/workspace')
      expect(w.posts[0].diskSettingsSnapshot).toBeDefined()
    }
    expect(w.posts[1]?.kind).toBe('tool_request')
    const req = w.posts[1]
    if (req?.kind === 'tool_request') {
      w.emitFromWorker({
        kind: 'tool_response',
        reqId: req.reqId,
        ok: true,
        result: { success: true, output: 'pong:x' },
      })
    }
    expect((await p).success).toBe(true)
  })

  it('host re-sends tool_init on respawn after a crash', async () => {
    const workers: FakeWorker[] = []
    const factory: ToolWorkerFactory = () => {
      const w = new FakeWorker()
      workers.push(w)
      queueMicrotask(() => w.emitFromWorker({ kind: 'tool_ready', pid: w.pid }))
      return w
    }
    const host = new ToolWorkerHost(factory)
    host.setWorkspacePathProvider(() => '/ws/A')

    const p1 = host.dispatch('__tool_worker_ping', { echo: 'a' })
    await new Promise((r) => setImmediate(r))
    workers[0].emitExit(1)
    await p1
    const p2 = host.dispatch('__tool_worker_ping', { echo: 'b' })
    await new Promise((r) => setImmediate(r))
    expect(workers).toHaveLength(2)
    // Second worker must have received its own tool_init.
    expect(workers[1].posts.some((m) => m.kind === 'tool_init')).toBe(true)
    const req = workers[1].requestPosts[0]
    if (req?.kind === 'tool_request') {
      workers[1].emitFromWorker({
        kind: 'tool_response',
        reqId: req.reqId,
        ok: true,
        result: { success: true, output: 'pong:b' },
      })
    }
    expect((await p2).success).toBe(true)
  })
})

// ─── SA-5: main/worker guard-state split fixes ───

/** Spin the event loop until `cond()` is true (bounded). */
async function waitFor(cond: () => boolean, maxTicks = 50): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (cond()) return
    await new Promise((r) => setImmediate(r))
  }
}

function makeTempWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sa5-toolworker-'))
}

describe('SA-5 — tool_request carries main-process read receipts', () => {
  let ws: string

  beforeEach(() => {
    ws = makeTempWorkspace()
    setWorkspacePath(ws)
    clearAllReadFileState()
  })

  afterEach(() => {
    clearAllReadFileState()
    setWorkspacePath(null)
    fs.rmSync(ws, { recursive: true, force: true })
  })

  it('classifies only write-class worker tools as file mutation tools', () => {
    expect(isWorkerFileMutationTool('write_file')).toBe(true)
    expect(isWorkerFileMutationTool('edit_file')).toBe(true)
    expect(isWorkerFileMutationTool('multi_edit_file')).toBe(true)
    for (const ro of ['read_file', 'glob', 'grep', 'web_fetch', 'WebSearch']) {
      expect(isWorkerFileMutationTool(ro), ro).toBe(false)
    }
  })

  it('forwards the target-path receipt (incl. baseReadId anchor) on edit_file dispatch', async () => {
    const filePath = path.join(ws, 'a.txt')
    fs.writeFileSync(filePath, 'hello world\n')
    const resolved = resolvePathForTool(filePath)
    if (!resolved.ok) throw new Error(resolved.reason)
    const { readId } = recordSuccessfulRead(resolved.resolved, {
      mtimeMs: fs.statSync(filePath).mtimeMs,
      isPartialView: false,
      fullFileContent: 'hello world\n',
      viewedContent: 'hello world\n',
    })

    const f = makeRotatingFactory()
    const host = new ToolWorkerHost(f.factory)
    const p = host.dispatch('edit_file', {
      filePath,
      oldString: 'hello',
      newString: 'goodbye',
      baseReadId: readId,
    })
    await new Promise((r) => setImmediate(r))
    const w = f.workers[0]
    const req = w.requestPosts[0]
    expect(req.kind).toBe('tool_request')
    if (req.kind !== 'tool_request') throw new Error('unreachable')
    expect(req.readReceipts).toBeDefined()
    expect(req.readReceipts!.length).toBeGreaterThanOrEqual(1)
    const receipt = req.readReceipts![0]
    expect(receipt.pathKey).toBe(normalizeReadStatePathKey(resolved.resolved))
    expect(receipt.record.readId).toBe(readId)
    expect(receipt.record.contentHash).toBe(hashFileContent('hello world\n'))
    w.emitFromWorker({
      kind: 'tool_response',
      reqId: req.reqId,
      ok: true,
      result: { success: true, output: 'ok' },
    })
    await p
  })

  it('still forwards B\'s current receipt when an expired id from edited A is mistakenly sent for B', async () => {
    const fileA = path.join(ws, 'chapter.txt')
    const fileB = path.join(ws, 'review.txt')
    fs.writeFileSync(fileA, 'chapter old\n')
    fs.writeFileSync(fileB, 'review old\n')
    const resolvedA = resolvePathForTool(fileA)
    const resolvedB = resolvePathForTool(fileB)
    if (!resolvedA.ok) throw new Error(resolvedA.reason)
    if (!resolvedB.ok) throw new Error(resolvedB.reason)

    const staleIdFromA = recordSuccessfulRead(resolvedA.resolved, {
      mtimeMs: fs.statSync(fileA).mtimeMs,
      isPartialView: false,
      fullFileContent: 'chapter old\n',
    }).readId
    const currentIdForB = recordSuccessfulRead(resolvedB.resolved, {
      mtimeMs: fs.statSync(fileB).mtimeMs,
      isPartialView: false,
      fullFileContent: 'review old\n',
    }).readId
    fs.writeFileSync(fileA, 'chapter new\n')
    recordSelfMutationReadReceipt(resolvedA.resolved, 'chapter new\n')
    expect(findReadReceiptByReadId(staleIdFromA)).toBeUndefined()

    const f = makeRotatingFactory()
    const host = new ToolWorkerHost(f.factory)
    const pending = host.dispatch('edit_file', {
      filePath: fileB,
      oldString: 'review old',
      newString: 'review new',
      baseReadId: staleIdFromA,
    })
    await new Promise((resolve) => setImmediate(resolve))

    const worker = f.workers[0]
    const request = worker.requestPosts[0]
    expect(request.kind).toBe('tool_request')
    if (request.kind !== 'tool_request') throw new Error('unreachable')
    expect(request.readReceipts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pathKey: normalizeReadStatePathKey(resolvedB.resolved),
          record: expect.objectContaining({ readId: currentIdForB }),
        }),
      ]),
    )

    worker.emitFromWorker({
      kind: 'tool_response',
      reqId: request.reqId,
      ok: true,
      result: { success: true, output: 'ok' },
    })
    await pending
  })

  it('omits readReceipts on read-only dispatches and when main has no receipt', async () => {
    const f = makeRotatingFactory()
    const host = new ToolWorkerHost(f.factory)

    const pRead = host.dispatch('read_file', { filePath: path.join(ws, 'a.txt') })
    const pWrite = host.dispatch('write_file', {
      filePath: path.join(ws, 'new.txt'),
      content: 'x',
    })
    await new Promise((r) => setImmediate(r))
    const w = f.workers[0]
    expect(w.requestPosts).toHaveLength(2)
    for (const req of w.requestPosts) {
      if (req.kind !== 'tool_request') throw new Error('unreachable')
      // read_file: never forwarded. write_file: no receipt exists in main.
      expect(req.readReceipts).toBeUndefined()
      w.emitFromWorker({
        kind: 'tool_response',
        reqId: req.reqId,
        ok: true,
        result: { success: true, output: 'ok' },
      })
    }
    await Promise.all([pRead, pWrite])
  })
})

describe('SA-5 — worker-side importReceipts feeds the read-before-write gate', () => {
  let dir: string
  let filePath: string

  beforeEach(() => {
    dir = makeTempWorkspace()
    filePath = path.join(dir, 'guarded.txt')
    fs.writeFileSync(filePath, 'hello world\n')
    clearAllReadFileState()
  })

  afterEach(() => {
    clearAllReadFileState()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  function buildReceipt(overrides?: Partial<ReadFileRecord>): {
    pathKey: string
    record: ReadFileRecord
  } {
    return {
      pathKey: normalizeReadStatePathKey(filePath),
      record: {
        mtimeMs: fs.statSync(filePath).mtimeMs,
        readAt: Date.now(),
        isPartialView: false,
        contentSnapshot: 'hello world\n',
        contentHash: hashFileContent('hello world\n'),
        readId: 'read-deadbeef00000001',
        source: 'read',
        absPath: filePath,
        ...overrides,
      },
    }
  }

  it('assertReadBeforeWrite passes after import (and fails before)', () => {
    expect(assertReadBeforeWrite(filePath).ok).toBe(false)
    importReceipts([buildReceipt()])
    expect(assertReadBeforeWrite(filePath).ok).toBe(true)
    const hit = findReadReceiptByReadId('read-deadbeef00000001')
    expect(hit).toBeDefined()
    expect(hit!.record.contentHash).toBe(hashFileContent('hello world\n'))
  })

  it('re-importing the same receipt is idempotent (no error, no duplication)', () => {
    const receipt = buildReceipt()
    importReceipts([receipt])
    importReceipts([receipt])
    importReceipts([receipt, receipt])
    expect(assertReadBeforeWrite(filePath).ok).toBe(true)
    expect(findReadReceiptByReadId('read-deadbeef00000001')).toBeDefined()
  })

  it('keeps the local promised readId when a NEWER import carries IDENTICAL content (double-promise fix)', () => {
    // Worker-side edit_file just rotated the readId and promised it to the
    // model in the "readId for next edit:" trailer…
    const local = recordSelfMutationReadReceipt(filePath, 'hello world\n')
    expect(local?.readId).toBeDefined()
    // …then main's post-hook re-stamp receipt for the SAME bytes (newer
    // readAt, different readId) is forwarded on the next dispatch.
    importReceipts([
      buildReceipt({
        readId: 'read-mainrestamp0003',
        readAt: Date.now() + 60_000,
        source: 'self_mutation',
      }),
    ])
    // The promised id must survive; the redundant main receipt is dropped.
    expect(findReadReceiptByReadId(local!.readId)).toBeDefined()
    expect(findReadReceiptByReadId('read-mainrestamp0003')).toBeUndefined()
    expect(assertReadBeforeWrite(filePath).ok).toBe(true)
  })

  it('still clobbers the local receipt when the newer import has DIFFERENT content (hook changed the file)', () => {
    const local = recordSelfMutationReadReceipt(filePath, 'hello world\n')
    expect(local?.readId).toBeDefined()
    // A main-side PostToolUse hook (formatter) rewrote the file.
    fs.writeFileSync(filePath, 'hello world!\n')
    importReceipts([
      buildReceipt({
        readId: 'read-hookrestamp0004',
        readAt: Date.now() + 60_000,
        mtimeMs: fs.statSync(filePath).mtimeMs,
        contentSnapshot: 'hello world!\n',
        contentHash: hashFileContent('hello world!\n'),
        source: 'self_mutation',
      }),
    ])
    expect(findReadReceiptByReadId(local!.readId)).toBeUndefined()
    expect(findReadReceiptByReadId('read-hookrestamp0004')).toBeDefined()
  })

  it('never clobbers a NEWER local receipt with a stale import', () => {
    // Worker-local read happened "now"…
    const local = recordSuccessfulRead(filePath, {
      mtimeMs: fs.statSync(filePath).mtimeMs,
      isPartialView: false,
      fullFileContent: 'hello world\n',
    })
    // …then a forwarded snapshot that lags behind by one tool call arrives.
    importReceipts([
      buildReceipt({ readId: 'read-stale000000000002', readAt: Date.now() - 60_000 }),
    ])
    expect(findReadReceiptByReadId(local.readId)).toBeDefined()
    expect(findReadReceiptByReadId('read-stale000000000002')).toBeUndefined()
    expect(assertReadBeforeWrite(filePath).ok).toBe(true)
  })
})

describe('SA-5 — main-held file lock serializes mutation dispatches', () => {
  let ws: string
  const envBefore = process.env.ASTRA_TOOL_WORKER

  beforeEach(() => {
    ws = makeTempWorkspace()
    setWorkspacePath(ws)
    clearAllReadFileState()
    process.env.ASTRA_TOOL_WORKER = '1'
  })

  afterEach(() => {
    if (envBefore === undefined) delete process.env.ASTRA_TOOL_WORKER
    else process.env.ASTRA_TOOL_WORKER = envBefore
    __setToolWorkerHostForTests(null)
    clearAllReadFileState()
    setWorkspacePath(null)
    fs.rmSync(ws, { recursive: true, force: true })
  })

  it('two concurrent write_file dispatches on the SAME path are serialized', async () => {
    const f = makeRotatingFactory()
    __setToolWorkerHostForTests(new ToolWorkerHost(f.factory))
    const { toolRegistry } = await import('../registry')

    const filePath = path.join(ws, 'serial.txt')
    const p1 = toolRegistry.execute(
      'write_file',
      { filePath, content: 'one' },
      { skipRegistryInputValidation: true },
    )
    const p2 = toolRegistry.execute(
      'write_file',
      { filePath, content: 'two' },
      { skipRegistryInputValidation: true },
    )
    await waitFor(() => f.workers.length > 0 && f.workers[0].requestPosts.length >= 1)
    const w = f.workers[0]
    // Main lock held across the first dispatch — the second request must
    // NOT reach the worker yet, even after extra event-loop turns.
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    expect(w.requestPosts).toHaveLength(1)
    const req1 = w.requestPosts[0]
    if (req1.kind !== 'tool_request') throw new Error('unreachable')
    expect(req1.input.content).toBe('one')

    w.emitFromWorker({
      kind: 'tool_response',
      reqId: req1.reqId,
      ok: true,
      result: { success: true, output: 'wrote one' },
    })
    expect((await p1).success).toBe(true)

    // Lock released → the queued second dispatch now reaches the worker.
    await waitFor(() => w.requestPosts.length === 2)
    expect(w.requestPosts).toHaveLength(2)
    const req2 = w.requestPosts[1]
    if (req2.kind !== 'tool_request') throw new Error('unreachable')
    expect(req2.input.content).toBe('two')
    w.emitFromWorker({
      kind: 'tool_response',
      reqId: req2.reqId,
      ok: true,
      result: { success: true, output: 'wrote two' },
    })
    expect((await p2).success).toBe(true)
  })

  it('dispatches on DIFFERENT paths are not serialized against each other', async () => {
    const f = makeRotatingFactory()
    __setToolWorkerHostForTests(new ToolWorkerHost(f.factory))
    const { toolRegistry } = await import('../registry')

    const p1 = toolRegistry.execute(
      'write_file',
      { filePath: path.join(ws, 'a.txt'), content: 'a' },
      { skipRegistryInputValidation: true },
    )
    const p2 = toolRegistry.execute(
      'write_file',
      { filePath: path.join(ws, 'b.txt'), content: 'b' },
      { skipRegistryInputValidation: true },
    )
    await waitFor(() => f.workers.length > 0 && f.workers[0].requestPosts.length === 2)
    const w = f.workers[0]
    expect(w.requestPosts).toHaveLength(2)
    for (const req of w.requestPosts) {
      if (req.kind !== 'tool_request') throw new Error('unreachable')
      w.emitFromWorker({
        kind: 'tool_response',
        reqId: req.reqId,
        ok: true,
        result: { success: true, output: 'ok' },
      })
    }
    expect((await p1).success).toBe(true)
    expect((await p2).success).toBe(true)
  })

  it('unresolvable path falls through to an unlocked dispatch (no blocking)', async () => {
    const f = makeRotatingFactory()
    __setToolWorkerHostForTests(new ToolWorkerHost(f.factory))
    const { toolRegistry } = await import('../registry')

    // Empty filePath cannot be resolved — the dispatch must still reach the
    // worker (which is where the tool's own validation error surfaces).
    const p = toolRegistry.execute(
      'write_file',
      { filePath: '', content: 'x' },
      { skipRegistryInputValidation: true },
    )
    await waitFor(() => f.workers.length > 0 && f.workers[0].requestPosts.length === 1)
    const w = f.workers[0]
    const req = w.requestPosts[0]
    if (req.kind !== 'tool_request') throw new Error('unreachable')
    w.emitFromWorker({
      kind: 'tool_error',
      reqId: req.reqId,
      ok: false,
      error: 'Path is empty.',
      errorClass: 'Error',
    })
    const result = await p
    expect(result.success).toBe(false)
    expect(result.error).toBe('Path is empty.')
  })
})

describe('isWorkerToHost (wire validation)', () => {
  it('accepts well-formed frames of every kind', () => {
    expect(isWorkerToHost({ kind: 'tool_ready', pid: 1 })).toBe(true)
    expect(
      isWorkerToHost({ kind: 'tool_progress', reqId: 1, event: { phase: 'x' } }),
    ).toBe(true)
    expect(
      isWorkerToHost({ kind: 'tool_response', reqId: 1, ok: true, result: { success: true } }),
    ).toBe(true)
    expect(
      isWorkerToHost({ kind: 'tool_error', reqId: 1, ok: false, error: 'boom' }),
    ).toBe(true)
  })

  it('rejects malformed / hostile frames', () => {
    expect(isWorkerToHost(null)).toBe(false)
    expect(isWorkerToHost({ kind: 'nope' })).toBe(false)
    expect(isWorkerToHost({ kind: 'tool_ready' })).toBe(false) // missing pid
    expect(isWorkerToHost({ kind: 'tool_response', reqId: 1, ok: true })).toBe(false) // no result
    expect(
      isWorkerToHost({ kind: 'tool_response', reqId: 1, ok: true, result: { output: 'x' } }),
    ).toBe(false) // result.success not boolean
    expect(isWorkerToHost({ kind: 'tool_error', reqId: 1, ok: false })).toBe(false) // no error
    expect(
      isWorkerToHost({ kind: 'tool_error', reqId: 1, ok: false, error: 7 }),
    ).toBe(false) // error not string
    expect(
      isWorkerToHost({ kind: 'tool_progress', reqId: 'x', event: {} }),
    ).toBe(false) // reqId not number
  })
})

// Silence unused-import lint for `vi` when the suite later adds spies.
void vi
