/**
 * 阶段 3 — Conductor tests.
 *
 *   Part A: `decideConductorAction` pure decision table.
 *   Part B: kernel integration — `runDriveMainChat`'s outer loop consults the
 *           Conductor and (when enabled) auto-re-dispatches / fans out best-of-N
 *           on an unaddressed verification FAIL, bounded by the re-dispatch cap.
 *
 * The inner loop (`driveInnerLoop`) and the verification-gate state are mocked so
 * the test exercises ONLY the outer-loop Conductor wiring.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the inner loop so `runDriveMainChat`'s CallModel resolves immediately and
// fires `onTerminate` with a controllable outcome (captured by the kernel for
// the Conductor decision).
const driveInnerLoopMock = vi.fn()
vi.mock('./phases/driveInnerLoop', () => ({
  driveInnerLoop: (
    p: unknown,
    c: unknown,
    hooks: { onTerminate?: (r: unknown) => void },
  ) => driveInnerLoopMock(p, c, hooks),
}))

// Mock the verification-gate snapshot the Conductor reads.
vi.mock('../planning/verificationGateState', () => ({
  getVerificationGateState: vi.fn(),
}))

vi.mock('../agents/agentContext', () => ({
  getAgentContext: vi.fn().mockReturnValue(null),
}))

import {
  decideConductorAction,
  isConductorEnabled,
  type ConductorBestOfNPort,
} from './conductor'
import { OrchestrationKernel } from './kernel'
import { createInitialKernelLoopState } from './kernelTypes'
import { noopHookPolicy, createTransportAdapter } from './transport'
import { DefaultToolRuntimePort } from './toolRuntime/defaultToolRuntimePort'
import { createNoopMcpSessionAdapter } from './mcpSessionAdapter'
import { getVerificationGateState } from '../planning/verificationGateState'

// ─── Part A: pure decision table ──────────────────────────────────────

describe('decideConductorAction', () => {
  const base = {
    enabled: true,
    budgetRemaining: true,
    gate: { needsVerification: true, mutationCount: 3, lastVerdict: 'FAIL' as const },
    outcomeReason: 'completed' as string | undefined,
    bestOfNAvailable: true,
  }

  it('accepts when disabled', () => {
    expect(decideConductorAction({ ...base, enabled: false })).toEqual({ kind: 'accept' })
  })

  it('accepts when no budget remains', () => {
    expect(decideConductorAction({ ...base, budgetRemaining: false })).toEqual({ kind: 'accept' })
  })

  it('accepts when the turn did not end cleanly (aborted/max_turns/error)', () => {
    expect(decideConductorAction({ ...base, outcomeReason: 'aborted_tools' })).toEqual({ kind: 'accept' })
    expect(decideConductorAction({ ...base, outcomeReason: 'max_turns' })).toEqual({ kind: 'accept' })
    expect(decideConductorAction({ ...base, outcomeReason: 'model_error' })).toEqual({ kind: 'accept' })
  })

  it('accepts when there is no gate state', () => {
    expect(decideConductorAction({ ...base, gate: undefined })).toEqual({ kind: 'accept' })
  })

  it('accepts when the verdict is PASS', () => {
    expect(
      decideConductorAction({
        ...base,
        gate: { needsVerification: false, mutationCount: 0, lastVerdict: 'PASS' },
      }),
    ).toEqual({ kind: 'accept' })
  })

  it('best_of_n on unaddressed FAIL when a port is available', () => {
    const a = decideConductorAction(base)
    expect(a.kind).toBe('best_of_n')
  })

  it('rewind on unaddressed FAIL when no best-of-n port is available', () => {
    const a = decideConductorAction({ ...base, bestOfNAvailable: false })
    expect(a.kind).toBe('rewind')
  })

  it('accepts a FAIL that was already cleared (needsVerification=false)', () => {
    expect(
      decideConductorAction({
        ...base,
        gate: { needsVerification: false, mutationCount: 0, lastVerdict: 'FAIL' },
      }),
    ).toEqual({ kind: 'accept' })
  })

  it('treats an undefined outcome reason as clean', () => {
    expect(decideConductorAction({ ...base, outcomeReason: undefined }).kind).toBe('best_of_n')
  })
})

describe('isConductorEnabled', () => {
  afterEach(() => {
    delete process.env.POLE_KERNEL_CONDUCTOR
  })
  it('off by default', () => {
    delete process.env.POLE_KERNEL_CONDUCTOR
    expect(isConductorEnabled()).toBe(false)
  })
  it.each(['1', 'true', 'on', 'yes', 'TRUE'])('on for %s', (v) => {
    process.env.POLE_KERNEL_CONDUCTOR = v
    expect(isConductorEnabled()).toBe(true)
  })
  it('off for 0/false', () => {
    process.env.POLE_KERNEL_CONDUCTOR = '0'
    expect(isConductorEnabled()).toBe(false)
  })
})

// ─── Part B: kernel integration ───────────────────────────────────────

function makeKernel(conversationId: string) {
  const ports = {
    tools: new DefaultToolRuntimePort({ get: () => null, set: () => {} }),
    permission: { noteToolInvocation: vi.fn() },
    session: createNoopMcpSessionAdapter(),
    transport: createTransportAdapter(vi.fn()),
    hooks: noopHookPolicy,
  }
  return new OrchestrationKernel(
    ports,
    undefined,
    createInitialKernelLoopState([]),
    conversationId,
  )
}

const minimalAgenticParams = {
  config: { id: 'anthropic', apiKey: 'x' },
  model: 'claude-test',
  messages: [{ role: 'user', content: 'do X' }],
  systemPrompt: 'sys',
  // callModel.ts merges this with the kernel signal — must be defined.
  signal: new AbortController().signal,
} as never

const minimalCallbacks = {
  onMessageEnd: vi.fn(),
  onTextDelta: vi.fn(),
  onToolStart: vi.fn(),
  onToolResult: vi.fn(),
  onError: vi.fn(),
} as never

describe('runDriveMainChat — Conductor integration', () => {
  beforeEach(() => {
    driveInnerLoopMock.mockReset()
    // Default inner loop: fire onTerminate with a clean `completed` outcome.
    driveInnerLoopMock.mockImplementation(
      async (_p: unknown, _c: unknown, hooks: { onTerminate?: (r: unknown) => void }) => {
        hooks.onTerminate?.({
          terminationResult: { reason: 'completed', turnCount: 1, terminatedAt: 0 },
          totalUsage: { inputTokens: 0, outputTokens: 0 },
          transition: 'init',
          transitionHistory: ['init'],
        })
      },
    )
    vi.mocked(getVerificationGateState).mockReset()
  })

  afterEach(() => {
    delete process.env.POLE_KERNEL_CONDUCTOR
  })

  it('does NOTHING when the Conductor is disabled (default)', async () => {
    delete process.env.POLE_KERNEL_CONDUCTOR
    vi.mocked(getVerificationGateState).mockReturnValue({
      needsVerification: true,
      mutationCount: 3,
      lastVerdict: 'FAIL',
    })
    const port: ConductorBestOfNPort = { run: vi.fn().mockResolvedValue({ integrated: true }) }
    const kernel = makeKernel('conv-disabled')

    await kernel.runDriveMainChat({
      rendererMessages: [{ role: 'user', content: 'do X' }],
      agenticParams: minimalAgenticParams,
      agenticCallbacks: minimalCallbacks,
      conductorBestOfNPort: port,
    })

    expect(port.run).not.toHaveBeenCalled()
    expect(driveInnerLoopMock).toHaveBeenCalledTimes(1)
  })

  it('fans out best-of-N on an unaddressed FAIL when enabled + port wired', async () => {
    process.env.POLE_KERNEL_CONDUCTOR = '1'
    vi.mocked(getVerificationGateState).mockReturnValue({
      needsVerification: true,
      mutationCount: 4,
      lastVerdict: 'FAIL',
    })
    const port: ConductorBestOfNPort = { run: vi.fn().mockResolvedValue({ integrated: true }) }
    const kernel = makeKernel('conv-bon')

    await kernel.runDriveMainChat({
      rendererMessages: [{ role: 'user', content: 'do X' }],
      agenticParams: minimalAgenticParams,
      agenticCallbacks: minimalCallbacks,
      conductorBestOfNPort: port,
    })

    expect(port.run).toHaveBeenCalledTimes(1)
    expect(port.run).toHaveBeenCalledWith(expect.objectContaining({ task: 'do X' }))
    // best_of_n breaks after one fan-out → exactly one turn ran.
    expect(driveInnerLoopMock).toHaveBeenCalledTimes(1)
  })

  it('re-dispatches (rewind) on FAIL with no port, bounded by the cap', async () => {
    process.env.POLE_KERNEL_CONDUCTOR = '1'
    // Gate keeps returning FAIL → Conductor wants to re-dispatch every turn.
    vi.mocked(getVerificationGateState).mockReturnValue({
      needsVerification: true,
      mutationCount: 3,
      lastVerdict: 'FAIL',
    })
    const kernel = makeKernel('conv-rewind')

    await kernel.runDriveMainChat({
      rendererMessages: [{ role: 'user', content: 'do X' }],
      agenticParams: minimalAgenticParams,
      agenticCallbacks: minimalCallbacks,
      // no conductorBestOfNPort → FAIL resolves to rewind re-dispatch
    })

    // Initial turn + 2 capped re-dispatches = 3 inner-loop runs.
    expect(driveInnerLoopMock).toHaveBeenCalledTimes(3)
  })

  it('classifies a best-of-N port failure as exitReason "error", not "completed"', async () => {
    // Contract audit (2026-07) regression — a throw out of
    // `conductorBestOfNPort.run` used to leave exitReason at 'completed', so
    // a failed verification-fix exploration looked like a clean turn end in
    // `outer_loop_complete` telemetry.
    process.env.POLE_KERNEL_CONDUCTOR = '1'
    vi.mocked(getVerificationGateState).mockReturnValue({
      needsVerification: true,
      mutationCount: 4,
      lastVerdict: 'FAIL',
    })
    const port: ConductorBestOfNPort = {
      run: vi.fn().mockRejectedValue(new Error('fan-out crashed')),
    }
    const emitted: unknown[] = []
    const ports = {
      tools: new DefaultToolRuntimePort({ get: () => null, set: () => {} }),
      permission: { noteToolInvocation: vi.fn() },
      session: createNoopMcpSessionAdapter(),
      transport: createTransportAdapter((ev) => emitted.push(ev)),
      hooks: noopHookPolicy,
    }
    const kernel = new OrchestrationKernel(
      ports,
      undefined,
      createInitialKernelLoopState([]),
      'conv-bon-fail',
    )

    await kernel.runDriveMainChat({
      rendererMessages: [{ role: 'user', content: 'do X' }],
      agenticParams: minimalAgenticParams,
      agenticCallbacks: minimalCallbacks,
      conductorBestOfNPort: port,
    })

    expect(port.run).toHaveBeenCalledTimes(1)
    const outerLoopEvent = emitted.find(
      (e) =>
        (e as { orchestrationPhase?: string }).orchestrationPhase === 'outer_loop_complete',
    ) as { outerLoopStats?: { exitReason: string } } | undefined
    expect(outerLoopEvent?.outerLoopStats?.exitReason).toBe('error')
  })

  it('keeps exitReason "completed" when the best-of-N port succeeds', async () => {
    process.env.POLE_KERNEL_CONDUCTOR = '1'
    vi.mocked(getVerificationGateState).mockReturnValue({
      needsVerification: true,
      mutationCount: 4,
      lastVerdict: 'FAIL',
    })
    const port: ConductorBestOfNPort = { run: vi.fn().mockResolvedValue({ integrated: true }) }
    const emitted: unknown[] = []
    const ports = {
      tools: new DefaultToolRuntimePort({ get: () => null, set: () => {} }),
      permission: { noteToolInvocation: vi.fn() },
      session: createNoopMcpSessionAdapter(),
      transport: createTransportAdapter((ev) => emitted.push(ev)),
      hooks: noopHookPolicy,
    }
    const kernel = new OrchestrationKernel(
      ports,
      undefined,
      createInitialKernelLoopState([]),
      'conv-bon-ok',
    )

    await kernel.runDriveMainChat({
      rendererMessages: [{ role: 'user', content: 'do X' }],
      agenticParams: minimalAgenticParams,
      agenticCallbacks: minimalCallbacks,
      conductorBestOfNPort: port,
    })

    const outerLoopEvent = emitted.find(
      (e) =>
        (e as { orchestrationPhase?: string }).orchestrationPhase === 'outer_loop_complete',
    ) as { outerLoopStats?: { exitReason: string } } | undefined
    expect(outerLoopEvent?.outerLoopStats?.exitReason).toBe('completed')
  })

  it('accepts immediately on a PASS verdict (single turn, no re-dispatch)', async () => {
    process.env.POLE_KERNEL_CONDUCTOR = '1'
    vi.mocked(getVerificationGateState).mockReturnValue({
      needsVerification: false,
      mutationCount: 0,
      lastVerdict: 'PASS',
    })
    const port: ConductorBestOfNPort = { run: vi.fn() }
    const kernel = makeKernel('conv-pass')

    await kernel.runDriveMainChat({
      rendererMessages: [{ role: 'user', content: 'do X' }],
      agenticParams: minimalAgenticParams,
      agenticCallbacks: minimalCallbacks,
      conductorBestOfNPort: port,
    })

    expect(port.run).not.toHaveBeenCalled()
    expect(driveInnerLoopMock).toHaveBeenCalledTimes(1)
  })
})
