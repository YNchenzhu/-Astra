/**
 * Contract tests for `executeToolBatch` — the tool-execution phase of the agentic loop.
 *
 * Surface under test (six observable contracts):
 *   1. Dedup — duplicate tool_use ids in `state.toolUseBlocks` are collapsed before execution.
 *   2. Branch selection — the three execution paths (streaming / orchestrated / legacy) are
 *      chosen based on `streamingToolExecutor` + `orchestratedToolExecution` presence.
 *   3. Streaming abort plumbing — `markInterrupted` + `getAbortedResults` fill in missing
 *      results when the user aborts mid-batch.
 *   4. Missing-results backfill — `yieldMissingToolResultBlocks` paired tool_result for any
 *      tool_use whose executor didn't produce a result.
 *   5. HITL pause — `takePendingHITL` non-empty fires the `interrupt` phase event AND the
 *      auxiliary `ask_user_question` stream event AND calls `kernel.interrupt('hitl')`.
 *   6. Post-execution abort — when `signal.aborted` after the batch, the phase pushes a
 *      minimal tool_result user message and skips skill-discovery + tool-use summary.
 *
 * Mocked surfaces are kept to the minimum necessary to control inputs/outputs of
 * `executeToolBatch` itself. All other behaviour (deterministic ledger formatting, skill
 * discovery scoring, etc.) is covered by the dedicated tests of those modules.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ─── Mock graph (all hoisted) ─────────────────────────────────────────

const runAgenticToolUseBatchMock = vi.fn<
  (params: { toolUseBlocks: Array<{ id: string; name: string }> }) => Promise<
    Array<Record<string, unknown>>
  >
>()

const takePendingHITLMock = vi.fn<
  (conversationId: string | undefined) => unknown
>()

const getOrchestrationKernelMock = vi.fn<
  (conversationId: string) => { interrupt: (reason: unknown) => void } | undefined
>()

const buildSkillDiscoveryInjectionMock = vi.fn<
  () => { injection: string; surfacedNames: string[] }
>()

interface LedgerFormatOptions {
  readReceiptHints?: ReadonlyArray<{ filePath: string; readId: string }>
}

const formatLedgerMock = vi.fn<(options: LedgerFormatOptions) => string>()
const startSummaryMock = vi.fn<() => Promise<unknown> | null>()
const yieldMissingBlocksMock = vi.fn<
  (
    toolUses: Array<{ id: string; name: string }>,
    completedIds: Set<string>,
  ) => Array<Record<string, unknown>>
>()

const emitPhaseEventMock = vi.fn<(transport: unknown, payload: unknown) => void>()

// The HITL `ask_user_question` UX bridge is intentionally routed through
// `interactionState.emitStreamEventForConversation` (main-process-wide
// sender), NOT `state.callbacks.onStreamEvent` — tool-batch callbacks do
// not expose `onStreamEvent` (see the comment in `toolExec.ts`'s HITL
// block). The assertion therefore observes THIS mock, not the callback.
const emitStreamEventForConversationMock =
  vi.fn<(conversationId: string, ev: Record<string, unknown>) => void>()

vi.mock('../agenticToolBatch', () => ({
  runAgenticToolUseBatch: (params: { toolUseBlocks: Array<{ id: string; name: string }> }) =>
    runAgenticToolUseBatchMock(params),
}))

vi.mock('../../orchestration/hitl', () => ({
  takePendingHITL: (id: string | undefined) => takePendingHITLMock(id),
}))

vi.mock('../../orchestration/activeKernelRegistry', () => ({
  getOrchestrationKernelForConversation: (id: string) => getOrchestrationKernelMock(id),
}))

vi.mock('../../orchestration/transport', () => ({
  createTransportAdapter: () => ({ kind: 'mock-transport' }),
  emitPhaseEvent: (t: unknown, p: unknown) => emitPhaseEventMock(t, p),
  // Audit P2 §6.3 wire-up — per-variant phase-event builders. Tests
  // observe the produced payload via `emitPhaseEventMock`, so the
  // builders just return a structurally faithful object.
  buildInterruptPhase: (
    args: { iteration: number; innerIteration?: number; conversationId?: string; interruptReason: string; hitlPending?: unknown }
  ) => ({ phase: 'interrupt', ...args }),
  buildPermissionDeniedPhase: (
    args: { iteration: number; innerIteration?: number; conversationId?: string; permissionDenial: unknown }
  ) => ({ phase: 'permission_denied_preflight', ...args }),
  // Audit R1 (2026-07) — fallback-path scheduler/quota backpressure emit.
  buildSchedulerBackpressurePhase: (
    args: { iteration: number; innerIteration?: number; conversationId?: string; schedulerBackpressure: unknown }
  ) => ({ phase: 'scheduler_backpressure', ...args }),
  // `emitInnerPhase` (innerPhaseEmit.ts), reached via `executeToolBatch`'s
  // `RunToolBatch` / `ApplyToolResults` inner-phase emits, imports this
  // builder from the same transport module. The whole-module mock must
  // expose it or every test that runs the batch throws "No
  // buildKernelFsmPhase export". Structurally-faithful stub, same as the
  // other builders above.
  buildKernelFsmPhase: (
    args: { phase: string; iteration: number; innerIteration?: number; conversationId?: string }
  ) => ({ ...args }),
}))

vi.mock('../interactionState', () => ({
  emitStreamEventForConversation: (id: string, ev: Record<string, unknown>) =>
    emitStreamEventForConversationMock(id, ev),
}))

vi.mock('../../skills/skillDiscovery', () => ({
  buildDiscoveryQuery: () => 'discovery-query',
  buildSkillDiscoveryInjection: () => buildSkillDiscoveryInjectionMock(),
}))

vi.mock('../toolUseSummary', () => ({
  formatDeterministicToolLedgerForInjection: (options: LedgerFormatOptions) =>
    formatLedgerMock(options),
  startToolUseSummaryInBackground: () => startSummaryMock(),
}))

vi.mock('../queryTermination', () => ({
  yieldMissingToolResultBlocks: (
    toolUses: Array<{ id: string; name: string }>,
    completedIds: Set<string>,
  ) => yieldMissingBlocksMock(toolUses, completedIds),
}))

vi.mock('../../context/tokenUsageAccounting', () => ({
  POLE_CONTEXT_USAGE_MESSAGE_KEY: '__poleUsage',
  getTokenCountFromUsage: (u: Record<string, unknown>) =>
    Number((u as { input_tokens?: number }).input_tokens ?? 0) +
    Number((u as { output_tokens?: number }).output_tokens ?? 0),
}))

// Configurable so the fallback-wiring tests can simulate a sub-agent with a
// declared priority (SA-1 P0 assertions). Default (set in the global
// beforeEach) stays the legacy `main` context.
const getAgentContextMock = vi.fn<() => Record<string, unknown> | undefined>()

vi.mock('../../agents/agentContext', () => ({
  getAgentContext: () => getAgentContextMock(),
}))

vi.mock('../agenticLoopBuilders', () => ({
  buildToolUseAssistantContent: (opts: {
    accumulatedText: string
    toolUseBlocks: Array<{ id: string; name: string; input: Record<string, unknown> }>
  }) => {
    const blocks: Array<Record<string, unknown>> = []
    if (opts.accumulatedText?.trim()) {
      blocks.push({ type: 'text', text: opts.accumulatedText })
    }
    for (const tu of opts.toolUseBlocks) {
      blocks.push({ type: 'tool_use', id: tu.id, name: tu.name, input: tu.input })
    }
    return blocks
  },
}))

// Import the SUT after all mocks are registered.
import { executeToolBatch } from './toolExec'
import type { LoopState } from './loopShared'

// Real (non-mocked) imports for the fallback-wiring assertions further below —
// the wire-in calls these directly and tests need to observe their state.
import {
  getToolScheduler,
  resetToolSchedulerForTests,
  ToolPriority,
} from '../../orchestration/toolRuntime/scheduler'
import {
  clearToolRuntimeStateForTests,
  getToolEntry,
  markToolCompleted,
  markToolRunning,
  registerToolInvocation,
} from '../../orchestration/toolRuntime/state'
import {
  getResourceQuotaManager,
  resetResourceQuotaManagerForTests,
} from '../../orchestration/toolRuntime/quota'
import {
  getPolicyEngine,
  resetPolicyEngineForTests,
} from '../../orchestration/toolRuntime/policy'
import {
  clearAllVerificationGateState,
  getVerificationGateState,
} from '../../planning/verificationGateState'
import {
  clearAllReadFileState,
  recordSuccessfulRead,
} from '../../tools/readFileState'

// ─── State factory ────────────────────────────────────────────────────

interface MakeStateOpts {
  toolUseBlocks?: Array<{
    id: string
    name: string
    input: Record<string, unknown>
    caller?: { type: 'direct' } | { type: 'code_execution_20260120'; tool_id: string }
  }>
  signal?: AbortSignal
  orchestratedToolExecution?: unknown
  lastStreamUsageForPole?: Record<string, unknown> | null
  apiMessages?: Array<Record<string, unknown>>
  thinkingBlocks?: Array<{ thinking: string; signature?: string }>
}

function makeMinimalState(opts: MakeStateOpts = {}): LoopState {
  const apiMessages: Array<Record<string, unknown>> = opts.apiMessages ?? [
    { role: 'user', content: 'hello' },
  ]
  const state = {
    apiMessages,
    iteration: 2,
    iterationModel: 'claude-test',
    toolUseBlocks: opts.toolUseBlocks ?? [
      { id: 'tu_1', name: 'read_file', input: { path: '/a' } },
    ],
    thinkingBlocks: opts.thinkingBlocks ?? [],
    serverToolUseBlocks: [],
    codeExecutionResultBlocks: [],
    accumulatedText: '',
    lastStreamUsageForPole: opts.lastStreamUsageForPole ?? null,
    signal: opts.signal ?? new AbortController().signal,
    config: { id: 'anthropic' },
    activeInlineSkillSession: null,
    discoveryExclude: new Set<string>(),
    callbacks: {
      onToolStart: vi.fn(),
      onToolResult: vi.fn(),
      onTextDelta: vi.fn(),
      onMessageEnd: vi.fn(),
      onError: vi.fn(),
    },
    syncConversation: vi.fn(),
    appendixReport: vi.fn(),
    appendAppendixAFlow: undefined,
    toolCallHistory: undefined,
    diffPermissionMode: 'default' as const,
    permissionDefaultMode: 'ask' as const,
    permissionRules: [],
    orchestratedToolExecution: opts.orchestratedToolExecution as
      | LoopState['orchestratedToolExecution']
      | undefined,
  }
  return state as unknown as LoopState
}

// Common defaults so each test only configures what it cares about.
beforeEach(() => {
  vi.clearAllMocks()
  clearAllVerificationGateState()
  clearAllReadFileState()
  runAgenticToolUseBatchMock.mockImplementation(async ({ toolUseBlocks }) =>
    toolUseBlocks.map((tu) => ({
      type: 'tool_result',
      tool_use_id: tu.id,
      content: `result for ${tu.name}`,
    })),
  )
  takePendingHITLMock.mockReturnValue(undefined)
  getOrchestrationKernelMock.mockReturnValue(undefined)
  getAgentContextMock.mockReturnValue({
    agentId: 'main',
    streamConversationId: 'conv-test',
  })
  buildSkillDiscoveryInjectionMock.mockReturnValue({ injection: '', surfacedNames: [] })
  formatLedgerMock.mockReturnValue('')
  startSummaryMock.mockReturnValue(Promise.resolve(null))
  yieldMissingBlocksMock.mockReturnValue([])
})

// ─── 1. Dedup ─────────────────────────────────────────────────────────

describe('executeToolBatch — dedup', () => {
  it('drops duplicate tool_use ids before forwarding to the executor', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const state = makeMinimalState({
      toolUseBlocks: [
        { id: 'tu_dup', name: 'read_file', input: { path: '/a' } },
        { id: 'tu_dup', name: 'read_file', input: { path: '/a' } },
        { id: 'tu_unique', name: 'glob', input: { pattern: '*.ts' } },
      ],
    })

    await executeToolBatch(state, {
      accumulatedText: '',
      streamingToolExecutor: null,
      useStreamingToolExecutor: false,
    })

    const callArg = runAgenticToolUseBatchMock.mock.calls[0]?.[0]
    expect(callArg?.toolUseBlocks).toHaveLength(2)
    expect(callArg?.toolUseBlocks.map((tu) => tu.id)).toEqual(['tu_dup', 'tu_unique'])
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Dropping duplicate tool_use id: tu_dup'),
    )
    warnSpy.mockRestore()
  })
})

// ─── 2. Branch selection ──────────────────────────────────────────────

describe('executeToolBatch — branch selection', () => {
  it('routes to runAgenticToolUseBatch when neither streaming nor orchestrated is set', async () => {
    const state = makeMinimalState()

    await executeToolBatch(state, {
      accumulatedText: '',
      streamingToolExecutor: null,
      useStreamingToolExecutor: false,
    })

    expect(runAgenticToolUseBatchMock).toHaveBeenCalledTimes(1)
  })

  it('routes to orchestratedToolExecution.port when it is set', async () => {
    const portExecuteMock = vi.fn(async () => ({
      toolResultBlocks: [
        { type: 'tool_result', tool_use_id: 'tu_1', content: 'orchestrated result' },
      ],
      hadFailure: false,
    }))
    const state = makeMinimalState({
      orchestratedToolExecution: {
        port: { executeToolBatch: portExecuteMock },
        getKernelState: () => ({}),
        noteToolInvocation: vi.fn(),
      },
    })

    await executeToolBatch(state, {
      accumulatedText: '',
      streamingToolExecutor: null,
      useStreamingToolExecutor: false,
    })

    expect(portExecuteMock).toHaveBeenCalledTimes(1)
    expect(runAgenticToolUseBatchMock).not.toHaveBeenCalled()
  })

  it('routes to streamingToolExecutor.getRemainingResults when useStreamingToolExecutor=true', async () => {
    const remainingResults = async function* () {
      yield {
        type: 'tool_result' as const,
        data: { type: 'tool_result', tool_use_id: 'tu_1', content: 'streamed' },
      }
    }
    const streamingExec = {
      isEmpty: vi.fn(() => false),
      getRemainingResults: vi.fn(() => remainingResults()),
      markInterrupted: vi.fn(),
      getAbortedResults: vi.fn(() => []),
    }
    const state = makeMinimalState()

    await executeToolBatch(state, {
      accumulatedText: '',
      streamingToolExecutor: streamingExec,
      useStreamingToolExecutor: true,
    })

    expect(streamingExec.getRemainingResults).toHaveBeenCalledTimes(1)
    expect(runAgenticToolUseBatchMock).not.toHaveBeenCalled()
  })

  it('arms the code verification gate from a real successful mutation batch', async () => {
    const state = makeMinimalState({
      toolUseBlocks: [
        { id: 'tu_mutation', name: 'edit_file', input: { path: '/a.ts' } },
      ],
    })

    await executeToolBatch(state, {
      accumulatedText: '',
      streamingToolExecutor: null,
      useStreamingToolExecutor: false,
    })

    expect(getVerificationGateState('conv-test')).toMatchObject({
      needsVerification: true,
      mutationCount: 1,
    })
  })
})

// ─── 3. Streaming abort plumbing ──────────────────────────────────────

describe('executeToolBatch — streaming abort plumbing', () => {
  it('calls markInterrupted and merges getAbortedResults when signal aborts mid-batch', async () => {
    const ac = new AbortController()
    ac.abort()
    const streamingExec = {
      isEmpty: vi.fn(() => false),
      getRemainingResults: vi.fn(async function* () {
        // intentionally yield nothing — aborted before any result
      }),
      markInterrupted: vi.fn(),
      getAbortedResults: vi.fn(() => [
        { type: 'tool_result', tool_use_id: 'tu_1', content: 'aborted', is_error: true },
      ]),
    }
    const state = makeMinimalState({ signal: ac.signal })

    await executeToolBatch(state, {
      accumulatedText: '',
      streamingToolExecutor: streamingExec,
      useStreamingToolExecutor: true,
    })

    expect(streamingExec.markInterrupted).toHaveBeenCalledTimes(1)
    expect(streamingExec.getAbortedResults).toHaveBeenCalledTimes(1)
  })
})

// ─── 4. Missing-results backfill ──────────────────────────────────────

describe('executeToolBatch — missing-results backfill', () => {
  it('calls yieldMissingToolResultBlocks when streaming results count < tool_use count', async () => {
    const streamingExec = {
      isEmpty: vi.fn(() => false),
      getRemainingResults: vi.fn(async function* () {
        yield {
          type: 'tool_result' as const,
          data: { type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' },
        }
        // tu_2 missing on purpose
      }),
      markInterrupted: vi.fn(),
      getAbortedResults: vi.fn(() => []),
    }
    yieldMissingBlocksMock.mockReturnValue([
      { type: 'tool_result', tool_use_id: 'tu_2', content: 'synthesized', is_error: true },
    ])
    const state = makeMinimalState({
      toolUseBlocks: [
        { id: 'tu_1', name: 'read_file', input: {} },
        { id: 'tu_2', name: 'glob', input: {} },
      ],
    })

    await executeToolBatch(state, {
      accumulatedText: '',
      streamingToolExecutor: streamingExec,
      useStreamingToolExecutor: true,
    })

    expect(yieldMissingBlocksMock).toHaveBeenCalledTimes(1)
    const completedIds = yieldMissingBlocksMock.mock.calls[0][1]
    expect(completedIds.has('tu_1')).toBe(true)
    expect(completedIds.has('tu_2')).toBe(false)
  })
})

// ─── 5. HITL pause ────────────────────────────────────────────────────

describe('executeToolBatch — HITL pause', () => {
  it('emits phase event and calls kernel.interrupt when takePendingHITL returns non-empty', async () => {
    const interruptMock = vi.fn()
    getOrchestrationKernelMock.mockReturnValue({ interrupt: interruptMock })
    takePendingHITLMock.mockReturnValue({
      toolUseId: 'tu_1',
      question: { questions: [{ id: 'q1', prompt: '?' }] },
      kind: 'ask_user_question',
      recordedAt: Date.now(),
    })
    const state = makeMinimalState()

    await executeToolBatch(state, {
      accumulatedText: '',
      streamingToolExecutor: null,
      useStreamingToolExecutor: false,
    })

    expect(emitPhaseEventMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        phase: 'interrupt',
        interruptReason: 'hitl',
        hitlPending: expect.objectContaining({ toolUseId: 'tu_1', kind: 'ask_user_question' }),
      }),
    )
    expect(interruptMock).toHaveBeenCalledWith('hitl')
  })

  it('also fires ask_user_question stream event when HITL kind is ask_user_question', async () => {
    takePendingHITLMock.mockReturnValue({
      toolUseId: 'tu_1',
      question: { questions: [{ id: 'q1', prompt: '?' }] },
      kind: 'ask_user_question',
      recordedAt: Date.now(),
    })
    const state = makeMinimalState()

    await executeToolBatch(state, {
      accumulatedText: '',
      streamingToolExecutor: null,
      useStreamingToolExecutor: false,
    })

    // Routed through the main-process-wide sender (conversationId from the
    // mocked AgentContext is 'conv-test'), NOT state.callbacks.onStreamEvent.
    expect(emitStreamEventForConversationMock).toHaveBeenCalledWith(
      'conv-test',
      expect.objectContaining({
        type: 'ask_user_question',
        requestId: 'tu_1',
      }),
    )
  })

  it('does NOT fire ask_user_question stream event when HITL kind is permission_ask', async () => {
    takePendingHITLMock.mockReturnValue({
      toolUseId: 'tu_1',
      question: { reason: 'needs permission' },
      kind: 'permission_ask',
      recordedAt: Date.now(),
    })
    const state = makeMinimalState()

    await executeToolBatch(state, {
      accumulatedText: '',
      streamingToolExecutor: null,
      useStreamingToolExecutor: false,
    })

    // permission_ask has its own renderer UI — the ask_user_question bridge
    // event must NOT be emitted for it.
    expect(emitStreamEventForConversationMock).not.toHaveBeenCalledWith(
      'conv-test',
      expect.objectContaining({ type: 'ask_user_question' }),
    )
  })
})

// ─── 6. Post-execution abort guard ────────────────────────────────────

describe('executeToolBatch — post-execution abort', () => {
  it('pushes minimal tool_result user message and skips skill discovery + summary when aborted after batch', async () => {
    const ac = new AbortController()
    // Simulate "user aborts WHILE tools are executing": the batch returns with
    // results, but by then signal.aborted is true. executeToolBatch should take
    // its post-execution abort branch (skip skill discovery + summary).
    runAgenticToolUseBatchMock.mockImplementation(async ({ toolUseBlocks }) => {
      ac.abort()
      return toolUseBlocks.map((tu) => ({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: 'ok',
      }))
    })
    const state = makeMinimalState({ signal: ac.signal })

    // Sentinel: skill discovery must NOT be invoked on the aborted path.
    buildSkillDiscoveryInjectionMock.mockImplementation(() => {
      throw new Error('skill discovery must NOT run after post-execution abort')
    })

    const result = await executeToolBatch(state, {
      accumulatedText: '',
      streamingToolExecutor: null,
      useStreamingToolExecutor: false,
    })

    expect(result.pendingToolUseSummary).toBeNull()
    expect(state.discoveryExclude.size).toBe(0)
    expect(startSummaryMock).not.toHaveBeenCalled()
    expect(buildSkillDiscoveryInjectionMock).not.toHaveBeenCalled()
    // The aborted branch still pushes a user message with the tool_results so
    // the transcript stays Anthropic-API-valid for resume.
    const lastMsg = state.apiMessages[state.apiMessages.length - 1]
    expect(lastMsg.role).toBe('user')
    expect(Array.isArray(lastMsg.content)).toBe(true)
  })
})

// ─── 7. Skill discovery follow-up ─────────────────────────────────────

describe('executeToolBatch — skill discovery follow-up', () => {
  it('appends followUpDiscovery text into the same user message and extends discoveryExclude', async () => {
    buildSkillDiscoveryInjectionMock.mockReturnValue({
      injection: 'Consider using `Glob` for file discovery.',
      surfacedNames: ['glob', 'grep'],
    })
    const state = makeMinimalState()

    await executeToolBatch(state, {
      accumulatedText: '',
      streamingToolExecutor: null,
      useStreamingToolExecutor: false,
    })

    // Last appended user message must contain the followUp text
    const lastUserMsg = state.apiMessages[state.apiMessages.length - 1]
    expect(lastUserMsg.role).toBe('user')
    expect(Array.isArray(lastUserMsg.content)).toBe(true)
    const contentBlocks = lastUserMsg.content as Array<Record<string, unknown>>
    const hasFollowUp = contentBlocks.some(
      (b) => b.type === 'text' && typeof b.text === 'string' && b.text.includes('Consider using'),
    )
    expect(hasFollowUp).toBe(true)
    expect(state.discoveryExclude.has('glob')).toBe(true)
    expect(state.discoveryExclude.has('grep')).toBe(true)
  })

  it('PTC shape guard: when batch contains code_execution_20260120 tool_use, followUp goes to a SEPARATE user message', async () => {
    buildSkillDiscoveryInjectionMock.mockReturnValue({
      injection: 'separated followup',
      surfacedNames: [],
    })
    const state = makeMinimalState({
      toolUseBlocks: [
        {
          id: 'tu_ptc',
          name: 'some_ptc_tool',
          input: {},
          caller: { type: 'code_execution_20260120', tool_id: 'srvr_1' },
        },
      ],
    })
    const lengthBefore = state.apiMessages.length

    await executeToolBatch(state, {
      accumulatedText: '',
      streamingToolExecutor: null,
      useStreamingToolExecutor: false,
    })

    // After execution we should have: [pre-existing..., assistant, user(tool_result), user(followUp)]
    // i.e. 3 messages appended (lengthBefore + 3)
    expect(state.apiMessages.length).toBe(lengthBefore + 3)
    const last = state.apiMessages[state.apiMessages.length - 1]
    expect(last.role).toBe('user')
    expect(Array.isArray(last.content)).toBe(true)
    const blocks = last.content as Array<Record<string, unknown>>
    expect(blocks).toEqual([{ type: 'text', text: 'separated followup' }])
  })
})

// ─── 8. Deterministic ledger ──────────────────────────────────────────

describe('executeToolBatch — deterministic ledger injection', () => {
  it('appends ledger text to user content when formatDeterministicToolLedgerForInjection returns non-empty', async () => {
    formatLedgerMock.mockReturnValue('LEDGER: 1 read_file ok')
    const state = makeMinimalState()

    await executeToolBatch(state, {
      accumulatedText: '',
      streamingToolExecutor: null,
      useStreamingToolExecutor: false,
    })

    const lastUserMsg = state.apiMessages[state.apiMessages.length - 1]
    const blocks = lastUserMsg.content as Array<Record<string, unknown>>
    const hasLedger = blocks.some(
      (b) => b.type === 'text' && typeof b.text === 'string' && b.text.includes('LEDGER:'),
    )
    expect(hasLedger).toBe(true)
  })

  it('passes the current path-bound readId map to the deterministic ledger', async () => {
    const receiptA = recordSuccessfulRead('C:/repo/src/a.ts', {
      mtimeMs: 1,
      isPartialView: false,
      fullFileContent: 'A',
    })
    const receiptB = recordSuccessfulRead('C:/repo/src/b.ts', {
      mtimeMs: 2,
      isPartialView: false,
      fullFileContent: 'B',
    })
    const state = makeMinimalState({
      toolUseBlocks: [
        { id: 'tu_read', name: 'read_file', input: { filePath: 'C:/repo/src/b.ts' } },
      ],
    })

    await executeToolBatch(state, {
      accumulatedText: '',
      streamingToolExecutor: null,
      useStreamingToolExecutor: false,
    })

    const options = formatLedgerMock.mock.calls.at(-1)?.[0]
    expect(options?.readReceiptHints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ filePath: 'C:/repo/src/a.ts', readId: receiptA.readId }),
        expect.objectContaining({ filePath: 'C:/repo/src/b.ts', readId: receiptB.readId }),
      ]),
    )
  })
})

// ─── 9. Tool-use summary ──────────────────────────────────────────────

describe('executeToolBatch — tool-use summary background launch', () => {
  // 2026-06 long-run hallucination fix: the haiku summary is OPT-IN.
  // Default (env unset) must NOT start the background call — the
  // injected past-tense recap was a long-run completion-claim priming
  // source. See toolExec.ts for the full rationale.
  it('returns a pendingToolUseSummary only when POLE_TOOL_USE_SUMMARY === "1"', async () => {
    const prev = process.env.POLE_TOOL_USE_SUMMARY
    process.env.POLE_TOOL_USE_SUMMARY = '1'
    const promise = Promise.resolve({
      summary: 's',
      generatedAt: Date.now(),
      toolNames: ['read_file'],
    })
    startSummaryMock.mockReturnValue(promise)
    const state = makeMinimalState()

    const result = await executeToolBatch(state, {
      accumulatedText: '',
      streamingToolExecutor: null,
      useStreamingToolExecutor: false,
    })

    expect(result.pendingToolUseSummary).toBe(promise)
    expect(startSummaryMock).toHaveBeenCalledTimes(1)

    if (prev === undefined) delete process.env.POLE_TOOL_USE_SUMMARY
    else process.env.POLE_TOOL_USE_SUMMARY = prev
  })

  it('returns null pendingToolUseSummary by default (env unset — opt-in semantics)', async () => {
    const prev = process.env.POLE_TOOL_USE_SUMMARY
    delete process.env.POLE_TOOL_USE_SUMMARY
    const state = makeMinimalState()

    const result = await executeToolBatch(state, {
      accumulatedText: '',
      streamingToolExecutor: null,
      useStreamingToolExecutor: false,
    })

    expect(result.pendingToolUseSummary).toBeNull()
    expect(startSummaryMock).not.toHaveBeenCalled()

    if (prev !== undefined) process.env.POLE_TOOL_USE_SUMMARY = prev
  })

  it('returns null pendingToolUseSummary when POLE_TOOL_USE_SUMMARY === "0"', async () => {
    const prev = process.env.POLE_TOOL_USE_SUMMARY
    process.env.POLE_TOOL_USE_SUMMARY = '0'
    const state = makeMinimalState()

    const result = await executeToolBatch(state, {
      accumulatedText: '',
      streamingToolExecutor: null,
      useStreamingToolExecutor: false,
    })

    expect(result.pendingToolUseSummary).toBeNull()
    expect(startSummaryMock).not.toHaveBeenCalled()

    if (prev === undefined) delete process.env.POLE_TOOL_USE_SUMMARY
    else process.env.POLE_TOOL_USE_SUMMARY = prev
  })
})

// ─── 10. Fallback path wires ToolRuntimeState + scheduler + quota ────

describe('executeToolBatch — fallback-path wiring (no orchestratedToolExecution)', () => {
  beforeEach(() => {
    clearToolRuntimeStateForTests()
    resetToolSchedulerForTests()
    resetResourceQuotaManagerForTests()
    // SA-1 — re-create the PolicyEngine after the quota reset so its bound
    // quota manager is the same fresh instance the fallback path admits with.
    resetPolicyEngineForTests()
  })

  it('registers fallback batch tools in BOTH the scheduler AND ToolRuntimeState', async () => {
    // Default state has no orchestratedToolExecution → fallback path.
    runAgenticToolUseBatchMock.mockImplementation(async ({ callbacks, toolUseBlocks }) => {
      // Inspect the state INSIDE the batch — the wire-in must have already
      // registered the tools before runAgenticToolUseBatch runs.
      for (const tu of toolUseBlocks) {
        const entry = getToolEntry(tu.id)
        expect(entry).toBeDefined()
      }
      // Fire the standard onToolStart/onToolResult lifecycle so the wrapped
      // callbacks transition state from 'queued' → 'running' → 'completed'.
      for (const tu of toolUseBlocks) {
        callbacks.onToolStart(tu)
        callbacks.onToolResult({ id: tu.id, name: tu.name, success: true })
      }
      return toolUseBlocks.map((tu) => ({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: 'ok',
      }))
    })

    const state = makeMinimalState({
      toolUseBlocks: [
        { id: 'tu_fb1', name: 'read_file', input: { path: '/a' } },
      ],
    })

    await executeToolBatch(state, {
      accumulatedText: '',
      streamingToolExecutor: null,
      useStreamingToolExecutor: false,
    })

    // After execution: scheduler still has the node (terminal sweep keeps it
    // until the 120s cleanup), state entry should be completed.
    const dump = getToolScheduler().debugDump()
    expect(dump).toContain('tu_fb1')
    const stateEntry = getToolEntry('tu_fb1')
    expect(stateEntry?.status).toBe('completed')
  })

  it('denies a fallback batch tool that fails quota and produces an is_error tool_result', async () => {
    // Saturate the mutation slot so the next mutation tool is denied.
    // backpressureMaxWaitMs=0 → legacy instant deny (this test asserts the
    // denial shape; the SA-1 wait-and-retry behaviour is covered below).
    getResourceQuotaManager().updateConfig({
      maxGlobalMutationParallel: 0,
      backpressureMaxWaitMs: 0,
    })

    const state = makeMinimalState({
      toolUseBlocks: [
        // 'custom_mutation' isn't in quota.ts's hardcoded readonly whitelist,
        // so it counts as a mutation tool and trips the saturated slot.
        { id: 'tu_fb_denied', name: 'custom_mutation', input: { path: '/x' } },
      ],
    })

    const result = await executeToolBatch(state, {
      accumulatedText: '',
      streamingToolExecutor: null,
      useStreamingToolExecutor: false,
    })

    // The synthesized denial tool_result must be in the result list
    const denied = result.toolResults.find(
      (r) => (r as { tool_use_id?: string }).tool_use_id === 'tu_fb_denied',
    )
    expect(denied).toBeDefined()
    expect(denied).toMatchObject({ is_error: true })
    expect((denied as { content: string }).content).toMatch(/Resource quota exceeded/)

    // State + scheduler both ended up failed
    expect(getToolEntry('tu_fb_denied')?.status).toBe('failed')
    expect(getToolScheduler().debugDump()).toMatch(/tu_fb_denied \[failed\]/)

    // runAgenticToolUseBatch never received this tool (filtered out as denied)
    const lastCall = runAgenticToolUseBatchMock.mock.calls[0]?.[0]
    expect(lastCall?.toolUseBlocks ?? []).toHaveLength(0)
  })

  it('fallback batch contributes to quota — running tool from this batch is visible in snapshot', async () => {
    // Make the inner batch hang so the tool stays in 'running' for the
    // duration of the snapshot read.
    let snapshotDuringRun: ReturnType<ReturnType<typeof getResourceQuotaManager>['snapshot']> | undefined
    runAgenticToolUseBatchMock.mockImplementation(async ({ callbacks, toolUseBlocks }) => {
      for (const tu of toolUseBlocks) {
        callbacks.onToolStart(tu)
      }
      // Capture quota snapshot WHILE the tool is in 'running' state
      snapshotDuringRun = getResourceQuotaManager().snapshot()
      for (const tu of toolUseBlocks) {
        callbacks.onToolResult({ id: tu.id, name: tu.name, success: true })
      }
      return toolUseBlocks.map((tu) => ({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: 'ok',
      }))
    })

    const state = makeMinimalState({
      toolUseBlocks: [
        { id: 'tu_fb_run', name: 'custom_mutation', input: {} },
      ],
    })

    await executeToolBatch(state, {
      accumulatedText: '',
      streamingToolExecutor: null,
      useStreamingToolExecutor: false,
    })

    expect(snapshotDuringRun?.activeMutationTools).toBe(1)
  })

  it('threads a declared BACKGROUND priority into policyEngine.evaluate AND quota.admit (SA-1 P0)', async () => {
    // Sub-agent context with an explicit BACKGROUND priority — pre-fix, the
    // fallback path hardcoded ToolPriority.NORMAL into both calls, so a
    // BACKGROUND sub-agent could never be picked as a preemption victim by
    // a HIGH main-chat newcomer (INVARIANTS.md cross-agent guarantee).
    getAgentContextMock.mockReturnValue({
      agentId: 'sub-bg',
      parentAgentId: 'main',
      streamConversationId: 'conv-test',
      priority: ToolPriority.BACKGROUND,
    })
    const quota = getResourceQuotaManager()
    const admitSpy = vi.spyOn(quota, 'admit')
    const evaluateSpy = vi.spyOn(getPolicyEngine(), 'evaluate')

    const state = makeMinimalState({
      toolUseBlocks: [{ id: 'tu_bg_prio', name: 'read_file', input: { path: '/p' } }],
    })

    await executeToolBatch(state, {
      accumulatedText: '',
      streamingToolExecutor: null,
      useStreamingToolExecutor: false,
    })

    expect(evaluateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        toolUseId: 'tu_bg_prio',
        priority: ToolPriority.BACKGROUND,
      }),
    )
    expect(admitSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        toolUseId: 'tu_bg_prio',
        priority: ToolPriority.BACKGROUND,
      }),
    )
  })

  it('waits for a quota slot and retries instead of instant-denying (SA-1 P1 backpressure parity)', async () => {
    // 1 mutation slot globally; a non-preemptible mutation tool from another
    // agent is already running and holding it. Mirrors the main-path P2-5
    // test in port.test.ts — both paths now share
    // `waitForQuotaSlotWithBackpressure` (backpressure.ts).
    getResourceQuotaManager({
      maxGlobalMutationParallel: 1,
      backpressureMaxWaitMs: 3_000,
      enablePreemption: false,
    })
    registerToolInvocation({
      toolUseId: 'tu_fb_blocker',
      toolName: 'OtherMutation',
      agentId: 'agent-Z',
      input: {},
      isReadOnly: false,
    })
    markToolRunning('tu_fb_blocker')

    // Free the slot 150ms in — the backpressure retry (≥500ms for
    // mutation_concurrency) re-admits on its first attempt.
    setTimeout(() => markToolCompleted('tu_fb_blocker'), 150)

    const state = makeMinimalState({
      toolUseBlocks: [
        { id: 'tu_fb_bp', name: 'custom_mutation', input: { v: 1 } },
      ],
    })

    const started = Date.now()
    const result = await executeToolBatch(state, {
      accumulatedText: '',
      streamingToolExecutor: null,
      useStreamingToolExecutor: false,
    })

    // It really waited (one retry interval), not just sailed through.
    expect(Date.now() - started).toBeGreaterThanOrEqual(400)
    // Pre-fix this was an instant denial: the tool never reached the inner
    // batch and the result carried `is_error: true`.
    expect(runAgenticToolUseBatchMock).toHaveBeenCalledTimes(1)
    const batchArg = runAgenticToolUseBatchMock.mock.calls[0]?.[0]
    expect(batchArg?.toolUseBlocks.map((tu) => tu.id)).toEqual(['tu_fb_bp'])
    const block = result.toolResults.find(
      (r) => (r as { tool_use_id?: string }).tool_use_id === 'tu_fb_bp',
    )
    expect(block).toBeDefined()
    expect((block as { is_error?: boolean }).is_error).toBeUndefined()
  })
})

// ─── 10b. Audit R1 (2026-07) — fallback path emits scheduler_backpressure ──
//
// Parity with `DefaultToolRuntimePort.runQuotaAdmitAndPreemptPhase`: a tool
// stalled by the cross-agent scheduler hold gate or by quota backpressure must
// surface a typed `scheduler_backpressure` phase event to the renderer, not
// just a console.log. Pre-R1 the fallback path dropped both signals.

describe('executeToolBatch — fallback-path scheduler_backpressure emit (audit R1/#12)', () => {
  beforeEach(() => {
    clearToolRuntimeStateForTests()
    resetToolSchedulerForTests()
    resetResourceQuotaManagerForTests()
    resetPolicyEngineForTests()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  /** Wire `onStreamEvent` so toolExec builds a (mocked) transport adapter. */
  function stateWithTransport(
    toolUseBlocks: Array<{ id: string; name: string; input: Record<string, unknown> }>,
  ): LoopState {
    const state = makeMinimalState({ toolUseBlocks })
    ;(state.callbacks as unknown as { onStreamEvent: (ev: unknown) => void }).onStreamEvent =
      vi.fn()
    return state
  }

  it('emits quota_backpressure when entering the quota wait loop', async () => {
    getResourceQuotaManager({
      maxGlobalMutationParallel: 1,
      backpressureMaxWaitMs: 3_000,
      enablePreemption: false,
    })
    registerToolInvocation({
      toolUseId: 'tu_emit_blocker',
      toolName: 'OtherMutation',
      agentId: 'agent-Z',
      input: {},
      isReadOnly: false,
    })
    markToolRunning('tu_emit_blocker')
    setTimeout(() => markToolCompleted('tu_emit_blocker'), 150)

    const state = stateWithTransport([
      { id: 'tu_emit_bp', name: 'custom_mutation', input: { v: 1 } },
    ])
    await executeToolBatch(state, {
      accumulatedText: '',
      streamingToolExecutor: null,
      useStreamingToolExecutor: false,
    })

    const bpCall = emitPhaseEventMock.mock.calls.find(
      (c) => (c[1] as { phase?: string }).phase === 'scheduler_backpressure',
    )
    expect(bpCall).toBeDefined()
    expect(
      (bpCall![1] as { schedulerBackpressure?: Record<string, unknown> }).schedulerBackpressure,
    ).toMatchObject({
      toolName: 'custom_mutation',
      toolUseId: 'tu_emit_bp',
      kind: 'quota_backpressure',
    })
  })

  it('emits scheduler_hold when the cross-agent hold gate actually delayed the tool', async () => {
    vi.stubEnv('POLE_TOOL_SCHEDULER_DRIVE', '1')
    vi.stubEnv('POLE_TOOL_SCHEDULER_HOLD_THRESHOLD', '1')
    // Small budget: the hold proceeds at the deadline (anti-starvation), so
    // the test doesn't need to release the HIGH node.
    getResourceQuotaManager({ backpressureMaxWaitMs: 250 })

    // A READY higher-priority node from the main agent…
    getToolScheduler().enqueueBatch([
      {
        toolUseId: 'main_hi',
        toolName: 'Read',
        agentId: 'main',
        input: {},
        readOnly: true,
        priority: ToolPriority.HIGH,
      },
    ])
    // …a contended system (running >= threshold 1)…
    registerToolInvocation({
      toolUseId: 'tu_running_other',
      toolName: 'Read',
      agentId: 'agent-Y',
      input: {},
      isReadOnly: true,
    })
    markToolRunning('tu_running_other')
    // …and a NORMAL-priority sub-agent issuing the batch.
    getAgentContextMock.mockReturnValue({
      agentId: 'sub-1',
      streamConversationId: 'conv-test',
      priority: ToolPriority.NORMAL,
    })

    const state = stateWithTransport([{ id: 'tu_held', name: 'read_file', input: { path: '/a' } }])
    const started = Date.now()
    await executeToolBatch(state, {
      accumulatedText: '',
      streamingToolExecutor: null,
      useStreamingToolExecutor: false,
    })

    // It really held until (roughly) the deadline.
    expect(Date.now() - started).toBeGreaterThanOrEqual(200)
    const holdCall = emitPhaseEventMock.mock.calls.find(
      (c) =>
        (c[1] as { phase?: string }).phase === 'scheduler_backpressure' &&
        ((c[1] as { schedulerBackpressure?: { kind?: string } }).schedulerBackpressure?.kind ===
          'scheduler_hold'),
    )
    expect(holdCall).toBeDefined()
    const payload = (holdCall![1] as {
      schedulerBackpressure: { toolName: string; toolUseId: string; waitedMs: number }
    }).schedulerBackpressure
    expect(payload).toMatchObject({ toolName: 'read_file', toolUseId: 'tu_held' })
    expect(payload.waitedMs).toBeGreaterThanOrEqual(200)
  })

  it('does NOT emit scheduler_backpressure when nothing held or waited', async () => {
    const state = stateWithTransport([{ id: 'tu_free', name: 'read_file', input: { path: '/a' } }])
    await executeToolBatch(state, {
      accumulatedText: '',
      streamingToolExecutor: null,
      useStreamingToolExecutor: false,
    })
    const bpCall = emitPhaseEventMock.mock.calls.find(
      (c) => (c[1] as { phase?: string }).phase === 'scheduler_backpressure',
    )
    expect(bpCall).toBeUndefined()
  })
})

// ─── 11. Assistant message shape ──────────────────────────────────────

describe('executeToolBatch — assistant message construction', () => {
  it('attaches pole usage meta when lastStreamUsageForPole has token count > 0', async () => {
    const state = makeMinimalState({
      lastStreamUsageForPole: { input_tokens: 100, output_tokens: 50 },
    })

    await executeToolBatch(state, {
      accumulatedText: 'hello world',
      streamingToolExecutor: null,
      useStreamingToolExecutor: false,
    })

    // Find the assistant message we just pushed
    const assistantMsg = state.apiMessages.find((m) => m.role === 'assistant')
    expect(assistantMsg).toBeDefined()
    expect((assistantMsg as Record<string, unknown>).__poleUsage).toEqual({
      input_tokens: 100,
      output_tokens: 50,
    })
  })

  it('does NOT attach pole usage meta when token count is 0', async () => {
    const state = makeMinimalState({
      lastStreamUsageForPole: { input_tokens: 0, output_tokens: 0 },
    })

    await executeToolBatch(state, {
      accumulatedText: '',
      streamingToolExecutor: null,
      useStreamingToolExecutor: false,
    })

    const assistantMsg = state.apiMessages.find((m) => m.role === 'assistant')
    expect(assistantMsg).toBeDefined()
    expect((assistantMsg as Record<string, unknown>).__poleUsage).toBeUndefined()
  })
})
