/**
 * Tests for the extracted post-tool context management phase.
 *
 * Production branches (post-P0.3):
 *   1. happy-path no compact         → outcome.kind === 'ok', wasCompacted: false
 *   2. happy-path compact            → outcome.kind === 'ok', wasCompacted: true, onContextCompact fired
 *   3. compact soft-failure (1st/2nd)→ outcome.kind === 'ok', wasCompacted: false, softFailure populated
 *   4. compact 3rd consecutive fail  → outcome.kind === 'terminate', model_error (legacy hard-stop)
 *   5. compact success resets counter→ next iteration starts fresh at 0
 *   6. abort during compact          → outcome.kind === 'aborted', terminationResult untouched
 *
 * The abort case is the contract change vs the legacy inline body:
 * `aborted_tools` / `max_turns` selection lives in the caller
 * (iteration.ts owns `redirectAbortToMaxTurnsIfExhausted`), so this
 * module surfaces aborts as `{ kind: 'aborted' }` without writing
 * `state.terminationResult`.
 *
 * P0.3 soft-failure parity: upstream's `services/compact/autoCompact.ts`
 * uses `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3` and NEVER terminates
 * on compact failure — it just stops trying. Pole tolerates 2 failures
 * (returning ok/no-compact) and terminates on the 3rd.
 */

import { describe, expect, it, vi } from 'vitest'
import { runPostModelPhase } from './postModel'
import type { LoopState } from './loopShared'

// ─── Mocks ────────────────────────────────────────────────────────────

vi.mock('../../agents/agentContext', () => ({
  getAgentContext: () => ({ agentId: 'main', streamConversationId: 'conv-test' }),
}))

vi.mock('../../context/tokenCounter', () => ({
  estimateToolDefinitionsTokens: () => 1024,
}))

vi.mock('../../context/contextCollapseStore', () => ({
  buildContextCollapseConversationKey: () => 'collapse-key-test',
}))

vi.mock('../../tools/workspaceState', () => ({
  getWorkspacePath: () => '/tmp/ws',
}))

vi.mock('../../skills/invokedSkillsRegistry', () => ({
  injectInvokedSkillsIntoLastUserMessage: (msgs: Array<Record<string, unknown>>) => msgs,
}))

vi.mock('../agenticLoopHelpers', () => ({
  buildCompactSideAttachmentIds: () => ({}),
}))

vi.mock('../queryTermination', () => ({
  createTerminalResult: (reason: string, extra: Record<string, unknown>) => ({
    reason,
    ...extra,
  }),
  runTerminationCleanup: vi.fn(async () => {}),
}))

// `decidePhaseAwareCompact` is a pure function; we replace it per-case
// via `vi.doMock` / dynamic re-import because each test wants a
// different shouldCompact / request shape.
let mockDecide: () => {
  shouldCompact: boolean
  request: { reason: string }
  estimatedTokens: number
  thresholdTokens: number
}
vi.mock('../../context/phaseAwareCompact', () => ({
  decidePhaseAwareCompact: () => mockDecide(),
}))

// ─── State factory ────────────────────────────────────────────────────

/**
 * Build the smallest `LoopState` that `runPostModelPhase` touches.
 * We deliberately omit every field outside the phase's reach so a future
 * accidental dependency widens the test signature loudly.
 */
function makeMinimalState(opts: {
  handleContext: () => Promise<{ wasCompacted: boolean; messages: Array<Record<string, unknown>> }>
  signal?: AbortSignal
  level?: string
  /** P0.3 — pre-set the soft-failure counter for terminal-cap tests. */
  consecutiveCompactFailures?: number
}): LoopState {
  const onContextCompact = vi.fn()
  const onError = vi.fn()
  const onMessageEnd = vi.fn()
  const syncConversation = vi.fn()
  const appendixReport = vi.fn()

  const state = {
    apiMessages: [{ role: 'user', content: 'first' }],
    iteration: 3,
    iterationToolDefs: [{ name: 't', description: '', inputSchema: {} }],
    iterationModel: 'claude-test',
    toolUseBlocks: [],
    lastPhaseAwareCompactIteration: 0,
    consecutiveCompactFailures: opts.consecutiveCompactFailures ?? 0,
    signal: opts.signal ?? new AbortController().signal,
    callbacks: {
      onTextDelta: vi.fn(),
      onToolStart: vi.fn(),
      onToolResult: vi.fn(),
      onMessageEnd,
      onError,
      onContextCompact,
    },
    appendixReport,
    syncConversation,
    totalUsage: { inputTokens: 100, outputTokens: 50 },
    terminationResult: null,
    config: { id: 'anthropic', apiKey: '', baseUrl: '' },
    permissionRules: [],
    loopContextManager: {
      estimateTotalInputTokensPeek: () => 50_000,
      getThresholds: () => ({
        warningTokens: 40000,
        autoCompactTokens: 80000,
        microCompactTokens: 60000,
        blockingTokens: 100000,
      }),
      handleContext: opts.handleContext,
      getState: () => ({ level: opts.level ?? 'auto_compact' }),
      clearUsageSnapshot: vi.fn(),
    },
  }

  return state as unknown as LoopState
}

// ─── Tests ────────────────────────────────────────────────────────────

describe('runPostModelPhase', () => {
  it('returns ok / wasCompacted=false when the ContextManager reports no compact', async () => {
    mockDecide = () => ({
      shouldCompact: false,
      request: { reason: 'n/a' },
      estimatedTokens: 50_000,
      thresholdTokens: 80_000,
    })
    const state = makeMinimalState({
      handleContext: async () => ({ wasCompacted: false, messages: state.apiMessages }),
    })

    const outcome = await runPostModelPhase({ state, systemPrompt: 'sys' })

    expect(outcome.kind).toBe('ok')
    if (outcome.kind === 'ok') {
      expect(outcome.wasCompacted).toBe(false)
      expect(outcome.contextLevel).toBeUndefined()
    }
    expect(state.callbacks.onContextCompact).not.toHaveBeenCalled()
    expect(state.terminationResult).toBeNull()
  })

  it('returns ok / wasCompacted=true and fires onContextCompact when compact succeeds', async () => {
    mockDecide = () => ({
      shouldCompact: true,
      request: { reason: 'phase_aware_post_tool' },
      estimatedTokens: 95_000,
      thresholdTokens: 80_000,
    })
    const compacted = [{ role: 'user', content: 'compacted' }]
    const state = makeMinimalState({
      handleContext: async () => ({ wasCompacted: true, messages: compacted }),
      level: 'micro_compact',
    })

    const outcome = await runPostModelPhase({ state, systemPrompt: 'sys' })

    expect(outcome.kind).toBe('ok')
    if (outcome.kind === 'ok') {
      expect(outcome.wasCompacted).toBe(true)
      expect(outcome.contextLevel).toBe('micro_compact')
    }
    expect(state.apiMessages).toBe(compacted)
    expect(state.lastPhaseAwareCompactIteration).toBe(3)
    expect(state.callbacks.onContextCompact).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'micro_compact' }),
    )
    // appendixReport stage emitted for the phase-aware decision
    expect(state.appendixReport).toHaveBeenCalledWith(
      'P2_Q_post_tool_context_manage',
      expect.objectContaining({
        phaseAwareCompact: true,
        reason: 'phase_aware_post_tool',
      }),
    )
  })

  it('returns terminate=model_error when handleContext throws on the 3rd consecutive failure', async () => {
    // Pre-P0.3 a single throw forced a terminal model_error. Now we
    // require 3 consecutive failures (upstream-aligned cap). Pre-set the
    // counter to 2 so this throw is the 3rd and trips the terminal.
    mockDecide = () => ({
      shouldCompact: false,
      request: { reason: 'n/a' },
      estimatedTokens: 50_000,
      thresholdTokens: 80_000,
    })
    const state = makeMinimalState({
      handleContext: async () => {
        throw new Error('boom: provider 500')
      },
      consecutiveCompactFailures: 2,
    })

    const outcome = await runPostModelPhase({ state, systemPrompt: 'sys' })

    expect(outcome.kind).toBe('terminate')
    expect(state.consecutiveCompactFailures).toBe(3)
    expect(state.terminationResult).not.toBeNull()
    expect(state.terminationResult).toMatchObject({
      reason: 'model_error',
      errorDetail: expect.stringContaining('boom: provider 500'),
    })
    expect(state.callbacks.onError).toHaveBeenCalledWith(
      expect.stringContaining('Post-tool context management failed'),
    )
    expect(state.callbacks.onMessageEnd).toHaveBeenCalled()
  })

  it('returns aborted (caller-owned exit) when handleContext throws AND signal.aborted', async () => {
    mockDecide = () => ({
      shouldCompact: false,
      request: { reason: 'n/a' },
      estimatedTokens: 50_000,
      thresholdTokens: 80_000,
    })
    const ac = new AbortController()
    ac.abort()
    const state = makeMinimalState({
      handleContext: async () => {
        throw new Error('cancelled mid-compact')
      },
      signal: ac.signal,
    })

    const outcome = await runPostModelPhase({ state, systemPrompt: 'sys' })

    expect(outcome.kind).toBe('aborted')
    // Contract: caller owns terminationResult in the abort branch.
    // The phase must NOT write model_error / aborted_tools / onMessageEnd
    // — that's iteration.ts's redirectAbortToMaxTurnsIfExhausted job.
    expect(state.terminationResult).toBeNull()
    expect(state.callbacks.onError).not.toHaveBeenCalled()
    expect(state.callbacks.onMessageEnd).not.toHaveBeenCalled()
  })

  // ── P0.3 — Compact soft-failure cap (upstream parity) ─────────────────
  //
  // Failures 1 and 2 must NOT terminate the loop. The phase returns
  // `ok` with `wasCompacted: false` and a `softFailure` annotation;
  // the loop continues into the next iteration on the un-compacted
  // transcript. A subsequent successful compact resets the counter
  // back to 0.

  it('P0.3: 1st handleContext throw soft-recovers (ok + counter=1, no terminal)', async () => {
    mockDecide = () => ({
      shouldCompact: false,
      request: { reason: 'n/a' },
      estimatedTokens: 50_000,
      thresholdTokens: 80_000,
    })
    const state = makeMinimalState({
      handleContext: async () => {
        throw new Error('boom: transient I/O')
      },
    })

    const outcome = await runPostModelPhase({ state, systemPrompt: 'sys' })

    expect(outcome.kind).toBe('ok')
    if (outcome.kind === 'ok') {
      expect(outcome.wasCompacted).toBe(false)
      expect(outcome.softFailure).toBeDefined()
      expect(outcome.softFailure?.attempt).toBe(1)
    }
    expect(state.consecutiveCompactFailures).toBe(1)
    expect(state.terminationResult).toBeNull()
    expect(state.callbacks.onError).not.toHaveBeenCalled()
    expect(state.callbacks.onMessageEnd).not.toHaveBeenCalled()
    expect(state.appendixReport).toHaveBeenCalledWith(
      'P2_Q_post_tool_context_manage',
      expect.objectContaining({ compactSoftFailure: true, attempt: 1 }),
    )
  })

  it('P0.3: 2nd consecutive throw still soft-recovers (ok + counter=2)', async () => {
    mockDecide = () => ({
      shouldCompact: false,
      request: { reason: 'n/a' },
      estimatedTokens: 50_000,
      thresholdTokens: 80_000,
    })
    const state = makeMinimalState({
      handleContext: async () => {
        throw new Error('boom: still transient')
      },
      consecutiveCompactFailures: 1,
    })

    const outcome = await runPostModelPhase({ state, systemPrompt: 'sys' })

    expect(outcome.kind).toBe('ok')
    if (outcome.kind === 'ok') {
      expect(outcome.softFailure?.attempt).toBe(2)
    }
    expect(state.consecutiveCompactFailures).toBe(2)
    expect(state.terminationResult).toBeNull()
  })

  it('P0.3: success after a soft-failure resets the counter to 0', async () => {
    mockDecide = () => ({
      shouldCompact: true,
      request: { reason: 'phase_aware_post_tool' },
      estimatedTokens: 95_000,
      thresholdTokens: 80_000,
    })
    const compacted = [{ role: 'user', content: 'compacted' }]
    const state = makeMinimalState({
      handleContext: async () => ({ wasCompacted: true, messages: compacted }),
      level: 'auto_compact',
      consecutiveCompactFailures: 2,
    })

    const outcome = await runPostModelPhase({ state, systemPrompt: 'sys' })

    expect(outcome.kind).toBe('ok')
    if (outcome.kind === 'ok') expect(outcome.wasCompacted).toBe(true)
    expect(state.consecutiveCompactFailures).toBe(0)
  })

  it('P0.3: soft-failures never fire onError/onMessageEnd (silent retry)', async () => {
    // Reinforces the soft-recovery contract: callbacks.onError surfaces
    // as a user-visible hard error in the UI. Compact transients must
    // stay console-only until the cap trips.
    mockDecide = () => ({
      shouldCompact: false,
      request: { reason: 'n/a' },
      estimatedTokens: 50_000,
      thresholdTokens: 80_000,
    })
    const state = makeMinimalState({
      handleContext: async () => {
        throw new Error('transient')
      },
    })

    await runPostModelPhase({ state, systemPrompt: 'sys' })

    expect(state.callbacks.onError).not.toHaveBeenCalled()
    expect(state.callbacks.onMessageEnd).not.toHaveBeenCalled()
  })
})
