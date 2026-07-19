/**
 * Unit tests for `driveInnerLoop` (F3 follow-up).
 *
 * Coverage:
 *   1. Happy path — runs setup → iteration → terminate
 *   2. Pre-iteration abort → graceful aborted_streaming exit (SA-2 fix 3:
 *      boundary abort happens before the next stream pass)
 *   3. Abort during pause await → still exits cleanly via second abort check
 *   4. Pause gate awaited before first iteration
 *   5. Snapshot called per iteration
 *   6. maxIterations exhausted → finaliseMaxIterations runs
 *   7. Caller-provided fireOnTerminate + finaliseTransitionHistory always run
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock the iteration primitives so tests don't spin the real agentic loop.
vi.mock('../iteration', () => ({
  setupAgenticLoopForRun: vi.fn(),
  runAgenticIteration: vi.fn(),
  finaliseMaxIterations: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../../ai/queryTermination', () => ({
  createTerminalResult: vi.fn((reason, payload) => ({ reason, ...payload })),
  runTerminationCleanup: vi.fn().mockResolvedValue(undefined),
}))

import { driveInnerLoop, type DriveInnerLoopHooks } from '../driveInnerLoop'
import {
  setupAgenticLoopForRun,
  runAgenticIteration,
  finaliseMaxIterations,
} from '../iteration'
import { createPauseGate, type PauseGate } from '../../pauseResume'

function makeFakeState() {
  return {
    iteration: 0,
    maxIterations: 5,
    callbacks: { onMessageEnd: vi.fn() },
    totalUsage: { inputTokens: 0, outputTokens: 0 },
    profiler: {
      setIteration: vi.fn(),
      flush: vi.fn(),
    },
    terminationResult: null,
    // Contract audit (2026-07) — the transcript invariant tracer reads
    // `state.apiMessages.length` at every boundary when the hook is wired.
    apiMessages: [{ role: 'user', content: 'q' }],
  } as unknown as Parameters<typeof runAgenticIteration>[0]
}

function makeHooks(overrides?: Partial<DriveInnerLoopHooks>): DriveInnerLoopHooks {
  const ac = new AbortController()
  const pg = createPauseGate()
  return {
    abortSignal: ac.signal,
    pauseGate: pg,
    snapshot: vi.fn(),
    ...overrides,
  }
}

function makeFakeSetupReturn(state: ReturnType<typeof makeFakeState>) {
  return {
    state,
    systemPrompt: 'sys',
    fireOnTerminate: vi.fn(),
    finaliseTransitionHistory: vi.fn(),
  }
}

describe('driveInnerLoop', () => {
  beforeEach(() => {
    vi.mocked(setupAgenticLoopForRun).mockReset()
    vi.mocked(runAgenticIteration).mockReset()
    vi.mocked(finaliseMaxIterations).mockReset()
    vi.mocked(finaliseMaxIterations).mockResolvedValue(undefined)
  })

  it('happy path — first iteration terminates, snapshot fired once', async () => {
    const state = makeFakeState()
    const setupReturn = makeFakeSetupReturn(state)
    vi.mocked(setupAgenticLoopForRun).mockReturnValue(setupReturn)
    vi.mocked(runAgenticIteration).mockResolvedValue({ kind: 'terminate' })

    const hooks = makeHooks()
    await driveInnerLoop({} as never, {} as never, hooks)

    expect(runAgenticIteration).toHaveBeenCalledTimes(1)
    expect(hooks.snapshot).toHaveBeenCalledTimes(1)
    expect(hooks.snapshot).toHaveBeenCalledWith('iteration_1_boundary')
    expect(state.profiler.flush).toHaveBeenCalled()
    expect(setupReturn.fireOnTerminate).toHaveBeenCalled()
    expect(setupReturn.finaliseTransitionHistory).toHaveBeenCalled()
  })

  it('pre-iteration abort → graceful aborted_streaming exit, no runAgenticIteration call', async () => {
    const state = makeFakeState()
    const setupReturn = makeFakeSetupReturn(state)
    vi.mocked(setupAgenticLoopForRun).mockReturnValue(setupReturn)

    const ac = new AbortController()
    ac.abort()
    const hooks = makeHooks({ abortSignal: ac.signal })
    await driveInnerLoop({} as never, {} as never, hooks)

    expect(runAgenticIteration).not.toHaveBeenCalled()
    expect(state.callbacks.onMessageEnd).toHaveBeenCalledWith(state.totalUsage)
    // SA-2 fix 3 — the boundary abort fires BEFORE the next iteration's
    // stream pass, so it reports the pre-stream reason.
    expect((state as { terminationResult?: { reason?: string } }).terminationResult?.reason).toBe(
      'aborted_streaming',
    )
  })

  it('pauseGate.awaitResume awaited before first iteration; resume → loop proceeds', async () => {
    const state = makeFakeState()
    const setupReturn = makeFakeSetupReturn(state)
    vi.mocked(setupAgenticLoopForRun).mockReturnValue(setupReturn)
    vi.mocked(runAgenticIteration).mockResolvedValue({ kind: 'terminate' })

    const pg = createPauseGate()
    pg.pause()
    const hooks = makeHooks({ pauseGate: pg })

    let done = false
    const p = driveInnerLoop({} as never, {} as never, hooks).then(() => {
      done = true
    })
    // Microtask flush — paused loop shouldn't have called runAgenticIteration yet.
    await new Promise((r) => setTimeout(r, 5))
    expect(runAgenticIteration).not.toHaveBeenCalled()
    expect(done).toBe(false)

    pg.resume()
    await p
    expect(runAgenticIteration).toHaveBeenCalledOnce()
    expect(done).toBe(true)
  })

  it('abort during pause await → exits via second abort check after resume', async () => {
    const state = makeFakeState()
    const setupReturn = makeFakeSetupReturn(state)
    vi.mocked(setupAgenticLoopForRun).mockReturnValue(setupReturn)

    const ac = new AbortController()
    const pg = createPauseGate()
    pg.pause()
    const hooks = makeHooks({ abortSignal: ac.signal, pauseGate: pg })

    const p = driveInnerLoop({} as never, {} as never, hooks)
    // Microtask flush — pause is engaged.
    await new Promise((r) => setTimeout(r, 5))
    // Now abort then resume — kernel sees abort flag immediately after pauseGate resolves.
    ac.abort()
    pg.resume()
    await p

    expect(runAgenticIteration).not.toHaveBeenCalled()
    expect((state as { terminationResult?: { reason?: string } }).terminationResult?.reason).toBe(
      'aborted_streaming',
    )
  })

  it('maxIterations exhausted → finaliseMaxIterations runs', async () => {
    const state = makeFakeState()
    state.maxIterations = 2
    const setupReturn = makeFakeSetupReturn(state)
    vi.mocked(setupAgenticLoopForRun).mockReturnValue(setupReturn)
    vi.mocked(runAgenticIteration).mockResolvedValue({ kind: 'continue' })

    await driveInnerLoop({} as never, {} as never, makeHooks())

    expect(runAgenticIteration).toHaveBeenCalledTimes(2)
    expect(finaliseMaxIterations).toHaveBeenCalledOnce()
  })

  it('finaliseTransitionHistory + fireOnTerminate always run even on early abort', async () => {
    const state = makeFakeState()
    const setupReturn = makeFakeSetupReturn(state)
    vi.mocked(setupAgenticLoopForRun).mockReturnValue(setupReturn)

    const ac = new AbortController()
    ac.abort()
    await driveInnerLoop({} as never, {} as never, makeHooks({ abortSignal: ac.signal }))

    expect(setupReturn.finaliseTransitionHistory).toHaveBeenCalled()
    expect(setupReturn.fireOnTerminate).toHaveBeenCalled()
  })

  it('snapshot called with iteration-specific tag (boundary semantics)', async () => {
    const state = makeFakeState()
    state.maxIterations = 3
    const setupReturn = makeFakeSetupReturn(state)
    vi.mocked(setupAgenticLoopForRun).mockReturnValue(setupReturn)
    let calls = 0
    vi.mocked(runAgenticIteration).mockImplementation(async () => {
      calls++
      return { kind: calls >= 2 ? 'terminate' : 'continue' }
    })

    const hooks = makeHooks()
    await driveInnerLoop({} as never, {} as never, hooks)

    expect(hooks.snapshot).toHaveBeenCalledTimes(2)
    expect(hooks.snapshot).toHaveBeenNthCalledWith(1, 'iteration_1_boundary')
    expect(hooks.snapshot).toHaveBeenNthCalledWith(2, 'iteration_2_boundary')
  })

  // 阶段 1 — kernelLoopPort injection onto agenticParams.
  it('injects hooks.kernelLoopPort onto the params handed to setupAgenticLoopForRun', async () => {
    const state = makeFakeState()
    const setupReturn = makeFakeSetupReturn(state)
    vi.mocked(setupAgenticLoopForRun).mockReturnValue(setupReturn)
    vi.mocked(runAgenticIteration).mockResolvedValue({ kind: 'terminate' })

    const persistThrottled = vi.fn()
    const kernelLoopPort = { persistThrottled }
    const baseParams = { model: 'm', maxTokens: 1 } as never
    await driveInnerLoop(baseParams, {} as never, makeHooks({ kernelLoopPort }))

    const passedParams = vi.mocked(setupAgenticLoopForRun).mock.calls[0]![0] as {
      model?: string
      kernelLoopPort?: unknown
    }
    expect(passedParams.kernelLoopPort).toBe(kernelLoopPort)
    // existing params are preserved (spread, not replaced)
    expect(passedParams.model).toBe('m')
  })

  it('leaves params untouched when no kernelLoopPort hook is provided', async () => {
    const state = makeFakeState()
    const setupReturn = makeFakeSetupReturn(state)
    vi.mocked(setupAgenticLoopForRun).mockReturnValue(setupReturn)
    vi.mocked(runAgenticIteration).mockResolvedValue({ kind: 'terminate' })

    const baseParams = { model: 'm' } as never
    await driveInnerLoop(baseParams, {} as never, makeHooks())

    // No port hook → the SAME params object is forwarded (no spread copy), and
    // it carries no kernelLoopPort.
    const passedParams = vi.mocked(setupAgenticLoopForRun).mock.calls[0]![0] as {
      kernelLoopPort?: unknown
    }
    expect(passedParams).toBe(baseParams)
    expect(passedParams.kernelLoopPort).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Contract audit (2026-07) — parity matrix vs `runAgenticLoop`'s driver
// semantics. Both drivers consume the same primitives; these rows pin the
// driver-level contract (`runAgenticLoop`'s while in iteration.ts documents
// the reference behaviour):
//
//   row 1: terminate outcome  → NO finaliseMaxIterations, single flush
//   row 2: iteration throw    → propagates; finally hooks still run
//   row 3: onTerminate option → forwarded into setupAgenticLoopForRun
//   row 4: invariant tracer   → called once per boundary with loop length
//   row 5: strict invariant   → throw propagates; finally hooks still run
// ---------------------------------------------------------------------------
describe('driveInnerLoop — parity matrix with runAgenticLoop driver semantics', () => {
  beforeEach(() => {
    vi.mocked(setupAgenticLoopForRun).mockReset()
    vi.mocked(runAgenticIteration).mockReset()
    vi.mocked(finaliseMaxIterations).mockReset()
    vi.mocked(finaliseMaxIterations).mockResolvedValue(undefined)
  })

  it('row 1 — clean terminate never reaches finaliseMaxIterations (same as legacy while)', async () => {
    const state = makeFakeState()
    const setupReturn = makeFakeSetupReturn(state)
    vi.mocked(setupAgenticLoopForRun).mockReturnValue(setupReturn)
    vi.mocked(runAgenticIteration).mockResolvedValue({ kind: 'terminate' })

    await driveInnerLoop({} as never, {} as never, makeHooks())

    expect(finaliseMaxIterations).not.toHaveBeenCalled()
    expect(state.profiler.flush).toHaveBeenCalledTimes(1)
  })

  it('row 2 — an iteration throw propagates AND the finally hooks still run (parity with legacy finally)', async () => {
    const state = makeFakeState()
    const setupReturn = makeFakeSetupReturn(state)
    vi.mocked(setupAgenticLoopForRun).mockReturnValue(setupReturn)
    vi.mocked(runAgenticIteration).mockRejectedValue(new Error('stream exploded'))

    await expect(
      driveInnerLoop({} as never, {} as never, makeHooks()),
    ).rejects.toThrow('stream exploded')

    expect(setupReturn.finaliseTransitionHistory).toHaveBeenCalled()
    expect(setupReturn.fireOnTerminate).toHaveBeenCalled()
    expect(finaliseMaxIterations).not.toHaveBeenCalled()
  })

  it('row 3 — hooks.onTerminate is forwarded as the setup onTerminate option (parity with runAgenticLoop options)', async () => {
    const state = makeFakeState()
    const setupReturn = makeFakeSetupReturn(state)
    vi.mocked(setupAgenticLoopForRun).mockReturnValue(setupReturn)
    vi.mocked(runAgenticIteration).mockResolvedValue({ kind: 'terminate' })

    const onTerminate = vi.fn()
    await driveInnerLoop({} as never, {} as never, makeHooks({ onTerminate }))

    const options = vi.mocked(setupAgenticLoopForRun).mock.calls[0]![2] as
      | { onTerminate?: unknown }
      | undefined
    expect(options?.onTerminate).toBe(onTerminate)
  })

  it('row 4 — assertTranscriptInvariant fires once per iteration boundary with the loop transcript length', async () => {
    const state = makeFakeState()
    state.maxIterations = 3
    const setupReturn = makeFakeSetupReturn(state)
    vi.mocked(setupAgenticLoopForRun).mockReturnValue(setupReturn)
    let calls = 0
    vi.mocked(runAgenticIteration).mockImplementation(async () => {
      calls++
      return { kind: calls >= 2 ? 'terminate' : 'continue' }
    })

    const assertTranscriptInvariant = vi.fn()
    await driveInnerLoop({} as never, {} as never, makeHooks({ assertTranscriptInvariant }))

    expect(assertTranscriptInvariant).toHaveBeenCalledTimes(2)
    expect(assertTranscriptInvariant).toHaveBeenNthCalledWith(1, {
      iteration: 1,
      loopTranscriptLength: 1,
      loopTranscriptFingerprint: expect.any(String),
    })
    expect(assertTranscriptInvariant).toHaveBeenNthCalledWith(2, {
      iteration: 2,
      loopTranscriptLength: 1,
      loopTranscriptFingerprint: expect.any(String),
    })
  })

  it('row 5 — a strict-mode invariant throw propagates and the finally hooks still run', async () => {
    const state = makeFakeState()
    const setupReturn = makeFakeSetupReturn(state)
    vi.mocked(setupAgenticLoopForRun).mockReturnValue(setupReturn)
    vi.mocked(runAgenticIteration).mockResolvedValue({ kind: 'continue' })

    const assertTranscriptInvariant = vi.fn(() => {
      throw new Error('Transcript invariant violated (strict mode)')
    })
    await expect(
      driveInnerLoop({} as never, {} as never, makeHooks({ assertTranscriptInvariant })),
    ).rejects.toThrow('Transcript invariant violated')

    // The invariant fired at the FIRST boundary — no iteration ran.
    expect(runAgenticIteration).not.toHaveBeenCalled()
    expect(setupReturn.finaliseTransitionHistory).toHaveBeenCalled()
    expect(setupReturn.fireOnTerminate).toHaveBeenCalled()
  })

  it('restores the kernel-accepted transcript before the model iteration runs', async () => {
    const state = makeFakeState()
    const acceptedTranscript = [{ role: 'user', content: 'kernel accepted' }]
    const acceptHostTranscript = vi.fn((messages: Array<Record<string, unknown>>) => {
      state.apiMessages = messages
    })
    state.acceptHostTranscript = acceptHostTranscript
    const setupReturn = makeFakeSetupReturn(state)
    vi.mocked(setupAgenticLoopForRun).mockReturnValue(setupReturn)
    vi.mocked(runAgenticIteration).mockResolvedValue({ kind: 'terminate' })

    await driveInnerLoop(
      {} as never,
      {} as never,
      makeHooks({ assertTranscriptInvariant: vi.fn(() => acceptedTranscript) }),
    )

    expect(acceptHostTranscript).toHaveBeenCalledWith(acceptedTranscript)
    expect(runAgenticIteration).toHaveBeenCalledTimes(1)
    expect(state.apiMessages).toEqual(acceptedTranscript)
  })
})

// Smoke type-check: ensure the DriveInnerLoopHooks shape is the documented one.
void (null as unknown as PauseGate)
