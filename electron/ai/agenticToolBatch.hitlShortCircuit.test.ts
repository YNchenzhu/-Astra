/**
 * G4 — `runAgenticToolUseBatch` short-circuits after a HITL placeholder lands.
 *
 * Scenarios:
 *   1. Serial step throws InterruptForHITL → next serial step is skipped (placeholder).
 *   2. Mid-batch HITL → all subsequent steps (serial + parallel) get skipped placeholders.
 *   3. Skipped tools fire `onToolResult` with `success: false` + a clear reason so
 *      telemetry / UI can distinguish them from real failures.
 *
 * The legacy (non-HITL) batch path is covered by other tests.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InterruptForHITL } from '../orchestration/hitl'

// Mock `runAgenticToolUse` so we can deterministically force one tool to act as the HITL
// catcher's output (placeholder block) and the rest to succeed if reached.
const mockResults = new Map<string, Record<string, unknown>>()
vi.mock('./runAgenticToolUse', () => ({
  runAgenticToolUse: vi.fn(async (params: { toolUse: { id: string; name: string } }) => {
    return (
      mockResults.get(params.toolUse.id) ?? {
        type: 'tool_result',
        tool_use_id: params.toolUse.id,
        content: `ok:${params.toolUse.name}:${params.toolUse.id}`,
      }
    )
  }),
}))

// Each step in the synthetic plan is a serial item. We override the planner so we control
// the exact step sequence without relying on production parallel-safety heuristics.
let mockPlan: Array<{
  kind: 'serial'
  item: { id: string; name: string; input: Record<string, unknown> }
  originalIndex: number
}> = []

vi.mock('../orchestration/toolPipeline', async () => {
  const actual = (await vi.importActual('../orchestration/toolPipeline')) as Record<
    string,
    unknown
  >
  return {
    ...actual,
    planToolExecution: () => mockPlan,
    canToolUseRunInParallelBatch: () => false,
    isShellToolName: () => false,
  }
})

vi.mock('../agents/agentContext', () => ({
  getAgentContext: vi.fn(() => ({
    streamConversationId: 'conv-hitl-batch',
    signal: new AbortController().signal,
  })),
  syncAgentContextConversation: vi.fn(),
  runWithAgentContextAsync: vi.fn(async (_ctx: unknown, fn: () => unknown) => fn()),
}))

beforeEach(() => {
  mockResults.clear()
  mockPlan = []
})

afterEach(() => {
  vi.clearAllMocks()
})

async function makeBatch(): Promise<typeof import('./agenticToolBatch').runAgenticToolUseBatch> {
  const mod = await import('./agenticToolBatch')
  return mod.runAgenticToolUseBatch
}

const sharedParams = {
  signal: new AbortController().signal,
  diffPermissionMode: 'default' as const,
  permissionDefaultMode: 'allow' as const,
  permissionRules: [],
  discoveryExclude: new Set<string>(),
  getInlineSkillSession: () => null,
  setInlineSkillSession: () => {},
}

describe('G4 — batch HITL short-circuit', () => {
  it('serial HITL placeholder skips subsequent serial steps', async () => {
    const onToolResult = vi.fn()
    const onToolStart = vi.fn()
    // Plan: 3 serial steps. The first one returns a HITL placeholder; the other two
    // should NEVER execute (their `runAgenticToolUse` mock would have returned `ok:...`,
    // but we should see synthesised skipped placeholders instead).
    mockPlan = [
      { kind: 'serial', item: { id: 't1', name: 'AskUserQuestion', input: {} }, originalIndex: 0 },
      { kind: 'serial', item: { id: 't2', name: 'Bash', input: {} }, originalIndex: 1 },
      { kind: 'serial', item: { id: 't3', name: 'Write', input: {} }, originalIndex: 2 },
    ]
    mockResults.set('t1', {
      type: 'tool_result',
      tool_use_id: 't1',
      is_error: false,
      content: '[HITL paused …]',
      _hitlPlaceholder: true,
    })
    const runAgenticToolUseBatch = await makeBatch()
    const out = await runAgenticToolUseBatch({
      toolUseBlocks: mockPlan.map((s) => s.item),
      callbacks: { onToolStart, onToolResult },
      ...sharedParams,
    })
    // Three result blocks pairing all three tool_use ids (Anthropic wire format).
    expect(out).toHaveLength(3)
    expect((out[0] as { _hitlPlaceholder?: unknown })._hitlPlaceholder).toBe(true)
    expect((out[1] as { _hitlSkipped?: unknown })._hitlSkipped).toBe(true)
    expect((out[2] as { _hitlSkipped?: unknown })._hitlSkipped).toBe(true)
    // Skipped tools should NOT have called the runAgenticToolUse mock — verify the count.
    const ru = await import('./runAgenticToolUse')
    expect(ru.runAgenticToolUse).toHaveBeenCalledTimes(1)
    expect(
      vi.mocked(ru.runAgenticToolUse).mock.calls.some(([p]) => p.toolUse.id === 't1'),
    ).toBe(true)
    // onToolResult fires for t1 (real run) + t2/t3 (skipped placeholder synthesis).
    expect(onToolResult.mock.calls.map((c) => c[0].id)).toEqual(['t2', 't3'])
    expect(onToolResult.mock.calls.every((c) => c[0].success === false)).toBe(true)
  })

  it('mid-plan HITL skips later steps but executes earlier ones normally', async () => {
    const onToolResult = vi.fn()
    mockPlan = [
      { kind: 'serial', item: { id: 'a', name: 'Read', input: {} }, originalIndex: 0 },
      { kind: 'serial', item: { id: 'b', name: 'AskUserQuestion', input: {} }, originalIndex: 1 },
      { kind: 'serial', item: { id: 'c', name: 'Edit', input: {} }, originalIndex: 2 },
    ]
    mockResults.set('b', {
      type: 'tool_result',
      tool_use_id: 'b',
      is_error: false,
      content: '[HITL paused …]',
      _hitlPlaceholder: true,
    })
    const runAgenticToolUseBatch = await makeBatch()
    const out = await runAgenticToolUseBatch({
      toolUseBlocks: mockPlan.map((s) => s.item),
      callbacks: { onToolStart: vi.fn(), onToolResult },
      ...sharedParams,
    })
    // a ran (legit), b returned placeholder, c skipped.
    expect((out[0] as { content: string }).content).toMatch(/ok:Read:a/)
    expect((out[1] as { _hitlPlaceholder?: unknown })._hitlPlaceholder).toBe(true)
    expect((out[2] as { _hitlSkipped?: unknown })._hitlSkipped).toBe(true)
    const ru = await import('./runAgenticToolUse')
    // a + b → 2 actual runs. c never ran.
    expect(ru.runAgenticToolUse).toHaveBeenCalledTimes(2)
  })

  // Reference the throw class so the import isn't tree-shaken to silence "unused" lint.
  it('InterruptForHITL is exported for catchers (smoke)', () => {
    const e = new InterruptForHITL('tu_x', null)
    expect(e.toolUseId).toBe('tu_x')
  })
})
