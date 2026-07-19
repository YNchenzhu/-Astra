/**
 * Audit #5 (Patch B): the StreamingToolExecutor must consult AND record into
 * the process-wide `getGlobalToolCallHistory()` so cross-agent repeat-failure
 * detection actually fires in production.
 *
 * Before this patch, the streaming path bypassed the kernel's
 * `DefaultToolRuntimePort.executeToolBatch`, which was the only call site
 * touching the global history. Since `useStreamingToolExecutor` is true for
 * every turn with tool_uses (see `agenticLoop/stream.ts:391`), the global
 * cross-agent block guard was effectively dead code in production —
 * documented but not asserted before the SA-4 streaming-path wiring (the
 * streaming executor used to bypass the kernel's cross-agent history).
 *
 * What's covered here:
 *   - `record` mirrors per-loop history into global on success AND failure
 *   - block-threshold reached → second instance is short-circuited without
 *     reaching `runAgenticToolUse`
 *   - hint-threshold reached → `runAgenticToolUse` still runs, but a failing
 *     result is annotated with the advisory
 *   - per-loop block wins over global block when both fire
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('./runAgenticToolUse', async () => {
  return { runAgenticToolUse: vi.fn() }
})

import { StreamingToolExecutor } from './streamingToolExecutor'
import { runAgenticToolUse } from './runAgenticToolUse'
import {
  getGlobalToolCallHistory,
  resetGlobalToolCallHistoryForTests,
} from '../orchestration/toolRuntime/history'
import { createToolCallHistory } from './toolCallHistory'
import {
  runWithAgentContextAsync,
  type AgentContext,
} from '../agents/agentContext'
import { asAgentId } from '../tools/ids'
import type { ProviderConfig } from './client'

const mockedRunAgenticToolUse = runAgenticToolUse as unknown as ReturnType<typeof vi.fn>

function makeExecutor(opts?: {
  toolCallHistory?: ReturnType<typeof createToolCallHistory>
}): {
  executor: StreamingToolExecutor
  onToolStart: ReturnType<typeof vi.fn>
  onToolResult: ReturnType<typeof vi.fn>
} {
  const onToolStart = vi.fn()
  const onToolResult = vi.fn()
  const executor = new StreamingToolExecutor({
    signal: new AbortController().signal,
    callbacks: { onToolStart, onToolResult },
    diffPermissionMode: 'default',
    permissionDefaultMode: 'allow',
    discoveryExclude: new Set<string>(),
    getInlineSkillSession: () => null,
    setInlineSkillSession: () => {},
    ...(opts?.toolCallHistory ? { toolCallHistory: opts.toolCallHistory } : {}),
  })
  return { executor, onToolStart, onToolResult }
}

async function drainRemaining(executor: StreamingToolExecutor): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = []
  for await (const item of executor.getRemainingResults()) {
    if (item.type === 'tool_result') out.push(item.data)
  }
  return out
}

function buildAgentCtx(
  agentId: string,
  options: { parentAgentId?: string; sessionAgentType?: string } = {},
): AgentContext {
  return {
    config: { id: 'anthropic' } as unknown as ProviderConfig,
    model: 'claude',
    systemPrompt: '',
    messages: [],
    signal: new AbortController().signal,
    agentId: asAgentId(agentId),
    ...(options.parentAgentId ? { parentAgentId: options.parentAgentId } : {}),
    ...(options.sessionAgentType ? { sessionAgentType: options.sessionAgentType } : {}),
  }
}

beforeEach(() => {
  resetGlobalToolCallHistoryForTests()
  mockedRunAgenticToolUse.mockReset()
})

afterEach(() => {
  resetGlobalToolCallHistoryForTests()
  vi.restoreAllMocks()
})

describe('StreamingToolExecutor — global ToolCallHistory integration (Patch B)', () => {
  it('records successful outcome into global history with the active agentId', async () => {
    mockedRunAgenticToolUse.mockResolvedValueOnce({
      type: 'tool_result',
      tool_use_id: 'tu1',
      content: 'all good',
    })

    const { executor } = makeExecutor()
    await runWithAgentContextAsync(buildAgentCtx('agent-A'), async () => {
      executor.addTool({ id: 'tu1', name: 'bash', input: { command: 'ls' } })
      await drainRemaining(executor)
    })

    const outcomes = getGlobalToolCallHistory().getOutcomes('bash', { command: 'ls' })
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0].success).toBe(true)
    expect(outcomes[0].agentId).toBe('agent-A')
  })

  it('records failure into global history with the agentId AND error summary', async () => {
    mockedRunAgenticToolUse.mockResolvedValueOnce({
      type: 'tool_result',
      tool_use_id: 'tu1',
      content: 'Error: file not found',
    })

    const { executor } = makeExecutor()
    await runWithAgentContextAsync(buildAgentCtx('agent-A'), async () => {
      executor.addTool({ id: 'tu1', name: 'bash', input: { command: 'ls /nope' } })
      await drainRemaining(executor)
    })

    const outcomes = getGlobalToolCallHistory().getOutcomes('bash', { command: 'ls /nope' })
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0].success).toBe(false)
    expect(outcomes[0].errorSummary).toMatch(/file not found/)
    expect(outcomes[0].agentId).toBe('agent-A')
  })

  it('block-threshold reached by PARENT agent-A → CHILD agent-B SHORT-CIRCUITS the same call (audit H4: bubble within chain)', async () => {
    // Audit fix H4 contract: when agent-A is the parent of agent-B
    // (i.e. they share lineage), the block bubbles. Seed two failures
    // recorded under agent-A WITH the lineage info so the registry
    // knows agent-A is on agent-B's parent chain.
    getGlobalToolCallHistory({ hintThreshold: 0, blockThreshold: 2 })
    const h = getGlobalToolCallHistory()
    h.record('bash', { command: 'fail' }, {
      success: false,
      agentId: asAgentId('agent-A'),
      agentType: 'main',
    })
    h.record('bash', { command: 'fail' }, {
      success: false,
      agentId: asAgentId('agent-A'),
      agentType: 'main',
    })

    const { executor, onToolResult } = makeExecutor()
    // agent-B is a CHILD of agent-A — same lineage chain, so the
    // cross-agent block legitimately fires.
    await runWithAgentContextAsync(
      buildAgentCtx('agent-B', { parentAgentId: 'agent-A', sessionAgentType: 'Explore' }),
      async () => {
        executor.addTool({ id: 'tuB', name: 'bash', input: { command: 'fail' } })
        const results = await drainRemaining(executor)

        expect(mockedRunAgenticToolUse).not.toHaveBeenCalled()

        expect(results).toHaveLength(1)
        expect(results[0]!.is_error).toBe(true)
        expect(String(results[0]!.content)).toMatch(/Cross-agent block/i)

        expect(onToolResult).toHaveBeenCalledTimes(1)
        expect(onToolResult.mock.calls[0][0]).toMatchObject({
          success: false,
          name: 'bash',
        })
      },
    )

    // Block decision is also recorded in global so subsequent attempts see
    // failures += 1 (now 3) — same fingerprint, same block.
    const outcomes = getGlobalToolCallHistory().getOutcomes('bash', { command: 'fail' })
    expect(outcomes).toHaveLength(3)
    expect(outcomes[2].agentId).toBe('agent-B')
    expect(outcomes[2].parentAgentId).toBe('agent-A')
  })

  // Audit fix H4 — explicit assertion of the desired sibling isolation
  // behaviour. Two agents that share a common parent but neither is on
  // the other's ancestor chain (siblings) must NOT block each other.
  it('SIBLING agents under a common parent do NOT block each other (audit H4)', async () => {
    getGlobalToolCallHistory({ hintThreshold: 0, blockThreshold: 2 })
    const h = getGlobalToolCallHistory()
    // explore-1 is a child of main and records failures.
    h.record('bash', { command: 'fail' }, {
      success: false,
      agentId: asAgentId('explore-1'),
      parentAgentId: asAgentId('main'),
      agentType: 'Explore',
    })
    h.record('bash', { command: 'fail' }, {
      success: false,
      agentId: asAgentId('explore-1'),
      parentAgentId: asAgentId('main'),
      agentType: 'Explore',
    })

    mockedRunAgenticToolUse.mockResolvedValueOnce({
      type: 'tool_result',
      tool_use_id: 'tu1',
      content: 'success this time',
    })

    const { executor } = makeExecutor()
    // plan-1 is ALSO a child of main — a sibling of explore-1.
    let results: Array<Record<string, unknown>> = []
    await runWithAgentContextAsync(
      buildAgentCtx('plan-1', { parentAgentId: 'main', sessionAgentType: 'Plan' }),
      async () => {
        executor.addTool({ id: 'tu1', name: 'bash', input: { command: 'fail' } })
        results = await drainRemaining(executor)
      },
    )

    // Tool execution actually ran — sibling isolation correctly let it
    // through despite explore-1's two prior failures of the same call.
    expect(mockedRunAgenticToolUse).toHaveBeenCalledTimes(1)
    expect(results).toHaveLength(1)
    expect(String(results[0]!.content)).toMatch(/success this time/)
  })

  it('hint-threshold reached by global history → runs the tool, annotates failing result with advisory (parent chain)', async () => {
    getGlobalToolCallHistory({ hintThreshold: 1, blockThreshold: 99 })
    // Audit fix H4: for the hint to count for agent-B, the recording
    // agent (agent-A) must be on agent-B's lineage chain.
    getGlobalToolCallHistory().record(
      'bash',
      { command: 'flaky' },
      {
        success: false,
        errorSummary: 'transient err',
        agentId: asAgentId('agent-A'),
        agentType: 'main',
      },
    )

    mockedRunAgenticToolUse.mockResolvedValueOnce({
      type: 'tool_result',
      tool_use_id: 'tu1',
      content: 'Error: still failing',
    })

    const { executor } = makeExecutor()
    let yielded: Array<Record<string, unknown>> = []
    await runWithAgentContextAsync(
      buildAgentCtx('agent-B', { parentAgentId: 'agent-A', sessionAgentType: 'Explore' }),
      async () => {
        executor.addTool({ id: 'tu1', name: 'bash', input: { command: 'flaky' } })
        yielded = await drainRemaining(executor)
      },
    )

    expect(mockedRunAgenticToolUse).toHaveBeenCalledTimes(1)
    expect(yielded).toHaveLength(1)
    // The advisory annotation comes from `attachAdvisoryToToolResult` — it
    // appends text after the original Error content.
    expect(String(yielded[0]!.content)).toMatch(/still failing/)
    expect(String(yielded[0]!.content)).toMatch(/Cross-agent advisory/i)
  })

  it('per-loop block wins over global block when both fire (same fingerprint)', async () => {
    // NOTE: `createToolCallHistory` enforces `blockThreshold = max(hintThreshold+1, ...)`
    // with a default floor of 2, so a single prior failure is NOT enough to trigger
    // per-loop block. Seed TWO failures so per-loop block actually fires.
    getGlobalToolCallHistory({ hintThreshold: 0, blockThreshold: 1 })
    getGlobalToolCallHistory().record(
      'bash',
      { command: 'same' },
      { success: false, errorSummary: 'global err', agentId: asAgentId('agent-A') },
    )

    const perLoop = createToolCallHistory()  // default block-threshold = 2
    perLoop.record('bash', { command: 'same' }, { success: false, errorSummary: 'per-loop err 1' })
    perLoop.record('bash', { command: 'same' }, { success: false, errorSummary: 'per-loop err 2' })

    const { executor } = makeExecutor({ toolCallHistory: perLoop })
    let yielded: Array<Record<string, unknown>> = []
    await runWithAgentContextAsync(buildAgentCtx('agent-B'), async () => {
      executor.addTool({ id: 'tu1', name: 'bash', input: { command: 'same' } })
      yielded = await drainRemaining(executor)
    })

    expect(mockedRunAgenticToolUse).not.toHaveBeenCalled()
    expect(yielded).toHaveLength(1)
    // Per-loop block message should be surfaced (more specific) — it contains
    // "per-loop err 2" (the latest per-loop error). The global block message
    // would include "global err" instead — assert per-loop won.
    const content = String(yielded[0]!.content)
    expect(content).toMatch(/per-loop err/)
    expect(content).not.toMatch(/Cross-agent block/i)
  })

  it('does not throw when AgentContext is missing — records outcome without agentId', async () => {
    mockedRunAgenticToolUse.mockResolvedValueOnce({
      type: 'tool_result',
      tool_use_id: 'tu1',
      content: 'ok',
    })

    const { executor } = makeExecutor()
    // NO runWithAgentContextAsync wrap — getAgentContext() returns null.
    executor.addTool({ id: 'tu1', name: 'bash', input: { command: 'no-ctx' } })
    await drainRemaining(executor)

    const outcomes = getGlobalToolCallHistory().getOutcomes('bash', { command: 'no-ctx' })
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0].agentId).toBeUndefined()
    expect(outcomes[0].success).toBe(true)
  })
})
