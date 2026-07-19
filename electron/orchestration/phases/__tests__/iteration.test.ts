/**
 * Contract tests for `runAgenticIteration` — the per-iteration primitive that drives
 * the agentic loop's 5-phase pipeline.
 *
 * What's under test (control flow):
 *   1. happy paths     — tool_use → continue, no tool_use → terminate completed
 *   2. abort guards    — each of the 5 abort checkpoints in iteration.ts
 *   3. preModel terminate, stream terminate, postModel terminate, postModel aborted
 *   4. iterationBoundaryHook stop / throw
 *   5. blocking_limit hard termination
 *   6. hook_stopped via consumeAgentContextPendingHookStop
 *   7. sub-agent stop directive injection (>= threshold)
 *   8. main-chat wrap-up directive injection (>= 80% maxIterations)
 *   9. kernel inbox drain → user message appended
 *  10. pendingToolUseSummary resolved → appended to last user message
 *  11. iteration === 1 skips postModel
 *  12. transition flag set to 'tool_use' after successful tool batch
 *  13. post-tool abort always reports aborted_tools — even at max
 *      iterations (SA-2 fix 3: user cancel wins over max_turns)
 *  14. duplicate tool_use id auto-repair (SA-2 fix 2)
 *  15. toolTokensForContext computed before runPreModelPhase (SA-2 fix 1)
 *
 * The 5 phase modules are mocked at the function boundary so each test
 * controls exactly what its iteration sees from preModel / stream / noTools /
 * toolExec / postModel. All other dependencies are mocked to deterministic
 * no-ops so iteration.ts's control flow is the only thing under test.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentLoopInboxDrainResult } from '../../../ai/agenticLoopTypes'
import {
  SIDE_CHANNEL_KIND,
  makeSideChannelUserMessage,
} from '../../../constants/sideChannelKinds'
import { fingerprintTranscript } from '../../kernelTypes'

// ─── Phase module mocks ───────────────────────────────────────────────

const runPreModelPhaseMock = vi.fn()
const runStreamPhaseMock = vi.fn()
const handleNoToolsBranchMock = vi.fn()
const executeToolBatchMock = vi.fn()
const runPostModelPhaseMock = vi.fn()

vi.mock('../../../ai/agenticLoop/preModel', () => ({
  runPreModelPhase: (input: unknown) => runPreModelPhaseMock(input),
}))
vi.mock('../../../ai/agenticLoop/stream', () => ({
  runStreamPhase: (input: unknown) => runStreamPhaseMock(input),
}))
vi.mock('../../../ai/agenticLoop/noTools', () => ({
  handleNoToolsBranch: (state: unknown, input: unknown) =>
    handleNoToolsBranchMock(state, input),
}))
vi.mock('../../../ai/agenticLoop/toolExec', () => ({
  executeToolBatch: (state: unknown, input: unknown) =>
    executeToolBatchMock(state, input),
}))
vi.mock('../../../ai/agenticLoop/postModel', () => ({
  runPostModelPhase: (input: unknown) => runPostModelPhaseMock(input),
}))

// ─── Helper mocks (the iteration body unconditionally calls these) ────

const getAgentContextMock = vi.fn(() => ({
  agentId: 'main' as const,
  streamConversationId: 'conv-test',
  systemPromptLayers: undefined,
}))
const getActiveAgentsMock = vi.fn(
  () => new Map<string, Record<string, unknown>>(),
)
const consumeAgentContextPendingHookStopMock = vi.fn(() => undefined)
const syncAgentContextConversationMock = vi.fn()

vi.mock('../../../agents/agentContext', () => ({
  getAgentContext: () => getAgentContextMock(),
  syncAgentContextConversation: (msgs: unknown) => syncAgentContextConversationMock(msgs),
  consumeAgentContextPendingHookStop: () => consumeAgentContextPendingHookStopMock(),
}))

vi.mock('../../../agents/activeAgentRegistry', () => ({
  cleanupStaleAgents: vi.fn(),
  getActiveAgents: () => getActiveAgentsMock(),
}))
vi.mock('../../../agents/processCommandQueue', () => ({
  drainMainThreadProcessCommandQueue: vi.fn(async () => {}),
}))
vi.mock('../../../context/filePathMemory', () => ({
  snapshotFilePathsForConversation: vi.fn(),
}))
vi.mock('../../../tools/schema', () => ({
  getToolDefinitions: vi.fn(() => []),
}))
vi.mock('../../../tools/registry', () => ({
  toolRegistry: {
    getToolsetRevision: vi.fn(() => 1),
  },
}))
vi.mock('../../../context/tokenCounter', () => ({
  estimateToolDefinitionsTokens: vi.fn(() => 0),
}))
vi.mock('../../../context/conversationDisplayState', () => ({
  updateConversationContextDisplay: vi.fn(),
}))
vi.mock('../../../skills/skillModelResolve', () => ({
  resolveSkillModelOverride: vi.fn((skillModel: string) => skillModel),
}))
vi.mock('../../../skills/skillSessionFilter', () => ({
  filterToolDefinitionsForSkill: vi.fn((defs: unknown[]) => defs),
}))
vi.mock('../../../context/ensureToolUseResultPairing', () => ({
  ensureToolUseResultPairing: vi.fn((msgs: unknown) => msgs),
}))
vi.mock('../../../context/anthropicThinkingTranscript', () => ({
  normalizeAnthropicThinkingTranscript: vi.fn((msgs: unknown) => msgs),
  // §10.3 三元组：peek 返回 ThinkingStreamSnapshot | undefined（仍 undefined 即可）
  peekLastStreamModelForThinkingTranscript: vi.fn(() => undefined),
  // remember 现在接受 snapshot 对象（{ provider, model, configId? }），mock 不关心
  rememberLastStreamModelForThinkingTranscript: vi.fn(),
}))
vi.mock('../../../settings/settingsAccess', () => ({
  // §10.3 iteration.ts 现在会从 disk settings 读 activeConfigId 来组三元组 snapshot
  readDiskSettings: vi.fn(() => ({})),
}))
vi.mock('../../../ai/anthropicExtendedThinking', () => ({
  buildAnthropicThinkingForStreamRequest: vi.fn(() => null),
}))
vi.mock('../../../context/normalizeMessagesForAPI', () => ({
  normalizeMessagesForAPI: vi.fn((msgs: unknown) => msgs),
}))
vi.mock('../../../context/compactBoundary', () => ({
  getMessagesAfterCompactBoundary: vi.fn((msgs: unknown) => msgs),
}))
vi.mock('../../../ai/agenticLoopHelpers', () => ({
  injectPendingInterAgentQueue: vi.fn(),
  cloneApiMessagesForOrchestration: vi.fn((m: unknown) => m),
}))
vi.mock('../../../ai/toolUseSummary', () => ({
  formatToolUseSummaryForInjection: vi.fn(
    (r: { summary?: string }) => r?.summary ?? '(summary)',
  ),
}))
vi.mock('../../../ai/providerQuirks', () => ({
  getProviderQuirks: vi.fn(() => ({
    supportsThinkingBlocks: false,
    thinkingRequiresHistoryEcho: false,
  })),
}))
vi.mock('../../../session/sessionMemoryTrigger', () => ({
  markSessionMemoryExtractConsumed: vi.fn(),
  recordMainThreadSessionMemorySignals: vi.fn(),
  shouldTriggerSessionMemoryExtract: vi.fn(() => false),
  suppressSessionMemoryExtract: vi.fn(),
}))
vi.mock('../../../session/memoryForkSnapshot', () => ({
  snapshotAgentContextForSessionMemoryFork: vi.fn(() => ({})),
}))
vi.mock('../../../session/sessionMemoryExtractInFlight', () => ({
  endSessionMemoryExtract: vi.fn(),
  tryBeginSessionMemoryExtract: vi.fn(() => false),
}))
vi.mock('../../../memory/memoryFeatureFlags', () => ({
  getMemoryFeatureFlags: vi.fn(() => ({ sessionMemoryEnabled: false })),
}))
vi.mock('../../../tools/workspaceState', () => ({
  getWorkspacePath: vi.fn(() => '/tmp/ws'),
}))
vi.mock('../../../context/contextCollapseStore', () => ({
  buildContextCollapseConversationKey: vi.fn(() => 'collapse-key'),
}))
vi.mock('../../../ai/queryTermination', () => ({
  createTerminalResult: (reason: string, extra: Record<string, unknown>) => ({
    reason,
    terminatedAt: 0,
    ...extra,
  }),
  // 2026-07 interruption protocol — mirror the production shape so the
  // abort-path marker push in `applyOutcome` stays observable in tests.
  createUserInterruptionMessage: (reason: string) => ({
    role: 'user',
    content:
      reason === 'aborted_streaming'
        ? '[User interrupted during model response.]'
        : '[User interrupted during tool execution.]',
    _type: 'interruption',
  }),
  runTerminationCleanup: vi.fn(async () => {}),
}))
vi.mock('../../../ai/toolResultBudget', () => ({
  cleanupOldToolResults: vi.fn(),
}))

// Import the SUT after all mocks are registered.
import { repairDuplicateToolUseIds, runAgenticIteration } from '../iteration'
import { estimateToolDefinitionsTokens } from '../../../context/tokenCounter'
import type { AgenticLoopParams } from '../../../ai/agenticLoopTypes'

// ─── Default phase outputs ────────────────────────────────────────────

/**
 * Default stream output — empty tool_use blocks so noTools branch is taken
 * by default. Tests override via runStreamPhaseMock.mockResolvedValueOnce().
 */
function defaultStreamOutput(state: { totalUsage: { inputTokens: number; outputTokens: number } }) {
  return {
    contextLengthExceeded: false,
    streamMaxOutTokens: 4096,
    iterationModel: 'claude-test',
    accumulatedText: '',
    toolUseBlocks: [],
    thinkingBlocks: [],
    serverToolUseBlocks: [],
    codeExecutionResultBlocks: [],
    lastStreamStopReason: 'end_turn',
    lastStreamUsageForPole: null,
    lastStreamInputTokens: 0,
    maxOutputRecoveryCycles: 0,
    totalUsage: state.totalUsage,
    lastStreamEndMs: 0,
    streamingToolExecutor: null,
    useStreamingToolExecutor: false,
  }
}

// ─── State factory ────────────────────────────────────────────────────

interface MakeStateOpts {
  iteration?: number
  maxIterations?: number
  signal?: AbortSignal
  apiMessages?: Array<Record<string, unknown>>
  blockingLimitHard?: boolean
  parentAgentId?: string
  enableTools?: boolean
  hasToolDefinitionsOverride?: boolean
  hostTranscriptDrain?: () => AgentLoopInboxDrainResult
  kernelLoopPort?: { persistThrottled: (counters: { maxOutputRecoveryCycles: number; consecutiveCompactFailures: number }) => void }
  pendingToolUseSummary?: Promise<unknown> | null
  _compactionReminderInjected?: boolean
  usagePercentOfWindow?: number
}

function makeMinimalState(opts: MakeStateOpts = {}) {
  const apiMessages = opts.apiMessages ?? [{ role: 'user', content: 'hi' }]
  const ctxManager = {
    evaluate: vi.fn(() => ({ action: 'noop' })),
    getThresholds: vi.fn(() => ({
      warningTokens: 0,
      autoCompactTokens: 0,
      microCompactTokens: 0,
      blockingTokens: 0,
    })),
    handleContext: vi.fn(async (msgs: unknown[]) => ({ wasCompacted: false, messages: msgs })),
    getState: () => ({
      level: 'idle',
      // Default 0 — most tests don't need to gate the compaction_reminder
      // path, and 0% < the 50% trigger keeps the reminder dormant.
      usagePercentOfWindow: opts.usagePercentOfWindow ?? 0,
    }),
    clearUsageSnapshot: vi.fn(),
    estimateTotalInputTokensPeek: vi.fn(() => 0),
  }

  const state = {
    apiMessages,
    iteration: opts.iteration ?? 1,
    maxIterations: opts.maxIterations ?? 100,
    enableTools: opts.enableTools ?? true,
    hasToolDefinitionsOverride: opts.hasToolDefinitionsOverride ?? true,
    baseToolDefinitions: [],
    iterationToolDefs: [],
    lastToolsetRevision: 1,
    iterationModel: 'claude-test',
    iterationEffort: undefined,
    model: 'claude-test',
    effortFromParams: undefined,
    activeInlineSkillSession: null,
    accumulatedText: '',
    toolUseBlocks: [],
    thinkingBlocks: [],
    serverToolUseBlocks: [],
    codeExecutionResultBlocks: [],
    streamMaxOutTokens: 4096,
    alwaysThinking: false,
    totalUsage: { inputTokens: 0, outputTokens: 0 },
    terminationResult: null,
    signal: opts.signal ?? new AbortController().signal,
    callbacks: {
      onTextDelta: vi.fn(),
      onToolStart: vi.fn(),
      onToolResult: vi.fn(),
      onMessageEnd: vi.fn(),
      onError: vi.fn(),
      onContextCompact: vi.fn(),
      onMaxIterationsReached: vi.fn(),
      onQueryLoopPreModel: vi.fn(),
    },
    config: { id: 'anthropic', apiKey: '', baseUrl: '' },
    queryConfig: {
      blockingLimitHard: opts.blockingLimitHard ?? false,
      // undefined ⇒ main thread; a string ⇒ sub-agent run (mirrors the
      // QueryConfig contract where the main thread's parentAgentId is unset).
      parentAgentId: opts.parentAgentId,
    },
    loopContextManager: ctxManager,
    useOpenClaudeDerivedLoopThresholds: false,
    profiler: {
      setIteration: vi.fn(),
      startCheckpoint: vi.fn(() => () => {}),
      flush: vi.fn(),
    },
    appendixReport: vi.fn(),
    syncConversation: vi.fn(),
    refreshMainChatContextHeader: vi.fn(),
    appendAppendixAFlow: undefined,
    transition: 'init' as const,
    transitionHistory: [],
    lastPhaseAwareCompactIteration: 0,
    stopHookActive: new Set<string>(),
    consecutiveStopHookBlocks: 0,
    consecutiveCompactFailures: 0,
    withheldStreamError: null,
    withheldStreamSignal: null,
    discoveryExclude: new Set<string>(),
    toolCallHistory: undefined,
    diffPermissionMode: 'default' as const,
    permissionDefaultMode: 'ask' as const,
    permissionRules: [],
    pendingToolUseSummary: opts.pendingToolUseSummary ?? null,
    toolTokensForContext: 0,
    toolsForApi: undefined,
    openAiStrictToolNames: undefined,
    collapseConversationKey: '',
    lastStreamUsageForPole: null,
    lastStreamInputTokens: 0,
    lastStreamStopReason: undefined,
    lastStreamEndMs: 0,
    maxOutputRecoveryCycles: 0,
    lastIdleClearMs: 0,
    tokenBudgetState: null,
    lastUserPlainBudgetSource: undefined,
    queryDeps: { signal: new AbortController().signal },
    anthropicFastModeEnabled: false,
    systemPromptLayers: undefined,
    orchestratedToolExecution: undefined,
    hostTranscript: opts.hostTranscriptDrain
      ? { commit: vi.fn(), drainInbox: opts.hostTranscriptDrain }
      : undefined,
    acceptHostTranscript: vi.fn(),
    kernelLoopPort: opts.kernelLoopPort,
    _compactionReminderInjected: opts._compactionReminderInjected ?? false,
  }
  state.acceptHostTranscript = (messages: Array<Record<string, unknown>>) => {
    state.apiMessages = structuredClone(messages)
    syncAgentContextConversationMock(state.apiMessages)
  }

  return state as unknown as Parameters<typeof runAgenticIteration>[0]
}

function makeInboxSnapshot(
  messages: Array<Record<string, unknown>>,
  text: string,
): AgentLoopInboxDrainResult {
  const nextMessages = [
    ...structuredClone(messages),
    makeSideChannelUserMessage(SIDE_CHANNEL_KIND.genericConvertedSystem, text.trim()),
  ]
  return {
    injected: true,
    snapshot: {
      revision: 1,
      fingerprint: fingerprintTranscript(nextMessages),
      messages: nextMessages,
    },
  }
}

function makeMinimalParams(overrides?: Partial<AgenticLoopParams>): AgenticLoopParams {
  return {
    config: { id: 'anthropic', apiKey: '', baseUrl: '' },
    model: 'claude-test',
    messages: [],
    systemPrompt: 'sys',
    initialApiMessages: undefined,
    enableTools: true,
    diffPermissionMode: 'default',
    permissionDefaultMode: 'ask',
    ...overrides,
  } as unknown as AgenticLoopParams
}

// ─── Common default phase impls ───────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()
  getAgentContextMock.mockReturnValue({
    agentId: 'main',
    streamConversationId: 'conv-test',
    systemPromptLayers: undefined,
  })
  getActiveAgentsMock.mockReturnValue(new Map())
  consumeAgentContextPendingHookStopMock.mockReturnValue(undefined)
  // Default: preserve whatever state.apiMessages already contains at the time
  // preModel runs. iteration.ts immediately overwrites state.apiMessages with
  // what we return (line 489 of iteration.ts), so returning the SAME array
  // preserves any side-channel directive / inbox-drain message the orchestrator
  // pushed before preModel.
  runPreModelPhaseMock.mockImplementation(
    async ({ state }: { state: { apiMessages: Array<Record<string, unknown>> } }) => ({
      apiMessages: state.apiMessages,
      wasPreModelCompacted: false,
      contextLevelAfter: undefined,
      snippedCount: 0,
      pipelinePhases: [],
      idleToolClearApplied: false,
      terminated: false,
    }),
  )
  runStreamPhaseMock.mockImplementation(async ({ state }: { state: { totalUsage: { inputTokens: number; outputTokens: number } } }) =>
    defaultStreamOutput(state),
  )
  handleNoToolsBranchMock.mockResolvedValue({ action: 'end' })
  executeToolBatchMock.mockImplementation(async (state: { apiMessages: Array<unknown> }) => ({
    toolResults: [],
    apiMessages: state.apiMessages,
    activeInlineSkillSession: null,
    discoveryExclude: new Set<string>(),
    pendingToolUseSummary: null,
  }))
  runPostModelPhaseMock.mockResolvedValue({ kind: 'ok', wasCompacted: false })
})

// ─── 1. Happy paths ───────────────────────────────────────────────────

describe('runAgenticIteration — happy paths', () => {
  it('returns terminate=completed when stream yields no tool_use and noTools returns end', async () => {
    const state = makeMinimalState()
    const params = makeMinimalParams()

    const outcome = await runAgenticIteration(state, params, 'sys')

    expect(outcome.kind).toBe('terminate')
    expect(state.terminationResult).toMatchObject({ reason: 'completed' })
    expect(state.callbacks.onMessageEnd).toHaveBeenCalledTimes(1)
    expect(handleNoToolsBranchMock).toHaveBeenCalledTimes(1)
    expect(executeToolBatchMock).not.toHaveBeenCalled()
  })

  it('returns continue and sets transition="tool_use" when stream yields tool_use blocks', async () => {
    runStreamPhaseMock.mockImplementationOnce(async ({ state }) => ({
      ...defaultStreamOutput(state),
      toolUseBlocks: [{ id: 'tu_1', name: 'read_file', input: { path: '/a' } }],
    }))
    const state = makeMinimalState({ iteration: 1 })
    const params = makeMinimalParams()

    const outcome = await runAgenticIteration(state, params, 'sys')

    expect(outcome.kind).toBe('continue')
    expect(executeToolBatchMock).toHaveBeenCalledTimes(1)
    expect(handleNoToolsBranchMock).not.toHaveBeenCalled()
    expect(state.transition).toBe('tool_use')
  })

  it('syncs a direct sub-agent transcript injection before the next iteration boundary', async () => {
    getActiveAgentsMock.mockReturnValue(new Map([
      ['agent-bg-sync', {
        agentId: 'agent-bg-sync',
        agentType: 'Explore',
        parentAgentId: 'main',
        description: 'background audit',
        messages: [],
        pendingMessages: [],
        abortController: new AbortController(),
        startTime: Date.now(),
        status: 'completed',
        resolve: () => {},
        latestTextOutput: 'sub-agent result that must be committed',
      }],
    ]))
    runStreamPhaseMock.mockImplementationOnce(async ({ state }) => ({
      ...defaultStreamOutput(state),
      toolUseBlocks: [{ id: 'tu_sync', name: 'read_file', input: { path: '/a' } }],
    }))
    executeToolBatchMock.mockImplementationOnce(async (state: {
      apiMessages: Array<unknown>
      syncConversation: ReturnType<typeof vi.fn>
    }) => {
      state.syncConversation.mockClear()
      return {
        toolResults: [],
        apiMessages: state.apiMessages,
        activeInlineSkillSession: null,
        discoveryExclude: new Set<string>(),
        pendingToolUseSummary: null,
      }
    })
    const state = makeMinimalState({ iteration: 2 })

    const outcome = await runAgenticIteration(state, makeMinimalParams(), 'sys')

    expect(outcome.kind).toBe('continue')
    expect(state.apiMessages.some((message) =>
      typeof message.content === 'string' &&
      message.content.includes('sub-agent result that must be committed')
    )).toBe(true)
    expect(state.syncConversation).toHaveBeenCalledTimes(1)
  })

  it('skips runPostModelPhase on iteration 1 even with tool_use', async () => {
    runStreamPhaseMock.mockImplementationOnce(async ({ state }) => ({
      ...defaultStreamOutput(state),
      toolUseBlocks: [{ id: 'tu_1', name: 'read_file', input: {} }],
    }))
    const state = makeMinimalState({ iteration: 1 })
    const params = makeMinimalParams()

    await runAgenticIteration(state, params, 'sys')

    expect(runPostModelPhaseMock).not.toHaveBeenCalled()
  })

  it('runs runPostModelPhase on iteration > 1 with tool_use', async () => {
    runStreamPhaseMock.mockImplementationOnce(async ({ state }) => ({
      ...defaultStreamOutput(state),
      toolUseBlocks: [{ id: 'tu_1', name: 'read_file', input: {} }],
    }))
    const state = makeMinimalState({ iteration: 3 })
    const params = makeMinimalParams()

    await runAgenticIteration(state, params, 'sys')

    expect(runPostModelPhaseMock).toHaveBeenCalledTimes(1)
  })

  // Critical invariant for the upstream-parity consecutive-cap circuit
  // breaker: when the model produces tool_use and the batch executes
  // without aborting, the orchestrator MUST reset both `stopHookActive`
  // and `consecutiveStopHookBlocks` to their initial values. Without
  // this reset, a long-running session could accumulate stale block
  // counts across unrelated stop-hook episodes and trip the breaker
  // for benign reasons.
  it('clears stopHookActive Set and resets consecutiveStopHookBlocks=0 after successful tool execution', async () => {
    runStreamPhaseMock.mockImplementationOnce(async ({ state }) => ({
      ...defaultStreamOutput(state),
      toolUseBlocks: [{ id: 'tu_1', name: 'read_file', input: {} }],
    }))
    const state = makeMinimalState({ iteration: 2 })
    // Simulate a prior iteration having accumulated stop-hook blocks
    // (e.g. a `decideAfterNoToolUse` recovery loop) followed by genuine
    // progress on this iteration. P0.4 — `stopHookActive` is now a Set
    // keyed by hookName.
    state.stopHookActive.add('lint-hook')
    state.stopHookActive.add('test-hook')
    state.consecutiveStopHookBlocks = 5

    await runAgenticIteration(state, makeMinimalParams(), 'sys')

    expect(state.stopHookActive.size).toBe(0)
    expect(state.consecutiveStopHookBlocks).toBe(0)
  })

  // Silent-stop audit (2026-06): when the stream yields NO tool_use and
  // `handleNoToolsBranch` returns `{ action: 'continue' }` (stop-hook
  // continue / token-budget reminder / declared-intent / active-todo /
  // all-tools-failed guards / inter-agent drain), the iteration MUST loop
  // to the next turn WITHOUT entering Phase 4. Falling through to
  // `executeToolBatch` with an empty tool batch pushed a duplicate
  // assistant message and buried the freshly-injected continuation
  // directive, defeating the very guards meant to prevent a silent stop.
  it('returns continue WITHOUT running executeToolBatch when noTools returns action=continue', async () => {
    handleNoToolsBranchMock.mockResolvedValueOnce({
      action: 'continue',
    })
    const state = makeMinimalState({ iteration: 2 })

    const outcome = await runAgenticIteration(state, makeMinimalParams(), 'sys')

    expect(outcome.kind).toBe('continue')
    expect(handleNoToolsBranchMock).toHaveBeenCalledTimes(1)
    expect(executeToolBatchMock).not.toHaveBeenCalled()
    // No terminal result — the loop is meant to advance to the next turn.
    expect(state.terminationResult).toBeNull()
  })

  // End-to-end transcript-shape guard for the silent-stop fix. We make the
  // noTools mock reproduce the REAL side effects of a `continue` outcome
  // (push the assistant reply, then push the side-channel directive as the
  // tail) and make executeToolBatch reproduce the OLD bug (push a duplicate
  // assistant message). The fix means executeToolBatch never runs, so the
  // injected directive MUST remain the last message — that's exactly what
  // lets the next stream pass act on it instead of stalling into a silent
  // `completed`.
  it('keeps the injected continuation directive at the transcript tail (no duplicate assistant)', async () => {
    handleNoToolsBranchMock.mockImplementationOnce(
      async (state: { apiMessages: Array<Record<string, unknown>> }) => {
        state.apiMessages.push({ role: 'assistant', content: [{ type: 'text', text: 'reply' }] })
        const directiveMsg: Record<string, unknown> = {
          role: 'user',
          content: '[directive] keep going',
          _convertedFromSystem: true,
        }
        state.apiMessages.push(directiveMsg)
        return { action: 'continue', appendedDirective: directiveMsg }
      },
    )
    // Reproduce the pre-fix corruption: a fall-through to Phase 4 would push
    // a second assistant message, burying the directive. NOTE: use a
    // persistent `mockImplementation` (not `mockImplementationOnce`) — the
    // fix means executeToolBatch is never called here, so a queued
    // once-impl would otherwise leak into the next test. `beforeEach`
    // restores the default impl before the following test.
    executeToolBatchMock.mockImplementation(
      async (state: { apiMessages: Array<Record<string, unknown>> }) => {
        state.apiMessages.push({ role: 'assistant', content: [{ type: 'text', text: 'reply' }] })
        return {
          toolResults: [],
          apiMessages: state.apiMessages,
          activeInlineSkillSession: null,
          discoveryExclude: new Set<string>(),
          pendingToolUseSummary: null,
        }
      },
    )
    const state = makeMinimalState({ iteration: 2 })

    await runAgenticIteration(state, makeMinimalParams(), 'sys')

    const tail = state.apiMessages[state.apiMessages.length - 1]
    expect(tail.role).toBe('user')
    expect(tail.content).toBe('[directive] keep going')
    // Exactly one assistant turn was appended this iteration (no duplicate).
    expect(
      state.apiMessages.filter(
        (m) => m.role === 'assistant' && Array.isArray(m.content),
      ).length,
    ).toBe(1)
  })
})

// ─── 2. Abort guards ──────────────────────────────────────────────────

describe('runAgenticIteration — abort guards', () => {
  it('terminates aborted_streaming when signal is already aborted at entry', async () => {
    const ac = new AbortController()
    ac.abort()
    const state = makeMinimalState({ signal: ac.signal })

    const outcome = await runAgenticIteration(state, makeMinimalParams(), 'sys')

    expect(outcome.kind).toBe('terminate')
    expect(state.terminationResult).toMatchObject({ reason: 'aborted_streaming' })
    // Pre-model pipeline must NOT have run
    expect(runPreModelPhaseMock).not.toHaveBeenCalled()
  })

  it('terminates aborted_streaming when signal aborts during the stream phase', async () => {
    const ac = new AbortController()
    runStreamPhaseMock.mockImplementationOnce(async ({ state }) => {
      ac.abort()
      return defaultStreamOutput(state)
    })
    const state = makeMinimalState({ signal: ac.signal })

    const outcome = await runAgenticIteration(state, makeMinimalParams(), 'sys')

    expect(outcome.kind).toBe('terminate')
    expect(state.terminationResult).toMatchObject({ reason: 'aborted_streaming' })
    // noTools and executeToolBatch must NOT have run
    expect(handleNoToolsBranchMock).not.toHaveBeenCalled()
    expect(executeToolBatchMock).not.toHaveBeenCalled()
  })

  it('terminates aborted_tools when signal aborts during the tool batch', async () => {
    const ac = new AbortController()
    runStreamPhaseMock.mockImplementationOnce(async ({ state }) => ({
      ...defaultStreamOutput(state),
      toolUseBlocks: [{ id: 'tu_1', name: 'read_file', input: {} }],
    }))
    executeToolBatchMock.mockImplementationOnce(async (state: { apiMessages: Array<unknown> }) => {
      ac.abort()
      return {
        toolResults: [],
        apiMessages: state.apiMessages,
        activeInlineSkillSession: null,
        discoveryExclude: new Set<string>(),
        pendingToolUseSummary: null,
      }
    })
    const state = makeMinimalState({ signal: ac.signal, iteration: 5, maxIterations: 100 })

    const outcome = await runAgenticIteration(state, makeMinimalParams(), 'sys')

    expect(outcome.kind).toBe('terminate')
    expect(state.terminationResult).toMatchObject({ reason: 'aborted_tools' })
  })

  it('reports aborted_tools even when iteration === maxIterations at tool abort guard (SA-2 fix 3: cancel wins over max_turns)', async () => {
    const ac = new AbortController()
    runStreamPhaseMock.mockImplementationOnce(async ({ state }) => ({
      ...defaultStreamOutput(state),
      toolUseBlocks: [{ id: 'tu_1', name: 'read_file', input: {} }],
    }))
    executeToolBatchMock.mockImplementationOnce(async (state: { apiMessages: Array<unknown> }) => {
      ac.abort()
      return {
        toolResults: [],
        apiMessages: state.apiMessages,
        activeInlineSkillSession: null,
        discoveryExclude: new Set<string>(),
        pendingToolUseSummary: null,
      }
    })
    const state = makeMinimalState({ signal: ac.signal, iteration: 5, maxIterations: 5 })

    const outcome = await runAgenticIteration(state, makeMinimalParams(), 'sys')

    expect(outcome.kind).toBe('terminate')
    expect(state.terminationResult).toMatchObject({ reason: 'aborted_tools' })
    expect(state.callbacks.onMaxIterationsReached).not.toHaveBeenCalled()
  })

  // 2026-07 interruption protocol — abort terminations append the
  // `[User interrupted…]` user marker to the transcript and sync it out,
  // so kernel/ALS consumers see the cut-off instead of a "complete" turn.
  it('appends the user-interruption marker to apiMessages on aborted_streaming', async () => {
    const ac = new AbortController()
    ac.abort()
    const state = makeMinimalState({ signal: ac.signal })

    await runAgenticIteration(state, makeMinimalParams(), 'sys')

    const tail = state.apiMessages[state.apiMessages.length - 1] as Record<string, unknown>
    expect(tail).toMatchObject({
      role: 'user',
      content: '[User interrupted during model response.]',
      _type: 'interruption',
    })
    expect(state.syncConversation).toHaveBeenCalled()
  })

  it('appends the tool-flavoured interruption marker on aborted_tools', async () => {
    const ac = new AbortController()
    runStreamPhaseMock.mockImplementationOnce(async ({ state }) => ({
      ...defaultStreamOutput(state),
      toolUseBlocks: [{ id: 'tu_1', name: 'read_file', input: {} }],
    }))
    executeToolBatchMock.mockImplementationOnce(async (state: { apiMessages: Array<unknown> }) => {
      ac.abort()
      return {
        toolResults: [],
        apiMessages: state.apiMessages,
        activeInlineSkillSession: null,
        discoveryExclude: new Set<string>(),
        pendingToolUseSummary: null,
      }
    })
    const state = makeMinimalState({ signal: ac.signal, iteration: 5, maxIterations: 100 })

    await runAgenticIteration(state, makeMinimalParams(), 'sys')

    const tail = state.apiMessages[state.apiMessages.length - 1] as Record<string, unknown>
    expect(tail).toMatchObject({
      role: 'user',
      content: '[User interrupted during tool execution.]',
      _type: 'interruption',
    })
  })
})

// ─── 3. Phase-returned termination ────────────────────────────────────

describe('runAgenticIteration — phase-returned termination', () => {
  it('terminates immediately when preModel returns { terminated: true }', async () => {
    runPreModelPhaseMock.mockResolvedValueOnce({
      apiMessages: [],
      wasPreModelCompacted: false,
      contextLevelAfter: undefined,
      snippedCount: 0,
      pipelinePhases: [],
      idleToolClearApplied: false,
      terminated: true,
    })
    const state = makeMinimalState()

    const outcome = await runAgenticIteration(state, makeMinimalParams(), 'sys')

    expect(outcome.kind).toBe('terminate')
    // Stream phase must NOT have run
    expect(runStreamPhaseMock).not.toHaveBeenCalled()
  })

  it('terminates immediately when stream phase wrote state.terminationResult', async () => {
    runStreamPhaseMock.mockImplementationOnce(async ({ state }) => {
      state.terminationResult = {
        reason: 'model_error',
        turnCount: state.iteration,
        terminatedAt: 0,
      }
      return defaultStreamOutput(state)
    })
    const state = makeMinimalState()

    const outcome = await runAgenticIteration(state, makeMinimalParams(), 'sys')

    expect(outcome.kind).toBe('terminate')
    expect(handleNoToolsBranchMock).not.toHaveBeenCalled()
  })

  it('terminates when postModel returns { kind: "terminate" } (compact failure path)', async () => {
    runStreamPhaseMock.mockImplementationOnce(async ({ state }) => ({
      ...defaultStreamOutput(state),
      toolUseBlocks: [{ id: 'tu_1', name: 'read_file', input: {} }],
    }))
    runPostModelPhaseMock.mockResolvedValueOnce({ kind: 'terminate' })
    const state = makeMinimalState({ iteration: 3 })

    const outcome = await runAgenticIteration(state, makeMinimalParams(), 'sys')

    expect(outcome.kind).toBe('terminate')
  })

  it('promotes postModel { kind: "aborted" } to aborted_tools terminationResult', async () => {
    runStreamPhaseMock.mockImplementationOnce(async ({ state }) => ({
      ...defaultStreamOutput(state),
      toolUseBlocks: [{ id: 'tu_1', name: 'read_file', input: {} }],
    }))
    runPostModelPhaseMock.mockResolvedValueOnce({ kind: 'aborted' })
    const state = makeMinimalState({ iteration: 3, maxIterations: 100 })

    const outcome = await runAgenticIteration(state, makeMinimalParams(), 'sys')

    expect(outcome.kind).toBe('terminate')
    expect(state.terminationResult).toMatchObject({ reason: 'aborted_tools' })
  })

  it('promotes postModel { kind: "aborted" } at max_iterations to aborted_tools (SA-2 fix 3: cancel wins over max_turns)', async () => {
    runStreamPhaseMock.mockImplementationOnce(async ({ state }) => ({
      ...defaultStreamOutput(state),
      toolUseBlocks: [{ id: 'tu_1', name: 'read_file', input: {} }],
    }))
    runPostModelPhaseMock.mockResolvedValueOnce({ kind: 'aborted' })
    const state = makeMinimalState({ iteration: 5, maxIterations: 5 })

    const outcome = await runAgenticIteration(state, makeMinimalParams(), 'sys')

    expect(outcome.kind).toBe('terminate')
    expect(state.terminationResult).toMatchObject({ reason: 'aborted_tools' })
  })
})

// ─── 4. iterationBoundaryHook ─────────────────────────────────────────

describe('runAgenticIteration — iterationBoundaryHook', () => {
  it('terminates with iteration_boundary_stopped when hook returns stop:true', async () => {
    const state = makeMinimalState()
    const params = makeMinimalParams({
      iterationBoundaryHook: vi.fn(async () => ({ stop: true })),
    })

    const outcome = await runAgenticIteration(state, params, 'sys')

    expect(outcome.kind).toBe('terminate')
    expect(state.terminationResult).toMatchObject({
      reason: 'iteration_boundary_stopped',
    })
    expect(runPreModelPhaseMock).not.toHaveBeenCalled()
  })

  it('continues normally when iterationBoundaryHook throws', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const state = makeMinimalState()
    const params = makeMinimalParams({
      iterationBoundaryHook: vi.fn(async () => {
        throw new Error('hook boom')
      }),
    })

    const outcome = await runAgenticIteration(state, params, 'sys')

    expect(outcome.kind).toBe('terminate') // happy path no-tool noTools=end
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('iterationBoundaryHook threw'),
      expect.any(Error),
    )
    warnSpy.mockRestore()
  })

  // ── Audit P0+ self-fix F-1 — hook fires BEFORE signal.aborted check ──
  it('hook returning stop:true wins over signal.aborted (audit F-1)', async () => {
    const ac = new AbortController()
    ac.abort()
    const state = makeMinimalState({ signal: ac.signal })
    const hookSpy = vi.fn(async () => ({ stop: true }))
    const params = makeMinimalParams({ iterationBoundaryHook: hookSpy })

    const outcome = await runAgenticIteration(state, params, 'sys')

    expect(outcome.kind).toBe('terminate')
    // The hook ran (its stop:true was honoured) — must produce
    // `iteration_boundary_stopped`, NOT the inner gate's
    // `aborted_streaming`. Pre-F-1 the inner abort gate would have
    // intercepted first.
    expect(state.terminationResult).toMatchObject({
      reason: 'iteration_boundary_stopped',
    })
    expect(hookSpy).toHaveBeenCalled()
  })

  it('signal.aborted still wins when hook is absent (drive-mode shape)', async () => {
    const ac = new AbortController()
    ac.abort()
    const state = makeMinimalState({ signal: ac.signal })
    // No hook — fallback to the inner abort gate.
    const params = makeMinimalParams()

    const outcome = await runAgenticIteration(state, params, 'sys')

    expect(outcome.kind).toBe('terminate')
    expect(state.terminationResult).toMatchObject({ reason: 'aborted_streaming' })
  })
})

// ─── 5. blocking_limit hard ───────────────────────────────────────────

describe('runAgenticIteration — blocking_limit hard', () => {
  it('terminates with blocking_limit reason when blockingLimitHard=true and ContextManager returns block (main chat)', async () => {
    const state = makeMinimalState({ blockingLimitHard: true })
    ;(state as { loopContextManager: { evaluate: ReturnType<typeof vi.fn> } }).loopContextManager.evaluate = vi.fn(
      () => ({ action: 'block' }),
    )

    const outcome = await runAgenticIteration(state, makeMinimalParams(), 'sys')

    expect(outcome.kind).toBe('terminate')
    expect(state.terminationResult).toMatchObject({ reason: 'blocking_limit' })
    expect(state.callbacks.onError).toHaveBeenCalledWith(
      expect.stringContaining('blocking threshold'),
    )
    expect(runStreamPhaseMock).not.toHaveBeenCalled()
  })

  it('does NOT hard-terminate a sub-agent (parentAgentId set) even when blockingLimitHard=true and block fires', async () => {
    // Sub-agent run: parentAgentId present ⇒ isMainChat guard is false, so
    // the hard-blocking gate is skipped and the iteration falls through to
    // the graceful auto-/micro-compact degradation path instead of a silent
    // blocking_limit termination.
    const state = makeMinimalState({
      blockingLimitHard: true,
      parentAgentId: 'agent-parent-1',
    })
    ;(state as { loopContextManager: { evaluate: ReturnType<typeof vi.fn> } }).loopContextManager.evaluate = vi.fn(
      () => ({ action: 'block' }),
    )

    await runAgenticIteration(state, makeMinimalParams(), 'sys')

    expect(state.terminationResult).not.toMatchObject({ reason: 'blocking_limit' })
    expect(state.callbacks.onError).not.toHaveBeenCalledWith(
      expect.stringContaining('blocking threshold'),
    )
    // The gate did not short-circuit, so the iteration proceeded into the
    // stream phase (the soft degradation path) instead of a blocking_limit
    // termination. With the default no-tool mock it ends naturally.
    expect(runStreamPhaseMock).toHaveBeenCalled()
    expect(state.terminationResult).toMatchObject({ reason: 'completed' })
  })

  it('does NOT hard-terminate the main chat when blockingLimitHard=false (soft path)', async () => {
    const state = makeMinimalState({ blockingLimitHard: false })
    ;(state as { loopContextManager: { evaluate: ReturnType<typeof vi.fn> } }).loopContextManager.evaluate = vi.fn(
      () => ({ action: 'block' }),
    )

    await runAgenticIteration(state, makeMinimalParams(), 'sys')

    expect(state.terminationResult).not.toMatchObject({ reason: 'blocking_limit' })
    expect(runStreamPhaseMock).toHaveBeenCalled()
    expect(state.terminationResult).toMatchObject({ reason: 'completed' })
  })
})

// ─── 6. hook_stopped ──────────────────────────────────────────────────

describe('runAgenticIteration — hook_stopped', () => {
  it('terminates with hook_stopped when consumeAgentContextPendingHookStop returns non-null after tool batch', async () => {
    runStreamPhaseMock.mockImplementationOnce(async ({ state }) => ({
      ...defaultStreamOutput(state),
      toolUseBlocks: [{ id: 'tu_1', name: 'read_file', input: {} }],
    }))
    // Two calls happen: one at line 290 (clear residue, returns undefined),
    // one at line 789 (the real consume after tool batch). The first call
    // is from the residue clear at the top of the iteration; the second is
    // the one we want to return our payload.
    consumeAgentContextPendingHookStopMock.mockReturnValueOnce(undefined)
    consumeAgentContextPendingHookStopMock.mockReturnValueOnce({
      reason: 'hook stopped the loop',
      hookName: 'PreToolUse',
    })
    const state = makeMinimalState({ iteration: 2 })

    const outcome = await runAgenticIteration(state, makeMinimalParams(), 'sys')

    expect(outcome.kind).toBe('terminate')
    expect(state.terminationResult).toMatchObject({
      reason: 'hook_stopped',
      hookName: 'PreToolUse',
    })
    expect(state.callbacks.onError).toHaveBeenCalledWith('hook stopped the loop')
  })
})

// ─── 7. upstream-style compaction_reminder injection (via hostAttachments) ───
//
// Background: the previous 80%-iteration "wind down" directives (both
// sub-agent and main-chat variants) were deleted because they
// contradicted upstream design, conflicted with
// the token-budget continuation nudge, and got eaten by compact in
// long sessions without re-injection. The replacement is a one-shot
// reassurance message in the upstream style — "context is automatically
// managed, no need to rush or summarise prematurely".
//
// Phase A migration: the reminder now fires via the `runCollectors`
// orchestrator at the `post_tool` call site (upstream's natural
// position for `getAttachmentMessages`). This means the iteration
// must reach the post-tool branch — i.e. the model must produce
// tool_use blocks. The helper below stubs that.

/**
 * Stub the stream phase to return one tool_use so the iteration
 * advances past noTools into the tool-execution + post-tool branch
 * where the host-attachments orchestrator runs.
 */
function stubStreamWithToolUse(): void {
  runStreamPhaseMock.mockImplementationOnce(async ({ state }) => ({
    ...defaultStreamOutput(state),
    toolUseBlocks: [{ id: 'tu_compact_test', name: 'read_file', input: {} }],
  }))
}

const hasCompactionReminderInMessages = (
  msgs: Array<Record<string, unknown>>,
): boolean =>
  msgs.some((m) => {
    if (m.role !== 'user') return false
    const c = m.content
    return (
      typeof c === 'string' &&
      c.includes('Automatic context management is active')
    )
  })

describe('runAgenticIteration — compaction_reminder injection (post_tool)', () => {
  it('injects the reminder once at ≥50% context usage on main chat', async () => {
    getAgentContextMock.mockReturnValue({
      agentId: 'main',
      streamConversationId: 'conv',
      systemPromptLayers: undefined,
    })
    stubStreamWithToolUse()
    const state = makeMinimalState({
      iteration: 5,
      usagePercentOfWindow: 60,
      _compactionReminderInjected: false,
    })

    await runAgenticIteration(state, makeMinimalParams(), 'sys')

    expect(state._compactionReminderInjected).toBe(true)
    expect(hasCompactionReminderInMessages(state.apiMessages)).toBe(true)
  })

  it('does NOT fire below the 50% usage threshold', async () => {
    getAgentContextMock.mockReturnValue({
      agentId: 'main',
      streamConversationId: 'conv',
      systemPromptLayers: undefined,
    })
    stubStreamWithToolUse()
    const state = makeMinimalState({
      iteration: 5,
      usagePercentOfWindow: 30,
      _compactionReminderInjected: false,
    })

    await runAgenticIteration(state, makeMinimalParams(), 'sys')

    expect(state._compactionReminderInjected).toBe(false)
    expect(hasCompactionReminderInMessages(state.apiMessages)).toBe(false)
  })

  it('does NOT fire when usagePercentOfWindow is undefined (defensive default)', async () => {
    // Guards against a future ContextManager refactor that drops
    // `usagePercentOfWindow` from the state shape or makes it nullable
    // with a non-zero sentinel. The `?? 0` fallback in the collector
    // must continue to mean "don't fire when uncertain".
    getAgentContextMock.mockReturnValue({
      agentId: 'main',
      streamConversationId: 'conv',
      systemPromptLayers: undefined,
    })
    stubStreamWithToolUse()
    const state = makeMinimalState({
      iteration: 5,
      _compactionReminderInjected: false,
    })
    // Override the ctx manager to return a state WITHOUT usagePercentOfWindow.
    state.loopContextManager.getState = () => ({ level: 'idle' })

    await runAgenticIteration(state, makeMinimalParams(), 'sys')

    expect(state._compactionReminderInjected).toBe(false)
  })

  it('does NOT fire on iteration 1 even when usage is high', async () => {
    getAgentContextMock.mockReturnValue({
      agentId: 'main',
      streamConversationId: 'conv',
      systemPromptLayers: undefined,
    })
    stubStreamWithToolUse()
    const state = makeMinimalState({
      iteration: 1,
      usagePercentOfWindow: 80,
      _compactionReminderInjected: false,
    })

    await runAgenticIteration(state, makeMinimalParams(), 'sys')

    expect(state._compactionReminderInjected).toBe(false)
  })

  it('does NOT fire for sub-agents', async () => {
    getAgentContextMock.mockReturnValue({
      agentId: 'sub-agent-1',
      streamConversationId: 'conv-sub',
      systemPromptLayers: undefined,
    })
    stubStreamWithToolUse()
    const state = makeMinimalState({
      iteration: 10,
      usagePercentOfWindow: 80,
      _compactionReminderInjected: false,
    })

    await runAgenticIteration(state, makeMinimalParams(), 'sys')

    expect(state._compactionReminderInjected).toBe(false)
  })

  it('is idempotent — does not re-fire when flag is already set', async () => {
    getAgentContextMock.mockReturnValue({
      agentId: 'main',
      streamConversationId: 'conv',
      systemPromptLayers: undefined,
    })
    stubStreamWithToolUse()
    const state = makeMinimalState({
      iteration: 10,
      usagePercentOfWindow: 80,
      _compactionReminderInjected: true,
    })

    await runAgenticIteration(state, makeMinimalParams(), 'sys')

    const reminderCount = state.apiMessages.filter((m) => {
      if (m.role !== 'user') return false
      const c = m.content
      return (
        typeof c === 'string' &&
        c.includes('Automatic context management is active')
      )
    }).length
    expect(reminderCount).toBe(0)
  })

  it('does NOT fire in the no-tool-use branch (model returned text only)', async () => {
    // Phase A: the collector only runs at `post_tool`. A turn that
    // produces NO tool_use terminates in the noTools branch and never
    // reaches the orchestrator call site — confirming the upstream
    // semantics that the reminder is a "system note attached to the
    // prior tool batch", not a turn-end nag.
    getAgentContextMock.mockReturnValue({
      agentId: 'main',
      streamConversationId: 'conv',
      systemPromptLayers: undefined,
    })
    // No stubStreamWithToolUse() — default stream returns no tool_use.
    const state = makeMinimalState({
      iteration: 5,
      usagePercentOfWindow: 80,
      _compactionReminderInjected: false,
    })

    await runAgenticIteration(state, makeMinimalParams(), 'sys')

    expect(state._compactionReminderInjected).toBe(false)
    expect(hasCompactionReminderInMessages(state.apiMessages)).toBe(false)
  })

  it('does NOT inject the deleted ITERATION BUDGET / ITERATION LIMIT directives', async () => {
    // Regression guard: the upstream-divergent wrap-up directives are
    // gone. If anything reintroduces them this test fails loudly.
    getAgentContextMock.mockReturnValue({
      agentId: 'main',
      streamConversationId: 'conv',
      systemPromptLayers: undefined,
    })
    stubStreamWithToolUse()
    const state = makeMinimalState({
      iteration: 90,
      maxIterations: 100,
      usagePercentOfWindow: 80,
    })

    await runAgenticIteration(state, makeMinimalParams(), 'sys')

    const hasWrapUp = state.apiMessages.some((m) => {
      if (m.role !== 'user') return false
      const c = m.content
      return (
        typeof c === 'string' &&
        (c.includes('ITERATION BUDGET') || c.includes('ITERATION LIMIT'))
      )
    })
    expect(hasWrapUp).toBe(false)
  })
})

// ─── 8. Kernel inbox drain (via hostAttachments at post_tool) ─────────
//
// Phase B migration: the drain moved from iter-top to the
// `runCollectors` orchestrator at `post_tool`. Tests now stub a
// tool_use stream pass so the iteration reaches the post-tool
// position where the collector runs.

describe('runAgenticIteration — kernel inbox drain', () => {
  it('appends the drained text as a side-channel user message at post_tool', async () => {
    stubStreamWithToolUse()
    const stateRef: { current?: ReturnType<typeof makeMinimalState> } = {}
    const drain = vi.fn(() =>
      makeInboxSnapshot(stateRef.current!.apiMessages, '   external nudge   '),
    )
    const state = makeMinimalState({ hostTranscriptDrain: drain })
    stateRef.current = state
    const beforeCount = state.apiMessages.length

    await runAgenticIteration(state, makeMinimalParams(), 'sys')

    // Audit fix R2-H3 / R4-H1 (2026-05): the kernel inbox text is
    // wrapped in the canonical `<system-reminder>` side-channel
    // envelope (with `_convertedFromSystem: true` and
    // `_sideChannelKind: generic_converted_system`) rather than
    // being dropped raw as a user message. Look for the wrapped
    // form so the main agent can distinguish kernel-injected text
    // from human input.
    const found = state.apiMessages.some((m) => {
      if (m.role !== 'user') return false
      if (m._convertedFromSystem !== true) return false
      const content = typeof m.content === 'string' ? m.content : ''
      return content.includes('external nudge') && content.includes('<system-reminder>')
    })
    expect(found).toBe(true)
    expect(state.apiMessages.length).toBeGreaterThan(beforeCount)
  })

  it('ignores empty drain payload', async () => {
    stubStreamWithToolUse()
    const state = makeMinimalState({
      hostTranscriptDrain: vi.fn(() => ({ injected: false })),
    })
    const beforeCount = state.apiMessages.length

    await runAgenticIteration(state, makeMinimalParams(), 'sys')

    expect(state.apiMessages.length).toBeGreaterThanOrEqual(beforeCount)
  })

  it('does NOT fire when the no-tool branch terminates (end path)', async () => {
    // When the model replies text-only AND the no-tool branch decides to
    // END (completed), the iteration terminates without reaching either the
    // post_tool collectors OR the no_tools_continue collectors, so the inbox
    // stays full. (P1 audit added a `no_tools_continue` call site, but it
    // only runs on the CONTINUE path — see the dedicated suite below.)
    const drainFn = vi.fn<() => AgentLoopInboxDrainResult>(() => ({ injected: false }))
    const state = makeMinimalState({ hostTranscriptDrain: drainFn })

    await runAgenticIteration(state, makeMinimalParams(), 'sys')

    const found = state.apiMessages.some(
      (m) => m.role === 'user' && m.content === 'late nudge',
    )
    expect(found).toBe(false)
    // Drain never called either (collector short-circuits before
    // invoking the callback when call-site doesn't match).
    expect(drainFn).not.toHaveBeenCalled()
  })
})

// ─── 8a. 阶段 1 — kernelLoopPort mid-iteration persistence ────────────
//
// Replaces the former global `getOrchestrationKernelForConversation`
// service-locator. The kernel injects `state.kernelLoopPort` via
// driveInnerLoop; the inner iteration calls `persistThrottled` once per
// iteration (after the pre-stream abort gate, before the phase pipeline).

describe('runAgenticIteration — kernelLoopPort persistence (阶段 1)', () => {
  it('calls persistThrottled once with the loop soft-cap counters', async () => {
    const persistThrottled = vi.fn()
    const state = makeMinimalState({ kernelLoopPort: { persistThrottled } })
    ;(state as unknown as { maxOutputRecoveryCycles: number }).maxOutputRecoveryCycles = 2
    ;(state as unknown as { consecutiveCompactFailures: number }).consecutiveCompactFailures = 1

    await runAgenticIteration(state, makeMinimalParams(), 'sys')

    expect(persistThrottled).toHaveBeenCalledTimes(1)
    expect(persistThrottled).toHaveBeenCalledWith({
      maxOutputRecoveryCycles: 2,
      consecutiveCompactFailures: 1,
    })
  })

  it('does not throw when no kernelLoopPort is injected (non-kernel callers)', async () => {
    const state = makeMinimalState() // no port (sub-agents / legacy / tests)

    await expect(
      runAgenticIteration(state, makeMinimalParams(), 'sys'),
    ).resolves.toBeDefined()
  })

  it('does NOT call persistThrottled when the iteration aborts before the persist site', async () => {
    // Signal already aborted → the pre-stream abort gate returns BEFORE the
    // persist call site, so the port must not be invoked.
    const persistThrottled = vi.fn()
    const ac = new AbortController()
    ac.abort()
    const state = makeMinimalState({ signal: ac.signal, kernelLoopPort: { persistThrottled } })

    await runAgenticIteration(state, makeMinimalParams(), 'sys')

    expect(persistThrottled).not.toHaveBeenCalled()
  })
})

// ─── 8b. no_tools_continue collectors (P1 audit) ──────────────────────
//
// Fix under test: a no-tool turn that decides to CONTINUE (stop-hook /
// token-budget / guard nudge) previously skipped ALL post_tool collectors
// because the continue branch returns before reaching them — starving
// queued inbox items / task notifications / sub-agent digests until the
// next tool batch. The fix runs the inbox/notifications/digest collectors
// at a new `no_tools_continue` call site, and (critically) preserves the
// silent-stop invariant: the continuation directive must stay the
// transcript tail, so collector messages are inserted BEFORE it.
//
// These tests run the REAL collectors (runCollectors is not mocked); the
// `kernel_inbox` collector is driven via `state.hostTranscript.drainInbox` to prove
// the call site fires and to exercise the pop/re-push ordering.

describe('runAgenticIteration — no_tools_continue collectors (P1 audit)', () => {
  it('runs the inbox collectors on the no-tool continue path AND keeps the directive at the tail', async () => {
    // Reproduce the real `handleNoToolsBranch` continue side effects: push
    // the assistant reply, then the continuation directive as the tail.
    let appendedDirective: Record<string, unknown> | undefined
    handleNoToolsBranchMock.mockImplementationOnce(
      async (state: { apiMessages: Array<Record<string, unknown>> }) => {
        state.apiMessages.push({
          role: 'assistant',
          content: [{ type: 'text', text: 'thinking out loud, will keep waiting' }],
        })
        const directiveMsg: Record<string, unknown> = {
          role: 'user',
          content: '[directive] keep going',
          _convertedFromSystem: true,
        }
        appendedDirective = directiveMsg
        state.apiMessages.push(directiveMsg)
        return { action: 'continue', appendedDirective: directiveMsg }
      },
    )
    // `kernel_inbox` is one of the no_tools_continue-tagged collectors.
    const stateRef: { current?: ReturnType<typeof makeMinimalState> } = {}
    const drain = vi.fn(() =>
      makeInboxSnapshot(
        appendedDirective
          ? [...stateRef.current!.apiMessages, structuredClone(appendedDirective)]
          : stateRef.current!.apiMessages,
        'queued external nudge',
      ),
    )
    const state = makeMinimalState({ iteration: 2, hostTranscriptDrain: drain })
    stateRef.current = state

    const outcome = await runAgenticIteration(state, makeMinimalParams(), 'sys')

    expect(outcome.kind).toBe('continue')
    // (1) The collector actually ran on the no-tool continue path.
    expect(drain).toHaveBeenCalledTimes(1)
    const inboxIdx = state.apiMessages.findIndex(
      (m) =>
        m.role === 'user' &&
        typeof m.content === 'string' &&
        (m.content as string).includes('queued external nudge'),
    )
    expect(inboxIdx).toBeGreaterThanOrEqual(0)
    // (2) Silent-stop invariant preserved: the continuation directive is
    //     STILL the transcript tail.
    const tail = state.apiMessages[state.apiMessages.length - 1]
    expect(tail.content).toBe('[directive] keep going')
    // (3) The injected collector content lands BEFORE the directive.
    expect(inboxIdx).toBeLessThan(state.apiMessages.length - 1)
    // The tool-execution branch must never run on the no-tool path.
    expect(executeToolBatchMock).not.toHaveBeenCalled()
  })

  it('runs the collectors on a continue with no directive (appendedDirective undefined)', async () => {
    // The inter-agent-injected continue case has no trailing directive —
    // the guarded lift must skip the pop and append collector content at
    // the tail.
    handleNoToolsBranchMock.mockImplementationOnce(
      async (state: { apiMessages: Array<Record<string, unknown>> }) => {
        state.apiMessages.push({
          role: 'assistant',
          content: [{ type: 'text', text: 'reply' }],
        })
        return { action: 'continue' }
      },
    )
    const stateRef: { current?: ReturnType<typeof makeMinimalState> } = {}
    const drain = vi.fn(() =>
      makeInboxSnapshot(stateRef.current!.apiMessages, 'inbox after assistant'),
    )
    const state = makeMinimalState({ iteration: 2, hostTranscriptDrain: drain })
    stateRef.current = state

    await runAgenticIteration(state, makeMinimalParams(), 'sys')

    expect(drain).toHaveBeenCalledTimes(1)
    const tail = state.apiMessages[state.apiMessages.length - 1]
    expect(
      typeof tail.content === 'string' &&
        (tail.content as string).includes('inbox after assistant'),
    ).toBe(true)
  })

  it('does NOT run the no_tools_continue collectors when the no-tool branch ENDS', async () => {
    // Default handleNoToolsBranchMock returns { action: 'end' } → terminate,
    // so the continue-only collector call site is never reached.
    const drain = vi.fn<() => AgentLoopInboxDrainResult>(() => ({ injected: false }))
    const state = makeMinimalState({ iteration: 2, hostTranscriptDrain: drain })

    const outcome = await runAgenticIteration(state, makeMinimalParams(), 'sys')

    expect(outcome.kind).toBe('terminate')
    expect(drain).not.toHaveBeenCalled()
    const found = state.apiMessages.some(
      (m) =>
        typeof m.content === 'string' &&
        (m.content as string).includes('should not drain'),
    )
    expect(found).toBe(false)
  })
})

// ─── 9. pendingToolUseSummary injection ───────────────────────────────

describe('runAgenticIteration — pendingToolUseSummary', () => {
  it('injects resolved tool-use summary as a standalone toolUseSummary side-channel message (audit R4-L7)', async () => {
    const resolvedSummary = {
      summary: 'SUMMARY_TEXT',
      generatedAt: Date.now(),
      toolNames: ['read_file'],
    }
    const state = makeMinimalState({
      pendingToolUseSummary: Promise.resolve(resolvedSummary),
      apiMessages: [{ role: 'user', content: 'original' }],
    })

    await runAgenticIteration(state, makeMinimalParams(), 'sys')

    // Self-audit fix R2-F (2026-05): the prior assertion accepted both
    // the old `concat_to_last_user` shape (summary text appended onto
    // ANY user message) and the new `push_message` shape (standalone
    // toolUseSummary side-channel). A revert of the R4-L7 fix would
    // pass either way. Pin the assertion to the new contract:
    //   1. SOME user message body must reference the summary text, AND
    //   2. there must exist a `_sideChannelKind === toolUseSummary`
    //      message (proves the collector emitted as `push_message`,
    //      not the legacy `concat_to_last_user`).
    const found = state.apiMessages.some((m) => {
      if (m.role !== 'user') return false
      const c = m.content
      if (typeof c === 'string') return c.includes('SUMMARY_TEXT')
      if (Array.isArray(c)) {
        return c.some(
          (b) =>
            (b as { type?: string; text?: string }).type === 'text' &&
            typeof (b as { text?: string }).text === 'string' &&
            (b as { text: string }).text.includes('SUMMARY_TEXT'),
        )
      }
      return false
    })
    expect(found).toBe(true)

    // Pre-merge marker: the collector pushed a message with
    // `_sideChannelKind: SIDE_CHANNEL_KIND.toolUseSummary` (R4-L7).
    // Without the fix, the collector used `concat_to_last_user` and
    // NO message in the array would carry this discriminator.
    const hasSideChannelMessage = state.apiMessages.some(
      (m) => (m as Record<string, unknown>)._sideChannelKind === 'tool_use_summary',
    )
    expect(hasSideChannelMessage).toBe(true)

    expect(state.pendingToolUseSummary).toBeNull() // consumed
  })

  it('clears pendingToolUseSummary even when the promise rejects', async () => {
    const state = makeMinimalState({
      pendingToolUseSummary: Promise.reject(new Error('summary failed')),
    })

    await runAgenticIteration(state, makeMinimalParams(), 'sys')

    expect(state.pendingToolUseSummary).toBeNull()
  })
})

// ─── 11. P1 decision-table boundaries — wired-up edge cases ───────────
//
// These three cases lock in the iteration-body integration of
// `decideIterationOutcome`:
//
//   1. The post-tool abort gate auto-promotes to `max_turns` when the
//      iteration counter has already reached `maxIterations`. Pre-P1
//      this was the `redirectAbortToMaxTurnsIfExhausted` helper; now
//      it's `IterationDecisionSignals.postToolAbort.iterationExhausted`.
//   2. The `stop_hook_circuit_breaker` exit comes through the
//      orchestrator path (noTools → decideIterationOutcome → applyOutcome
//      with `caller_writes_termination` strategy) instead of the legacy
//      noTools-local terminal write. Verifies the unified cleanup
//      pipeline.
//   3. Inter-agent + token-budget signals both present must produce a
//      continue (sub-agent only); main-chat where both end up false
//      cleanly terminates as `completed`. Exercises the no-tool-use row
//      table rather than just one row at a time.

describe('runAgenticIteration — P1 unified decision integration', () => {
  it('post-tool abort with exhausted budget terminates as aborted_tools (SA-2 fix 3: cancel wins over max_turns)', async () => {
    // Pre-SA-2 the exhausted-budget abort was redirected to `max_turns`
    // (legacy `redirectAbortToMaxTurnsIfExhausted` semantics). Fix 3
    // unified abort semantics: user cancellation always reports the
    // cancel reason, even on the last allowed iteration. We let stream +
    // tool batch run cleanly, then trip abort just before the post-tool
    // gate inside `executeToolBatch` so the gate sees
    // `signal.aborted === true`.
    stubStreamWithToolUse()
    const ac = new AbortController()
    const state = makeMinimalState({ iteration: 5, signal: ac.signal })
    state.maxIterations = 5
    executeToolBatchMock.mockImplementationOnce(async () => {
      ac.abort()
      return {
        apiMessages: state.apiMessages,
        activeInlineSkillSession: null,
        discoveryExclude: new Set<string>(),
        pendingToolUseSummary: null,
      }
    })
    const onMaxIterationsReached = vi.fn()
    state.callbacks.onMaxIterationsReached = onMaxIterationsReached

    await runAgenticIteration(state, makeMinimalParams(), 'sys')

    expect(state.terminationResult).toMatchObject({ reason: 'aborted_tools' })
    expect(onMaxIterationsReached).not.toHaveBeenCalled()
  })

  it('post-tool abort with budget remaining terminates as aborted_tools (not max_turns)', async () => {
    // Sibling case to the one above: when the counter is BELOW
    // maxIterations, the same `postToolAbort` signal flows to the
    // `aborted_tools` row instead of `max_turns`.
    stubStreamWithToolUse()
    const ac = new AbortController()
    const state = makeMinimalState({ iteration: 2, signal: ac.signal })
    state.maxIterations = 5
    executeToolBatchMock.mockImplementationOnce(async () => {
      ac.abort()
      return {
        apiMessages: state.apiMessages,
        activeInlineSkillSession: null,
        discoveryExclude: new Set<string>(),
        pendingToolUseSummary: null,
      }
    })
    const onMaxIterationsReached = vi.fn()
    state.callbacks.onMaxIterationsReached = onMaxIterationsReached

    await runAgenticIteration(state, makeMinimalParams(), 'sys')

    expect(state.terminationResult).toMatchObject({ reason: 'aborted_tools' })
    expect(onMaxIterationsReached).not.toHaveBeenCalled()
  })

  it('preStreamAbort flows through applyOutcome (single onMessageEnd + cleanup)', async () => {
    // Smoke test for the most common abort path: signal already aborted
    // at iteration entry → row 1 of the decision table → terminate as
    // aborted_streaming. The unified path should fire onMessageEnd
    // EXACTLY ONCE and create exactly one terminationResult.
    const ac = new AbortController()
    ac.abort()
    const state = makeMinimalState({ signal: ac.signal })
    const onMessageEnd = vi.fn()
    const onError = vi.fn()
    state.callbacks.onMessageEnd = onMessageEnd
    state.callbacks.onError = onError

    await runAgenticIteration(state, makeMinimalParams(), 'sys')

    expect(state.terminationResult).toMatchObject({ reason: 'aborted_streaming' })
    // No `onError` for clean aborts — only error-y terminal reasons fire it.
    expect(onError).not.toHaveBeenCalled()
    expect(onMessageEnd).toHaveBeenCalledTimes(1)
  })
})

// ─── 12. SA-2 fix 1 — toolTokensForContext computed before preModel ───

describe('runAgenticIteration — toolTokensForContext timing (SA-2 fix 1)', () => {
  it('computes toolTokensForContext/toolsForApi BEFORE runPreModelPhase reads them', async () => {
    const toolDefs = [{ name: 'read_file', description: 'd', input_schema: {} }]
    vi.mocked(estimateToolDefinitionsTokens).mockReturnValue(42)

    let toolTokensSeenByPreModel: number | undefined
    let toolsForApiSeenByPreModel: unknown
    runPreModelPhaseMock.mockImplementationOnce(
      async ({ state }: { state: { apiMessages: Array<Record<string, unknown>>; toolTokensForContext: number; toolsForApi: unknown } }) => {
        toolTokensSeenByPreModel = state.toolTokensForContext
        toolsForApiSeenByPreModel = state.toolsForApi
        return {
          apiMessages: state.apiMessages,
          wasPreModelCompacted: false,
          contextLevelAfter: undefined,
          snippedCount: 0,
          pipelinePhases: [],
          idleToolClearApplied: false,
          terminated: false,
        }
      },
    )

    const state = makeMinimalState()
    ;(state as unknown as { baseToolDefinitions: unknown[] }).baseToolDefinitions = toolDefs

    await runAgenticIteration(state, makeMinimalParams(), 'sys')

    // Pre-fix, preModel saw the PREVIOUS iteration's value (0 here).
    expect(toolTokensSeenByPreModel).toBe(42)
    expect(toolsForApiSeenByPreModel).toBe(toolDefs)
    // Computed exactly once per iteration — the old post-normalize
    // recomputation was removed.
    expect(estimateToolDefinitionsTokens).toHaveBeenCalledTimes(1)
  })

  it('disableToolsForThisTurn zeroes the precomputed slots', async () => {
    const toolDefs = [{ name: 'read_file', description: 'd', input_schema: {} }]
    vi.mocked(estimateToolDefinitionsTokens).mockReturnValue(42)
    const state = makeMinimalState()
    ;(state as unknown as { baseToolDefinitions: unknown[] }).baseToolDefinitions = toolDefs
    state.callbacks.onQueryLoopPreModel = vi.fn(() => ({ disableToolsForThisTurn: true }))

    await runAgenticIteration(state, makeMinimalParams(), 'sys')

    expect((state as unknown as { toolTokensForContext: number }).toolTokensForContext).toBe(0)
    expect((state as unknown as { toolsForApi: unknown }).toolsForApi).toBeUndefined()
  })
})

// ─── 13. SA-2 fix 2 — duplicate tool_use id repair ────────────────────

describe('repairDuplicateToolUseIds (SA-2 fix 2)', () => {
  const toolUse = (id: string) => ({ type: 'tool_use', id, name: 'read_file', input: {} })
  const toolResult = (id: string) => ({ type: 'tool_result', tool_use_id: id, content: 'ok' })

  it('renames later duplicates and rewrites their paired tool_results in order', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const msgs: Array<Record<string, unknown>> = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [toolUse('a'), toolUse('a'), toolUse('b'), toolUse('a')] },
      { role: 'user', content: [toolResult('a'), toolResult('a'), toolResult('b'), toolResult('a')] },
    ]

    const repaired = repairDuplicateToolUseIds(msgs)

    expect(repaired).toBe(true)
    const aIds = (msgs[1].content as Array<{ id: string }>).map((b) => b.id)
    expect(aIds).toEqual(['a', 'a__dup1', 'b', 'a__dup2'])
    const rIds = (msgs[2].content as Array<{ tool_use_id: string }>).map((b) => b.tool_use_id)
    expect(rIds).toEqual(['a', 'a__dup1', 'b', 'a__dup2'])
    // No duplicates remain and every tool_use has a matching tool_result.
    expect(new Set(aIds).size).toBe(aIds.length)
    expect(new Set(rIds)).toEqual(new Set(aIds))
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('auto-repaired'))
    errSpy.mockRestore()
  })

  it('returns false and performs zero writes when there are no duplicates', () => {
    const assistant = { role: 'assistant', content: [toolUse('a'), toolUse('b')] }
    const user = { role: 'user', content: [toolResult('a'), toolResult('b')] }
    const msgs: Array<Record<string, unknown>> = [assistant, user]

    const repaired = repairDuplicateToolUseIds(msgs)

    expect(repaired).toBe(false)
    // Same object references — copy-on-write only happens on repair.
    expect(msgs[0]).toBe(assistant)
    expect(msgs[1]).toBe(user)
  })

  it('leaves an unmatched renamed duplicate unpaired (ensureToolUseResultPairing backfills downstream)', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const msgs: Array<Record<string, unknown>> = [
      { role: 'assistant', content: [toolUse('a'), toolUse('a')] },
      { role: 'user', content: [toolResult('a')] },
    ]

    const repaired = repairDuplicateToolUseIds(msgs)

    expect(repaired).toBe(true)
    const aIds = (msgs[0].content as Array<{ id: string }>).map((b) => b.id)
    expect(aIds).toEqual(['a', 'a__dup1'])
    // The single tool_result stays paired with the kept first tool_use.
    const rIds = (msgs[1].content as Array<{ tool_use_id: string }>).map((b) => b.tool_use_id)
    expect(rIds).toEqual(['a'])
    errSpy.mockRestore()
  })

  it('only rewrites tool_results within the pairing window (stops at the next assistant turn)', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const laterResult = toolResult('a')
    const msgs: Array<Record<string, unknown>> = [
      { role: 'assistant', content: [toolUse('a'), toolUse('a')] },
      { role: 'user', content: [toolResult('a'), toolResult('a')] },
      { role: 'assistant', content: [{ type: 'text', text: 'next turn' }] },
      { role: 'user', content: [laterResult] },
    ]

    repairDuplicateToolUseIds(msgs)

    const rIds = (msgs[1].content as Array<{ tool_use_id: string }>).map((b) => b.tool_use_id)
    expect(rIds).toEqual(['a', 'a__dup1'])
    // The tool_result beyond the next assistant turn is untouched.
    expect((msgs[3].content as Array<{ tool_use_id: string }>)[0].tool_use_id).toBe('a')
    errSpy.mockRestore()
  })

  it('integration: runAgenticIteration repairs duplicates in state.apiMessages before the stream phase', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const state = makeMinimalState({
      apiMessages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: [toolUse('dup_x'), toolUse('dup_x')] },
        { role: 'user', content: [toolResult('dup_x'), toolResult('dup_x')] },
      ],
    })

    await runAgenticIteration(state, makeMinimalParams(), 'sys')

    const allToolUseIds: string[] = []
    for (const m of state.apiMessages) {
      if (m.role !== 'assistant' || !Array.isArray(m.content)) continue
      for (const b of m.content as Array<Record<string, unknown>>) {
        if (b.type === 'tool_use' && typeof b.id === 'string') allToolUseIds.push(b.id)
      }
    }
    expect(allToolUseIds).toEqual(['dup_x', 'dup_x__dup1'])
    expect(new Set(allToolUseIds).size).toBe(allToolUseIds.length)
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('auto-repaired'))
    errSpy.mockRestore()
  })
})

// NOTE: an outer-driver test for `runAgenticLoop` (while loop + finaliseMaxIterations)
// is intentionally omitted here. The outer driver is a thin while-wrapper and is already
// covered by `driveInnerLoop.test.ts`, which mocks `runAgenticIteration` and verifies
// the equivalent while + finaliseMaxIterations sequence. Adding a parallel test would
// require either booting the real `initialiseLoopState` (heavy, brittle) or mocking
// `setupAgenticLoopForRun` (which is what driveInnerLoop.test.ts already does).
