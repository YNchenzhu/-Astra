/**
 * pause gate + file persistence adapter.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  buildPersistedState,
  createFileKernelPersistenceAdapter,
  createPauseGate,
  type PersistedKernelState,
} from './pauseResume'
import { createInitialKernelLoopState } from './kernelTypes'
import { OrchestrationKernel } from './kernel'
import { createTransportAdapter, noopHookPolicy } from './transport'
import { DefaultToolRuntimePort } from './toolRuntime/defaultToolRuntimePort'
import { createNoopMcpSessionAdapter } from './mcpSessionAdapter'

describe('createPauseGate ', () => {
  it('awaitResume resolves immediately when not paused', async () => {
    const gate = createPauseGate()
    const start = Date.now()
    await gate.awaitResume()
    expect(Date.now() - start).toBeLessThan(50)
  })

  it('pause then resume unblocks awaiters', async () => {
    const gate = createPauseGate()
    gate.pause()
    expect(gate.isPaused()).toBe(true)

    let resolved = false
    const waiter = gate.awaitResume().then(() => {
      resolved = true
    })
    await new Promise((r) => setTimeout(r, 10))
    expect(resolved).toBe(false)

    gate.resume()
    await waiter
    expect(resolved).toBe(true)
    expect(gate.isPaused()).toBe(false)
  })

  it('multiple concurrent awaiters all unblock on resume', async () => {
    const gate = createPauseGate()
    gate.pause()

    const flags = [false, false, false]
    const promises = [0, 1, 2].map((i) =>
      gate.awaitResume().then(() => {
        flags[i] = true
      }),
    )
    gate.resume()
    await Promise.all(promises)
    expect(flags).toEqual([true, true, true])
  })
})

describe('createFileKernelPersistenceAdapter ', () => {
  let tmpDir = ''
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-persist-'))
  })
  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('save + load round-trip preserves state', () => {
    const adapter = createFileKernelPersistenceAdapter(tmpDir)
    const blob = buildPersistedState({
      conversationId: 'c1',
      state: createInitialKernelLoopState([{ role: 'user', content: 'hi' }]),
      paused: true,
    })
    adapter.save(blob)
    const loaded = adapter.load('c1') as PersistedKernelState
    expect(loaded).not.toBeNull()
    expect(loaded.paused).toBe(true)
    expect(loaded.state.transcript).toEqual([{ role: 'user', content: 'hi' }])
  })

  it('load returns null when blob is missing', () => {
    const adapter = createFileKernelPersistenceAdapter(tmpDir)
    expect(adapter.load('missing')).toBeNull()
  })

  it('load rejects mismatched conversationId (corruption guard)', () => {
    const adapter = createFileKernelPersistenceAdapter(tmpDir)
    const blob = buildPersistedState({
      conversationId: 'c1',
      state: createInitialKernelLoopState([]),
      paused: false,
    })
    adapter.save(blob)
    // Manually rename file to a different conversation id.
    const files = fs.readdirSync(path.join(tmpDir, 'kernel-state'))
    const src = path.join(tmpDir, 'kernel-state', files[0])
    const dst = path.join(tmpDir, 'kernel-state', 'c2.json')
    fs.renameSync(src, dst)
    expect(adapter.load('c2')).toBeNull()
  })

  it('delete removes blob', () => {
    const adapter = createFileKernelPersistenceAdapter(tmpDir)
    adapter.save(
      buildPersistedState({
        conversationId: 'c1',
        state: createInitialKernelLoopState([]),
        paused: false,
      }),
    )
    expect(adapter.load('c1')).not.toBeNull()
    adapter.delete('c1')
    expect(adapter.load('c1')).toBeNull()
  })
})

describe('OrchestrationKernel pause / persist / restore ', () => {
  it('pause emits paused phase event and flips isPaused', () => {
    const emit = vi.fn()
    const ports = {
      tools: new DefaultToolRuntimePort({ get: () => null, set: () => {} }),
      permission: { noteToolInvocation: vi.fn() },
      session: createNoopMcpSessionAdapter(),
      transport: createTransportAdapter(emit),
      hooks: noopHookPolicy,
    }
    const kernel = new OrchestrationKernel(
      ports,
      undefined,
      createInitialKernelLoopState([]),
      'conv-pause',
    )
    kernel.pause()
    expect(kernel.isPaused()).toBe(true)
    kernel.pause() // idempotent
    const pausedEvents = emit.mock.calls
      .map((c) => c[0] as { orchestrationPhase?: string })
      .filter((e) => e.orchestrationPhase === 'paused')
    expect(pausedEvents).toHaveLength(1)

    kernel.resume()
    expect(kernel.isPaused()).toBe(false)
    const resumeEvents = emit.mock.calls
      .map((c) => c[0] as { orchestrationPhase?: string })
      .filter((e) => e.orchestrationPhase === 'resumed')
    expect(resumeEvents).toHaveLength(1)
  })

  it('persist + restoreFrom survive a simulated process restart', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-kernel-persist-'))
    try {
      const adapter = createFileKernelPersistenceAdapter(tmpDir)
      const ports = {
        tools: new DefaultToolRuntimePort({ get: () => null, set: () => {} }),
        permission: { noteToolInvocation: vi.fn() },
        session: createNoopMcpSessionAdapter(),
        transport: createTransportAdapter(vi.fn()),
        hooks: noopHookPolicy,
      }
      const kernel = new OrchestrationKernel(
        ports,
        undefined,
        createInitialKernelLoopState([{ role: 'user', content: 'restore me' }]),
        'conv-persist',
        { persistenceAdapter: adapter },
      )
      kernel.enqueueInboxItem({ kind: 'synthetic_user_text', text: 'pending' })
      kernel.pause()
      await kernel.persist()

      // Simulate restart: new kernel, restore from disk.
      const loaded = adapter.load('conv-persist') as PersistedKernelState
      expect(loaded).not.toBeNull()
      const kernel2 = new OrchestrationKernel(
        ports,
        undefined,
        createInitialKernelLoopState([]),
        'conv-persist',
      )
      kernel2.restoreFrom(loaded)
      expect(kernel2.getState().transcript).toEqual([{ role: 'user', content: 'restore me' }])
      expect(kernel2.getState().inbox).toHaveLength(1)
      expect(kernel2.isPaused()).toBe(true)
    } finally {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
  })
})
