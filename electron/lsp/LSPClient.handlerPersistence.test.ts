/**
 * Regression: handlers registered via `onNotification` / `onRequest` MUST be
 * re-attached to the fresh connection on every `start()` — not just the first
 * one. Without this, the very first server crash (or manual restart) silently
 * tears the renderer's Problems-panel wiring and pyright/tsserver's
 * `workspace/configuration` answers down for the rest of the process lifetime.
 *
 * We stub the two external surfaces — `child_process.spawn` and
 * `vscode-jsonrpc/node.js.createMessageConnection` — so the test exercises the
 * real `LSPClient` code path without spawning a real LSP. Each call to
 * `createMessageConnection` returns a fresh mock so we can assert that every
 * new connection received its own handler bindings.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

type Spawn = typeof import('node:child_process').spawn

interface FakeChild extends EventEmitter {
  stdin: PassThrough & { destroy?: () => void }
  stdout: PassThrough
  stderr: PassThrough
  pid: number
  killed: boolean
  kill: (signal?: string) => void
  removeAllListeners: EventEmitter['removeAllListeners']
}

function makeFakeChild(): FakeChild {
  const emitter = new EventEmitter() as FakeChild
  emitter.stdin = new PassThrough()
  emitter.stdout = new PassThrough()
  emitter.stderr = new PassThrough()
  emitter.pid = 12345
  emitter.killed = false
  emitter.kill = (_signal?: string) => {
    emitter.killed = true
  }
  // child_process emits 'spawn' asynchronously; mimic that.
  setImmediate(() => emitter.emit('spawn'))
  return emitter
}

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>(
    'node:child_process',
  )
  return {
    ...actual,
    spawn: vi.fn<Spawn>(() => makeFakeChild() as unknown as ReturnType<Spawn>),
  }
})

// We need to track every `createMessageConnection` invocation so we can
// inspect per-connection handler registrations across restarts.
const createdConnections: Array<{
  onNotification: ReturnType<typeof vi.fn>
  onRequest: ReturnType<typeof vi.fn>
  onError: ReturnType<typeof vi.fn>
  onClose: ReturnType<typeof vi.fn>
  listen: ReturnType<typeof vi.fn>
  trace: ReturnType<typeof vi.fn>
  sendRequest: ReturnType<typeof vi.fn>
  sendNotification: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
}> = []

vi.mock('vscode-jsonrpc/node.js', () => {
  return {
    Trace: { Verbose: 'verbose' },
    StreamMessageReader: class {
      constructor(public stream: NodeJS.ReadableStream) {}
    },
    StreamMessageWriter: class {
      constructor(public stream: NodeJS.WritableStream) {}
    },
    createMessageConnection: vi.fn(() => {
      const conn = {
        onNotification: vi.fn(),
        onRequest: vi.fn(),
        onError: vi.fn(),
        onClose: vi.fn(),
        listen: vi.fn(),
        trace: vi.fn().mockResolvedValue(undefined),
        sendRequest: vi.fn().mockResolvedValue({ capabilities: {} }),
        sendNotification: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      }
      createdConnections.push(conn)
      return conn
    }),
  }
})

import { createLSPClient } from './LSPClient'

describe('LSPClient — handler persistence across restarts', () => {
  beforeEach(() => {
    createdConnections.length = 0
    vi.clearAllMocks()
  })

  it('applies pre-start handlers to the first connection', async () => {
    const client = createLSPClient('test')

    const notifHandler = vi.fn()
    const reqHandler = vi.fn()
    client.onNotification('textDocument/publishDiagnostics', notifHandler)
    client.onRequest('workspace/configuration', reqHandler)

    await client.start('whatever', ['--stdio'])

    expect(createdConnections).toHaveLength(1)
    const c1 = createdConnections[0]!
    expect(c1.onNotification).toHaveBeenCalledWith(
      'textDocument/publishDiagnostics',
      notifHandler,
    )
    expect(c1.onRequest).toHaveBeenCalledWith(
      'workspace/configuration',
      reqHandler,
    )
  })

  it('re-attaches handlers to a NEW connection after stop+start (manual restart path)', async () => {
    const client = createLSPClient('test')

    const notifHandler = vi.fn()
    const reqHandler = vi.fn()
    client.onNotification('textDocument/publishDiagnostics', notifHandler)
    client.onRequest('workspace/configuration', reqHandler)

    await client.start('cmd', [])
    expect(createdConnections).toHaveLength(1)

    await client.stop()
    await client.start('cmd', [])

    expect(createdConnections).toHaveLength(2)
    const c2 = createdConnections[1]!

    // The second connection MUST get the same handlers — that's the whole
    // point. Pre-fix, both maps would be empty by now and the new connection
    // would be silently handler-less.
    expect(c2.onNotification).toHaveBeenCalledWith(
      'textDocument/publishDiagnostics',
      notifHandler,
    )
    expect(c2.onRequest).toHaveBeenCalledWith(
      'workspace/configuration',
      reqHandler,
    )
  })

  it('handlers registered AFTER the first start also survive a restart', async () => {
    // Production case: LSPServerManager.initialize() registers
    // workspace/configuration before start(); registerLSPNotificationHandlers
    // registers publishDiagnostics AFTER start() (manager.initialize().then(...)
    // queues it). Both paths must persist across the next restart.
    const client = createLSPClient('test')
    await client.start('cmd', [])

    const lateHandler = vi.fn()
    client.onNotification('textDocument/publishDiagnostics', lateHandler)

    // First connection got it immediately.
    const c1 = createdConnections[0]!
    expect(c1.onNotification).toHaveBeenCalledWith(
      'textDocument/publishDiagnostics',
      lateHandler,
    )

    await client.stop()
    await client.start('cmd', [])

    const c2 = createdConnections[1]!
    expect(c2.onNotification).toHaveBeenCalledWith(
      'textDocument/publishDiagnostics',
      lateHandler,
    )
  })

  it('second registration of same method replaces the first across reconnects', async () => {
    // vscode-jsonrpc's onNotification replaces per-method; our Map-backed
    // store mirrors that semantic so the second call wins on the new
    // connection too.
    const client = createLSPClient('test')

    const first = vi.fn()
    const second = vi.fn()
    client.onNotification('textDocument/publishDiagnostics', first)
    client.onNotification('textDocument/publishDiagnostics', second)

    await client.start('cmd', [])
    const c1 = createdConnections[0]!
    // On the first connection we apply only ONE handler per method (the latest).
    const publishCalls = c1.onNotification.mock.calls.filter(
      (call: unknown[]) => call[0] === 'textDocument/publishDiagnostics',
    )
    expect(publishCalls).toHaveLength(1)
    expect(publishCalls[0]![1]).toBe(second)

    await client.stop()
    await client.start('cmd', [])
    const c2 = createdConnections[1]!
    const publishCalls2 = c2.onNotification.mock.calls.filter(
      (call: unknown[]) => call[0] === 'textDocument/publishDiagnostics',
    )
    expect(publishCalls2).toHaveLength(1)
    expect(publishCalls2[0]![1]).toBe(second)
  })
})
