import { describe, it, expect } from 'vitest'
import {
  activityFromLoopEvent,
  createActivityRing,
  createBoundedRing,
  createStderrRing,
  DEFAULT_ACTIVITY_RING_SIZE,
  DEFAULT_STDERR_RING_SIZE,
} from './activityRing'

describe('createBoundedRing', () => {
  it('keeps insertion order under capacity', () => {
    const r = createBoundedRing<number>(5)
    r.push(1)
    r.push(2)
    r.push(3)
    expect([...r.snapshot()]).toEqual([1, 2, 3])
    expect(r.size()).toBe(3)
    expect(r.latest()).toBe(3)
  })

  it('drops oldest when capacity exceeded', () => {
    const r = createBoundedRing<number>(3)
    for (let i = 1; i <= 5; i++) r.push(i)
    expect([...r.snapshot()]).toEqual([3, 4, 5])
    expect(r.size()).toBe(3)
    expect(r.capacity()).toBe(3)
  })

  it('snapshot reference is stable until next push', () => {
    const r = createBoundedRing<number>(3)
    r.push(1)
    const s1 = r.snapshot()
    r.push(2)
    const s2 = r.snapshot()
    expect(s1).not.toBe(s2)
    expect([...s1]).toEqual([1])
    expect([...s2]).toEqual([1, 2])
  })

  it('rejects non-positive capacity', () => {
    expect(() => createBoundedRing<number>(0)).toThrow()
    expect(() => createBoundedRing<number>(-1)).toThrow()
    expect(() => createBoundedRing<number>(NaN)).toThrow()
  })

  it('clear() empties without changing capacity', () => {
    const r = createBoundedRing<number>(3)
    r.push(1)
    r.push(2)
    r.clear()
    expect(r.size()).toBe(0)
    expect(r.latest()).toBeNull()
    r.push(99)
    expect([...r.snapshot()]).toEqual([99])
  })

  it('latest() returns null when empty', () => {
    const r = createBoundedRing<number>(2)
    expect(r.latest()).toBeNull()
  })
})

describe('createActivityRing / createStderrRing — sensible defaults', () => {
  it('defaults match documented OC parity (last 10)', () => {
    expect(createActivityRing().capacity()).toBe(DEFAULT_ACTIVITY_RING_SIZE)
    expect(createStderrRing().capacity()).toBe(DEFAULT_STDERR_RING_SIZE)
    expect(DEFAULT_ACTIVITY_RING_SIZE).toBe(10)
    expect(DEFAULT_STDERR_RING_SIZE).toBe(10)
  })

  it('custom sizes are honoured', () => {
    expect(createActivityRing(5).capacity()).toBe(5)
    expect(createStderrRing(20).capacity()).toBe(20)
  })
})

describe('activityFromLoopEvent — LoopEvent → Activity mapping', () => {
  it('text_delta → text activity (truncated)', () => {
    const long = 'x'.repeat(500)
    const a = activityFromLoopEvent({ type: 'text_delta', text: long })
    expect(a?.kind).toBe('text')
    expect(a!.summary.length).toBeLessThanOrEqual(100)
  })

  it('tool_start → tool_start activity with name', () => {
    const a = activityFromLoopEvent({
      type: 'tool_start',
      toolUse: { id: 't1', name: 'Bash', input: {} },
    })
    expect(a?.kind).toBe('tool_start')
    expect(a?.summary).toBe('tool: Bash')
  })

  it('tool_result success → tool_result activity', () => {
    const a = activityFromLoopEvent({
      type: 'tool_result',
      toolResult: { id: 't1', name: 'Bash', success: true, output: 'ok' },
    })
    expect(a?.kind).toBe('tool_result')
    expect(a?.summary).toContain('tool ok')
    expect(a?.summary).toContain('Bash')
  })

  it('tool_result failure → tool_result activity with error tail', () => {
    const a = activityFromLoopEvent({
      type: 'tool_result',
      toolResult: {
        id: 't1',
        name: 'Bash',
        success: false,
        error: 'permission denied',
      },
    })
    expect(a?.kind).toBe('tool_result')
    expect(a?.summary).toContain('tool fail')
    expect(a?.summary).toContain('permission denied')
  })

  it('error event → error activity', () => {
    const a = activityFromLoopEvent({ type: 'error', error: 'boom' })
    expect(a?.kind).toBe('error')
    expect(a?.summary).toBe('boom')
  })

  it('context_compact → note', () => {
    const a = activityFromLoopEvent({ type: 'context_compact', level: 'micro_compact' })
    expect(a?.kind).toBe('note')
    expect(a?.summary).toContain('micro_compact')
  })

  it('streaming_fallback → note', () => {
    const a = activityFromLoopEvent({
      type: 'streaming_fallback',
      info: { status: 529, reason: 'overload' },
    })
    expect(a?.kind).toBe('note')
    expect(a?.summary).toContain('overload')
  })

  it('events without UI surface return null (telemetry-only)', () => {
    expect(
      activityFromLoopEvent({ type: 'thinking_delta', text: 't' }),
    ).toBeNull()
    expect(
      activityFromLoopEvent({
        type: 'message_end',
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    ).toBeNull()
    expect(
      activityFromLoopEvent({ type: 'max_iterations', maxIterations: 50 }),
    ).toBeNull()
    expect(
      activityFromLoopEvent({
        type: 'pre_model',
        info: { iteration: 1, phases: [], snippedCount: 0, wasContextManaged: false },
      }),
    ).toBeNull()
  })
})
