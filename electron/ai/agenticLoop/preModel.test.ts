/**
 * Tests for agenticLoop preModel — idle tool clear logic.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyIdleToolClear } from './preModel'
import type { LoopState } from './loopShared'

// ── Mock: idle threshold ──
vi.mock('../../context/openClaudeParityConstants', () => ({
  getIdleToolClearMs: () => 30_000, // 30 seconds
  getEffectiveContextWindowTokens: () => 200000,
  deriveContextThresholdsFromOpenClaudeWindow: () => ({
    ok: 40000, warning: 52000, error: 64000, micro_compact: 76000, auto_compact: 88000, blocking: 102000,
  }),
  getModelMaxOutputTokensBounds: () => ({ lowerLimit: 1024, upperLimit: 64000 }),
  MAX_OUTPUT_TOKENS_RECOVERY_ATTEMPTS: 3,
}))

// ── Mock: agent context ──
vi.mock('../../agents/agentContext', () => ({
  getAgentContext: () => ({ agentId: 'main', streamConversationId: 'test-conv' }),
}))

// ── Mock: idle clear ──
vi.mock('../../context/idleToolResultClear', () => ({
  clearCompletedToolResultsExceptRecent: (msgs: Array<Record<string, unknown>>, keep: number) => {
    // For testing: just return a copy with a marker that clear happened
    return [...msgs, { role: 'system', content: `CLEARED_${keep}` }]
  },
}))

function makeQueryDeps(now: () => number = () => Date.now()): LoopState['queryDeps'] {
  return {
    // Param contravariance: `async () => undefined` is assignable to
    // `typeof streamText` because a zero-arg fn satisfies a four-arg
    // contract (callers can drop extras). No cast needed.
    callModel: async () => undefined,
    uuid: () => 'fixed-uuid-for-test',
    now,
    signal: new AbortController().signal,
  }
}

function makeState(overrides: Partial<LoopState> = {}): LoopState {
  return {
    apiMessages: [{ role: 'user', content: 'test' }],
    lastStreamEndMs: Date.now(),
    lastIdleClearMs: 0,
    queryDeps: makeQueryDeps(),
    ...overrides,
  } as LoopState
}

describe('applyIdleToolClear', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('does not apply clear when within idle threshold', () => {
    const state = makeState({
      lastStreamEndMs: Date.now(), // just happened
    })
    const result = applyIdleToolClear(state)
    expect(result.applied).toBe(false)
    expect(result.apiMessages.length).toBe(1) // no clear applied
  })

  it('applies clear when idle exceeds threshold', () => {
    const state = makeState({
      lastStreamEndMs: Date.now() - 60_000, // 60 seconds ago, > 30s threshold
    })
    const result = applyIdleToolClear(state)
    expect(result.applied).toBe(true)
    expect(result.apiMessages.length).toBe(2) // original + CLEARED marker
    expect(state.lastIdleClearMs).toBeGreaterThan(0)
  })

  it('records clear timestamp so immediate repeated clears are suppressed', () => {
    const state = makeState({
      lastStreamEndMs: Date.now() - 60_000,
    })
    const first = applyIdleToolClear(state)
    const second = applyIdleToolClear(state)

    expect(first.applied).toBe(true)
    expect(second.applied).toBe(false)
  })

  it('does not apply clear when last clear was too recent', () => {
    const state = makeState({
      lastStreamEndMs: Date.now() - 60_000, // idle long enough
      lastIdleClearMs: Date.now() - 5_000, // but cleared 5 seconds ago (< threshold)
    })
    const result = applyIdleToolClear(state)
    expect(result.applied).toBe(false)
  })

  it('applies clear when both idle and last-clear exceed threshold', () => {
    const state = makeState({
      lastStreamEndMs: Date.now() - 60_000,
      lastIdleClearMs: Date.now() - 60_000, // both >= threshold
    })
    const result = applyIdleToolClear(state)
    expect(result.applied).toBe(true)
  })

  // 5-piece-set §A3 — `state.queryDeps.now()` is the production clock seam.
  // These three cases prove the seam: tests pin the clock at a fixed point
  // and assert the threshold logic precisely, without the fragile
  // `lastStreamEndMs: Date.now() - 60_000` pattern (which can race against
  // a slow CI run, or mis-account for clock-rounding on Windows).
  describe('deterministic clock via queryDeps.now()', () => {
    it('clears when (now - lastStreamEndMs) is exactly at the threshold (30 000 ms)', () => {
      // Production guard is `idleElapsed < threshold` (strict <), so the
      // boundary case `elapsed === threshold` does NOT trigger the bail
      // branch and clear is applied. If the guard ever drifts to `<=`,
      // this test goes red.
      const state = makeState({
        lastStreamEndMs: 100_000,
        lastIdleClearMs: 0,
        queryDeps: makeQueryDeps(() => 130_000),
      })
      const result = applyIdleToolClear(state)
      expect(result.applied).toBe(true)
    })

    it('does not clear when (now - lastStreamEndMs) is one millisecond below threshold', () => {
      const state = makeState({
        lastStreamEndMs: 100_000,
        lastIdleClearMs: 0,
        queryDeps: makeQueryDeps(() => 129_999),
      })
      // idleElapsed = 29_999 < 30_000 → guard returns no-clear.
      const result = applyIdleToolClear(state)
      expect(result.applied).toBe(false)
    })

    // P2-1 audit fix (2026-07) — the production call site used to pass a
    // spread copy of the state, so this write-back was lost. The transcript
    // override is now a second parameter; the state argument must be the
    // REAL LoopState and the write-back must land on it.
    it('persists lastIdleClearMs on the real state when a transcript override is supplied', () => {
      const FIXED_NOW = 500_000
      const state = makeState({
        lastStreamEndMs: 0,
        lastIdleClearMs: 0,
        queryDeps: makeQueryDeps(() => FIXED_NOW),
      })
      const workingCopy = [{ role: 'user', content: 'working copy' }]
      const result = applyIdleToolClear(state, workingCopy)
      expect(result.applied).toBe(true)
      // Clear operated on the override, not state.apiMessages …
      expect(result.apiMessages[0].content).toBe('working copy')
      // … while the throttle timestamp landed on the real state.
      expect(state.lastIdleClearMs).toBe(FIXED_NOW)
      // Second call within the threshold is suppressed by the persisted stamp.
      const second = applyIdleToolClear(state, workingCopy)
      expect(second.applied).toBe(false)
    })

    it('writes back `state.lastIdleClearMs` using the injected clock (not bare Date.now)', () => {
      const FIXED_NOW = 999_999
      const state = makeState({
        lastStreamEndMs: 0,
        lastIdleClearMs: 0,
        queryDeps: makeQueryDeps(() => FIXED_NOW),
      })
      const result = applyIdleToolClear(state)
      expect(result.applied).toBe(true)
      // If production code accidentally calls `Date.now()` instead of
      // `state.queryDeps.now()`, this will fail with a current wall-clock
      // timestamp instead of our pinned 999_999.
      expect(state.lastIdleClearMs).toBe(FIXED_NOW)
    })
  })
})

// ── Stage 7 regression — budget extraction order vs ledger insert ─────
// Production order in `runPreModelPhase`:
//   1. extract last-user-turn text → applyPoleOutputTokenBudgetFromUserText
//   2. push ledger as a new user-meta msg at array tail
// Pre-Stage 7 the order was reversed, which made the budget extractor
// read the ledger goal text instead of the user's real `+500k` /
// `use 1m tokens` directive (and the `lastUserPlainBudgetSource`
// dedupe cache then locked onto the unchanging goal).
//
// We assert the invariant via the helper: when called BEFORE the ledger
// push, `extractLastUserTurnPlainText` returns the real user text;
// when called AFTER, it returns the ledger body. The production code
// must match the BEFORE order.

describe('extractLastUserTurnPlainText — returns the literal last user message', () => {
  it('returns the real user turn when no synthetic message has been appended', async () => {
    const { extractLastUserTurnPlainText } = await import('../../context/tokenBudgetUserCommands')
    const msgs: Array<Record<string, unknown>> = [
      { role: 'user', content: 'first turn' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'please use 500k tokens for this large refactor' },
    ]
    expect(extractLastUserTurnPlainText(msgs)).toContain('500k')
  })

  it('returns the synthetic message when one is appended after the real user turn', async () => {
    const { extractLastUserTurnPlainText } = await import('../../context/tokenBudgetUserCommands')
    const msgs: Array<Record<string, unknown>> = [
      { role: 'user', content: 'first turn' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'please use 500k tokens for this large refactor' },
      // Synthetic injection (e.g. stop-hook error) appended AFTER the real user turn.
      { role: 'user', content: '<system-reminder>\n[Stop hook reported an error]\nlint failed\n</system-reminder>' },
    ]
    // Documents the contract: extractor returns the LITERAL last user message
    // without filtering. Callers that need the real user turn must invoke
    // the extractor BEFORE appending any synthetic message.
    const out = extractLastUserTurnPlainText(msgs)
    expect(out).toContain('Stop hook')
    expect(out).not.toContain('500k')
  })
})

// ── Phase B regression: PreModelOutput surfaces pipeline phases + idle-clear ──
//
// `iteration.ts` used to call `onQueryLoopPreModel({ phases: [],
// idleToolClearApplied: false, … })` regardless of what really ran. This
// regression guard pins `PreModelOutput.pipelinePhases` and
// `idleToolClearApplied` so a future "let's just pass nothing" refactor
// reintroducing the placeholder loses the build.
describe('PreModelOutput phase passthrough (regression)', () => {
  it('PreModelOutput type must carry pipelinePhases + idleToolClearApplied', () => {
    // Compile-time-only: the test passes iff TypeScript accepts the shape.
    // (We deliberately avoid spinning the full `runPreModelPhase` here —
    // its real wiring needs ContextManager + skill registry + workspace
    // state, which would balloon this test file. The integration path is
    // covered by the agenticLoopAsync test suite.)
    type ExpectShape = {
      apiMessages: Array<Record<string, unknown>>
      wasPreModelCompacted: boolean
      contextLevelAfter: string | undefined
      snippedCount: number
      pipelinePhases: ReadonlyArray<string>
      idleToolClearApplied: boolean
      terminated: boolean
    }
    const sample: import('./loopShared').PreModelOutput = {
      apiMessages: [],
      wasPreModelCompacted: false,
      contextLevelAfter: undefined,
      snippedCount: 0,
      pipelinePhases: ['tool_result_budget', 'auto_compact'],
      idleToolClearApplied: true,
      terminated: false,
    }
    // Structural assignability check — won't compile if the type drifts.
    const widened: ExpectShape = sample
    expect(widened.pipelinePhases).toEqual(['tool_result_budget', 'auto_compact'])
    expect(widened.idleToolClearApplied).toBe(true)
  })
})
