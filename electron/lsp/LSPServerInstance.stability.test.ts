/**
 * Stability surfaces on LSPServerInstance: crash tracking, quarantine,
 * listener registration, quarantine release via `clearQuarantine`.
 *
 * We stub `LSPClient` via `vi.mock` so we can fire simulated crash events
 * without spawning a real child process.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

type CrashCallback = (error: Error) => void

let recordedCrashCallback: CrashCallback | null = null

vi.mock('./LSPClient', () => {
  return {
    createLSPClient: vi.fn((_name: string, onCrash?: CrashCallback) => {
      recordedCrashCallback = onCrash ?? null
      return {
        get capabilities() {
          return undefined
        },
        get isInitialized() {
          return true
        },
        start: vi.fn(async () => {}),
        initialize: vi.fn(async () => ({ capabilities: { positionEncoding: 'utf-16' } })),
        sendRequest: vi.fn(async () => ({} as never)),
        sendNotification: vi.fn(async () => {}),
        onNotification: vi.fn(),
        onRequest: vi.fn(),
        stop: vi.fn(async () => {}),
        getStderrTail: vi.fn(() => 'stderr tail'),
        setTraceLog: vi.fn((p: string | null) => p),
      }
    }),
  }
})

import { createLSPServerInstance } from './LSPServerInstance'

function triggerCrash(i: number = 1): void {
  if (!recordedCrashCallback) throw new Error('crash callback not registered')
  for (let n = 0; n < i; n++) recordedCrashCallback(new Error(`simulated crash ${n}`))
}

describe('LSPServerInstance — crash & quarantine', () => {
  beforeEach(() => {
    recordedCrashCallback = null
    vi.clearAllMocks()
  })
  afterEach(() => {
    recordedCrashCallback = null
  })

  function makeInstance() {
    return createLSPServerInstance('test-server', {
      scope: 'test-server',
      command: 'true',
      args: [],
      extensionToLanguage: { '.ts': 'typescript' },
    })
  }

  it('increments crashCount on every crash callback', () => {
    const inst = makeInstance()
    expect(inst.getCrashCount()).toBe(0)
    triggerCrash(1)
    expect(inst.getCrashCount()).toBe(1)
    triggerCrash(2)
    expect(inst.getCrashCount()).toBe(3)
  })

  it('fires onCrash listeners in registration order', () => {
    const inst = makeInstance()
    const log: string[] = []
    inst.onCrash(() => log.push('one'))
    const dispose = inst.onCrash(() => log.push('two'))

    triggerCrash(1)
    expect(log).toEqual(['one', 'two'])

    dispose()
    triggerCrash(1)
    expect(log).toEqual(['one', 'two', 'one'])
  })

  it('enters quarantine after 3 crashes in 60s window', () => {
    const inst = makeInstance()
    expect(inst.isQuarantined()).toBe(false)
    triggerCrash(3)
    expect(inst.isQuarantined()).toBe(true)
  })

  it('does NOT quarantine if crashes are spread out beyond the window', () => {
    vi.useFakeTimers()
    try {
      const inst = makeInstance()
      triggerCrash(1)
      vi.advanceTimersByTime(40_000)
      triggerCrash(1)
      vi.advanceTimersByTime(40_000) // first event now > 60s old → pruned
      triggerCrash(1)
      expect(inst.isQuarantined()).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('`clearQuarantine` resets quarantine + crashCount', () => {
    const inst = makeInstance()
    triggerCrash(3)
    expect(inst.isQuarantined()).toBe(true)
    expect(inst.getCrashCount()).toBe(3)
    inst.clearQuarantine()
    expect(inst.isQuarantined()).toBe(false)
    expect(inst.getCrashCount()).toBe(0)
  })

  it('start() throws immediately while quarantined', async () => {
    const inst = makeInstance()
    triggerCrash(3)
    expect(inst.isQuarantined()).toBe(true)
    await expect(inst.start()).rejects.toThrow(/quarantined/i)
  })

  it('exposes stderr tail and setTraceLog via the client', () => {
    const inst = makeInstance()
    expect(inst.getStderrTail()).toBe('stderr tail')
    expect(inst.setTraceLog('/tmp/x.log')).toBe('/tmp/x.log')
    expect(inst.setTraceLog(null)).toBeNull()
  })
})
