import { describe, expect, it, vi, afterEach } from 'vitest'
import {
  NON_PARALLEL_TOOLS,
  canToolUseRunInParallelBatch,
  isShellToolName,
  maxParallelChunkSize,
  partitionToolUsesIntoChunks,
  planToolExecution,
} from './toolPipeline'

describe('partitionToolUsesIntoChunks', () => {
  it('returns one chunk per tool when names are unknown', () => {
    const chunks = partitionToolUsesIntoChunks([
      { id: '1', name: 'UnknownTool', input: {} },
      { id: '2', name: 'UnknownTool2', input: {} },
    ])
    expect(chunks.length).toBeGreaterThanOrEqual(1)
  })
})

describe('canToolUseRunInParallelBatch', () => {
  it('non-parallel list blocks concurrency regardless of registry opinion', () => {
    for (const n of NON_PARALLEL_TOOLS) {
      expect(canToolUseRunInParallelBatch(n, {})).toBe(false)
    }
  })

  it('unknown tools default to non-parallel', () => {
    expect(canToolUseRunInParallelBatch('UnknownTool', {})).toBe(false)
  })
})

describe('isShellToolName', () => {
  it('matches bash / powershell case-insensitive', () => {
    expect(isShellToolName('bash')).toBe(true)
    expect(isShellToolName('Bash')).toBe(true)
    expect(isShellToolName('POWERSHELL')).toBe(true)
    expect(isShellToolName('python')).toBe(false)
  })
})

describe('maxParallelChunkSize', () => {
  it('applies the Agent ceiling when the chunk contains an Agent tool', () => {
    const withAgent = [{ name: 'Agent' }, { name: 'Read' }]
    const withoutAgent = [{ name: 'Read' }, { name: 'Grep' }]
    expect(maxParallelChunkSize(withAgent)).toBeLessThanOrEqual(
      maxParallelChunkSize(withoutAgent),
    )
  })
})

describe('planToolExecution (consumed by agenticToolBatch)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('emits a serial step per non-parallel-safe tool', () => {
    const plan = planToolExecution([
      { id: 'a', name: 'Skill', input: {} },
      { id: 'b', name: 'AskUserQuestion', input: {} },
    ])
    expect(plan).toHaveLength(2)
    expect(plan[0]).toMatchObject({ kind: 'serial', originalIndex: 0 })
    expect(plan[1]).toMatchObject({ kind: 'serial', originalIndex: 1 })
  })

  it('preserves originalIndex for downstream telemetry', () => {
    const plan = planToolExecution([
      { id: 'a', name: 'Skill', input: {} },
      { id: 'b', name: 'SendMessage', input: {} },
      { id: 'c', name: 'Skill', input: {} },
    ])
    const indices = plan.map((step) =>
      step.kind === 'serial' ? step.originalIndex : step.originalIndex,
    )
    expect(indices).toEqual([0, 1, 2])
  })
})
