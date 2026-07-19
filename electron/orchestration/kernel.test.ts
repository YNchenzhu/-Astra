import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  OrchestrationKernel,
  buildOrchestrationPortsForLegacyMainChat,
  createKernelForLegacyMainChat,
} from './kernel'
import type { PersistedKernelState } from './pauseResume'
import { createInitialKernelLoopState } from './kernelTypes'
import { noopHookPolicy, createTransportAdapter } from './transport'
import { DefaultToolRuntimePort } from './toolRuntime/defaultToolRuntimePort'
import { createNoopMcpSessionAdapter } from './mcpSessionAdapter'

vi.mock('../agents/agentContext', () => ({
  getAgentContext: vi.fn().mockReturnValue(null),
}))

// Chunk 8c — the iteration primitives physically live in `./phases/iteration`.
// `driveInnerLoop` lives in its own `./phases/driveInnerLoop` (deliberately
// separate so this mock intercepts the cross-module calls it makes).
vi.mock('./phases/iteration', () => ({
  runAgenticLoop: vi.fn().mockResolvedValue(undefined),
  runAgenticIteration: vi.fn().mockResolvedValue({ kind: 'terminate' }),
  finaliseMaxIterations: vi.fn().mockResolvedValue(undefined),
  setupAgenticLoopForRun: vi.fn(),
}))

function makeFakeLoopState() {
  // Minimal stub mirroring the real `LoopState` fields touched by the kernel-owned `while`.
  return {
    iteration: 0,
    maxIterations: 256,
    callbacks: {
      onMessageEnd: vi.fn(),
      onTextDelta: vi.fn(),
      onToolStart: vi.fn(),
      onToolResult: vi.fn(),
      onError: vi.fn(),
    },
    totalUsage: { inputTokens: 0, outputTokens: 0 },
    transition: 'init' as const,
    transitionHistory: ['init'] as Array<unknown>,
    profiler: {
      setIteration: vi.fn(),
      flush: vi.fn(),
      startCheckpoint: vi.fn(() => () => undefined),
    },
    terminationResult: null,
  } as unknown as import('../ai/agenticLoop/loopShared').LoopState
}

describe('OrchestrationKernel', () => {
  afterEach(async () => {
    // Chunk 8b — read from `./phases/iteration` (the real home post-move).
    const ag = await import('./phases/iteration')
    vi.mocked(ag.runAgenticLoop).mockReset()
    vi.mocked(ag.runAgenticLoop).mockResolvedValue(undefined)
    vi.mocked(ag.runAgenticIteration).mockReset()
    vi.mocked(ag.runAgenticIteration).mockResolvedValue({ kind: 'terminate' })
    vi.mocked(ag.finaliseMaxIterations).mockReset()
    vi.mocked(ag.finaliseMaxIterations).mockResolvedValue(undefined)
    vi.mocked(ag.setupAgenticLoopForRun).mockReset()
    // 重置 getAgentContext 回到默认 null，避免 mockReturnValue 泄漏
    const agentContext = await import('../agents/agentContext')
    vi.mocked(agentContext.getAgentContext).mockReturnValue(null)
  })

  it('runs PrepareContext then CallModel (legacy delegate)', async () => {
    const { runAgenticLoop } = await import('./phases/iteration')
    const emit = vi.fn()
    const onTranscriptCommitted = vi.fn()
    const onSessionStart = vi.fn()
    const onSessionEnd = vi.fn()
    const onPromptSubmit = vi.fn()
    const ports = {
      tools: new DefaultToolRuntimePort({ get: () => null, set: () => {} }),
      permission: { noteToolInvocation: vi.fn() },
      session: { onTranscriptCommitted },
      transport: createTransportAdapter(emit),
      hooks: { onSessionStart, onPromptSubmit, onSessionEnd },
    }
    const kernel = new OrchestrationKernel(
      ports,
      undefined,
      createInitialKernelLoopState([]),
      'conv-test',
    )
    await kernel.runLegacyDelegateMainChat({
      rendererMessages: [{ role: 'user', content: 'ping' }],
      agenticParams: {
        config: { id: 'anthropic', apiKey: 'x' } as import('../ai/client').ProviderConfig,
        model: 'claude',
        messages: [],
        signal: new AbortController().signal,
      },
      agenticCallbacks: {
        onTextDelta: vi.fn(),
        onToolStart: vi.fn(),
        onToolResult: vi.fn(),
        onMessageEnd: vi.fn(),
        onError: vi.fn(),
      },
    })
    expect(onSessionStart).toHaveBeenCalledOnce()
    expect(onPromptSubmit).toHaveBeenCalled()
    expect(onSessionEnd).toHaveBeenCalledOnce()
    expect(onTranscriptCommitted).toHaveBeenCalledWith([
      { role: 'user', content: 'ping' },
    ])
    expect(runAgenticLoop).toHaveBeenCalledOnce()
    const arg0 = vi.mocked(runAgenticLoop).mock.calls[0][0]
    expect(arg0.messages).toEqual([{ role: 'user', content: 'ping' }])
    expect(arg0.orchestratedToolExecution?.port).toBe(ports.tools)
    expect(arg0.orchestratedToolExecution?.getKernelState()).toEqual(kernel.getState())
    expect(typeof arg0.hostTranscript?.commit).toBe('function')
    expect(kernel.getState().phase).toBe('Terminal')
    const phaseTypes = emit.mock.calls.map((c) => (c[0] as { type?: string }).type)
    expect(phaseTypes.filter((t) => t === 'orchestration_phase').length).toBeGreaterThanOrEqual(3)
  })

  it('buildOrchestrationPortsForLegacyMainChat returns five ports', () => {
    const p = buildOrchestrationPortsForLegacyMainChat(vi.fn())
    expect(p.tools).toBeDefined()
    expect(p.permission).toBeDefined()
    expect(p.session).toBeDefined()
    expect(p.transport).toBeDefined()
    expect(p.hooks).toBeDefined()
  })

  it('hostTranscript commit updates kernel transcript before Terminal', async () => {
    const { runAgenticLoop } = await import('./phases/iteration')
    vi.mocked(runAgenticLoop).mockImplementation(async (params) => {
      params.hostTranscript?.commit([
        { role: 'user', content: 'seed' },
        { role: 'assistant', content: [{ type: 'text', text: 'during-loop' }] },
      ])
    })

    const emit = vi.fn()
    const onTranscriptCommitted = vi.fn()
    const ports = {
      tools: new DefaultToolRuntimePort({ get: () => null, set: () => {} }),
      permission: { noteToolInvocation: vi.fn() },
      session: { onTranscriptCommitted },
      transport: createTransportAdapter(emit),
      hooks: {},
    }
    const kernel = new OrchestrationKernel(
      ports,
      undefined,
      createInitialKernelLoopState([]),
      'conv-sync',
    )
    await kernel.runLegacyDelegateMainChat({
      rendererMessages: [{ role: 'user', content: 'seed' }],
      agenticParams: {
        config: { id: 'anthropic', apiKey: 'x' } as import('../ai/client').ProviderConfig,
        model: 'claude',
        messages: [],
        signal: new AbortController().signal,
      },
      agenticCallbacks: {
        onTextDelta: vi.fn(),
        onToolStart: vi.fn(),
        onToolResult: vi.fn(),
        onMessageEnd: vi.fn(),
        onError: vi.fn(),
      },
    })
    expect(kernel.getState().transcript).toEqual([
      { role: 'user', content: 'seed' },
      { role: 'assistant', content: [{ type: 'text', text: 'during-loop' }] },
    ])
    expect(onTranscriptCommitted).toHaveBeenCalledWith([
      { role: 'user', content: 'seed' },
      { role: 'assistant', content: [{ type: 'text', text: 'during-loop' }] },
    ])
  })

  it('runDriveMainChat owns the inner while — uses runAgenticIteration, NOT runAgenticLoop', async () => {
    const ag = await import('./phases/iteration')
    vi.mocked(ag.setupAgenticLoopForRun).mockImplementationOnce(() => ({
      state: makeFakeLoopState(),
      systemPrompt: '',
      fireOnTerminate: vi.fn(),
      finaliseTransitionHistory: vi.fn(),
    }))
    vi.mocked(ag.runAgenticIteration).mockResolvedValueOnce({ kind: 'terminate' })

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
      'conv-drive',
    )
    await kernel.runDriveMainChat({
      rendererMessages: [{ role: 'user', content: 'drive' }],
      agenticParams: {
        config: { id: 'anthropic', apiKey: 'x' } as import('../ai/client').ProviderConfig,
        model: 'claude',
        messages: [],
        signal: new AbortController().signal,
      },
      agenticCallbacks: {
        onTextDelta: vi.fn(),
        onToolStart: vi.fn(),
        onToolResult: vi.fn(),
        onMessageEnd: vi.fn(),
        onError: vi.fn(),
      },
    })
    // The kernel's own `while` body runs — runAgenticIteration is the granular call point.
    expect(ag.runAgenticIteration).toHaveBeenCalledOnce()
    // Drive mode should NEVER fall through to the legacy `runAgenticLoop` (it owns the loop).
    expect(ag.runAgenticLoop).not.toHaveBeenCalled()
    // No iterationBoundaryHook is injected — kernel does the equivalent inline.
    const iterArg = vi.mocked(ag.runAgenticIteration).mock.calls[0][1]
    expect(iterArg.iterationBoundaryHook).toBeUndefined()
    expect(kernel.getState().phase).toBe('Terminal')
  })

  it('runDriveMainChat classifies a thrown turn as exitReason "error" in outer_loop_complete (2026-06 fix)', async () => {
    const ag = await import('./phases/iteration')
    vi.mocked(ag.setupAgenticLoopForRun).mockImplementationOnce(() => ({
      state: makeFakeLoopState(),
      systemPrompt: '',
      fireOnTerminate: vi.fn(),
      finaliseTransitionHistory: vi.fn(),
    }))
    vi.mocked(ag.runAgenticIteration).mockRejectedValueOnce(new Error('boom'))

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
      'conv-drive-error',
    )
    await expect(
      kernel.runDriveMainChat({
        rendererMessages: [{ role: 'user', content: 'drive' }],
        agenticParams: {
          config: { id: 'anthropic', apiKey: 'x' } as import('../ai/client').ProviderConfig,
          model: 'claude',
          messages: [],
          signal: new AbortController().signal,
        },
        agenticCallbacks: {
          onTextDelta: vi.fn(),
          onToolStart: vi.fn(),
          onToolResult: vi.fn(),
          onMessageEnd: vi.fn(),
          onError: vi.fn(),
        },
      }),
    ).rejects.toThrow('boom')
    // Pre-fix the finally-side telemetry reported `exitReason: 'completed'`
    // for a turn that actually threw.
    const outer = emit.mock.calls
      .map((c) => c[0] as { orchestrationPhase?: string; outerLoopStats?: { exitReason?: string } })
      .find((ev) => ev.orchestrationPhase === 'outer_loop_complete')
    expect(outer?.outerLoopStats?.exitReason).toBe('error')
  })

  it('preserves the first outer iteration assistant transcript when a late inbox item triggers a second outer iteration', async () => {
    const ag = await import('./phases/iteration')
    const messagesSeenByLoop: Array<Array<Record<string, unknown>>> = []
    let setupCount = 0
    vi.mocked(ag.setupAgenticLoopForRun).mockImplementation((agenticParams) => {
      messagesSeenByLoop.push(
        agenticParams.messages.map((message) => ({ ...message })) as Array<Record<string, unknown>>,
      )
      const state = {
        ...makeFakeLoopState(),
        apiMessages: agenticParams.messages.map((message) => ({ ...message })),
      }
      if (setupCount++ === 0) {
        agenticParams.hostTranscript?.commit([
          { role: 'user', content: 'seed' },
          { role: 'assistant', content: 'first-result' },
        ])
        kernel.enqueueInboxItem({ kind: 'synthetic_user_text', text: 'late-input' })
      }
      return {
        state: state as never,
        systemPrompt: '',
        fireOnTerminate: vi.fn(),
        finaliseTransitionHistory: vi.fn(),
      }
    })
    vi.mocked(ag.runAgenticIteration).mockResolvedValue({ kind: 'terminate' })

    const kernel = new OrchestrationKernel(
      {
        tools: new DefaultToolRuntimePort({ get: () => null, set: () => {} }),
        permission: { noteToolInvocation: vi.fn() },
        session: createNoopMcpSessionAdapter(),
        transport: createTransportAdapter(vi.fn()),
        hooks: noopHookPolicy,
      },
      undefined,
      createInitialKernelLoopState([]),
      'conv-outer-transcript',
    )

    await kernel.runDriveMainChat({
      rendererMessages: [{ role: 'user', content: 'seed' }],
      agenticParams: {
        config: { id: 'anthropic', apiKey: 'x' } as import('../ai/client').ProviderConfig,
        model: 'claude',
        messages: [],
        signal: new AbortController().signal,
      },
      agenticCallbacks: {
        onTextDelta: vi.fn(),
        onToolStart: vi.fn(),
        onToolResult: vi.fn(),
        onMessageEnd: vi.fn(),
        onError: vi.fn(),
      },
    })

    expect(messagesSeenByLoop).toHaveLength(2)
    expect(messagesSeenByLoop[1]).toEqual([
      { role: 'user', content: 'seed' },
      { role: 'assistant', content: 'first-result' },
      {
        role: 'user',
        content: expect.stringContaining('late-input'),
      },
    ])
  })

  it('detects same-length transcript content drift at an iteration boundary', async () => {
    const ag = await import('./phases/iteration')
    vi.mocked(ag.setupAgenticLoopForRun).mockImplementationOnce(() => ({
      state: {
        ...makeFakeLoopState(),
        apiMessages: [{ role: 'user', content: 'different' }],
      } as never,
      systemPrompt: '',
      fireOnTerminate: vi.fn(),
      finaliseTransitionHistory: vi.fn(),
    }))
    vi.mocked(ag.runAgenticIteration).mockResolvedValueOnce({ kind: 'terminate' })
    const emit = vi.fn()
    const kernel = new OrchestrationKernel(
      {
        tools: new DefaultToolRuntimePort({ get: () => null, set: () => {} }),
        permission: { noteToolInvocation: vi.fn() },
        session: createNoopMcpSessionAdapter(),
        transport: createTransportAdapter(emit),
        hooks: noopHookPolicy,
      },
      undefined,
      createInitialKernelLoopState([]),
      'conv-same-length-drift',
    )

    await kernel.runDriveMainChat({
      rendererMessages: [{ role: 'user', content: 'seed' }],
      agenticParams: {
        config: { id: 'anthropic', apiKey: 'x' } as import('../ai/client').ProviderConfig,
        model: 'claude',
        messages: [],
        signal: new AbortController().signal,
      },
      agenticCallbacks: {
        onTextDelta: vi.fn(),
        onToolStart: vi.fn(),
        onToolResult: vi.fn(),
        onMessageEnd: vi.fn(),
        onError: vi.fn(),
      },
    })

    const drift = emit.mock.calls
      .map((call) => call[0] as { orchestrationPhase?: string })
      .find((event) => event.orchestrationPhase === 'transcript_drift')
    expect(drift).toBeDefined()
  })

  it('forwards the typed AgentLoop termination reason into outer-loop telemetry', async () => {
    const ag = await import('./phases/iteration')
    vi.mocked(ag.setupAgenticLoopForRun).mockImplementationOnce((_params, _callbacks, options) => {
      const result = {
        terminationResult: {
          reason: 'model_error' as const,
          turnCount: 1,
          terminatedAt: Date.now(),
        },
        totalUsage: { inputTokens: 0, outputTokens: 0 },
        transition: 'init' as const,
        transitionHistory: [],
      }
      return {
        state: makeFakeLoopState(),
        systemPrompt: '',
        fireOnTerminate: () => options?.onTerminate?.(result),
        finaliseTransitionHistory: vi.fn(),
      }
    })
    vi.mocked(ag.runAgenticIteration).mockResolvedValueOnce({ kind: 'terminate' })
    const emit = vi.fn()
    const kernel = new OrchestrationKernel(
      {
        tools: new DefaultToolRuntimePort({ get: () => null, set: () => {} }),
        permission: { noteToolInvocation: vi.fn() },
        session: createNoopMcpSessionAdapter(),
        transport: createTransportAdapter(emit),
        hooks: noopHookPolicy,
      },
      undefined,
      createInitialKernelLoopState([]),
      'conv-typed-termination',
    )

    await kernel.runDriveMainChat({
      rendererMessages: [{ role: 'user', content: 'seed' }],
      agenticParams: {
        config: { id: 'anthropic', apiKey: 'x' } as import('../ai/client').ProviderConfig,
        model: 'claude',
        messages: [],
        signal: new AbortController().signal,
      },
      agenticCallbacks: {
        onTextDelta: vi.fn(),
        onToolStart: vi.fn(),
        onToolResult: vi.fn(),
        onMessageEnd: vi.fn(),
        onError: vi.fn(),
      },
    })

    const outer = emit.mock.calls
      .map((call) => call[0] as {
        orchestrationPhase?: string
        outerLoopStats?: { terminationReason?: string }
      })
      .find((event) => event.orchestrationPhase === 'outer_loop_complete')
    expect(outer?.outerLoopStats?.terminationReason).toBe('model_error')
  })

  it('emits transcript_drift (iteration_boundary) when the loop transcript diverges from kernel state', async () => {
    // Contract audit (2026-07) — per-iteration invariant tracer. The fake
    // loop state carries 3 apiMessages while the kernel transcript was seeded
    // with 1 renderer message; the boundary check must emit a typed
    // `transcript_drift` event tagged `iteration_boundary`.
    const ag = await import('./phases/iteration')
    const fakeState = {
      ...makeFakeLoopState(),
      apiMessages: [
        { role: 'user', content: 'a' },
        { role: 'assistant', content: 'b' },
        { role: 'user', content: 'c' },
      ],
    }
    const acceptHostTranscript = vi.fn((messages: Array<Record<string, unknown>>) => {
      fakeState.apiMessages = structuredClone(messages)
    })
    fakeState.acceptHostTranscript = acceptHostTranscript
    vi.mocked(ag.setupAgenticLoopForRun).mockImplementationOnce(() => ({
      state: fakeState as never,
      systemPrompt: '',
      fireOnTerminate: vi.fn(),
      finaliseTransitionHistory: vi.fn(),
    }))
    vi.mocked(ag.runAgenticIteration).mockResolvedValueOnce({ kind: 'terminate' })

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
      'conv-drift-tracer',
    )
    await kernel.runDriveMainChat({
      rendererMessages: [{ role: 'user', content: 'drive' }],
      agenticParams: {
        config: { id: 'anthropic', apiKey: 'x' } as import('../ai/client').ProviderConfig,
        model: 'claude',
        messages: [],
        signal: new AbortController().signal,
      },
      agenticCallbacks: {
        onTextDelta: vi.fn(),
        onToolStart: vi.fn(),
        onToolResult: vi.fn(),
        onMessageEnd: vi.fn(),
        onError: vi.fn(),
      },
    })

    const drift = emit.mock.calls
      .map((c) => c[0] as {
        orchestrationPhase?: string
        transcriptDrift?: {
          agentContextLength: number
          kernelTranscriptLength: number
          checkpoint?: string
        }
      })
      .find((ev) => ev.orchestrationPhase === 'transcript_drift')
    expect(drift?.transcriptDrift?.checkpoint).toBe('iteration_boundary')
    expect(drift?.transcriptDrift?.agentContextLength).toBe(3)
    expect(drift?.transcriptDrift?.kernelTranscriptLength).toBe(1)
    expect(acceptHostTranscript).toHaveBeenCalledWith([
      { role: 'user', content: 'drive' },
    ])
    expect(fakeState.apiMessages).toEqual([{ role: 'user', content: 'drive' }])
  })

  it('drive-mode while terminates cleanly when interrupted before the first iteration', async () => {
    const ag = await import('./phases/iteration')
    const fakeState = makeFakeLoopState()
    vi.mocked(ag.setupAgenticLoopForRun).mockImplementationOnce(() => ({
      state: fakeState,
      systemPrompt: '',
      fireOnTerminate: vi.fn(),
      finaliseTransitionHistory: vi.fn(),
    }))

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
      createInitialKernelLoopState([]),
      'conv-drive-stop',
    )
    // Interrupt BEFORE the run starts → kernel's pre-iteration abort check should fire,
    // skipping `runAgenticIteration` entirely and going straight to clean termination.
    kernel.interrupt('user')
    await kernel.runDriveMainChat({
      rendererMessages: [{ role: 'user', content: 'drive' }],
      agenticParams: {
        config: { id: 'anthropic', apiKey: 'x' } as import('../ai/client').ProviderConfig,
        model: 'claude',
        messages: [],
        signal: new AbortController().signal,
      },
      agenticCallbacks: {
        onTextDelta: vi.fn(),
        onToolStart: vi.fn(),
        onToolResult: vi.fn(),
        onMessageEnd: vi.fn(),
        onError: vi.fn(),
      },
    })
    // Inner while bailed before any iteration ran.
    expect(ag.runAgenticIteration).not.toHaveBeenCalled()
  })

  it('drive-mode while pauses inner iterations until the kernel is resumed', async () => {
    const ag = await import('./phases/iteration')
    const fakeState = makeFakeLoopState()
    vi.mocked(ag.setupAgenticLoopForRun).mockImplementationOnce(() => ({
      state: fakeState,
      systemPrompt: '',
      fireOnTerminate: vi.fn(),
      finaliseTransitionHistory: vi.fn(),
    }))
    vi.mocked(ag.runAgenticIteration).mockResolvedValueOnce({ kind: 'terminate' })

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
      createInitialKernelLoopState([]),
      'conv-drive-pause',
    )
    // Pause kernel BEFORE the run starts. The kernel's inner `while` should observe the
    // pause flag at the iteration boundary and await before invoking runAgenticIteration.
    kernel.pause()
    let runFinished = false
    const runPromise = kernel.runDriveMainChat({
      rendererMessages: [{ role: 'user', content: 'drive' }],
      agenticParams: {
        config: { id: 'anthropic', apiKey: 'x' } as import('../ai/client').ProviderConfig,
        model: 'claude',
        messages: [],
        signal: new AbortController().signal,
      },
      agenticCallbacks: {
        onTextDelta: vi.fn(),
        onToolStart: vi.fn(),
        onToolResult: vi.fn(),
        onMessageEnd: vi.fn(),
        onError: vi.fn(),
      },
    }).then(() => { runFinished = true })
    // Microtask flush — paused kernel must NOT have called runAgenticIteration yet
    // (the outer drive `while` waits at `awaitPauseResume()` BEFORE entering the
    // legacy delegate that would invoke the inner CallModel impl).
    await new Promise((r) => setTimeout(r, 5))
    expect(ag.runAgenticIteration).not.toHaveBeenCalled()
    expect(runFinished).toBe(false)
    kernel.resume()
    await runPromise
    expect(ag.runAgenticIteration).toHaveBeenCalledOnce()
    expect(runFinished).toBe(true)
  })

  it('interrupt() aborts the merged signal and still runs Terminal + onSessionEnd', async () => {
    const { runAgenticLoop } = await import('./phases/iteration')
    let observedSignal: AbortSignal | undefined
    vi.mocked(runAgenticLoop).mockImplementation(async (params) => {
      observedSignal = params.signal
      // Simulate the loop running long enough for an interrupt to arrive.
      await new Promise<void>((resolve) => {
        if (params.signal.aborted) {
          resolve()
          return
        }
        params.signal.addEventListener('abort', () => resolve(), { once: true })
      })
    })

    const emit = vi.fn()
    const onSessionEnd = vi.fn()
    const onTranscriptCommitted = vi.fn()
    const ports = {
      tools: new DefaultToolRuntimePort({ get: () => null, set: () => {} }),
      permission: { noteToolInvocation: vi.fn() },
      session: { onTranscriptCommitted },
      transport: createTransportAdapter(emit),
      hooks: { onSessionEnd },
    }
    const kernel = new OrchestrationKernel(
      ports,
      undefined,
      createInitialKernelLoopState([]),
      'conv-interrupt',
    )

    const run = kernel.runLegacyDelegateMainChat({
      rendererMessages: [{ role: 'user', content: 'start' }],
      agenticParams: {
        config: { id: 'anthropic', apiKey: 'x' } as import('../ai/client').ProviderConfig,
        model: 'claude',
        messages: [],
        signal: new AbortController().signal,
      },
      agenticCallbacks: {
        onTextDelta: vi.fn(),
        onToolStart: vi.fn(),
        onToolResult: vi.fn(),
        onMessageEnd: vi.fn(),
        onError: vi.fn(),
      },
    })
    // Give the microtask loop a chance to start runAgenticLoop.
    await new Promise((r) => setTimeout(r, 0))
    expect(observedSignal).toBeDefined()
    expect(observedSignal?.aborted).toBe(false)

    kernel.interrupt('user')
    await run

    expect(observedSignal?.aborted).toBe(true)
    expect(kernel.getInterruptReason()).toBe('user')
    expect(onTranscriptCommitted).toHaveBeenCalledOnce()
    expect(onSessionEnd).toHaveBeenCalledOnce()

    const events = emit.mock.calls
      .map((c) => c[0] as { type?: string; orchestrationPhase?: string; interruptReason?: string })
      .filter((ev) => ev.orchestrationPhase === 'interrupt')
    expect(events).toHaveLength(1)
    expect(events[0].interruptReason).toBe('user')
  })

  it('repeated interrupts are idempotent; first reason wins', async () => {
    const { runAgenticLoop } = await import('./phases/iteration')
    vi.mocked(runAgenticLoop).mockResolvedValueOnce(undefined)

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
      'conv-interrupt-idem',
    )
    // Disable auto grace promotion so this test only observes soft idempotency.
    kernel.setSoftInterruptGraceMs(0)
    kernel.interrupt('timeout')
    kernel.interrupt('user')
    kernel.interrupt('shutdown')
    expect(kernel.getInterruptReason()).toBe('timeout')

    const interruptEvents = emit.mock.calls
      .map((c) => c[0] as { orchestrationPhase?: string })
      .filter((ev) => ev.orchestrationPhase === 'interrupt')
    expect(interruptEvents).toHaveLength(1)
  })

  // P0-2 — soft interrupt does NOT abort the hard signal; only an explicit
  // hard interrupt OR the grace timer does.
  it('soft interrupt does not abort hard signal; hard interrupt does', () => {
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
      'conv-soft-hard',
    )
    kernel.setSoftInterruptGraceMs(0) // disable auto-promotion for deterministic test

    expect(kernel.getAbortSignal().aborted).toBe(false)
    expect(kernel.getHardAbortSignal().aborted).toBe(false)

    kernel.interrupt('user')
    expect(kernel.getAbortSignal().aborted).toBe(true)
    expect(kernel.getHardAbortSignal().aborted).toBe(false)

    kernel.interrupt('user', { hard: true })
    expect(kernel.getHardAbortSignal().aborted).toBe(true)
  })

  // P0-2 — grace timer auto-promotes soft to hard when configured.
  it('soft interrupt auto-promotes to hard after grace period', async () => {
    vi.useFakeTimers()
    try {
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
        'conv-grace',
      )
      kernel.setSoftInterruptGraceMs(50)

      kernel.interrupt('user')
      expect(kernel.getAbortSignal().aborted).toBe(true)
      expect(kernel.getHardAbortSignal().aborted).toBe(false)

      vi.advanceTimersByTime(60)
      // microtask queue flush is not needed; AbortController.abort is sync.
      expect(kernel.getHardAbortSignal().aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  // P2-1 — HITL inbox persistence failure surfaces a typed phase event.
  it('persistInbox emits hitl_persistence_failed when save fails AND inbox has pending_human_resume', async () => {
    const inboxModule = await import('./inboxPersistence')
    // Stub saveInboxToDisk to simulate a disk write failure.
    const original = inboxModule.saveInboxToDisk
    const spy = vi
      .spyOn(inboxModule, 'saveInboxToDisk')
      .mockReturnValue({ ok: false, reason: 'disk_error', error: 'ENOSPC: disk full' })

    try {
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
        'conv-hitl-persist-fail',
      )
      // Inject a pending_human_resume directly via the inbox reducer.
      kernel.enqueueInboxItem({
        kind: 'pending_human_resume',
        toolUseId: 'tu_x',
        value: { answer: 'fortytwo' },
      })

      const failedEvents = emit.mock.calls
        .map((c) => c[0] as { orchestrationPhase?: string; hitlPersistenceFailed?: unknown })
        .filter((ev) => ev.orchestrationPhase === 'hitl_persistence_failed')
      expect(failedEvents).toHaveLength(1)
      const payload = failedEvents[0].hitlPersistenceFailed as {
        reason: string
        error: string
        pendingHumanResumeCount: number
      }
      expect(payload.reason).toBe('disk_error')
      expect(payload.error).toMatch(/ENOSPC/)
      expect(payload.pendingHumanResumeCount).toBe(1)
    } finally {
      spy.mockRestore()
      // Reference original so the linter doesn't drop the import.
      void original
    }
  })

  // Audit Bug-4 fix — burst of enqueues with same disk-failure reason
  // should only fire ONE phase event within the throttle window.
  it('persistInbox throttles repeated hitl_persistence_failed events for the same reason', async () => {
    const inboxModule = await import('./inboxPersistence')
    const spy = vi
      .spyOn(inboxModule, 'saveInboxToDisk')
      .mockReturnValue({ ok: false, reason: 'disk_error', error: 'ENOSPC' })

    try {
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
        'conv-hitl-throttle',
      )
      // Pre-seed a HITL item so every subsequent enqueue will trigger
      // the emit path. The first enqueue saves (and fails) once.
      kernel.enqueueInboxItem({
        kind: 'pending_human_resume',
        toolUseId: 'tu_a',
        value: { ans: 1 },
      })
      kernel.enqueueInboxItem({
        kind: 'pending_human_resume',
        toolUseId: 'tu_b',
        value: { ans: 2 },
      })
      kernel.enqueueInboxItem({
        kind: 'pending_human_resume',
        toolUseId: 'tu_c',
        value: { ans: 3 },
      })

      const failedEvents = emit.mock.calls
        .map((c) => c[0] as { orchestrationPhase?: string })
        .filter((ev) => ev.orchestrationPhase === 'hitl_persistence_failed')
      // Expect exactly ONE event for the burst of 3 enqueues — same disk
      // error reason within the throttle window.
      expect(failedEvents).toHaveLength(1)
    } finally {
      spy.mockRestore()
    }
  })

  it('persistInbox does NOT emit hitl_persistence_failed when save fails but no pending_human_resume', async () => {
    const inboxModule = await import('./inboxPersistence')
    const spy = vi
      .spyOn(inboxModule, 'saveInboxToDisk')
      .mockReturnValue({ ok: false, reason: 'disk_error', error: 'EACCES' })

    try {
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
        'conv-hitl-persist-no-hitl',
      )
      // No HITL item — synthetic_user_text only.
      kernel.enqueueInboxItem({ kind: 'synthetic_user_text', text: 'hello' })

      const failedEvents = emit.mock.calls
        .map((c) => c[0] as { orchestrationPhase?: string })
        .filter((ev) => ev.orchestrationPhase === 'hitl_persistence_failed')
      expect(failedEvents).toHaveLength(0)
    } finally {
      spy.mockRestore()
    }
  })

  // Audit Bug-2 fix — kernel.dispose() cancels the grace timer so a soft
  // interrupt that fired late in a turn doesn't emit a phantom event
  // 30 seconds after the session ended.
  it('dispose() cancels pending grace promotion timer', async () => {
    vi.useFakeTimers()
    try {
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
        'conv-dispose-grace',
      )
      kernel.setSoftInterruptGraceMs(60_000)
      kernel.interrupt('user')

      // Snapshot interrupt-event count before dispose.
      const before = emit.mock.calls.filter(
        (c) => (c[0] as { orchestrationPhase?: string }).orchestrationPhase === 'interrupt',
      ).length

      kernel.dispose()
      // Past the grace period, NO additional interrupt event should fire.
      vi.advanceTimersByTime(120_000)
      const after = emit.mock.calls.filter(
        (c) => (c[0] as { orchestrationPhase?: string }).orchestrationPhase === 'interrupt',
      ).length
      expect(after).toBe(before)
      // Hard signal must remain UNaborted (dispose is not an abort).
      expect(kernel.getHardAbortSignal().aborted).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  // P0-2 — explicit hard interrupt before grace cancels the grace timer.
  it('explicit hard interrupt before grace expiry cancels grace timer', async () => {
    vi.useFakeTimers()
    try {
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
        'conv-hard-cancel-grace',
      )
      kernel.setSoftInterruptGraceMs(60_000)

      kernel.interrupt('user')
      kernel.interrupt('user', { hard: true })
      expect(kernel.getHardAbortSignal().aborted).toBe(true)

      // Advancing past the grace period should not emit a second hard event
      // (the timer was cancelled).
      const before = emit.mock.calls.filter(
        (c) =>
          (c[0] as { orchestrationPhase?: string }).orchestrationPhase === 'interrupt',
      ).length
      vi.advanceTimersByTime(120_000)
      const after = emit.mock.calls.filter(
        (c) =>
          (c[0] as { orchestrationPhase?: string }).orchestrationPhase === 'interrupt',
      ).length
      expect(after).toBe(before)
    } finally {
      vi.useRealTimers()
    }
  })

  it('Host transcript inbox drain is always passed to runAgenticLoop and clears inbox', async () => {
    const { runAgenticLoop } = await import('./phases/iteration')

    let drainCallback: import('../ai/agenticLoopTypes').AgentLoopTranscriptPort['drainInbox']
    vi.mocked(runAgenticLoop).mockImplementation(async (params) => {
      drainCallback = params.hostTranscript?.drainInbox
    })

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
      'conv-inbox',
    )
    // Enqueue before the run so the drain path has something to hand back mid-turn.
    kernel.enqueueInboxItem({ kind: 'synthetic_user_text', text: 'mid-turn ping' })
    kernel.enqueueInboxItem({ kind: 'slash_command', name: 'help', args: 'tools' })
    await kernel.runLegacyDelegateMainChat({
      rendererMessages: [{ role: 'user', content: 'start' }],
      agenticParams: {
        config: { id: 'anthropic', apiKey: 'x' } as import('../ai/client').ProviderConfig,
        model: 'claude',
        messages: [],
        signal: new AbortController().signal,
      },
      agenticCallbacks: {
        onTextDelta: vi.fn(),
        onToolStart: vi.fn(),
        onToolResult: vi.fn(),
        onMessageEnd: vi.fn(),
        onError: vi.fn(),
      },
    })
    // Inbox is flushed by PrepareContext into transcript before CallModel runs, so by the time
    // the drain callback is available the inbox is already empty. The callback must still exist
    // when the flag is on.
    expect(typeof drainCallback).toBe('function')
    // Drain returns no-op because flushInboxToTranscript cleared everything at PrepareContext.
    expect(drainCallback?.()).toEqual({ injected: false })

    // Now simulate a fresh enqueue mid-turn: the drain should return the accepted snapshot.
    kernel.enqueueInboxItem({ kind: 'synthetic_user_text', text: 'late ping' })
    const drained = drainCallback?.()
    expect(drained?.injected).toBe(true)
    if (!drained?.injected) throw new Error('expected injected transcript snapshot')
    expect(drained.snapshot.messages.at(-1)).toEqual(
      expect.objectContaining({
        role: 'user',
        _sideChannelKind: 'generic_converted_system',
      }),
    )
    expect(drained.snapshot.revision).toBe(kernel.getState().transcriptRevision)
    expect(kernel.getState().inbox).toHaveLength(0)
  })

  it('wraps appendixAFlow reporter and tracks inner iteration via P2_Q_iteration_open', async () => {
    const { runAgenticLoop } = await import('./phases/iteration')
    const innerReports: Array<{ stage: string; detail: Record<string, unknown> | undefined }> = []
    const innerReporter = {
      report: (stage: string, detail?: Record<string, unknown>) => {
        innerReports.push({ stage, detail })
      },
    }

    vi.mocked(runAgenticLoop).mockImplementation(async (params) => {
      params.appendixAFlow?.report('P2_Q_iteration_open', { iteration: 1 })
      params.appendixAFlow?.report('P2_Q_stream_request_start', { iteration: 1 })
      params.appendixAFlow?.report('P2_Q_iteration_open', { iteration: 2 })
      params.appendixAFlow?.report('P2_Q_stream_complete', { iteration: 2 })
    })

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
      'conv-iter',
    )
    await kernel.runLegacyDelegateMainChat({
      rendererMessages: [{ role: 'user', content: 'go' }],
      agenticParams: {
        config: { id: 'anthropic', apiKey: 'x' } as import('../ai/client').ProviderConfig,
        model: 'claude',
        messages: [],
        signal: new AbortController().signal,
        appendixAFlow: innerReporter as unknown as import('./appendixAFlow').AppendixAFlowReporter,
      },
      agenticCallbacks: {
        onTextDelta: vi.fn(),
        onToolStart: vi.fn(),
        onToolResult: vi.fn(),
        onMessageEnd: vi.fn(),
        onError: vi.fn(),
      },
    })
    // Reporter received wrapped detail with outerIteration/innerIteration appended.
    expect(innerReports.length).toBe(4)
    expect(innerReports[0].stage).toBe('P2_Q_iteration_open')
    expect((innerReports[0].detail as { outerIteration: number }).outerIteration).toBe(1)
    expect((innerReports[0].detail as { innerIteration: number }).innerIteration).toBe(1)
    // After 2nd iteration_open the inner counter is 2.
    expect((innerReports[3].detail as { innerIteration: number }).innerIteration).toBe(2)
    // Kernel state reflects final inner counter.
    expect(kernel.getState().innerIteration).toBe(2)
  })

  it('runs Terminal + onSessionEnd and emits Error phase when runAgenticLoop throws ', async () => {
    const { runAgenticLoop } = await import('./phases/iteration')
    const boom = new Error('boom')
    vi.mocked(runAgenticLoop).mockRejectedValueOnce(boom)

    const emit = vi.fn()
    const onTranscriptCommitted = vi.fn()
    const onSessionEnd = vi.fn()
    const ports = {
      tools: new DefaultToolRuntimePort({ get: () => null, set: () => {} }),
      permission: { noteToolInvocation: vi.fn() },
      session: { onTranscriptCommitted },
      transport: createTransportAdapter(emit),
      hooks: { onSessionEnd },
    }
    const kernel = new OrchestrationKernel(
      ports,
      undefined,
      createInitialKernelLoopState([]),
      'conv-err',
    )

    await expect(
      kernel.runLegacyDelegateMainChat({
        rendererMessages: [{ role: 'user', content: 'trigger-throw' }],
        agenticParams: {
          config: { id: 'anthropic', apiKey: 'x' } as import('../ai/client').ProviderConfig,
          model: 'claude',
          messages: [],
          signal: new AbortController().signal,
        },
        agenticCallbacks: {
          onTextDelta: vi.fn(),
          onToolStart: vi.fn(),
          onToolResult: vi.fn(),
          onMessageEnd: vi.fn(),
          onError: vi.fn(),
        },
      }),
    ).rejects.toThrow('boom')

    // Terminal transcript commit ran despite the throw.
    expect(onTranscriptCommitted).toHaveBeenCalledOnce()
    // onSessionEnd ran.
    expect(onSessionEnd).toHaveBeenCalledOnce()
    // Error + Terminal phase events both emitted.
    const phaseEvents = emit.mock.calls
      .map((c) => c[0] as { type?: string; orchestrationPhase?: string })
      .filter((ev) => ev.type === 'orchestration_phase')
      .map((ev) => ev.orchestrationPhase)
    expect(phaseEvents).toContain('Error')
    expect(phaseEvents).toContain('Terminal')
    expect(kernel.getState().phase).toBe('Terminal')
  })

  it('Terminal phase keeps the last kernel-accepted transcript when AgentContext drifts', async () => {
    const agentContext = await import('../agents/agentContext')
    // 内核在 CallModel 阶段(setup toolRuntimePort)和 Terminal 阶段(读取 messages)
    // 各调用一次 getAgentContext，因此不能用 mockReturnValueOnce（只服务第一次调用）
    vi.mocked(agentContext.getAgentContext).mockReturnValue({
      messages: [
        { role: 'user', content: 'seed' },
        { role: 'assistant', content: [{ type: 'text', text: 'from-loop' }] },
      ],
    } as import('../agents/agentContext').AgentContext)

    const emit = vi.fn()
    const onTranscriptCommitted = vi.fn()
    const ports = {
      tools: new DefaultToolRuntimePort({ get: () => null, set: () => {} }),
      permission: { noteToolInvocation: vi.fn() },
      session: { onTranscriptCommitted },
      transport: createTransportAdapter(emit),
      hooks: {},
    }
    const kernel = new OrchestrationKernel(
      ports,
      undefined,
      createInitialKernelLoopState([]),
      'conv-ctx',
    )
    await kernel.runLegacyDelegateMainChat({
      rendererMessages: [{ role: 'user', content: 'seed' }],
      agenticParams: {
        config: { id: 'anthropic', apiKey: 'x' } as import('../ai/client').ProviderConfig,
        model: 'claude',
        messages: [],
        signal: new AbortController().signal,
      },
      agenticCallbacks: {
        onTextDelta: vi.fn(),
        onToolStart: vi.fn(),
        onToolResult: vi.fn(),
        onMessageEnd: vi.fn(),
        onError: vi.fn(),
      },
    })
    expect(onTranscriptCommitted).toHaveBeenCalledWith([{ role: 'user', content: 'seed' }])
    const drift = emit.mock.calls
      .map((call) => call[0] as {
        orchestrationPhase?: string
        transcriptDrift?: { resolvedWith?: string }
      })
      .find((event) => event.orchestrationPhase === 'transcript_drift')
    expect(drift?.transcriptDrift?.resolvedWith).toBe('kernel')
  })
})

describe('createKernelForLegacyMainChat — P2-3 soft-cap counter seeding', () => {
  const makeBlob = (
    phase: PersistedKernelState['state']['phase'],
    iteration: number,
    maxOutputRecoveryCycles: number,
    consecutiveCompactFailures: number,
  ): PersistedKernelState => ({
    version: 1,
    savedAt: Date.now(),
    conversationId: 'p2-3-conv',
    paused: false,
    state: {
      phase,
      iteration,
      innerIteration: 0,
      transcript: [],
      inbox: [],
      maxOutputRecoveryCycles,
      consecutiveCompactFailures,
    },
  })

  it('resets soft-cap counters but keeps iteration when prior turn completed (phase=Terminal)', () => {
    const kernel = createKernelForLegacyMainChat(() => {}, undefined, [], {
      prevPersistedBlob: makeBlob('Terminal', 5, 3, 2),
    })
    const s = kernel.getState()
    // Cumulative turn counter is inherited…
    expect(s.iteration).toBe(5)
    // …but the per-turn recovery budgets start fresh so they don't leak
    // across normal turns (would otherwise monotonically trip the soft caps).
    expect(s.maxOutputRecoveryCycles).toBe(0)
    expect(s.consecutiveCompactFailures).toBe(0)
  })

  it('inherits soft-cap counters on genuine mid-turn crash recovery (phase=CallModel)', () => {
    // A blob whose last persist was mid-turn (no Terminal marker) means the
    // process crashed before the turn finished — audit §4.1 requires the
    // recovery budgets carry over so a runaway loop does not reset its cap.
    const kernel = createKernelForLegacyMainChat(() => {}, undefined, [], {
      prevPersistedBlob: makeBlob('CallModel', 7, 3, 2),
    })
    const s = kernel.getState()
    expect(s.iteration).toBe(7)
    expect(s.maxOutputRecoveryCycles).toBe(3)
    expect(s.consecutiveCompactFailures).toBe(2)
  })

  it('keeps a mid-turn committed transcript instead of overwriting it with the renderer seed', () => {
    const blob = makeBlob('CallModel', 7, 1, 1)
    blob.state.transcript = [{ role: 'assistant', content: 'accepted checkpoint' }]
    const kernel = createKernelForLegacyMainChat(
      () => {},
      undefined,
      [{ role: 'user', content: 'stale renderer snapshot' }],
      { prevPersistedBlob: blob },
    )

    expect(kernel.getState().transcript).toEqual([
      { role: 'assistant', content: 'accepted checkpoint' },
    ])
    expect(kernel.getState().transcriptRevision).toBe(0)
  })
})
