/**
 * AC-1.1: end-to-end sub-agent run (tool registry → resolveAgentTools → runAgenticLoop → completion)
 * with a mocked model stream (no network).
 */

import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from 'vitest'
import { streamText } from '../ai/client'
import { runSubAgent } from '../agents/subAgentRunner'
import { EXPLORE_AGENT } from '../agents/builtInAgents'

// Audit Finding 2 (P2) — tighten mock-impl typing. `CallModelFn = typeof streamText`
// makes the seam contract type-safe; mock implementations below ride
// `typeof streamText` inference (via `vi.mocked(streamText).mockImplementation`)
// rather than falling back to `Record<string, unknown>` casts on the
// callbacks bag. Upstream renames (e.g. `onMessageEnd` → `onTurnEnd`)
// now break compilation in this file instead of silently passing.

vi.mock('../ai/client', () => ({
  streamText: vi.fn(async (_config, _params, callbacks) => {
    callbacks.onTextDelta('## Summary\nSub-agent integration OK.')
    callbacks.onMessageEnd?.({ inputTokens: 10, outputTokens: 20 })
  }),
}))

describe('runSubAgent integration', () => {
  // These cases exercise token/output ACCOUNTING over a deterministic mocked
  // 2-turn stream. The real `list_files` tool executes with no workspace
  // configured in this integration harness and therefore FAILS, which would
  // otherwise trip the orthogonal stop-prevention guard
  // (`electron/ai/agenticLoop/allToolsFailedGuard.ts`): an all-errors tool
  // batch makes it inject one extra "retry-or-explain" turn, adding a 3rd
  // model call and skewing the turn/token counts these tests assert on
  // (e.g. 8/17 → 11/24). That guard is correct product behavior and has its
  // own coverage — it is simply unrelated to what this suite measures, so we
  // disable it here to isolate the accounting flow. (Save/restore so the env
  // toggle never leaks to other suites sharing the worker.)
  let prevAllToolsFailedGuard: string | undefined
  beforeAll(() => {
    prevAllToolsFailedGuard = process.env.POLE_ALL_TOOLS_FAILED_GUARD
    process.env.POLE_ALL_TOOLS_FAILED_GUARD = '0'
  })
  afterAll(() => {
    if (prevAllToolsFailedGuard === undefined) {
      delete process.env.POLE_ALL_TOOLS_FAILED_GUARD
    } else {
      process.env.POLE_ALL_TOOLS_FAILED_GUARD = prevAllToolsFailedGuard
    }
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('completes a text-only sub-agent agentic loop', async () => {
    const types: string[] = []
    const ac = new AbortController()
    const result = await runSubAgent({
      config: { id: 'anthropic', name: 'anthropic', apiKey: 'test-key' },
      model: 'claude-sonnet-4-20250514',
      agentDef: EXPLORE_AGENT,
      prompt: 'Reply with a one-line summary only.',
      signal: ac.signal,
      onEvent: (e) => {
        types.push(e.type)
      },
    })

    expect(result.success).toBe(true)
    expect(result.output).toMatch(/Sub-agent integration OK/i)
    expect(types).toContain('subagent_start')
    expect(types).toContain('subagent_complete')
    expect(result.totalToolUses).toBe(0)
  })

  /**
   * Regression for "sub-agent 秒结束任务，返回结果无可用信息": previously
   * `iterationToolCount` never reset between agenticLoop iterations (because
   * `callbacks.onMessageEnd` only fires once at termination), so `lastFinalText`
   * was never captured whenever the sub-agent used any tool — the parent ended
   * up with cross-iteration preamble text instead of the final deliverable.
   */
  it('captures only the last iteration text as the deliverable when earlier iterations used tools', async () => {
    let streamCall = 0
    vi.mocked(streamText).mockImplementation(async (_config, _params, cb): Promise<void> => {
      streamCall += 1
      if (streamCall === 1) {
        cb.onTextDelta?.(
          'Let me first inspect the repository before I write the final report…',
        )
        cb.onToolUse?.({
          id: 'toolu_iter1',
          name: 'list_files',
          input: { path: '.' },
        })
        cb.onMessageEnd?.({ inputTokens: 5, outputTokens: 10, stopReason: 'tool_use' })
      } else {
        cb.onTextDelta?.('## Findings\nFINAL_DELIVERABLE_LINE_123')
        cb.onMessageEnd?.({ inputTokens: 3, outputTokens: 7, stopReason: 'end_turn' })
      }
    })

    const ac = new AbortController()
    const result = await runSubAgent({
      config: { id: 'anthropic', name: 'anthropic', apiKey: 'test-key' },
      model: 'claude-sonnet-4-20250514',
      agentDef: EXPLORE_AGENT,
      prompt: 'Produce findings.',
      signal: ac.signal,
      onEvent: () => {},
    })

    expect(result.output).toMatch(/FINAL_DELIVERABLE_LINE_123/)
    expect(result.output).not.toMatch(/Let me first inspect the repository/)
  })

  /**
   * Regression for audit Finding 1 (E): `SubAgentResult.totalTokens` and
   * `tokenUsage` must use **sum** semantics for both input and output so
   * the in-process path (subAgentRunner.ts) and worker-process path
   * (subAgentWorkerClient.ts, which reports `totalUsage.inputTokens +
   * outputTokens` straight from the worker's accumulator) report
   * comparable numbers to the parent agent. Earlier the in-process path
   * briefly reported `max(input) + sum(output)` which made the two
   * spawn paths inconsistent.
   *
   * Setup: two turns of `onMessageEnd`:
   *   - turn 1: input=5, output=10
   *   - turn 2: input=3, output=7
   * Expected: input=5+3=8, output=10+7=17, totalTokens=8+17=25.
   * (Under the old buggy `max+sum` semantics the value would have been 22.)
   */
  it('reports sum-based totalTokens consistent with the worker path', async () => {
    let streamCall = 0
    vi.mocked(streamText).mockImplementation(async (_config, _params, cb): Promise<void> => {
      streamCall += 1
      if (streamCall === 1) {
        cb.onTextDelta?.('partial')
        cb.onToolUse?.({ id: 'tu_one', name: 'list_files', input: { path: '.' } })
        cb.onMessageEnd?.({ inputTokens: 5, outputTokens: 10, stopReason: 'tool_use' })
      } else {
        cb.onTextDelta?.('## Done')
        cb.onMessageEnd?.({ inputTokens: 3, outputTokens: 7, stopReason: 'end_turn' })
      }
    })

    const ac = new AbortController()
    const result = await runSubAgent({
      config: { id: 'anthropic', name: 'anthropic', apiKey: 'test-key' },
      model: 'claude-sonnet-4-20250514',
      agentDef: EXPLORE_AGENT,
      prompt: 'do it',
      signal: ac.signal,
      onEvent: () => {},
    })

    expect(result.tokenUsage).toEqual({ input: 8, output: 17 })
    expect(result.totalTokens).toBe(25)
    // Sanity: explicit guard against the old `max + sum` formula re-appearing.
    expect(result.totalTokens).not.toBe(5 + 17)
  })

  /**
   * Smoke check that module-level `vi.mock('../ai/client')` still
   * intercepts the stream phase after the §A3 migration to
   * `state.queryDeps.callModel(...)`.
   *
   * ⚠ **Scope honesty (audit Finding 6)**: this is a smoke, NOT a
   * seam-routing guard. Both the old code path (bare `streamText`
   * import + direct call) AND the new code path (`state.queryDeps.callModel`)
   * resolve to the same mocked module export, so `mock.calls.length > 0`
   * fires under both wirings. If `stream.ts` were silently reverted to
   * the bare import, this test would still pass.
   *
   * The actual routing guard lives at `setup.test.ts` —
   * `expect(state.queryDeps.callModel).toBe(streamText)` proves the
   * production reference is the one captured on the state — and is
   * reinforced by the absence of any `streamText` import inside
   * `stream.ts` (typechecker enforces that the only path through is
   * `state.queryDeps.callModel`).
   */
  it('module-level vi.mock continues to intercept the stream phase after the §A3 migration', async () => {
    vi.mocked(streamText).mockImplementation(
      async (
        _config,
        _params,
        callbacks,
      ): Promise<void> => {
        callbacks.onTextDelta?.('hi')
        callbacks.onMessageEnd?.({
          inputTokens: 1,
          outputTokens: 1,
          stopReason: 'end_turn',
        })
      },
    )

    const ac = new AbortController()
    await runSubAgent({
      config: { id: 'anthropic', name: 'anthropic', apiKey: 'test-key' },
      model: 'claude-sonnet-4-20250514',
      agentDef: EXPLORE_AGENT,
      prompt: 'mock me',
      signal: ac.signal,
      onEvent: () => {},
    })

    expect(vi.mocked(streamText).mock.calls.length).toBeGreaterThan(0)
  })
})
