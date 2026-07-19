/**
 * Regression tests for the EventDrivenNetwork audit fixes:
 *
 *   - R4 (2026-05): `initEventDrivenNetwork` must be idempotent. A second
 *     call (hot reload, double `app.whenReady`, sloppy test teardown) MUST
 *     NOT install a second subscriber — otherwise every terminal task
 *     fires `extractMemoryPostTask` twice (real LLM calls).
 *   - R5 (2026-05): a `cancelled` task lifecycle event must surface to
 *     the system output channel and MUST NOT trigger memory extraction
 *     (user-aborted work is not "completed work").
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  initEventDrivenNetwork,
  __resetEventDrivenNetworkForTests,
  __isEventDrivenNetworkInitializedForTests,
} from './EventDrivenNetwork'
import { taskManager } from '../tools/TaskManager'

// Stub the memory extractor — we don't want real LLM calls in unit tests,
// and the *count* is exactly what we're asserting on.
const extractCalls = { count: 0 }
vi.mock('../memory/autoExtract', () => ({
  extractMemoryPostTask: vi.fn(async () => {
    extractCalls.count += 1
    return { created: 0, updated: 0 }
  }),
}))

interface OutputCall {
  channel: string
  message: string
  type: 'info' | 'warning' | 'error' | undefined
}

function makeAppender(): { calls: OutputCall[]; fn: (channel: string, message: string, type?: 'info' | 'warning' | 'error') => void } {
  const calls: OutputCall[] = []
  const fn = (channel: string, message: string, type?: 'info' | 'warning' | 'error'): void => {
    calls.push({ channel, message, type })
  }
  return { calls, fn }
}

beforeEach(() => {
  __resetEventDrivenNetworkForTests()
  taskManager.clear()
  extractCalls.count = 0
})

afterEach(() => {
  __resetEventDrivenNetworkForTests()
  taskManager.clear()
})

describe('R4 — initEventDrivenNetwork is idempotent', () => {
  it('first call wires the subscriber and returns a dispose', () => {
    expect(__isEventDrivenNetworkInitializedForTests()).toBe(false)
    const { fn } = makeAppender()
    const dispose = initEventDrivenNetwork(fn)
    expect(typeof dispose).toBe('function')
    expect(__isEventDrivenNetworkInitializedForTests()).toBe(true)
  })

  it('second call returns the SAME dispose without re-wiring', async () => {
    const { fn } = makeAppender()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const d1 = initEventDrivenNetwork(fn)
      const d2 = initEventDrivenNetwork(fn)
      expect(d2).toBe(d1)
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(warnSpy.mock.calls[0]![0]).toMatch(/called more than once/i)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('a completed task fires memory extraction exactly ONCE even after double-init', async () => {
    const { fn } = makeAppender()
    initEventDrivenNetwork(fn)
    initEventDrivenNetwork(fn) // would have installed a 2nd subscriber pre-fix

    const t = taskManager.create({
      subject: 'do the thing',
      source: 'user',
      status: 'in_progress',
    })
    taskManager.markCompleted(t.taskId, { summary: 'done' })

    // Flush the microtask queued by the async IIFE inside completedHandler.
    await Promise.resolve()
    await Promise.resolve()

    expect(extractCalls.count).toBe(1)
  })

  it('dispose tears down listeners — no further events propagate', async () => {
    const { fn } = makeAppender()
    const dispose = initEventDrivenNetwork(fn)

    dispose()

    expect(__isEventDrivenNetworkInitializedForTests()).toBe(false)

    const t = taskManager.create({
      subject: 'post-dispose',
      source: 'user',
      status: 'in_progress',
    })
    taskManager.markCompleted(t.taskId, { summary: 'done' })

    await Promise.resolve()
    await Promise.resolve()

    expect(extractCalls.count).toBe(0)
  })

  it('stale dispose is a no-op (does not tear down a fresh init)', () => {
    const { fn } = makeAppender()
    const d1 = initEventDrivenNetwork(fn)
    d1()
    const d2 = initEventDrivenNetwork(fn)
    expect(d2).not.toBe(d1)
    expect(__isEventDrivenNetworkInitializedForTests()).toBe(true)
    // Calling the OLD dispose should be a no-op now.
    d1()
    expect(__isEventDrivenNetworkInitializedForTests()).toBe(true)
  })
})

describe('R5 — cancelled task lifecycle is surfaced (not silently dropped)', () => {
  it('emits an "info" line on the system channel and does NOT trigger memory extraction', async () => {
    const { calls, fn } = makeAppender()
    initEventDrivenNetwork(fn)

    const t = taskManager.create({
      subject: 'user will abort this',
      source: 'user',
      status: 'in_progress',
    })

    await taskManager.stop(t.taskId)

    await Promise.resolve()
    await Promise.resolve()

    const cancelLine = calls.find((c) =>
      c.message.includes('Task cancelled by user') && c.message.includes('user will abort this'),
    )
    expect(cancelLine).toBeDefined()
    expect(cancelLine?.channel).toBe('system')
    expect(cancelLine?.type).toBe('info')

    // Cancellation must NOT seed memory.
    expect(extractCalls.count).toBe(0)
  })

  it('completed task still triggers extraction (cancel branch did not over-filter)', async () => {
    const { fn } = makeAppender()
    initEventDrivenNetwork(fn)

    const t = taskManager.create({
      subject: 'finish properly',
      source: 'user',
      status: 'in_progress',
    })
    taskManager.markCompleted(t.taskId, { summary: 'finished' })

    await Promise.resolve()
    await Promise.resolve()

    expect(extractCalls.count).toBe(1)
  })
})
