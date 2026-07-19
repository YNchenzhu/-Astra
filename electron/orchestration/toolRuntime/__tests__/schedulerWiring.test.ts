/**
 * Integration tests for the ToolScheduler wire-in completed in stages 1a–1c:
 *
 *   - `DefaultToolRuntimePort.executeToolBatch` (port.ts) enqueues batches,
 *     marks per-tool completion/failure, and applies cross-agent quota admission.
 *   - `StreamingToolExecutor.addTool` + `executeToolUse` (streamingToolExecutor.ts)
 *     enqueue single-tool batches and mark completion/failure.
 *   - `unspawnAndUntrackAgent` (agentLifecycle.ts) calls `scheduler.cancelAgent`
 *     so an unregistered agent's queued/scheduled scheduler nodes are dropped
 *     instead of leaking for the 120s cleanup window.
 *
 * These tests exercise the OBSERVABLE scheduler state changes, not internal mock
 * call counts — `scheduler.debugDump()` is the truth source for assertions.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Stub `runAgenticToolUseBatch` so we don't spin real tool execution.
vi.mock('../../../ai/agenticToolBatch', () => ({
  runAgenticToolUseBatch: vi.fn(),
  toolResultBlockIndicatesFailure: (block: Record<string, unknown>) =>
    typeof block.content === 'string' && (block.content as string).startsWith('Error:'),
}))

// Stub the agentic-tool registry so isReadOnly lookups have deterministic answers.
vi.mock('../../../tools/registry', () => ({
  toolRegistry: {
    get: (name: string) => {
      if (name === 'Read' || name === 'Grep') return { isReadOnly: true }
      if (name === 'Write' || name === 'Edit') return { isReadOnly: false }
      return undefined
    },
  },
}))

// Stub `runAgenticToolUse` so the streaming-path tests don't try to spin real
// tool execution (the full code path requires AgentContext, permission rules,
// file system, etc.). Each test configures what the inner call returns.
const runAgenticToolUseMock = vi.fn()
vi.mock('../../../ai/runAgenticToolUse', () => ({
  runAgenticToolUse: (params: unknown) => runAgenticToolUseMock(params),
}))

// Stub the agent-context lookup to a stable shape so register / agentId
// resolution in streamingToolExecutor is deterministic.
vi.mock('../../../agents/agentContext', () => ({
  getAgentContext: () => ({
    agentId: 'agent_streaming_test',
    streamConversationId: 'conv-test',
  }),
}))

import { DefaultToolRuntimePort } from '../defaultToolRuntimePort'
import { runAgenticToolUseBatch } from '../../../ai/agenticToolBatch'
import { StreamingToolExecutor } from '../../../ai/streamingToolExecutor'
import {
  getToolScheduler,
  resetToolSchedulerForTests,
  ToolPriority,
} from '../scheduler'
import {
  clearToolRuntimeStateForTests,
  getAllToolEntries,
  getToolEntry,
  registerToolInvocation,
  markToolRunning,
  markToolCompleted,
} from '../state'
import {
  resetGlobalToolCallHistoryForTests,
} from '../history'
import {
  getResourceQuotaManager,
  resetResourceQuotaManagerForTests,
} from '../quota'
import { asAgentId } from '../../../tools/ids'

function makeKernelLoopState() {
  return {
    phase: 'CallModel',
    iteration: 1,
    innerIteration: 0,
    transcript: [],
    inbox: [],
    maxOutputRecoveryCycles: 0,
    consecutiveCompactFailures: 0,
  }
}

function makePort() {
  return new DefaultToolRuntimePort({ get: () => null, set: () => {} })
}

function dumpNodes(): Array<{ id: string; status: string; name: string }> {
  const lines = getToolScheduler().debugDump().split('\n').filter((l) => l.trim())
  return lines.map((line) => {
    const m = /^(\S+) \[(\w+)\] (\S+)/.exec(line)
    return m ? { id: m[1], status: m[2], name: m[3] } : { id: '?', status: '?', name: '?' }
  })
}

beforeEach(() => {
  clearToolRuntimeStateForTests()
  resetGlobalToolCallHistoryForTests()
  resetToolSchedulerForTests()
  resetResourceQuotaManagerForTests()
  runAgenticToolUseMock.mockReset()
})

afterEach(() => {
  clearToolRuntimeStateForTests()
  resetGlobalToolCallHistoryForTests()
  resetToolSchedulerForTests()
  resetResourceQuotaManagerForTests()
  vi.mocked(runAgenticToolUseBatch).mockReset()
  runAgenticToolUseMock.mockReset()
})

// ─── A. Port wiring ───────────────────────────────────────────────────

describe('DefaultToolRuntimePort wires ToolScheduler', () => {
  it('enqueues each batch tool into the scheduler before executing', async () => {
    vi.mocked(runAgenticToolUseBatch).mockResolvedValue([
      { type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' },
      { type: 'tool_result', tool_use_id: 'tu_2', content: 'ok' },
    ])
    const port = makePort()

    await port.executeToolBatch({
      state: makeKernelLoopState() as never,
      toolUses: [
        { id: 'tu_1', name: 'Read', input: { path: '/a' } },
        { id: 'tu_2', name: 'Grep', input: { pattern: 'foo' } },
      ],
      signal: new AbortController().signal,
      diffPermissionMode: 'default',
      permissionDefaultMode: 'ask',
      discoveryExclude: new Set(),
    })

    const nodes = dumpNodes()
    expect(nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'tu_1', name: 'Read' }),
        expect.objectContaining({ id: 'tu_2', name: 'Grep' }),
      ]),
    )
  })

  it('marks scheduler nodes completed when tools succeed', async () => {
    vi.mocked(runAgenticToolUseBatch).mockImplementation(async ({ callbacks, toolUseBlocks }) => {
      for (const tu of toolUseBlocks) {
        callbacks.onToolStart(tu)
        callbacks.onToolResult({ id: tu.id, name: tu.name, success: true })
      }
      return toolUseBlocks.map((tu) => ({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: 'ok',
      }))
    })
    const port = makePort()

    await port.executeToolBatch({
      state: makeKernelLoopState() as never,
      toolUses: [{ id: 'tu_1', name: 'Read', input: {} }],
      signal: new AbortController().signal,
      diffPermissionMode: 'default',
      permissionDefaultMode: 'ask',
      discoveryExclude: new Set(),
    })

    const node = dumpNodes().find((n) => n.id === 'tu_1')
    expect(node?.status).toBe('completed')
  })

  it('marks scheduler nodes failed when tools fail', async () => {
    vi.mocked(runAgenticToolUseBatch).mockImplementation(async ({ callbacks, toolUseBlocks }) => {
      for (const tu of toolUseBlocks) {
        callbacks.onToolStart(tu)
        callbacks.onToolResult({ id: tu.id, name: tu.name, success: false, error: 'boom' })
      }
      return toolUseBlocks.map((tu) => ({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: 'Error: boom',
      }))
    })
    const port = makePort()

    await port.executeToolBatch({
      state: makeKernelLoopState() as never,
      toolUses: [{ id: 'tu_1', name: 'Write', input: {} }],
      signal: new AbortController().signal,
      diffPermissionMode: 'default',
      permissionDefaultMode: 'ask',
      discoveryExclude: new Set(),
    })

    const node = dumpNodes().find((n) => n.id === 'tu_1')
    expect(node?.status).toBe('failed')
  })

  it('quota admission denial produces a permission_denied_preflight event and synthesizes a tool_result', async () => {
    // Pre-saturate the mutation slot in ToolRuntimeState so the next mutation tool admission fails.
    // backpressureMaxWaitMs=0 → legacy instant deny (this test asserts the denial
    // event shape, not the P2-5 wait behaviour — that's covered in port.test.ts).
    const quota = getResourceQuotaManager()
    quota.updateConfig({ maxGlobalMutationParallel: 0, backpressureMaxWaitMs: 0 })

    // TransportPort: must expose `emit` (and optionally `emitPhase`). The phase event
    // shape returned through `emit` is `{ type: 'orchestration_phase', orchestrationPhase, ... }`.
    const transportEmits: Array<Record<string, unknown>> = []
    const transport = {
      emit: (ev: Record<string, unknown>) => transportEmits.push(ev),
    }

    vi.mocked(runAgenticToolUseBatch).mockResolvedValue([])
    const port = new DefaultToolRuntimePort(
      { get: () => null, set: () => {} },
      { transport: transport as never },
    )

    const result = await port.executeToolBatch({
      state: makeKernelLoopState() as never,
      toolUses: [{ id: 'tu_write', name: 'Write', input: { path: '/a' } }],
      signal: new AbortController().signal,
      diffPermissionMode: 'default',
      permissionDefaultMode: 'ask',
      discoveryExclude: new Set(),
    })

    // Synthesized denial tool_result must be present with is_error=true
    expect(result.toolResultBlocks).toHaveLength(1)
    expect(result.toolResultBlocks[0]).toMatchObject({
      tool_use_id: 'tu_write',
      is_error: true,
    })
    expect((result.toolResultBlocks[0] as { content: string }).content).toMatch(
      /Resource quota exceeded/,
    )

    // The phase event surfaced with the matched rule tagged as `quota:*`.
    const denialEvent = transportEmits.find(
      (e) => e.orchestrationPhase === 'permission_denied_preflight',
    ) as { permissionDenial?: { matchedRule?: string } } | undefined
    expect(denialEvent?.permissionDenial?.matchedRule).toMatch(/^quota:/)

    // The scheduler node ended up failed (not lingering as queued).
    const node = dumpNodes().find((n) => n.id === 'tu_write')
    expect(node?.status).toBe('failed')

    // runAgenticToolUseBatch was called with the allowed subset, which is now empty.
    expect(vi.mocked(runAgenticToolUseBatch)).not.toHaveBeenCalled()
  })

  it('aborted batch with no result triggers the finally-sweep markFailed on scheduler', async () => {
    vi.mocked(runAgenticToolUseBatch).mockImplementation(async () => {
      // never invoke callbacks; simulate a batch that exited early
      return []
    })
    const port = makePort()

    await port.executeToolBatch({
      state: makeKernelLoopState() as never,
      toolUses: [{ id: 'tu_orphan', name: 'Grep', input: {} }],
      signal: new AbortController().signal,
      diffPermissionMode: 'default',
      permissionDefaultMode: 'ask',
      discoveryExclude: new Set(),
    })

    const node = dumpNodes().find((n) => n.id === 'tu_orphan')
    expect(node?.status).toBe('failed')
  })
})

// ─── B'. Streaming-path wiring ────────────────────────────────────────

function makeStreamingExec() {
  return new StreamingToolExecutor({
    signal: new AbortController().signal,
    callbacks: { onToolStart: () => {}, onToolResult: () => {} },
    diffPermissionMode: 'default',
    permissionDefaultMode: 'ask',
    discoveryExclude: new Set(),
    getInlineSkillSession: () => null,
    setInlineSkillSession: () => {},
  })
}

describe('StreamingToolExecutor wires ToolScheduler + ToolRuntimeState', () => {
  it('addTool registers the tool in BOTH the scheduler AND ToolRuntimeState', () => {
    const exec = makeStreamingExec()
    // Block execution by NOT mocking runAgenticToolUse — addTool calls tryExecute
    // which calls executeToolUse which awaits runAgenticToolUse. Without the
    // mock, runAgenticToolUseMock returns undefined → executeToolUse hits the
    // catch and marks failed. To isolate addTool's registration, we make
    // runAgenticToolUse hang.
    runAgenticToolUseMock.mockImplementation(() => new Promise(() => {}))

    exec.addTool({ id: 'tu_s1', name: 'Read', input: { path: '/a' } })

    // ToolRuntimeState now contains the entry (status 'queued' or 'running')
    const stateEntry = getToolEntry('tu_s1')
    expect(stateEntry).toBeDefined()
    expect(stateEntry?.agentId).toBe('agent_streaming_test')

    // Scheduler also has the node
    const node = dumpNodes().find((n) => n.id === 'tu_s1')
    expect(node?.name).toBe('Read')
  })

  it('marks BOTH the runtime entry and scheduler node as failed on quota denial', async () => {
    // Saturate the mutation slot so a mutation admission is denied.
    getResourceQuotaManager().updateConfig({ maxGlobalMutationParallel: 0 })

    const exec = makeStreamingExec()
    // executeToolUse will hit quota.admit denial BEFORE calling runAgenticToolUse,
    // so the mock body never runs. But provide a no-op anyway for safety.
    runAgenticToolUseMock.mockResolvedValue({
      type: 'tool_result',
      tool_use_id: 'tu_s2',
      content: 'ok',
    })

    // Use a non-builtin mutation tool name so addTool doesn't enter the
    // `isBuiltinFullFileWriteTool` preflight branch (which would write-preflight
    // gate first and short-circuit the path we're trying to exercise).
    exec.addTool({ id: 'tu_s2', name: 'CustomMutation', input: { path: '/x' } })

    // Wait for the async execute promise to settle. addTool returns
    // synchronously; we need to let the tryExecute → executeToolUse async
    // chain reach quota.admit + return.
    await new Promise((r) => setTimeout(r, 10))

    const stateEntry = getToolEntry('tu_s2')
    expect(stateEntry?.status).toBe('failed')
    expect(stateEntry?.errorMessage).toMatch(/Resource quota exceeded/)

    const node = dumpNodes().find((n) => n.id === 'tu_s2')
    expect(node?.status).toBe('failed')
  })

  it('marks BOTH terminal states completed when runAgenticToolUse returns a successful tool_result', async () => {
    const exec = makeStreamingExec()
    runAgenticToolUseMock.mockResolvedValue({
      type: 'tool_result',
      tool_use_id: 'tu_s3',
      content: 'success output',
    })

    exec.addTool({ id: 'tu_s3', name: 'Read', input: { path: '/a' } })
    await new Promise((r) => setTimeout(r, 10))

    const stateEntry = getToolEntry('tu_s3')
    expect(stateEntry?.status).toBe('completed')

    const node = dumpNodes().find((n) => n.id === 'tu_s3')
    expect(node?.status).toBe('completed')
  })

  it('marks BOTH terminal states failed when runAgenticToolUse returns an Error tool_result', async () => {
    const exec = makeStreamingExec()
    runAgenticToolUseMock.mockResolvedValue({
      type: 'tool_result',
      tool_use_id: 'tu_s4',
      content: 'Error: file not found',
    })

    exec.addTool({ id: 'tu_s4', name: 'Read', input: { path: '/missing' } })
    await new Promise((r) => setTimeout(r, 10))

    const stateEntry = getToolEntry('tu_s4')
    expect(stateEntry?.status).toBe('failed')

    const node = dumpNodes().find((n) => n.id === 'tu_s4')
    expect(node?.status).toBe('failed')
  })

  it('getAbortedResults marks runtime entries aborted for tools still in flight', async () => {
    const exec = makeStreamingExec()
    // Make runAgenticToolUse hang so the tool stays in 'executing' status
    runAgenticToolUseMock.mockImplementation(() => new Promise(() => {}))

    exec.addTool({ id: 'tu_s5', name: 'Grep', input: { pattern: 'foo' } })
    // Let tryExecute fire so status transitions queued → running
    await new Promise((r) => setTimeout(r, 5))

    exec.markInterrupted()
    // Drain aborted results — this is the call site that does the cleanup
    const results = Array.from(exec.getAbortedResults())
    expect(results).toHaveLength(1)

    const stateEntry = getToolEntry('tu_s5')
    expect(stateEntry?.status).toBe('aborted')

    const node = dumpNodes().find((n) => n.id === 'tu_s5')
    expect(node?.status).toBe('failed') // scheduler uses 'failed' for cancellation too
  })

  it('streaming-path tools count against quota — second streaming executor (different agent) denied while first is running', async () => {
    // Capped at 1 mutation globally so the second one trips quota.
    getResourceQuotaManager().updateConfig({ maxGlobalMutationParallel: 1 })

    // Two SEPARATE streaming executors model cross-agent scenarios where
    // each agent has its own executor instance. The agent context mock returns
    // a stable agentId, but the key point is the SHARED process-wide
    // ToolRuntimeState — first executor's running tool occupies the global
    // mutation slot, second executor's admit() sees it and denies.
    const execA = makeStreamingExec()
    const execB = makeStreamingExec()

    // First tool hangs — stays 'running', occupies the lone mutation slot
    runAgenticToolUseMock.mockImplementationOnce(() => new Promise(() => {}))
    execA.addTool({ id: 'tu_first', name: 'CustomMutation', input: { path: '/a' } })
    await new Promise((r) => setTimeout(r, 5))

    // Confirm first tool occupies the slot (would be 0 if streaming-path
    // tools weren't reflected in ToolRuntimeState).
    const firstSnap = getResourceQuotaManager().snapshot()
    expect(firstSnap.activeMutationTools).toBe(1)

    // Second tool via a SEPARATE executor — quota.admit must deny
    runAgenticToolUseMock.mockResolvedValueOnce({
      type: 'tool_result',
      tool_use_id: 'tu_second',
      content: 'ok',
    })
    execB.addTool({ id: 'tu_second', name: 'CustomMutation', input: { path: '/b' } })
    await new Promise((r) => setTimeout(r, 10))

    const secondEntry = getToolEntry('tu_second')
    expect(secondEntry?.status).toBe('failed')
    expect(secondEntry?.errorMessage).toMatch(/Resource quota exceeded/)
    // runAgenticToolUse must NOT have been called for the second tool
    // (the first call from tu_first is the only one).
    expect(runAgenticToolUseMock).toHaveBeenCalledTimes(1)
    // Both entries are registered in the global state registry
    expect(getAllToolEntries().length).toBeGreaterThanOrEqual(2)
  })
})

// ─── B. Lifecycle wiring ──────────────────────────────────────────────

describe('unspawnAndUntrackAgent wires scheduler.cancelAgent', () => {
  it('removes scheduler nodes owned by the unregistered agent', async () => {
    // Pre-populate the scheduler with nodes from two agents directly (no port,
    // no streaming — we're testing the cancelAgent surface in isolation).
    const scheduler = getToolScheduler()
    scheduler.enqueueBatch([
      {
        toolUseId: 'tu_a1',
        toolName: 'Read',
        agentId: asAgentId('agent_alpha'),
        input: {},
        readOnly: true,
        priority: ToolPriority.NORMAL,
      },
      {
        toolUseId: 'tu_b1',
        toolName: 'Read',
        agentId: asAgentId('agent_beta'),
        input: {},
        readOnly: true,
        priority: ToolPriority.NORMAL,
      },
    ])
    expect(dumpNodes()).toHaveLength(2)

    // Use the SAME entry-point the production code uses, not a direct
    // scheduler.cancelAgent call. This verifies the wire-in, not the scheduler.
    const { unspawnAndUntrackAgent } = await import('../../../agents/agentLifecycle')
    unspawnAndUntrackAgent('agent_alpha')

    const remaining = dumpNodes()
    expect(remaining.find((n) => n.id === 'tu_a1')).toBeUndefined()
    expect(remaining.find((n) => n.id === 'tu_b1')).toBeDefined()
  })
})

// ─── C. Cross-agent visibility ────────────────────────────────────────

describe('ToolScheduler cross-agent visibility', () => {
  it('two enqueueBatch calls from different agents share one scheduler view', () => {
    const scheduler = getToolScheduler()
    scheduler.enqueueBatch([
      {
        toolUseId: 'tu_a1',
        toolName: 'Read',
        agentId: asAgentId('agent_alpha'),
        input: {},
        readOnly: true,
        priority: ToolPriority.NORMAL,
      },
    ])
    scheduler.enqueueBatch([
      {
        toolUseId: 'tu_b1',
        toolName: 'Write',
        agentId: asAgentId('agent_beta'),
        input: {},
        readOnly: false,
        priority: ToolPriority.NORMAL,
      },
    ])

    const nodes = dumpNodes()
    expect(nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'tu_a1', name: 'Read' }),
        expect.objectContaining({ id: 'tu_b1', name: 'Write' }),
      ]),
    )
  })

  it('quota.admit reads global ToolRuntimeState — running mutation in agent A blocks new mutation in agent B', () => {
    const quota = getResourceQuotaManager()
    quota.updateConfig({ maxGlobalMutationParallel: 1 })

    // Agent A starts a mutation tool that's now "running".
    registerToolInvocation({
      toolUseId: 'tu_running',
      toolName: 'Write',
      agentId: asAgentId('agent_alpha'),
      input: {},
    })
    markToolRunning('tu_running')

    // Agent B tries to admit a mutation tool → should be denied.
    const decision = quota.admit({
      toolName: 'Write',
      toolUseId: 'tu_b1',
      agentId: asAgentId('agent_beta'),
      isReadOnly: false,
      priority: ToolPriority.NORMAL,
    })

    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe('mutation_concurrency')

    // After agent A's tool completes, admission for agent B should succeed.
    markToolCompleted('tu_running')
    const retry = quota.admit({
      toolName: 'Write',
      toolUseId: 'tu_b2',
      agentId: asAgentId('agent_beta'),
      isReadOnly: false,
      priority: ToolPriority.NORMAL,
    })
    expect(retry.allowed).toBe(true)
  })
})
