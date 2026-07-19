/**
 * Unit tests for `DefaultToolRuntimePort.executeToolBatch` (F3 follow-up).
 *
 * Covers the Chunk 5a/5b wire-in that the previous test surface (in
 * `defaultAdapters.test.ts`) only exercised via the preflight branch:
 *   - registerToolInvocation called for every tool in the batch
 *   - history.check blocks the SECOND identical-fingerprint failed call
 *     (cross-agent repeat-failure guard)
 *   - markToolCompleted / markToolFailed flow through the wrapped
 *     onToolStart / onToolResult callbacks
 *   - Sweep on batch end marks any tool that never reached terminal as aborted
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Stub `runAgenticToolUseBatch` so we don't spin real tool execution. Each test
// chooses what the inner batch returns so we can assert the wire-in around it.
vi.mock('../../../ai/agenticToolBatch', () => ({
  runAgenticToolUseBatch: vi.fn(),
  toolResultBlockIndicatesFailure: (block: Record<string, unknown>) =>
    typeof block.content === 'string' && block.content.startsWith('Error:'),
}))

import { DefaultToolRuntimePort } from '../defaultToolRuntimePort'
import { createTransportAdapter } from '../../transport'
import { runAgenticToolUseBatch } from '../../../ai/agenticToolBatch'
import {
  clearToolRuntimeStateForTests,
  getAllToolEntries,
  getToolEntry,
  markToolCompleted,
  markToolRunning,
  registerToolInvocation,
} from '../state'
import {
  getGlobalToolCallHistory,
  resetGlobalToolCallHistoryForTests,
} from '../history'
import {
  getResourceQuotaManager,
  resetResourceQuotaManagerForTests,
} from '../quota'

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

afterEach(() => {
  clearToolRuntimeStateForTests()
  resetGlobalToolCallHistoryForTests()
  resetResourceQuotaManagerForTests()
  vi.mocked(runAgenticToolUseBatch).mockReset()
})

describe('DefaultToolRuntimePort.executeToolBatch — Chunk 5a wire-in', () => {
  beforeEach(() => {
    clearToolRuntimeStateForTests()
    resetGlobalToolCallHistoryForTests()
  })

  it('registers every tool in the batch as queued before executing', async () => {
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
    expect(getAllToolEntries()).toHaveLength(2)
    expect(getToolEntry('tu_1')?.toolName).toBe('Read')
    expect(getToolEntry('tu_2')?.toolName).toBe('Grep')
  })

  it('onToolStart wrap marks tool as running; onToolResult wrap marks completed', async () => {
    let capturedCallbacks: import('../../../ai/agenticToolBatch').AgenticToolBatchCallbacks | undefined
    let statusAfterStart: string | undefined
    vi.mocked(runAgenticToolUseBatch).mockImplementation(async (params) => {
      capturedCallbacks = params.callbacks
      params.callbacks.onToolStart({ id: 'tu_1', name: 'Read', input: {} })
      statusAfterStart = getToolEntry('tu_1')?.status
      params.callbacks.onToolResult({ id: 'tu_1', name: 'Read', success: true })
      return [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' }]
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
    expect(capturedCallbacks).toBeDefined()
    expect(statusAfterStart).toBe('running')
    expect(getToolEntry('tu_1')?.status).toBe('completed')
  })

  it('onToolResult with success=false marks tool as failed with the error string', async () => {
    let capturedCallbacks: import('../../../ai/agenticToolBatch').AgenticToolBatchCallbacks | undefined
    vi.mocked(runAgenticToolUseBatch).mockImplementation(async (params) => {
      capturedCallbacks = params.callbacks
      params.callbacks.onToolStart({ id: 'tu_x', name: 'Bash', input: { cmd: 'false' } })
      params.callbacks.onToolResult({
        id: 'tu_x',
        name: 'Bash',
        success: false,
        error: 'boom',
      })
      return [{ type: 'tool_result', tool_use_id: 'tu_x', content: 'Error: boom' }]
    })
    const port = makePort()
    await port.executeToolBatch({
      state: makeKernelLoopState() as never,
      toolUses: [{ id: 'tu_x', name: 'Bash', input: { cmd: 'false' } }],
      signal: new AbortController().signal,
      diffPermissionMode: 'default',
      permissionDefaultMode: 'ask',
      discoveryExclude: new Set(),
    })
    expect(capturedCallbacks).toBeDefined()
    const entry = getToolEntry('tu_x')
    expect(entry?.status).toBe('failed')
    expect(entry?.errorMessage).toBe('boom')
  })

  it('sweep: tools that never reached terminal get marked aborted on batch end', async () => {
    vi.mocked(runAgenticToolUseBatch).mockResolvedValue([
      // Inner batch only returns tu_1; tu_2 was registered but never reported.
      { type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' },
    ])
    const port = makePort()
    await port.executeToolBatch({
      state: makeKernelLoopState() as never,
      toolUses: [
        { id: 'tu_1', name: 'Read', input: {} },
        { id: 'tu_2', name: 'Read', input: {} },
      ],
      signal: new AbortController().signal,
      diffPermissionMode: 'default',
      permissionDefaultMode: 'ask',
      discoveryExclude: new Set(),
    })
    // tu_2 was registered (queued) but inner batch never fired its onToolResult.
    expect(getToolEntry('tu_2')?.status).toBe('aborted')
    expect(getToolEntry('tu_2')?.errorMessage).toBe('batch ended without result')
  })
})

describe('DefaultToolRuntimePort.executeToolBatch — P2-5 quota backpressure', () => {
  beforeEach(() => {
    clearToolRuntimeStateForTests()
    resetGlobalToolCallHistoryForTests()
    resetResourceQuotaManagerForTests()
  })

  it('waits for a quota slot instead of hard-failing, then executes (P2-5 fix)', async () => {
    // 1 mutation slot globally; a non-preemptible mutation tool from another
    // agent is already running and holding it.
    getResourceQuotaManager({
      maxGlobalMutationParallel: 1,
      backpressureMaxWaitMs: 3_000,
      enablePreemption: false,
    })
    registerToolInvocation({
      toolUseId: 'tu_blocker',
      toolName: 'OtherMutation',
      agentId: 'agent-Z',
      input: {},
      isReadOnly: false,
    })
    markToolRunning('tu_blocker')

    vi.mocked(runAgenticToolUseBatch).mockResolvedValue([
      { type: 'tool_result', tool_use_id: 'tu_bp', content: 'ok' },
    ])

    // Free the slot 150ms in — the backpressure retry (≥500ms for
    // mutation_concurrency) re-admits on its first attempt.
    setTimeout(() => markToolCompleted('tu_blocker'), 150)

    const port = makePort()
    const started = Date.now()
    const out = await port.executeToolBatch({
      state: makeKernelLoopState() as never,
      toolUses: [{ id: 'tu_bp', name: 'SomeMutation', input: { v: 1 } }],
      signal: new AbortController().signal,
      diffPermissionMode: 'default',
      permissionDefaultMode: 'ask',
      discoveryExclude: new Set(),
    })

    // Pre-fix this was an instant `Resource quota exceeded` denial block.
    expect(out.hadFailure).toBe(false)
    expect(runAgenticToolUseBatch).toHaveBeenCalledOnce()
    expect(out.toolResultBlocks[0]).toMatchObject({ tool_use_id: 'tu_bp', content: 'ok' })
    // It really waited (one retry interval), not just sailed through.
    expect(Date.now() - started).toBeGreaterThanOrEqual(400)
  })

  it('denies with the quota reason only after the wait budget is exhausted', async () => {
    getResourceQuotaManager({
      maxGlobalMutationParallel: 1,
      backpressureMaxWaitMs: 250,
      enablePreemption: false,
    })
    registerToolInvocation({
      toolUseId: 'tu_blocker2',
      toolName: 'OtherMutation',
      agentId: 'agent-Z',
      input: {},
      isReadOnly: false,
    })
    markToolRunning('tu_blocker2') // never completes — budget must run out

    vi.mocked(runAgenticToolUseBatch).mockResolvedValue([])

    const port = makePort()
    const started = Date.now()
    const out = await port.executeToolBatch({
      state: makeKernelLoopState() as never,
      toolUses: [{ id: 'tu_starved', name: 'SomeMutation', input: { v: 2 } }],
      signal: new AbortController().signal,
      diffPermissionMode: 'default',
      permissionDefaultMode: 'ask',
      discoveryExclude: new Set(),
    })

    expect(Date.now() - started).toBeGreaterThanOrEqual(200)
    expect(out.hadFailure).toBe(true)
    expect(String(out.toolResultBlocks[0].content)).toContain('Resource quota exceeded')
    expect(getToolEntry('tu_starved')?.status).toBe('failed')
  })

  it('emits a scheduler_backpressure (quota_backpressure) phase event when entering the wait (audit #12)', async () => {
    // Same starvation setup as above, but with a transport wired so the
    // wait-entry emit (contract audit 2026-07) is observable: the stall must
    // surface to the renderer toast strip, not just console.log.
    getResourceQuotaManager({
      maxGlobalMutationParallel: 1,
      backpressureMaxWaitMs: 250,
      enablePreemption: false,
    })
    registerToolInvocation({
      toolUseId: 'tu_blocker_emit',
      toolName: 'OtherMutation',
      agentId: 'agent-Z',
      input: {},
      isReadOnly: false,
    })
    markToolRunning('tu_blocker_emit')

    vi.mocked(runAgenticToolUseBatch).mockResolvedValue([])

    const emitted: Array<Record<string, unknown>> = []
    const port = new DefaultToolRuntimePort(
      { get: () => null, set: () => {} },
      { transport: createTransportAdapter((ev) => emitted.push(ev as Record<string, unknown>)) },
    )
    await port.executeToolBatch({
      state: makeKernelLoopState() as never,
      toolUses: [{ id: 'tu_bp_emit', name: 'SomeMutation', input: { v: 9 } }],
      signal: new AbortController().signal,
      diffPermissionMode: 'default',
      permissionDefaultMode: 'ask',
      discoveryExclude: new Set(),
    })

    const bp = emitted.find((ev) => ev.orchestrationPhase === 'scheduler_backpressure') as
      | { schedulerBackpressure?: { toolName: string; toolUseId: string; kind: string; reason?: string } }
      | undefined
    expect(bp).toBeDefined()
    expect(bp?.schedulerBackpressure).toMatchObject({
      toolName: 'SomeMutation',
      toolUseId: 'tu_bp_emit',
      kind: 'quota_backpressure',
    })
  })

  it('setting backpressureMaxWaitMs=0 restores the legacy instant deny', async () => {
    getResourceQuotaManager({
      maxGlobalMutationParallel: 1,
      backpressureMaxWaitMs: 0,
      enablePreemption: false,
    })
    registerToolInvocation({
      toolUseId: 'tu_blocker3',
      toolName: 'OtherMutation',
      agentId: 'agent-Z',
      input: {},
      isReadOnly: false,
    })
    markToolRunning('tu_blocker3')

    vi.mocked(runAgenticToolUseBatch).mockResolvedValue([])

    const port = makePort()
    const started = Date.now()
    const out = await port.executeToolBatch({
      state: makeKernelLoopState() as never,
      toolUses: [{ id: 'tu_legacy', name: 'SomeMutation', input: { v: 3 } }],
      signal: new AbortController().signal,
      diffPermissionMode: 'default',
      permissionDefaultMode: 'ask',
      discoveryExclude: new Set(),
    })

    expect(Date.now() - started).toBeLessThan(150)
    expect(out.hadFailure).toBe(true)
    expect(String(out.toolResultBlocks[0].content)).toContain('Resource quota exceeded')
  })
})

describe('DefaultToolRuntimePort.executeToolBatch — Chunk 5b cross-agent repeat-failure guard', () => {
  beforeEach(() => {
    clearToolRuntimeStateForTests()
    resetGlobalToolCallHistoryForTests()
  })

  it('blocks a tool whose fingerprint has 2+ prior failures in global history', async () => {
    // Pre-seed the global history with 2 failures of bash{cmd:"x"}.
    // Audit fix H4 — record under agentId 'main' so it shares lineage
    // with the port's resolved caller (`agentCtx?.agentId ?? 'main'`).
    // The pre-H4 test used a different agentId on the assumption that
    // global history blocked indiscriminately; that's now scoped.
    const history = getGlobalToolCallHistory({ hintThreshold: 0, blockThreshold: 2 })
    history.record('Bash', { cmd: 'x' }, { success: false, agentId: 'main', agentType: 'main' })
    history.record('Bash', { cmd: 'x' }, { success: false, agentId: 'main', agentType: 'main' })

    // runAgenticToolUseBatch SHOULD NOT be called for the blocked tool.
    vi.mocked(runAgenticToolUseBatch).mockResolvedValue([])

    const onToolResult = vi.fn()
    const port = makePort()
    const out = await port.executeToolBatch({
      state: makeKernelLoopState() as never,
      toolUses: [{ id: 'tu_blocked', name: 'Bash', input: { cmd: 'x' } }],
      signal: new AbortController().signal,
      diffPermissionMode: 'default',
      permissionDefaultMode: 'ask',
      discoveryExclude: new Set(),
      toolCallbacks: { onToolStart: vi.fn(), onToolResult },
    })

    // The blocked tool gets a synthesized denial block, runAgenticToolUseBatch
    // is called with `allowed=[]` (or skipped entirely → still returns []).
    expect(out.toolResultBlocks).toHaveLength(1)
    expect(out.hadFailure).toBe(true)
    expect(out.toolResultBlocks[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'tu_blocked',
      is_error: true,
    })
    expect(String(out.toolResultBlocks[0].content)).toMatch(/Cross-agent block/)
    // Policy/history rejection happens before admission, so no runtime lease
    // or scheduler node is created for the denied invocation.
    expect(getToolEntry('tu_blocked')).toBeUndefined()
    // The user's onToolResult callback fired with success=false.
    expect(onToolResult).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'tu_blocked', success: false }),
    )
  })

  it('hint-level history advice does NOT block (only warn)', async () => {
    // Self-audit fix (2026-05): the prior version seeded `agent-A`
    // outcomes without lineage info. The port resolves
    // `callerAgentId: 'main'` and `sharesLineage(['main'], ['agent-A'])`
    // is false → outcomes filtered out → `allow` (not `hint`). The
    // test accidentally passed because allow ALSO lets the tool run,
    // but it was proving lineage isolation, not "hint doesn't block".
    // Now we register agent-A as a child of main so its failures
    // ARE on the caller's lineage, the hint actually fires, and the
    // assertion "hint doesn't block, tool still runs" is proven.
    const history = getGlobalToolCallHistory({ hintThreshold: 1, blockThreshold: 99 })
    history.registerAgentLineage('agent-A', { parentAgentId: 'main' })
    history.record('Bash', { cmd: 'y' }, {
      success: false,
      agentId: 'agent-A',
      parentAgentId: 'main',
    })
    history.record('Bash', { cmd: 'y' }, {
      success: false,
      agentId: 'agent-A',
      parentAgentId: 'main',
    })

    // Sanity precondition for the audit-corrected setup: a direct
    // `check` from the caller's perspective MUST now yield `hint`
    // (proving lineage scoping picks up the agent-A failures). If a
    // future regression makes this return `allow`, the test still
    // catches it instead of silently degrading to the old false-pass.
    const directCheck = history.check('Bash', { cmd: 'y' }, { callerAgentId: 'main' })
    expect(directCheck.level).toBe('hint')

    vi.mocked(runAgenticToolUseBatch).mockResolvedValue([
      { type: 'tool_result', tool_use_id: 'tu_hint', content: 'ok' },
    ])
    const port = makePort()
    const out = await port.executeToolBatch({
      state: makeKernelLoopState() as never,
      toolUses: [{ id: 'tu_hint', name: 'Bash', input: { cmd: 'y' } }],
      signal: new AbortController().signal,
      diffPermissionMode: 'default',
      permissionDefaultMode: 'ask',
      discoveryExclude: new Set(),
    })
    // Now exercise the real invariant: hint advisory does NOT block,
    // tool still runs.
    expect(out.toolResultBlocks).toHaveLength(1)
    expect(out.hadFailure).toBe(false)
    expect(runAgenticToolUseBatch).toHaveBeenCalledOnce()
  })

  it('records outcome to history so the NEXT batch sees the failure', async () => {
    let capturedCallbacks: import('../../../ai/agenticToolBatch').AgenticToolBatchCallbacks | undefined
    vi.mocked(runAgenticToolUseBatch).mockImplementation(async (params) => {
      capturedCallbacks = params.callbacks
      return [{ type: 'tool_result', tool_use_id: 'tu_rec', content: 'Error: boom' }]
    })
    const port = makePort()
    await port.executeToolBatch({
      state: makeKernelLoopState() as never,
      toolUses: [{ id: 'tu_rec', name: 'Bash', input: { cmd: 'z' } }],
      signal: new AbortController().signal,
      diffPermissionMode: 'default',
      permissionDefaultMode: 'ask',
      discoveryExclude: new Set(),
    })
    // Simulate the inner batch firing the onToolResult callback with failure.
    capturedCallbacks!.onToolResult({ id: 'tu_rec', name: 'Bash', success: false, error: 'boom' })

    // Now history should have one outcome for that fingerprint.
    const history = getGlobalToolCallHistory()
    const outcomes = history.getOutcomes('Bash', { cmd: 'z' })
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0].success).toBe(false)
  })
})
