/**
 * Audit SA-6 (P1) — integration contract for the per-iteration model-call
 * budget in `runStreamPhase`.
 *
 * Scenario: a `callModel` stub that ALWAYS ends with `stop_reason:
 * 'max_tokens'` (with recoverable text output) keeps the max-output
 * recovery loop scheduling retries forever. With the budget in place:
 *
 *   - the total number of model calls launched by the stream phase never
 *     exceeds `POLE_MAX_MODEL_ATTEMPTS_PER_ITERATION`;
 *   - exhaustion terminates the iteration through the same path as
 *     "recovery exhausted": typed `model_error` termination whose
 *     `errorDetail` carries the attempt breakdown per recovery entry.
 *
 * Heavy collaborators (StreamingToolExecutor, watchdog, prompt
 * diagnostics, the extracted recovery modules, …) are mocked at the
 * module boundary, mirroring `__tests__/iteration.test.ts` style. The
 * budget module itself and the overload-retry decision stay REAL — they
 * are the units under test plus their pure dependency.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

// ─── Module mocks (heavy collaborators) ───────────────────────────────

vi.mock('../streamWatchdog', () => ({
  StreamWatchdog: class {
    start(): void {}
    dispose(): void {}
    notifyActivity(): void {}
  },
}))

vi.mock('../streamingToolExecutor', () => ({
  StreamingToolExecutor: class {
    addTool(): void {}
    isEmpty(): boolean {
      return true
    }
  },
}))

vi.mock('./stream/withheldSignalPromotion', () => ({
  promoteOrRecoverWithheldSignal: vi.fn(async () => ({ kind: 'none' })),
}))
vi.mock('./stream/stripImageRetry', () => ({
  maybeRunImageStripRetry: vi.fn(async (_s: unknown, r: unknown) => r),
}))
vi.mock('./stream/reactiveCompactRecovery', () => ({
  maybeRunReactiveCompactRecovery: vi.fn(async (_s: unknown, r: unknown) => ({
    kind: 'ok',
    result: r,
  })),
}))
vi.mock('./stream/recoverFromContext', () => ({
  tryDrainOnlyContextRecovery: vi.fn(async (_s: unknown, r: unknown) => ({
    kind: 'fall_through',
    result: r,
  })),
}))

vi.mock('../../agents/agentContext', () => ({
  getAgentContext: () => undefined,
  recordAgentContextOutputBudgetUsage: vi.fn(),
}))
vi.mock('../../agents/queryTracking', () => ({
  attachPoleQueryTrackingToTailUserMessage: vi.fn(),
  buildPoleQueryTrackingForNextRequest: vi.fn(() => undefined),
}))
vi.mock('../../context/cachedMicrocompactPromptCache', () => ({
  consumeMicroCompactMessageCacheForkShiftOnce: vi.fn(() => false),
}))
vi.mock('../../context/promptCacheBreakDetection', () => ({
  buildCacheKeyFactors: vi.fn(() => ({})),
  getConversationCacheBreakDetector: vi.fn(() => ({ check: () => null })),
}))
vi.mock('../../context/tokenUsageAccounting', () => ({
  buildPoleContextUsageSnapshot: vi.fn(() => ({})),
  getTokenCountFromUsage: vi.fn(() => 0),
  POLE_CONTEXT_USAGE_MESSAGE_KEY: '_poleContextUsage',
}))
vi.mock('../../context/promptDiagnostics', () => ({
  failPromptDiagnostics: vi.fn(),
  finishPromptDiagnostics: vi.fn(),
  markPromptDiagnosticsFirstResponse: vi.fn(),
  startPromptDiagnostics: vi.fn(() => 'diag-1'),
}))
vi.mock('../../context/openClaudeParityConstants', () => ({
  getModelMaxOutputTokensBounds: vi.fn(() => ({ upperLimit: 64_000 })),
  MAX_OUTPUT_TOKENS_RECOVERY_ATTEMPTS: 3,
}))
vi.mock('../maxOutputTruncationRecovery', () => ({
  MAX_OUTPUT_TRUNCATION_USER_MESSAGE: 'Please continue from where you left off.',
}))
vi.mock('../queryProfiler', () => ({
  QUERY_PROFILER_LABELS: {
    streamRetry: 'streamRetry',
    reactiveCompact: 'reactiveCompact',
  },
}))
vi.mock('../queryTermination', () => ({
  createTerminalResult: vi.fn(
    (reason: string, extra: Record<string, unknown>) => ({ reason, ...extra }),
  ),
  runTerminationCleanup: vi.fn(async () => {}),
}))
vi.mock('../../agents/sendMessageToolSchema', () => ({
  patchToolDefinitionsForSendMessageRecipients: vi.fn((defs: unknown) => defs),
}))
vi.mock('../strictToolCallingSupport', () => ({
  providerAllowsOpenAiNativeStrictTools: vi.fn(() => false),
}))
vi.mock('./streamAccumulatorReset', () => ({
  resetStreamAccumulators: vi.fn(),
}))

import { runStreamPhase } from './stream'
import { MODEL_CALL_BUDGET_ENV_VAR } from './stream/modelCallBudget'

// ─── State factory ────────────────────────────────────────────────────

type CallModelStub = ReturnType<typeof vi.fn>

function makeState(callModel: CallModelStub): Record<string, unknown> {
  return {
    iterationModel: 'test-model',
    streamMaxOutTokens: 8_000,
    maxOutputRecoveryCycles: 0,
    iterationToolDefs: [],
    config: { id: 'anthropic' },
    signal: new AbortController().signal,
    appendixReport: vi.fn(),
    apiMessages: [{ role: 'user', content: 'hi' }],
    callbacks: {
      onTextDelta: vi.fn(),
      onError: vi.fn(),
      onMessageEnd: vi.fn(),
      onToolStart: vi.fn(),
      onToolResult: vi.fn(),
    },
    diffPermissionMode: 'default',
    permissionDefaultMode: 'allow',
    permissionRules: undefined,
    discoveryExclude: new Set<string>(),
    activeInlineSkillSession: undefined,
    appendAppendixAFlow: undefined,
    toolCallHistory: undefined,
    queryDeps: { now: () => 0, callModel },
    // P3 audit fix (2026-07) — stream.ts reads the adaptive-thinking base
    // from the frozen QueryConfig snapshot; production always has one via
    // initialiseLoopState.
    queryConfig: {},
    profiler: { startCheckpoint: vi.fn(() => vi.fn()) },
    loopContextManager: {
      recordUsageAfterRequest: vi.fn(),
      clearUsageSnapshot: vi.fn(),
    },
    withheldStreamError: null,
    withheldStreamSignal: null,
    totalUsage: { inputTokens: 0, outputTokens: 0 },
    transition: undefined,
    transitionHistory: [],
    syncConversation: vi.fn(),
    iteration: 1,
    iterationEffort: undefined,
    alwaysThinking: false,
    systemPromptLayers: undefined,
    toolTokensForContext: 0,
    collapseConversationKey: undefined,
    terminationResult: undefined,
  }
}

type StreamCallbacks = {
  onTextDelta: (t: string) => void
  onMessageEnd: (usage: {
    stopReason: string
    inputTokens: number
    outputTokens: number
  }) => void
}

/** A callModel stub that ALWAYS truncates at max_tokens with some text. */
function makeAlwaysMaxTokensCallModel(): CallModelStub {
  return vi.fn(
    async (_config: unknown, _params: unknown, cbs: StreamCallbacks) => {
      cbs.onTextDelta('partial output')
      cbs.onMessageEnd({
        stopReason: 'max_tokens',
        inputTokens: 10,
        outputTokens: 10,
      })
    },
  )
}

/** A callModel stub that truncates at max_tokens with NO output at all. */
function makeEmptyMaxTokensCallModel(): CallModelStub {
  return vi.fn(
    async (_config: unknown, _params: unknown, cbs: StreamCallbacks) => {
      // No onTextDelta, no thinking, no tool_use — pure empty truncation.
      cbs.onMessageEnd({
        stopReason: 'max_tokens',
        inputTokens: 10,
        outputTokens: 0,
      })
    },
  )
}

// ─── Tests ────────────────────────────────────────────────────────────

describe('runStreamPhase — SA-6 per-iteration model-call budget', () => {
  const envBackup = process.env[MODEL_CALL_BUDGET_ENV_VAR]

  beforeEach(() => {
    delete process.env[MODEL_CALL_BUDGET_ENV_VAR]
  })
  afterEach(() => {
    if (envBackup === undefined) delete process.env[MODEL_CALL_BUDGET_ENV_VAR]
    else process.env[MODEL_CALL_BUDGET_ENV_VAR] = envBackup
  })

  it('never exceeds the budget and terminates as model_error with the attempt breakdown', async () => {
    process.env[MODEL_CALL_BUDGET_ENV_VAR] = '2'
    const callModel = makeAlwaysMaxTokensCallModel()
    const state = makeState(callModel)

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let output: { useStreamingToolExecutor: boolean }
    try {
      output = (await runStreamPhase({
        state: state as never,
        systemPrompt: 'sys',
      })) as { useStreamingToolExecutor: boolean }
    } finally {
      warn.mockRestore()
    }

    // Total model calls capped at the budget despite the endless
    // max-output recovery pressure.
    expect(callModel).toHaveBeenCalledTimes(2)

    // Terminated through the "recovery exhausted" path.
    const termination = state.terminationResult as {
      reason: string
      errorDetail: string
    }
    expect(termination).toBeDefined()
    expect(termination.reason).toBe('model_error')
    expect(termination.errorDetail).toMatch(/retry budget exhausted/i)
    // Attempt distribution across recovery entries, for operators.
    expect(termination.errorDetail).toContain('initial=1')
    expect(termination.errorDetail).toContain('max_output_recovery=1')
    expect(termination.errorDetail).toContain(MODEL_CALL_BUDGET_ENV_VAR)

    // The terminal path mirrors maxOutputExhausted: onError + onMessageEnd
    // fired, streaming executor disabled on the way out.
    const callbacks = (state as { callbacks: { onError: CallModelStub } }).callbacks
    expect(callbacks.onError).toHaveBeenCalledWith(termination.errorDetail)
    expect(output.useStreamingToolExecutor).toBe(false)

    const cleanup = (await import('../queryTermination')).runTerminationCleanup
    expect(cleanup).toHaveBeenCalled()
  })

  it('audit F-7: empty max_tokens truncation terminates as model_error, not silent completed', async () => {
    // No env budget override — default budget is generous; the point is that
    // the recovery loop NEVER runs (nothing to continue from), so the only
    // thing that can stop a silent `completed` is the empty-truncation guard.
    const callModel = makeEmptyMaxTokensCallModel()
    const state = makeState(callModel)

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let output: { useStreamingToolExecutor: boolean }
    try {
      output = (await runStreamPhase({
        state: state as never,
        systemPrompt: 'sys',
      })) as { useStreamingToolExecutor: boolean }
    } finally {
      warn.mockRestore()
    }

    // Initial call only — recovery loop never enters (no recoverable output).
    expect(callModel).toHaveBeenCalledTimes(1)

    const termination = state.terminationResult as {
      reason: string
      errorDetail: string
    }
    expect(termination).toBeDefined()
    expect(termination.reason).toBe('model_error')
    expect(termination.errorDetail).toMatch(/empty truncation/i)

    const callbacks = (state as { callbacks: { onError: CallModelStub } }).callbacks
    expect(callbacks.onError).toHaveBeenCalledWith(termination.errorDetail)
    expect(output.useStreamingToolExecutor).toBe(false)
  })

  it('does not interfere with a single successful pass (default budget)', async () => {
    const callModel = vi.fn(
      async (_config: unknown, _params: unknown, cbs: StreamCallbacks) => {
        cbs.onTextDelta('done')
        cbs.onMessageEnd({
          stopReason: 'end_turn',
          inputTokens: 5,
          outputTokens: 5,
        })
      },
    )
    const state = makeState(callModel)

    const output = (await runStreamPhase({
      state: state as never,
      systemPrompt: 'sys',
    })) as { accumulatedText: string }

    expect(callModel).toHaveBeenCalledTimes(1)
    expect(output.accumulatedText).toBe('done')
    expect(state.terminationResult).toBeUndefined()
  })

  it('caps an overload ping-pong + max-output combination at the budget', async () => {
    // Overload rounds: the provider keeps proposing a DIFFERENT fallback
    // model (ping-pong), so decideOverloadRetry keeps switching until its
    // own cap — each round is one model call that the budget must count.
    process.env[MODEL_CALL_BUDGET_ENV_VAR] = '3'
    process.env.POLE_ANTHROPIC_OVERLOAD_FALLBACK_MODEL = 'fallback-model'
    try {
      const callModel = vi.fn(
        async (
          _config: unknown,
          params: {
            model: string
            anthropicOverloadFallbackModelRef?: { value: string | null }
          },
          cbs: StreamCallbacks,
        ) => {
          // Always report overload → propose the "other" model.
          if (params.anthropicOverloadFallbackModelRef) {
            params.anthropicOverloadFallbackModelRef.value =
              params.model === 'test-model' ? 'fallback-model' : 'test-model'
          }
          cbs.onMessageEnd({
            stopReason: 'max_tokens',
            inputTokens: 1,
            outputTokens: 1,
          })
          cbs.onTextDelta('x')
        },
      )
      const state = makeState(callModel)

      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        await runStreamPhase({ state: state as never, systemPrompt: 'sys' })
      } finally {
        warn.mockRestore()
      }

      expect(callModel.mock.calls.length).toBeLessThanOrEqual(3)
      const termination = state.terminationResult as
        | { reason: string }
        | undefined
      // Whichever layer hit its own cap first, the budget held — and if
      // it was the budget that fired, the termination is a model_error.
      if (termination) {
        expect(termination.reason).toBe('model_error')
      }
    } finally {
      delete process.env.POLE_ANTHROPIC_OVERLOAD_FALLBACK_MODEL
    }
  })
})
