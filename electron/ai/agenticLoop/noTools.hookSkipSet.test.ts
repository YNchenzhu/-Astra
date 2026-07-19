/**
 * P0.4 — per-hook recursion guard via `state.stopHookActive: Set<string>`.
 *
 * Verifies the contract between `handleNoToolsBranch` and
 * `runStopHooks` / `runSubagentStopHooks`:
 *
 *   1. The Set is passed through verbatim as `opts.skipHooks` so the
 *      engine can per-hook short-circuit instead of silencing every
 *      Stop hook in the system.
 *   2. A `blockingError` outcome adds the offending hook name to the
 *      Set (or `'*'` when the outcome has no hookName).
 *   3. A `preventStop` outcome that wins continuation also adds its
 *      name. Other hooks (different names) are NOT added — only the
 *      one that actually fired.
 *
 * The `iteration.test.ts` Set-clear-on-tool-success assertion covers
 * the reset side of the contract (P0.4 reset is the orchestrator's
 * responsibility, not noTools').
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'

// ── Engine mock ──────────────────────────────────────────────────────
const runStopHooksMock = vi.fn()
const runSubagentStopHooksMock = vi.fn()

vi.mock('../../tools/hooks/engine', () => ({
  runStopHooks: (text: string, cwd: string, opts?: unknown) =>
    runStopHooksMock(text, cwd, opts),
  runSubagentStopHooks: (text: string, cwd: string, opts?: unknown) =>
    runSubagentStopHooksMock(text, cwd, opts),
  preventStopContinuationContent: (outcome: { kind: string; appendUserContent?: string }) => {
    if (outcome.kind !== 'preventStop') return null
    const trimmed = outcome.appendUserContent?.trim()
    return trimmed && trimmed.length > 0 ? trimmed : null
  },
}))

// ── Other dependency mocks (kept minimal) ───────────────────────────
vi.mock('../../agents/agentContext', () => ({
  getAgentContext: () => ({ agentId: 'main' }),
}))
vi.mock('../../tools/workspaceState', () => ({
  getWorkspacePath: () => '/tmp/ws',
}))
vi.mock('../agenticLoopHelpers', () => ({
  injectPendingInterAgentQueue: () => false,
}))
vi.mock('../../context/tokenBudget', () => ({
  checkTokenBudget: () => ({ action: 'stop', reason: 'n/a' }),
  recordOutputTokens: vi.fn(),
}))
vi.mock('../queryTermination', () => ({
  createTerminalResult: (reason: string, extra: Record<string, unknown>) => ({
    reason,
    ...extra,
  }),
  runTerminationCleanup: vi.fn(async () => {}),
}))
vi.mock('../../context/tokenUsageAccounting', () => ({
  POLE_CONTEXT_USAGE_MESSAGE_KEY: '__pole_usage__',
  getTokenCountFromUsage: () => 0,
}))
vi.mock('../agenticLoopBuilders', () => ({
  buildNoToolUseAssistantContent: () => [],
}))
vi.mock('../../constants/sideChannelKinds', () => ({
  SIDE_CHANNEL_KIND: {
    stopHookError: 'stop_hook_error',
    genericConvertedSystem: 'generic_converted_system',
  },
  wrapSideChannelBody: (_kind: string, body: string) => body,
  // F2 (2026-06): preventStop / tokenBudget continuations now route through
  // the canonical side-channel envelope. Mirror the real shape minus the wrap.
  makeSideChannelUserMessage: (kind: string, body: string) => ({
    role: 'user',
    content: body,
    _convertedFromSystem: true,
    _sideChannelKind: kind,
  }),
}))

import { handleNoToolsBranch } from './noTools'
import type { LoopState } from './loopShared'

function makeState(opts?: {
  preloaded?: string[]
  signal?: AbortSignal
}): LoopState {
  const set = new Set<string>(opts?.preloaded ?? [])
  return {
    iteration: 1,
    accumulatedText: '',
    apiMessages: [],
    thinkingBlocks: [],
    serverToolUseBlocks: [],
    codeExecutionResultBlocks: [],
    totalUsage: { inputTokens: 0, outputTokens: 0 },
    lastStreamUsageForPole: null,
    signal: opts?.signal ?? new AbortController().signal,
    stopHookActive: set,
    consecutiveStopHookBlocks: 0,
    activeInlineSkillSession: null,
    tokenBudgetState: null,
    transition: 'init',
    // Row 12f (completion-evidence handshake) reads this to decide whether
    // the turn used tools; empty history ⇒ gate never fires in these tests.
    transitionHistory: [],
    callbacks: {
      onMessageEnd: vi.fn(),
      onError: vi.fn(),
      onQueryLoopStopHook: vi.fn(),
    },
    appendixReport: vi.fn(),
    syncConversation: vi.fn(),
    refreshMainChatContextHeader: vi.fn(),
    profiler: {
      startCheckpoint: () => () => {},
    },
    loopContextManager: {
      clearUsageSnapshot: vi.fn(),
    },
  } as unknown as LoopState
}

describe('P0.4: per-hook recursion guard (stopHookActive: Set<string>)', () => {
  beforeEach(() => {
    runStopHooksMock.mockReset()
    runSubagentStopHooksMock.mockReset()
  })

  it('forwards the Set verbatim as opts.skipHooks (main chat)', async () => {
    runStopHooksMock.mockResolvedValue({ kind: 'neutral' })
    const state = makeState({ preloaded: ['lint-hook', 'pytest-hook'] })

    await handleNoToolsBranch(state, {
      accumulatedText: 'done.',
      streamingToolExecutor: null,
      useStreamingToolExecutor: false,
    })

    expect(runStopHooksMock).toHaveBeenCalledTimes(1)
    const callArgs = runStopHooksMock.mock.calls[0]
    expect(callArgs[2]).toMatchObject({
      skipHooks: expect.any(Set),
    })
    const passedSet = (callArgs[2] as { skipHooks: Set<string> }).skipHooks
    expect(passedSet.has('lint-hook')).toBe(true)
    expect(passedSet.has('pytest-hook')).toBe(true)
  })

  it('adds the hookName to the Set on blockingError outcome', async () => {
    runStopHooksMock.mockResolvedValue({
      kind: 'blockingError',
      errorMessage: 'lint failed',
      hookName: 'lint-hook',
    })
    const state = makeState() // start with empty set

    const outcome = await handleNoToolsBranch(state, {
      accumulatedText: '',
      streamingToolExecutor: null,
      useStreamingToolExecutor: false,
    })

    expect(outcome.action).toBe('continue')
    expect(state.stopHookActive.has('lint-hook')).toBe(true)
    // Only THAT one hook is added — other hooks remain free to fire.
    expect(state.stopHookActive.size).toBe(1)
  })

  it('adds the hookName to the Set on preventStop continuation', async () => {
    runStopHooksMock.mockResolvedValue({
      kind: 'preventStop',
      appendUserContent: 'keep going',
      hookName: 'pytest-hook',
    })
    const state = makeState({ preloaded: ['lint-hook'] })

    const outcome = await handleNoToolsBranch(state, {
      accumulatedText: '',
      streamingToolExecutor: null,
      useStreamingToolExecutor: false,
    })

    expect(outcome.action).toBe('continue')
    // Both the old and the new hook are now in the set; the old one
    // was preloaded (e.g. from a previous iteration) and the engine
    // still skipped it this turn — the test verifies the new one is
    // ALSO recorded so it gets skipped next iteration.
    expect(state.stopHookActive.has('lint-hook')).toBe(true)
    expect(state.stopHookActive.has('pytest-hook')).toBe(true)
    expect(state.stopHookActive.size).toBe(2)
  })

  it('falls back to wildcard "*" when blockingError outcome lacks hookName', async () => {
    // Defensive contract: every outcome from `tools/hooks/engine.ts`
    // currently carries a hookName, but if a future surface forgets
    // to set it, the Set still records SOMETHING so the recursion
    // guard doesn't silently degrade to "no guard" on that path.
    runStopHooksMock.mockResolvedValue({
      kind: 'blockingError',
      errorMessage: 'unnamed failure',
      // intentionally no hookName
    })
    const state = makeState()

    await handleNoToolsBranch(state, {
      accumulatedText: '',
      streamingToolExecutor: null,
      useStreamingToolExecutor: false,
    })

    expect(state.stopHookActive.has('*')).toBe(true)
  })

  it('empty Set means no hooks are skipped → engine evaluates everyone', async () => {
    runStopHooksMock.mockResolvedValue({ kind: 'neutral' })
    const state = makeState() // empty

    await handleNoToolsBranch(state, {
      accumulatedText: 'done.',
      streamingToolExecutor: null,
      useStreamingToolExecutor: false,
    })

    const callArgs = runStopHooksMock.mock.calls[0]
    const passedSet = (callArgs[2] as { skipHooks: Set<string> }).skipHooks
    expect(passedSet.size).toBe(0)
  })

  it('neutral outcome does NOT add anything to the Set', async () => {
    runStopHooksMock.mockResolvedValue({ kind: 'neutral' })
    const state = makeState()

    await handleNoToolsBranch(state, {
      accumulatedText: 'done.',
      streamingToolExecutor: null,
      useStreamingToolExecutor: false,
    })

    expect(state.stopHookActive.size).toBe(0)
  })
})
