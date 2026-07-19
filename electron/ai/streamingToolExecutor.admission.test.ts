/**
 * Audit fix SA-4 — streaming-path admission gates.
 *
 * The StreamingToolExecutor used to start tools straight from the model
 * stream, bypassing the PolicyEngine preflight and `quota.admit` that the
 * batch paths (`DefaultToolRuntimePort` / `toolExec.ts` fallback) enforce —
 * a permission or quota deny could only happen after the tool had already
 * begun executing.
 *
 * What's covered here:
 *   - PolicyEngine deny → tool never executes, denial tool_result in the
 *     same shape as the batch path, state/scheduler marked failed, and a
 *     `permission_denied_preflight` phase event is emitted.
 *   - quota.admit deny → same terminalisation, hard deny without
 *     backpressure wait (streaming semantics).
 *   - allowed tool still executes (regression guard).
 *   - pre-aborted signal → admission never runs the tool (abort-aware).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('./runAgenticToolUse', () => ({ runAgenticToolUse: vi.fn() }))

const emitStreamEventForConversationMock =
  vi.fn<(conversationId: string | undefined | null, ev: Record<string, unknown>) => void>()
vi.mock('./interactionState', () => ({
  emitStreamEventForConversation: (
    id: string | undefined | null,
    ev: Record<string, unknown>,
  ) => emitStreamEventForConversationMock(id, ev),
}))

import { StreamingToolExecutor, type StreamingToolExecutorParams } from './streamingToolExecutor'
import { runAgenticToolUse } from './runAgenticToolUse'
import {
  getResourceQuotaManager,
  resetResourceQuotaManagerForTests,
} from '../orchestration/toolRuntime/quota'
import { resetPolicyEngineForTests } from '../orchestration/toolRuntime/policy'
import { resetGlobalToolCallHistoryForTests } from '../orchestration/toolRuntime/history'
import { resetToolSchedulerForTests } from '../orchestration/toolRuntime/scheduler'
import {
  clearToolRuntimeStateForTests,
  getToolEntry,
} from '../orchestration/toolRuntime/state'
import {
  runWithAgentContextAsync,
  type AgentContext,
} from '../agents/agentContext'
import { asAgentId } from '../tools/ids'
import type { ProviderConfig } from './client'

const mockedRunAgenticToolUse = runAgenticToolUse as unknown as ReturnType<typeof vi.fn>

function makeExecutor(overrides?: Partial<StreamingToolExecutorParams>): {
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
    ...overrides,
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

function buildAgentCtx(agentId: string, options: { conversationId?: string } = {}): AgentContext {
  return {
    config: { id: 'anthropic' } as unknown as ProviderConfig,
    model: 'claude',
    systemPrompt: '',
    messages: [],
    signal: new AbortController().signal,
    agentId: asAgentId(agentId),
    ...(options.conversationId ? { streamConversationId: options.conversationId } : {}),
  } as AgentContext
}

beforeEach(() => {
  resetResourceQuotaManagerForTests()
  resetPolicyEngineForTests()
  resetGlobalToolCallHistoryForTests()
  resetToolSchedulerForTests()
  clearToolRuntimeStateForTests()
  mockedRunAgenticToolUse.mockReset()
  emitStreamEventForConversationMock.mockReset()
})

afterEach(() => {
  resetResourceQuotaManagerForTests()
  resetPolicyEngineForTests()
  resetGlobalToolCallHistoryForTests()
  resetToolSchedulerForTests()
  clearToolRuntimeStateForTests()
  vi.restoreAllMocks()
})

describe('StreamingToolExecutor — admission gates (SA-4)', () => {
  it('PolicyEngine deny: tool never executes and a denial tool_result is synthesized', async () => {
    // permissionDefaultMode 'deny' with no rules → PolicyEngine denies every
    // tool ('default-deny' matched rule), same as the batch preflight.
    const { executor, onToolResult } = makeExecutor({ permissionDefaultMode: 'deny' })

    let results: Array<Record<string, unknown>> = []
    await runWithAgentContextAsync(
      buildAgentCtx('agent-A', { conversationId: 'conv-1' }),
      async () => {
        executor.addTool({ id: 'tu_pol', name: 'bash', input: { command: 'ls' } })
        results = await drainRemaining(executor)
      },
    )

    expect(mockedRunAgenticToolUse).not.toHaveBeenCalled()
    expect(results).toHaveLength(1)
    expect(results[0]!.is_error).toBe(true)
    expect(String(results[0]!.content)).toMatch(/denied by default permission policy/i)
    // Denial format parity with toolExec.fallback: matched rule suffix.
    expect(String(results[0]!.content)).toMatch(/\(matched: .*default-deny.*\)/)

    // UI callback observed the failure.
    expect(onToolResult).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'tu_pol', name: 'bash', success: false }),
    )

    // Policy denial happens before admission, so no RuntimeState entry exists.
    expect(getToolEntry('tu_pol')).toBeUndefined()

    // `permission_denied_preflight` phase event reached the conversation
    // (transport adapter wraps the payload as an `orchestration_phase`
    // stream event — see `buildPhaseStreamEvent`).
    expect(emitStreamEventForConversationMock).toHaveBeenCalledWith(
      'conv-1',
      expect.objectContaining({
        type: 'orchestration_phase',
        orchestrationPhase: 'permission_denied_preflight',
        permissionDenial: expect.objectContaining({ toolUseId: 'tu_pol', toolName: 'bash' }),
      }),
    )
  })

  it('PolicyEngine deny via tool-name deny rule', async () => {
    const { executor } = makeExecutor({
      permissionDefaultMode: 'allow',
      permissionRules: [{ id: 'r1', pattern: 'bash', mode: 'deny' }],
    })

    let results: Array<Record<string, unknown>> = []
    await runWithAgentContextAsync(buildAgentCtx('agent-A'), async () => {
      executor.addTool({ id: 'tu_rule', name: 'bash', input: { command: 'rm -rf x' } })
      results = await drainRemaining(executor)
    })

    expect(mockedRunAgenticToolUse).not.toHaveBeenCalled()
    expect(results).toHaveLength(1)
    expect(results[0]!.is_error).toBe(true)
    expect(String(results[0]!.content)).toMatch(/denied by permission policy/i)
  })

  it('quota deny: tool never executes, hard deny without backpressure wait', async () => {
    // Zero mutation slots and no preemption → any non-read-only tool is
    // denied with 'mutation_concurrency'.
    getResourceQuotaManager({ maxGlobalMutationParallel: 0, enablePreemption: false })

    const { executor, onToolResult } = makeExecutor()
    let results: Array<Record<string, unknown>> = []
    await runWithAgentContextAsync(buildAgentCtx('agent-A'), async () => {
      executor.addTool({ id: 'tu_quota', name: 'write_file', input: { filePath: 'a.txt' } })
      results = await drainRemaining(executor)
    })

    expect(mockedRunAgenticToolUse).not.toHaveBeenCalled()
    expect(results).toHaveLength(1)
    expect(results[0]!.is_error).toBe(true)
    const content = String(results[0]!.content)
    expect(content).toMatch(/Resource quota exceeded: mutation_concurrency/)
    // Streaming semantics: deny now, no backpressure retry loop.
    expect(content).toMatch(/Retry on the next turn/i)
    expect(content).toMatch(/\(matched: quota:mutation_concurrency\)/)

    expect(onToolResult).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'tu_quota', success: false }),
    )
    expect(getToolEntry('tu_quota')?.status).toBe('failed')
  })

  it('allowed tool still executes through the gates (regression)', async () => {
    mockedRunAgenticToolUse.mockResolvedValueOnce({
      type: 'tool_result',
      tool_use_id: 'tu_ok',
      content: 'fine',
    })

    const { executor } = makeExecutor()
    let results: Array<Record<string, unknown>> = []
    await runWithAgentContextAsync(buildAgentCtx('agent-A'), async () => {
      executor.addTool({ id: 'tu_ok', name: 'grep', input: { pattern: 'x' } })
      results = await drainRemaining(executor)
    })

    expect(mockedRunAgenticToolUse).toHaveBeenCalledTimes(1)
    expect(results).toHaveLength(1)
    expect(String(results[0]!.content)).toMatch(/fine/)
    expect(emitStreamEventForConversationMock).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ orchestrationPhase: 'permission_denied_preflight' }),
    )
  })

  it('pre-aborted signal: admission is abort-aware and the tool never executes', async () => {
    const abort = new AbortController()
    abort.abort()
    const { executor } = makeExecutor({ signal: abort.signal })

    let results: Array<Record<string, unknown>> = []
    await runWithAgentContextAsync(buildAgentCtx('agent-A'), async () => {
      executor.addTool({ id: 'tu_abort', name: 'bash', input: { command: 'ls' } })
      results = await drainRemaining(executor)
    })

    expect(mockedRunAgenticToolUse).not.toHaveBeenCalled()
    expect(results).toHaveLength(1)
    expect(results[0]!.is_error).toBe(true)
    expect(String(results[0]!.content)).toMatch(/interrupted/i)
    expect(getToolEntry('tu_abort')).toBeUndefined()
  })

  it('chatMode "plan": a mutating tool is denied at preflight (chat-mode gate)', async () => {
    const { executor, onToolResult } = makeExecutor({ chatMode: 'plan' })

    let results: Array<Record<string, unknown>> = []
    await runWithAgentContextAsync(
      buildAgentCtx('agent-A', { conversationId: 'conv-plan' }),
      async () => {
        executor.addTool({ id: 'tu_plan', name: 'write_file', input: { filePath: 'a.txt' } })
        results = await drainRemaining(executor)
      },
    )

    expect(mockedRunAgenticToolUse).not.toHaveBeenCalled()
    expect(results).toHaveLength(1)
    expect(results[0]!.is_error).toBe(true)
    expect(String(results[0]!.content)).toMatch(/Plan mode/i)
    expect(String(results[0]!.content)).toMatch(/\(matched: .*chat_mode:plan.*\)/)
    expect(onToolResult).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'tu_plan', success: false }),
    )
    expect(getToolEntry('tu_plan')).toBeUndefined()
    expect(emitStreamEventForConversationMock).toHaveBeenCalledWith(
      'conv-plan',
      expect.objectContaining({
        type: 'orchestration_phase',
        orchestrationPhase: 'permission_denied_preflight',
        permissionDenial: expect.objectContaining({ toolUseId: 'tu_plan', toolName: 'write_file' }),
      }),
    )
  })

  it('chatMode "ask": every tool is denied at preflight', async () => {
    const { executor } = makeExecutor({ chatMode: 'ask' })

    let results: Array<Record<string, unknown>> = []
    await runWithAgentContextAsync(buildAgentCtx('agent-A'), async () => {
      executor.addTool({ id: 'tu_ask', name: 'grep', input: { pattern: 'x' } })
      results = await drainRemaining(executor)
    })

    expect(mockedRunAgenticToolUse).not.toHaveBeenCalled()
    expect(results).toHaveLength(1)
    expect(results[0]!.is_error).toBe(true)
    expect(String(results[0]!.content)).toMatch(/Ask mode/i)
    expect(String(results[0]!.content)).toMatch(/\(matched: .*chat_mode:ask.*\)/)
  })

  it('chatMode "plan": a read-only tool still executes (plan allows reads)', async () => {
    mockedRunAgenticToolUse.mockResolvedValueOnce({
      type: 'tool_result',
      tool_use_id: 'tu_plan_ro',
      content: 'ok',
    })

    const { executor } = makeExecutor({ chatMode: 'plan' })
    let results: Array<Record<string, unknown>> = []
    await runWithAgentContextAsync(buildAgentCtx('agent-A'), async () => {
      executor.addTool({ id: 'tu_plan_ro', name: 'grep', input: { pattern: 'x' } })
      results = await drainRemaining(executor)
    })

    expect(mockedRunAgenticToolUse).toHaveBeenCalledTimes(1)
    expect(results).toHaveLength(1)
    expect(String(results[0]!.content)).toMatch(/ok/)
    expect(emitStreamEventForConversationMock).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ orchestrationPhase: 'permission_denied_preflight' }),
    )
  })
})
