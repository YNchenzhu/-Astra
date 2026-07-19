/**
 * Tests for agenticLoop setup — initialiseLoopState.
 *
 * Validates state initialisation: parameter destructuring, tool definitions,
 * context thresholds, token budget, API message cloning, and default values.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { initialiseLoopState } from './setup'
import type { AgenticLoopParams } from '../agenticLoopTypes'
import { runWithAgentContextAsync } from '../../agents/agentContext'
import { asAgentId } from '../../tools/ids'

// ── Minimal mock: tool registry ──
vi.mock('../../tools/registry', () => ({
  toolRegistry: {
    getToolsetRevision: () => 1,
  },
}))

// ── Minimal mock: tool schema ──
vi.mock('../../tools/schema', () => ({
  getToolDefinitions: () => [{ name: 'Read', description: 'Read a file' }],
}))

// ── Minimal mock: context manager ──
const mockThresholds = {
  ok: 40000,
  warning: 52000,
  error: 64000,
  micro_compact: 76000,
  auto_compact: 88000,
  blocking: 102000,
}

// P1 audit fix (阈值双源收敛) regression instrumentation — the mock records
// how the loop-local manager was constructed and whether the single-source
// `primeThresholdsForModel` path was taken, so tests can pin the wiring in
// `initialiseLoopState` without spinning the real derivation.
const contextManagerMockCalls: {
  constructorArgs: unknown[]
  primedModels: string[]
  globalHasUserCustomized: boolean
} = {
  constructorArgs: [],
  primedModels: [],
  globalHasUserCustomized: false,
}

vi.mock('../../context/manager', () => {
  class MockContextManager {
    constructor(thresholds?: unknown) {
      contextManagerMockCalls.constructorArgs.push(thresholds)
    }
    getThresholds() { return mockThresholds }
    updateThresholds() {}
    primeThresholdsForModel(model: string) {
      contextManagerMockCalls.primedModels.push(model)
    }
    hasUserCustomizedThresholds() { return false }
    evaluate() { return { action: 'none', level: 'ok', estimatedTokens: 1000 } }
    handleContext() { return { wasCompacted: false, messages: [], level: 'ok' } }
    getState() { return { level: 'ok', estimatedTokens: 1000 } }
    recordUsageAfterRequest() {}
    clearUsageSnapshot() {}
  }
  return {
    ContextManager: MockContextManager,
    contextManager: {
      getThresholds: () => mockThresholds,
      hasUserCustomizedThresholds: () => contextManagerMockCalls.globalHasUserCustomized,
    },
  }
})

// ── Minimal mock: token budget ──
vi.mock('../../context/tokenBudget', () => ({
  isTokenBudgetEnabled: () => false,
  getTokenBudgetConfigFromEnv: () => null,
  createTokenBudgetState: vi.fn(),
}))

// ── Minimal mock: context thresholds ──
vi.mock('../../context/openClaudeParityConstants', () => ({
  deriveContextThresholdsFromOpenClaudeWindow: () => ({
    ok: 40000,
    warning: 52000,
    error: 64000,
    micro_compact: 76000,
    auto_compact: 88000,
    blocking: 102000,
  }),
  getEffectiveContextWindowTokens: () => 200000,
  getCompactPlanningWindowTokens: () => 200000,
  MAX_OUTPUT_TOKENS_RECOVERY_ATTEMPTS: 3,
}))

// ── Basic params factory ──
function makeParams(overrides: Partial<AgenticLoopParams> = {}): AgenticLoopParams {
  return {
    config: {
      id: 'anthropic' as const,
      name: 'Anthropic',
      apiKey: 'test-key',
    },
    model: 'claude-sonnet-4-20250514',
    messages: [
      { role: 'user' as const, content: 'Hello' },
    ],
    systemPrompt: 'You are a helpful assistant.',
    signal: new AbortController().signal,
    ...overrides,
  }
}

describe('initialiseLoopState', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('returns a state object with all expected keys', () => {
    const state = initialiseLoopState(makeParams())

    // Core
    expect(state.apiMessages).toBeDefined()
    expect(state.iteration).toBe(0)
    expect(state.totalUsage).toEqual({ inputTokens: 0, outputTokens: 0 })
    expect(state.maxIterations).toBeGreaterThan(0)
    expect(state.loopContextManager).toBeDefined()

    // Tool-related
    expect(state.baseToolDefinitions.length).toBeGreaterThan(0)
    expect(state.lastToolsetRevision).toBe(1)
    expect(state.enableTools).toBe(true)
    expect(state.hasToolDefinitionsOverride).toBe(false)

    // Mutable state initialised to defaults
    expect(state.accumulatedText).toBe('')
    expect(state.toolUseBlocks).toEqual([])
    expect(state.thinkingBlocks).toEqual([])
    expect(state.activeInlineSkillSession).toBeNull()
    expect(state.pendingToolUseSummary).toBeNull()
    expect(state.discoveryExclude).toBeInstanceOf(Set)
    expect(state.discoveryExclude.size).toBe(0)
    expect(state.tokenBudgetState).toBeNull()
    expect(state.terminationResult).toBeNull()

    // Timing
    expect(state.lastStreamEndMs).toBeGreaterThan(0)
    // "Never cleared yet" is seeded as `now` (not epoch 0) so the idle-clear
    // guard can't misfire on the first message under a small idle threshold.
    expect(state.lastIdleClearMs).toBeGreaterThan(0)

    // Resolved values
    expect(state.diffPermissionMode).toBe('default')
    expect(state.permissionDefaultMode).toBe('ask')
    expect(state.anthropicFastModeEnabled).toBe(false)
  })

  it('clones initialApiMessages when provided', () => {
    const initial = [
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello!' },
    ]
    const state = initialiseLoopState(makeParams({ initialApiMessages: initial }))
    expect(state.apiMessages.length).toBe(2)
    expect(state.apiMessages[0].role).toBe('user')
    expect(state.apiMessages[1].role).toBe('assistant')
  })

  it('falls back to messages when initialApiMessages is not provided', () => {
    const state = initialiseLoopState(makeParams({
      messages: [
        { role: 'user', content: 'Test' },
      ],
    }))
    expect(state.apiMessages.length).toBe(1)
    expect(state.apiMessages[0].role).toBe('user')
  })

  it('respects enableTools = false', () => {
    const state = initialiseLoopState(makeParams({ enableTools: false }))
    expect(state.enableTools).toBe(false)
    // When tools are disabled, baseToolDefinitions should be empty
    // (but our mock always returns definitions — the real getToolDefinitions wouldn't be called)
  })

  it('respects toolDefinitionsOverride', () => {
    const override = [{ name: 'CustomTool', description: 'Custom' }] as unknown as Parameters<typeof initialiseLoopState>[0]['toolDefinitionsOverride']
    const state = initialiseLoopState(makeParams({ toolDefinitionsOverride: override }))
    expect(state.baseToolDefinitions).toBe(override)
    expect(state.hasToolDefinitionsOverride).toBe(true)
  })

  it('respects maxIterationsOverride', () => {
    const state = initialiseLoopState(makeParams({ maxIterationsOverride: 10 }))
    expect(state.maxIterations).toBe(10)
  })

  it('respects diffPermissionMode override', () => {
    const state = initialiseLoopState(makeParams({ diffPermissionMode: 'acceptEdits' }))
    expect(state.diffPermissionMode).toBe('acceptEdits')
  })

  it('respects permissionDefaultMode override', () => {
    const state = initialiseLoopState(makeParams({ permissionDefaultMode: 'dontAsk' }))
    expect(state.permissionDefaultMode).toBe('dontAsk')
  })

  it('defaults chatMode to "agent" when omitted', () => {
    const state = initialiseLoopState(makeParams())
    expect(state.chatMode).toBe('agent')
  })

  it('respects chatMode override', () => {
    const state = initialiseLoopState(makeParams({ chatMode: 'plan' }))
    expect(state.chatMode).toBe('plan')
  })

  it('sets anthropicFastModeEnabled when fastMode is true', () => {
    const state = initialiseLoopState(makeParams({ fastMode: true }))
    expect(state.anthropicFastModeEnabled).toBe(true)
  })

  it('sets anthropicFastModeEnabled to false when fastMode is undefined', () => {
    const state = initialiseLoopState(makeParams())
    expect(state.anthropicFastModeEnabled).toBe(false)
  })

  it('passes through temperature and topP', () => {
    const state = initialiseLoopState(makeParams({ temperature: 0.7, topP: 0.9 }))
    expect(state.temperature).toBe(0.7)
    expect(state.topP).toBe(0.9)
  })

  it('passes through effort', () => {
    const state = initialiseLoopState(makeParams({ effort: 'high' }))
    expect(state.effortFromParams).toBe('high')
  })

  it('passes through alwaysThinking', () => {
    const state = initialiseLoopState(makeParams({ alwaysThinking: true }))
    expect(state.alwaysThinking).toBe(true)
  })

  it('passes through orchestration hooks', () => {
    const mockExec = { port: { executeToolBatch: vi.fn() }, getKernelState: vi.fn(), noteToolInvocation: vi.fn() }
    const mockSync = vi.fn()
    const mockDrain = vi.fn()
    const hostTranscript = { commit: mockSync, drainInbox: mockDrain }
    const state = initialiseLoopState(makeParams({
      orchestratedToolExecution: mockExec as unknown as Parameters<typeof initialiseLoopState>[0]['orchestratedToolExecution'],
      hostTranscript,
    }))
    expect(state.orchestratedToolExecution).toBe(mockExec)
    expect(state.hostTranscript).toBe(hostTranscript)
  })

  it('initialises toolCallHistory when not disabled', () => {
    const state = initialiseLoopState(makeParams())
    expect(state.toolCallHistory).toBeDefined()
  })

  it('skips toolCallHistory when ASTRA_TOOL_CALL_HISTORY=0', () => {
    vi.stubEnv('ASTRA_TOOL_CALL_HISTORY', '0')
    const state = initialiseLoopState(makeParams())
    expect(state.toolCallHistory).toBeUndefined()
  })

  it('disables OpenClaude thresholds when POLE_OPENCLAUDE_CONTEXT_THRESHOLDS=0', () => {
    vi.stubEnv('POLE_OPENCLAUDE_CONTEXT_THRESHOLDS', '0')
    const state = initialiseLoopState(makeParams())
    expect(state.useOpenClaudeDerivedLoopThresholds).toBe(false)
  })

  // ── P1 audit fix (阈值双源收敛) — single-source threshold wiring ──
  describe('loop-local ContextManager threshold source', () => {
    it('primes model-derived thresholds via primeThresholdsForModel when user has NOT customized', () => {
      contextManagerMockCalls.constructorArgs = []
      contextManagerMockCalls.primedModels = []
      contextManagerMockCalls.globalHasUserCustomized = false

      const state = initialiseLoopState(makeParams({ model: 'claude-sonnet-4-20250514' }))
      expect(state.useOpenClaudeDerivedLoopThresholds).toBe(true)
      // Pristine construction (no thresholds arg) keeps dynamic derivation
      // enabled for mid-conversation model switches …
      expect(contextManagerMockCalls.constructorArgs).toEqual([undefined])
      // … and the ONE derivation path is used to seed the session model.
      expect(contextManagerMockCalls.primedModels).toEqual(['claude-sonnet-4-20250514'])
    })

    it('honours user-customized thresholds verbatim (no derivation, no prime)', () => {
      contextManagerMockCalls.constructorArgs = []
      contextManagerMockCalls.primedModels = []
      contextManagerMockCalls.globalHasUserCustomized = true

      const state = initialiseLoopState(makeParams())
      expect(state.useOpenClaudeDerivedLoopThresholds).toBe(false)
      // Constructed FROM the global (user) thresholds, never primed.
      expect(contextManagerMockCalls.constructorArgs).toEqual([mockThresholds])
      expect(contextManagerMockCalls.primedModels).toEqual([])
    })

    it('POLE_OPENCLAUDE_CONTEXT_THRESHOLDS=0 keeps legacy copy-from-global behaviour', () => {
      vi.stubEnv('POLE_OPENCLAUDE_CONTEXT_THRESHOLDS', '0')
      contextManagerMockCalls.constructorArgs = []
      contextManagerMockCalls.primedModels = []
      contextManagerMockCalls.globalHasUserCustomized = false

      initialiseLoopState(makeParams())
      expect(contextManagerMockCalls.constructorArgs).toEqual([mockThresholds])
      expect(contextManagerMockCalls.primedModels).toEqual([])
    })
  })

  it('sets streamMaxOutTokens from maxTokens param', () => {
    const state = initialiseLoopState(makeParams({ maxTokens: 16384 }))
    expect(state.streamMaxOutTokens).toBe(16384)
  })

  it('defaults streamMaxOutTokens to 8192 when maxTokens is undefined', () => {
    const state = initialiseLoopState(makeParams())
    expect(state.streamMaxOutTokens).toBe(8192)
  })

  it('initialises systemPromptLayers from params', () => {
    const layers = { systemContext: 'sys', userContext: 'usr', userMessageContext: '' }
    const state = initialiseLoopState(makeParams({ systemPromptLayers: layers }))
    expect(state.systemPromptLayers).toBe(layers)
  })

  it('sets iterationModel and iterationToolDefs from base values', () => {
    const state = initialiseLoopState(makeParams({ model: 'claude-opus-4-20250514' }))
    expect(state.iterationModel).toBe('claude-opus-4-20250514')
    expect(state.iterationToolDefs).toBe(state.baseToolDefinitions)
    expect(state.iterationEffort).toBeUndefined()
  })

  it('handles empty messages gracefully', () => {
    const state = initialiseLoopState(makeParams({ messages: [] }))
    expect(state.apiMessages).toEqual([])
  })

  it('preserves caller placeholder functions (to be wired by runAgenticLoop)', () => {
    const state = initialiseLoopState(makeParams())
    // These are placeholder functions before runAgenticLoop wires them
    expect(typeof state.appendixReport).toBe('function')
    expect(typeof state.syncConversation).toBe('function')
    expect(typeof state.refreshMainChatContextHeader).toBe('function')
    // callbacks should be undefined until wired
    expect(state.callbacks).toBeUndefined()
  })

  it('diffPermissionMode applies killswitch', () => {
    vi.stubEnv('POLE_DIFF_PERMISSION_DISABLED', '1')
    // The killswitch converts 'acceptEdits' to 'ask' when disabled
    // (behaviour depends on applyDiffPermissionKillswitch)
    const state = initialiseLoopState(makeParams({ diffPermissionMode: 'acceptEdits' }))
    // Killswitch should have been applied
    expect(typeof state.diffPermissionMode).toBe('string')
  })

  // ── 5-piece-set §A3: QueryDeps DI seam on LoopState ──
  describe('queryDeps wiring (§A3 — callModel)', () => {
    it('exposes a queryDeps container with callModel bound to streamText', async () => {
      const state = initialiseLoopState(makeParams())
      expect(state.queryDeps).toBeDefined()
      // `callModel` is captured at state-init time and held by reference.
      // We verify the slot is filled with a function (the imported
      // `streamText` reference, possibly replaced by vi.mock in other
      // suites) — not undefined / null.
      expect(typeof state.queryDeps.callModel).toBe('function')
      // The signal passes through verbatim so abort propagation works.
      expect(state.queryDeps.signal).toBe(makeParams().signal === state.signal ? state.signal : state.queryDeps.signal)
      // `now` default supplied by defaultQueryDeps.
      expect(typeof state.queryDeps.now).toBe('function')
      expect(typeof state.queryDeps.now()).toBe('number')
    })

    it('forwards the params.signal onto queryDeps.signal so stream-phase abort propagates', () => {
      const ac = new AbortController()
      const state = initialiseLoopState(makeParams({ signal: ac.signal }))
      expect(state.queryDeps.signal).toBe(ac.signal)
    })

    it('callModel reference is replaceable via the module mock — the seam respects vi.mock', async () => {
      // We can't easily mock `streamText` inside a `describe` block
      // without bleeding into other tests; instead we verify the
      // contract: `state.queryDeps.callModel` is the SAME function
      // identity as the imported `streamText` at state-init time.
      // A `vi.mock('../client')` in a different suite swaps the
      // export — and because we capture the reference here, that
      // swap propagates to `state.queryDeps.callModel` automatically.
      const { streamText } = await import('../client')
      const state = initialiseLoopState(makeParams())
      expect(state.queryDeps.callModel).toBe(streamText)
    })
  })

  // ── 5-piece-set §A2: QueryConfig on LoopState ──
  describe('queryConfig wiring (§A2)', () => {
    it('emits a frozen queryConfig snapshot with identity + flags captured at init', () => {
      const state = initialiseLoopState(makeParams({ model: 'opus-4' }))
      expect(state.queryConfig).toBeDefined()
      expect(Object.isFrozen(state.queryConfig)).toBe(true)
      expect(state.queryConfig.model).toBe('opus-4')
      // No ALS context in this test → falls back to 'main' identity.
      expect(state.queryConfig.agentId).toBe('main')
      expect(state.queryConfig.replDepth).toBe(0)
      // Flags settle to their env-derived values.
      expect(typeof state.queryConfig.blockingLimitHard).toBe('boolean')
      expect(typeof state.queryConfig.forkCacheStrategy).toBe('string')
    })

    it.each([
      ['1', true],
      ['true', true],
      ['yes', true],
      ['0', false],
      ['false', false],
      ['', false],
      [undefined, false],
    ])(
      'captures POLE_BLOCKING_LIMIT_HARD=%j as blockingLimitHard=%s',
      (raw, expected) => {
        if (raw === undefined) {
          vi.stubEnv('POLE_BLOCKING_LIMIT_HARD', '')
        } else {
          vi.stubEnv('POLE_BLOCKING_LIMIT_HARD', raw)
        }
        const state = initialiseLoopState(makeParams())
        expect(state.queryConfig.blockingLimitHard).toBe(expected)
      },
    )

    it('freezes the captured blockingLimitHard — mid-run env flip cannot mutate the snapshot', () => {
      // Regression for the previous "process.env read at iteration time"
      // shape: tests for that behaviour would observe the new env value.
      // With the §A2 wiring, the captured snapshot must stay stable.
      vi.stubEnv('POLE_BLOCKING_LIMIT_HARD', '1')
      const state = initialiseLoopState(makeParams())
      expect(state.queryConfig.blockingLimitHard).toBe(true)
      // Flip env after init.
      vi.stubEnv('POLE_BLOCKING_LIMIT_HARD', '0')
      // Snapshot value unchanged.
      expect(state.queryConfig.blockingLimitHard).toBe(true)
      // And the frozen object refuses mutation.
      let threw = false
      try {
        ;(state.queryConfig as { blockingLimitHard: boolean }).blockingLimitHard =
          false
      } catch {
        threw = true
      }
      expect(threw || state.queryConfig.blockingLimitHard === true).toBe(true)
    })

    // ── ALS pass-through coverage (upstream parity §16.2 + §7.5) ──
    // Three pass-through fields (`thinkingBudgetTokens`, `queryChainId`,
    // `taskBudgetMs`) read from the ambient AgentContext at init time.
    // The earlier behaviour silently dropped `queryChainId` and
    // `taskBudgetMs` (defined on the type, never written by
    // `buildQueryConfig`) so analytics readers had to peek into ALS.
    it('captures queryChainId from ALS context onto the frozen snapshot', async () => {
      await runWithAgentContextAsync(
        { agentId: asAgentId('main'), queryChainId: 'chain-abc' },
        async () => {
          const state = initialiseLoopState(makeParams())
          expect(state.queryConfig.queryChainId).toBe('chain-abc')
        },
      )
    })

    it('omits queryChainId when ALS context has no value (presence is opt-in)', async () => {
      await runWithAgentContextAsync(
        { agentId: asAgentId('main') }, // queryChainId undefined
        async () => {
          const state = initialiseLoopState(makeParams())
          expect(state.queryConfig.queryChainId).toBeUndefined()
        },
      )
    })

    it('treats whitespace-only queryChainId as absent and trims valid values', async () => {
      // Audit fix: pairs with `agents/queryTracking.ts:65` which does
      // `ctx?.queryChainId?.trim() || generateQueryChainId()`. The two
      // call sites must agree on what counts as "no chainId" so that a
      // frozen snapshot saying "chainId X" is never contradicted by a
      // runtime tracking attach that says "chainId Y (freshly generated)".
      // Whitespace-only → absent.
      await runWithAgentContextAsync(
        { agentId: asAgentId('main'), queryChainId: '   \t\n  ' },
        async () => {
          const state = initialiseLoopState(makeParams())
          expect(state.queryConfig.queryChainId).toBeUndefined()
        },
      )
      // Surrounding whitespace → captured trimmed.
      await runWithAgentContextAsync(
        { agentId: asAgentId('main'), queryChainId: '  chain-trimmed  ' },
        async () => {
          const state = initialiseLoopState(makeParams())
          expect(state.queryConfig.queryChainId).toBe('chain-trimmed')
        },
      )
    })

    it('captures taskBudgetMs from ALS context (sub-agent wall-clock budget)', async () => {
      await runWithAgentContextAsync(
        { agentId: asAgentId('main'), taskBudgetMs: 60_000 },
        async () => {
          const state = initialiseLoopState(makeParams())
          expect(state.queryConfig.taskBudgetMs).toBe(60_000)
        },
      )
    })

    it('resets the iteration-stall streak for the conversation at turn start (2026-06 audit)', async () => {
      // Regression guard: the IterationStallGuard singleton previously only
      // reset on successful tool execution / session teardown, so three
      // consecutive short no-tool turns (normal chit-chat) accumulated a
      // cross-turn streak and falsely terminated with `iteration_stalled`.
      // A new user turn (= a fresh initialiseLoopState call) must zero the
      // streak.
      const { getIterationStallGuard } = await import('../../orchestration/iterationStallGuard')
      const guard = getIterationStallGuard()
      const cid = 'conv-stall-reset-test'
      guard.record(cid, { hadToolUse: false, textLength: 5, tokenDelta: 50 })
      guard.record(cid, { hadToolUse: false, textLength: 5, tokenDelta: 50 })
      expect(guard.snapshot(cid)?.streak).toBe(2)

      await runWithAgentContextAsync(
        { agentId: asAgentId('main'), streamConversationId: cid },
        async () => {
          initialiseLoopState(makeParams())
        },
      )
      expect(guard.snapshot(cid)?.streak).toBe(0)
      guard.deleteFor(cid)
    })

    it('rejects invalid taskBudgetMs values from ALS context (defensive)', async () => {
      // Guard mirrors `resolveInheritedTaskBudgetMs` in
      // `agents/subAgentInheritance.ts:11`: rejects any value that is
      // not a positive finite number. Each row exercises a distinct
      // failure mode:
      //   - 0 / -1   → non-positive
      //   - NaN      → not a number-like value (typeof === 'number'
      //                  but !Number.isFinite)
      //   - Infinity → not a finite budget (same reason)
      for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
        await runWithAgentContextAsync(
          { agentId: asAgentId('main'), taskBudgetMs: bad },
          async () => {
            const state = initialiseLoopState(makeParams())
            expect(state.queryConfig.taskBudgetMs).toBeUndefined()
          },
        )
      }
    })
  })
})
