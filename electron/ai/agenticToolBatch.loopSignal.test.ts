/**
 * Phase 5 — LoopSignal envelope emission from the tool batch.
 *
 * Verifies that `runAgenticToolUseBatch` surfaces typed `tool:*` signals
 * via `callbacks.onLoopSignal` when the repetition guard fires:
 *   - 3rd identical successful call → `tool:repetition_warn`
 *     (tool still executes, advisory attached to result)
 *   - 5th identical successful call → `tool:repetition_halt`
 *     (tool short-circuited, synthetic error result)
 *
 * Also verifies:
 *   - `onLoopSignal` is optional (existing callers without it work)
 *   - a thrown consumer is swallowed (tool batch must not crash)
 *
 * Mirrors `agenticToolBatch.repeatGuard.test.ts` setup so it stays
 * decoupled from real shells / the full tool registry.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the inner tool runner so we can drive deterministic outcomes
// without spawning anything.
vi.mock('./runAgenticToolUse', async () => {
  return {
    runAgenticToolUse: vi.fn(),
  }
})

// Trivial serial planner — same as the existing repeat-guard test.
vi.mock('../orchestration/toolPipeline', () => {
  return {
    canToolUseRunInParallelBatch: () => false,
    isShellToolName: (n: string) => n.toLowerCase() === 'bash',
    planToolExecution: (items: Array<{ id: string; name: string; input: Record<string, unknown> }>) =>
      items.map((item, i) => ({ kind: 'serial' as const, item, originalIndex: i })),
  }
})

import { runAgenticToolUseBatch, type AgenticToolBatchCallbacks } from './agenticToolBatch'
import { runAgenticToolUse } from './runAgenticToolUse'
import { resetRepetitionGuardForTests } from '../orchestration/repetitionGuard'
import type { LoopSignal } from './loopSignal'

const mockedRunAgenticToolUse = runAgenticToolUse as unknown as ReturnType<typeof vi.fn>

const SUCCESS_TOOL_RESULT = {
  type: 'tool_result',
  tool_use_id: 'dummy',
  content: 'ok',
}

function makeParams(
  toolUse: { id: string; name: string; input: Record<string, unknown> },
  callbacks: AgenticToolBatchCallbacks,
) {
  return {
    toolUseBlocks: [toolUse],
    signal: new AbortController().signal,
    callbacks,
    diffPermissionMode: 'default' as const,
    permissionDefaultMode: 'allow' as const,
    discoveryExclude: new Set<string>(),
    getInlineSkillSession: () => null,
    setInlineSkillSession: () => {},
  }
}

beforeEach(() => {
  mockedRunAgenticToolUse.mockReset()
  // RepetitionGuard is a process-wide singleton; clear between cases.
  resetRepetitionGuardForTests()
})

describe('runAgenticToolUseBatch — onLoopSignal envelope emission', () => {
  it('emits tool:repetition_warn on the 3rd identical successful call (tool still executes)', async () => {
    mockedRunAgenticToolUse.mockResolvedValue({ ...SUCCESS_TOOL_RESULT })
    const input = { command: 'echo "ok"' }
    const signals: LoopSignal[] = []
    const cb: AgenticToolBatchCallbacks = {
      onToolStart: vi.fn(),
      onToolResult: vi.fn(),
      onLoopSignal: (s) => signals.push(s),
    }

    await runAgenticToolUseBatch(makeParams({ id: 't1', name: 'Bash', input }, cb))
    await runAgenticToolUseBatch(makeParams({ id: 't2', name: 'Bash', input }, cb))
    const out3 = await runAgenticToolUseBatch(
      makeParams({ id: 't3', name: 'Bash', input }, cb),
    )

    // Tool DID execute on call #3 (repetition warn doesn't short-circuit).
    expect(mockedRunAgenticToolUse).toHaveBeenCalledTimes(3)
    // Result still carries the advisory text (existing behaviour).
    expect(String(out3[0]!.content)).toMatch(/Repetition guard/)

    // Envelope fired exactly once across the three calls — only on call #3.
    expect(signals).toHaveLength(1)
    expect(signals[0]!.kind).toBe('tool:repetition_warn')
    expect(signals[0]!.provider).toBe('tool')
    expect(signals[0]!.rawMessage).toMatch(/Repetition guard/)
    expect(signals[0]!.details).toEqual({
      toolName: 'Bash',
      consecutiveCount: 3,
    })
  })

  it('emits tool:repetition_halt on the 5th identical successful call (tool short-circuited)', async () => {
    mockedRunAgenticToolUse.mockResolvedValue({ ...SUCCESS_TOOL_RESULT })
    const input = { command: 'echo "ok"' }
    const signals: LoopSignal[] = []
    const cb: AgenticToolBatchCallbacks = {
      onToolStart: vi.fn(),
      onToolResult: vi.fn(),
      onLoopSignal: (s) => signals.push(s),
    }

    // Calls 1–4 — execute; call 4 only carries warn-level envelope.
    for (let i = 1; i <= 4; i++) {
      await runAgenticToolUseBatch(
        makeParams({ id: `t${i}`, name: 'Bash', input }, cb),
      )
    }
    // Call 5 → halt.
    const out5 = await runAgenticToolUseBatch(
      makeParams({ id: 't5', name: 'Bash', input }, cb),
    )

    // Underlying tool ran 4 times (call 5 short-circuited).
    expect(mockedRunAgenticToolUse).toHaveBeenCalledTimes(4)
    // Result is a synthetic error block.
    expect(String(out5[0]!.content)).toMatch(/^Error:/)
    expect(String(out5[0]!.content)).toMatch(/Repetition guard/)

    // Envelope sequence: 3rd, 4th = warn ; 5th = halt.
    expect(signals.map((s) => s.kind)).toEqual([
      'tool:repetition_warn',
      'tool:repetition_warn',
      'tool:repetition_halt',
    ])
    const halt = signals.at(-1)!
    expect(halt.provider).toBe('tool')
    expect(halt.rawMessage).toMatch(/Repetition guard/)
    expect(halt.details).toEqual({
      toolName: 'Bash',
      consecutiveCount: 5,
    })
  })

  it('does not emit any envelope when calls have different fingerprints', async () => {
    mockedRunAgenticToolUse.mockResolvedValue({ ...SUCCESS_TOOL_RESULT })
    const signals: LoopSignal[] = []
    const cb: AgenticToolBatchCallbacks = {
      onToolStart: vi.fn(),
      onToolResult: vi.fn(),
      onLoopSignal: (s) => signals.push(s),
    }

    await runAgenticToolUseBatch(
      makeParams({ id: 't1', name: 'Bash', input: { command: 'a' } }, cb),
    )
    await runAgenticToolUseBatch(
      makeParams({ id: 't2', name: 'Bash', input: { command: 'b' } }, cb),
    )
    await runAgenticToolUseBatch(
      makeParams({ id: 't3', name: 'Bash', input: { command: 'c' } }, cb),
    )

    expect(signals).toHaveLength(0)
  })

  it('works when onLoopSignal is omitted (optional field, no crash)', async () => {
    mockedRunAgenticToolUse.mockResolvedValue({ ...SUCCESS_TOOL_RESULT })
    const input = { command: 'echo "ok"' }
    // No onLoopSignal wired — existing callers' shape.
    const cb: AgenticToolBatchCallbacks = {
      onToolStart: vi.fn(),
      onToolResult: vi.fn(),
    }

    await runAgenticToolUseBatch(makeParams({ id: 't1', name: 'Bash', input }, cb))
    await runAgenticToolUseBatch(makeParams({ id: 't2', name: 'Bash', input }, cb))
    const out3 = await runAgenticToolUseBatch(
      makeParams({ id: 't3', name: 'Bash', input }, cb),
    )

    // Behaviour unchanged: advisory still attached, tool still ran.
    expect(mockedRunAgenticToolUse).toHaveBeenCalledTimes(3)
    expect(String(out3[0]!.content)).toMatch(/Repetition guard/)
  })

  it('swallows a thrown onLoopSignal consumer — tool batch keeps working', async () => {
    mockedRunAgenticToolUse.mockResolvedValue({ ...SUCCESS_TOOL_RESULT })
    const input = { command: 'echo "ok"' }
    let invocations = 0
    const cb: AgenticToolBatchCallbacks = {
      onToolStart: vi.fn(),
      onToolResult: vi.fn(),
      onLoopSignal: () => {
        invocations++
        throw new Error('consumer is broken')
      },
    }

    // Drive past warn (3rd) and halt (5th) — neither should abort the batch
    // despite onLoopSignal throwing on each fire.
    for (let i = 1; i <= 5; i++) {
      const out = await runAgenticToolUseBatch(
        makeParams({ id: `t${i}`, name: 'Bash', input }, cb),
      )
      expect(out).toHaveLength(1) // every call produced a result
    }

    // Underlying tool ran 4 times (call 5 short-circuited).
    expect(mockedRunAgenticToolUse).toHaveBeenCalledTimes(4)
    // Consumer was invoked 3 times: warn @3, warn @4, halt @5.
    expect(invocations).toBe(3)
  })

  it('classifies via signal kind (typed), not by parsing the rendered advisory string', async () => {
    // Documents the upstream parity property: consumers branch on
    // `signal.kind`, not on substring-matching `rawMessage`. Same
    // contract we enforce on the stream-domain envelope.
    mockedRunAgenticToolUse.mockResolvedValue({ ...SUCCESS_TOOL_RESULT })
    const input = { command: 'echo "x"' }
    const signals: LoopSignal[] = []
    const cb: AgenticToolBatchCallbacks = {
      onToolStart: vi.fn(),
      onToolResult: vi.fn(),
      onLoopSignal: (s) => signals.push(s),
    }

    for (let i = 1; i <= 5; i++) {
      await runAgenticToolUseBatch(makeParams({ id: `t${i}`, name: 'Bash', input }, cb))
    }

    const haltSignals = signals.filter((s) => s.kind === 'tool:repetition_halt')
    const warnSignals = signals.filter((s) => s.kind === 'tool:repetition_warn')
    expect(haltSignals).toHaveLength(1)
    expect(warnSignals).toHaveLength(2) // count=3 and count=4
    // Halt envelope carries the larger consecutiveCount than any warn.
    const maxWarn = Math.max(
      ...warnSignals.map((s) => (s.details!.consecutiveCount as number) ?? -1),
    )
    expect((haltSignals[0]!.details!.consecutiveCount as number) ?? -1).toBeGreaterThan(maxWarn)
  })
})
