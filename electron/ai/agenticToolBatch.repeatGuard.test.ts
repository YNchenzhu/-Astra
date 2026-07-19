/**
 * Integration tests: the loop-guard wired through `runAgenticToolUseBatch`
 * actually fires at the 2nd (hint) and 3rd (block) identical-args failures.
 *
 * We mock {@link runAgenticToolUse} so we can simulate deterministic failure
 * results without spawning real shells, then drive the batch executor with
 * a shared {@link createToolCallHistory} across three sequential calls.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// The mock must be declared before importing the module under test so the
// vitest `vi.mock` hoist places it correctly.
vi.mock('./runAgenticToolUse', async () => {
  return {
    runAgenticToolUse: vi.fn(),
  }
})

// Also mock toolPipeline planner to a trivial identity plan (everything serial),
// removing the dependency on the full tool registry for this focused test.
vi.mock('../orchestration/toolPipeline', () => {
  return {
    canToolUseRunInParallelBatch: () => false,
    isShellToolName: (n: string) => n.toLowerCase() === 'bash',
    planToolExecution: (items: Array<{ id: string; name: string; input: Record<string, unknown> }>) =>
      items.map((item, i) => ({ kind: 'serial' as const, item, originalIndex: i })),
  }
})

import { runAgenticToolUseBatch } from './agenticToolBatch'
import { runAgenticToolUse } from './runAgenticToolUse'
import { createToolCallHistory } from './toolCallHistory'
import { resetRepetitionGuardForTests } from '../orchestration/repetitionGuard'

const mockedRunAgenticToolUse = runAgenticToolUse as unknown as ReturnType<typeof vi.fn>

function makeParams(
  toolUse: { id: string; name: string; input: Record<string, unknown> },
  history: ReturnType<typeof createToolCallHistory>,
  callbacks = {
    onToolStart: vi.fn(),
    onToolResult: vi.fn(),
  },
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
    toolCallHistory: history,
  }
}

const FAILING_TOOL_RESULT = {
  type: 'tool_result',
  tool_use_id: 'dummy',
  content: 'Error: Task toolu_abc failed (exit 9009): (no output captured)',
}

describe('runAgenticToolUseBatch × toolCallHistory', () => {
  beforeEach(() => {
    mockedRunAgenticToolUse.mockReset()
    // The repetition guard is a process-wide singleton that this test
    // doesn't explicitly inject — reset it between cases so a previous
    // test's identical-call sequence doesn't bleed into the next one.
    resetRepetitionGuardForTests()
  })

  it('passes through unchanged on the first failure', async () => {
    mockedRunAgenticToolUse.mockResolvedValueOnce({
      ...FAILING_TOOL_RESULT,
      tool_use_id: 't1',
    })
    const history = createToolCallHistory()
    const out = await runAgenticToolUseBatch(
      makeParams({ id: 't1', name: 'Bash', input: { command: 'python3 -c "x"' } }, history),
    )
    expect(out).toHaveLength(1)
    expect(out[0]!.content).not.toMatch(/System advisory/)
    expect(mockedRunAgenticToolUse).toHaveBeenCalledTimes(1)
  })

  it('attaches a [System advisory] on the 2nd identical failure (hint level)', async () => {
    const history = createToolCallHistory()
    const input = { command: 'python3 -c "x"' }

    mockedRunAgenticToolUse
      .mockResolvedValueOnce({ ...FAILING_TOOL_RESULT, tool_use_id: 't1' })
      .mockResolvedValueOnce({ ...FAILING_TOOL_RESULT, tool_use_id: 't2' })

    await runAgenticToolUseBatch(makeParams({ id: 't1', name: 'Bash', input }, history))
    const out2 = await runAgenticToolUseBatch(
      makeParams({ id: 't2', name: 'Bash', input }, history),
    )

    expect(mockedRunAgenticToolUse).toHaveBeenCalledTimes(2) // BOTH ran
    expect(out2[0]!.content).toMatch(/\[System advisory\]/)
    expect(out2[0]!.content).toMatch(/^Error:/) // still marked as failure
    expect(out2[0]!.content).toMatch(/Task toolu_abc failed/) // original detail preserved
  })

  it('short-circuits the 3rd identical failure WITHOUT calling runAgenticToolUse (block level)', async () => {
    const history = createToolCallHistory()
    const input = { command: 'python3 -c "x"' }

    mockedRunAgenticToolUse
      .mockResolvedValueOnce({ ...FAILING_TOOL_RESULT, tool_use_id: 't1' })
      .mockResolvedValueOnce({ ...FAILING_TOOL_RESULT, tool_use_id: 't2' })

    await runAgenticToolUseBatch(makeParams({ id: 't1', name: 'Bash', input }, history))
    await runAgenticToolUseBatch(makeParams({ id: 't2', name: 'Bash', input }, history))

    // 3rd call — should NOT invoke the underlying tool.
    const out3 = await runAgenticToolUseBatch(
      makeParams({ id: 't3', name: 'Bash', input }, history),
    )

    expect(mockedRunAgenticToolUse).toHaveBeenCalledTimes(2) // UNCHANGED
    expect(out3[0]!.content).toMatch(/\[System block\]/)
    expect(out3[0]!.content).toMatch(/^Error:/)
    expect(out3[0]!.tool_use_id).toBe('t3')
  })

  it('resets after a successful call with the same args', async () => {
    const history = createToolCallHistory()
    const input = { command: 'python3 -c "x"' }

    mockedRunAgenticToolUse
      .mockResolvedValueOnce({ ...FAILING_TOOL_RESULT, tool_use_id: 't1' })
      .mockResolvedValueOnce({
        type: 'tool_result',
        tool_use_id: 't2',
        content: 'Task ID: xx\nall good',
      })
      .mockResolvedValueOnce({ ...FAILING_TOOL_RESULT, tool_use_id: 't3' })

    await runAgenticToolUseBatch(makeParams({ id: 't1', name: 'Bash', input }, history)) // fail
    await runAgenticToolUseBatch(makeParams({ id: 't2', name: 'Bash', input }, history)) // success
    const out3 = await runAgenticToolUseBatch(
      makeParams({ id: 't3', name: 'Bash', input }, history),
    ) // fail again — counter reset, so NO advisory

    expect(out3[0]!.content).not.toMatch(/System advisory/)
    expect(out3[0]!.content).not.toMatch(/System block/)
  })

  it('differentiates distinct commands — history does not cross-contaminate', async () => {
    const history = createToolCallHistory()

    mockedRunAgenticToolUse
      .mockResolvedValue({
        ...FAILING_TOOL_RESULT,
      })

    await runAgenticToolUseBatch(
      makeParams({ id: 't1', name: 'Bash', input: { command: 'cmd-A' } }, history),
    )
    await runAgenticToolUseBatch(
      makeParams({ id: 't2', name: 'Bash', input: { command: 'cmd-A' } }, history),
    )
    // Third call uses a DIFFERENT command → first-time for that fingerprint, no advisory.
    const out3 = await runAgenticToolUseBatch(
      makeParams({ id: 't3', name: 'Bash', input: { command: 'cmd-B' } }, history),
    )
    expect(out3[0]!.content).not.toMatch(/System advisory/)
    expect(out3[0]!.content).not.toMatch(/System block/)
  })

  it('emits onToolResult and onToolStart on a hard block so UI/telemetry see the event', async () => {
    const history = createToolCallHistory()
    const input = { command: 'same' }

    mockedRunAgenticToolUse
      .mockResolvedValueOnce({ ...FAILING_TOOL_RESULT, tool_use_id: 't1' })
      .mockResolvedValueOnce({ ...FAILING_TOOL_RESULT, tool_use_id: 't2' })

    await runAgenticToolUseBatch(makeParams({ id: 't1', name: 'Bash', input }, history))
    await runAgenticToolUseBatch(makeParams({ id: 't2', name: 'Bash', input }, history))

    const cb = { onToolStart: vi.fn(), onToolResult: vi.fn() }
    await runAgenticToolUseBatch(makeParams({ id: 't3', name: 'Bash', input }, history, cb))

    expect(cb.onToolStart).toHaveBeenCalledTimes(1)
    expect(cb.onToolResult).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 't3',
        success: false,
        error: expect.stringMatching(/System block/),
      }),
    )
  })

  it('can be disabled by passing no tracker (legacy path)', async () => {
    mockedRunAgenticToolUse.mockResolvedValue({ ...FAILING_TOOL_RESULT })
    const params = {
      toolUseBlocks: [{ id: 't', name: 'Bash', input: { command: 'x' } }],
      signal: new AbortController().signal,
      callbacks: { onToolStart: () => {}, onToolResult: () => {} },
      diffPermissionMode: 'default' as const,
      permissionDefaultMode: 'allow' as const,
      discoveryExclude: new Set<string>(),
      getInlineSkillSession: () => null,
      setInlineSkillSession: () => {},
      // toolCallHistory intentionally omitted
    }
    const out1 = await runAgenticToolUseBatch(params)
    const out2 = await runAgenticToolUseBatch(params)
    const out3 = await runAgenticToolUseBatch(params)
    expect(out1[0]!.content).not.toMatch(/System advisory|System block/)
    expect(out2[0]!.content).not.toMatch(/System advisory|System block/)
    expect(out3[0]!.content).not.toMatch(/System advisory|System block/)
    expect(mockedRunAgenticToolUse).toHaveBeenCalledTimes(3)
  })
})
