/**
 * Tests for the tool-input batcher. Pure module — no zustand / DOM needed;
 * we install a capture flush fn and drive flushes explicitly (mirrors
 * `streamingDeltaBatcher.test.ts`).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  enqueueToolInputDelta,
  flushPendingToolInputsNow,
  installToolInputBatchFlush,
  __resetToolInputBatcherForTests,
  __peekPendingToolInputsForTests,
  type ToolInputEntry,
} from './toolInputDeltaBatcher'

type Captured = Array<{ convId: string; entries: Map<string, ToolInputEntry> }>

let captured: Captured

beforeEach(() => {
  __resetToolInputBatcherForTests()
  captured = []
  installToolInputBatchFlush((convId, entries) => {
    captured.push({ convId, entries: new Map(entries) })
  })
})

afterEach(() => {
  __resetToolInputBatcherForTests()
})

describe('toolInputDeltaBatcher', () => {
  it('coalesces latest-wins per tool within one flush', () => {
    enqueueToolInputDelta('c1', 'a1', 'tool1', '{"x":1')
    enqueueToolInputDelta('c1', 'a1', 'tool1', '{"x":1,"y":2')
    enqueueToolInputDelta('c1', 'a1', 'tool1', '{"x":1,"y":2,"z":3}')

    flushPendingToolInputsNow()

    expect(captured).toHaveLength(1)
    expect(captured[0].convId).toBe('c1')
    expect(captured[0].entries.get('tool1')).toEqual({
      assistantId: 'a1',
      partialJson: '{"x":1,"y":2,"z":3}',
    })
  })

  it('buckets multiple tools in the same conversation', () => {
    enqueueToolInputDelta('c1', 'a1', 'tool1', '{"a":1}')
    enqueueToolInputDelta('c1', 'a1', 'tool2', '{"b":2}')

    flushPendingToolInputsNow()

    expect(captured).toHaveLength(1)
    expect(captured[0].entries.size).toBe(2)
    expect(captured[0].entries.get('tool1')?.partialJson).toBe('{"a":1}')
    expect(captured[0].entries.get('tool2')?.partialJson).toBe('{"b":2}')
  })

  it('separates buckets per conversation', () => {
    enqueueToolInputDelta('c1', 'a1', 'tool1', '{"a":1}')
    enqueueToolInputDelta('c2', 'a2', 'tool2', '{"b":2}')

    flushPendingToolInputsNow()

    expect(captured).toHaveLength(2)
    const byConv = new Map(captured.map((c) => [c.convId, c.entries]))
    expect(byConv.get('c1')?.get('tool1')?.partialJson).toBe('{"a":1}')
    expect(byConv.get('c2')?.get('tool2')?.partialJson).toBe('{"b":2}')
  })

  it('ignores empty partialJson', () => {
    enqueueToolInputDelta('c1', 'a1', 'tool1', '')
    expect(__peekPendingToolInputsForTests().size).toBe(0)
    flushPendingToolInputsNow()
    expect(captured).toHaveLength(0)
  })

  it('clears pending after flush (second flush is a no-op)', () => {
    enqueueToolInputDelta('c1', 'a1', 'tool1', '{"a":1}')
    flushPendingToolInputsNow()
    expect(captured).toHaveLength(1)

    flushPendingToolInputsNow()
    expect(captured).toHaveLength(1)
    expect(__peekPendingToolInputsForTests().size).toBe(0)
  })

  it('honours a replaced flush fn', () => {
    const alt: Captured = []
    installToolInputBatchFlush((convId, entries) => {
      alt.push({ convId, entries: new Map(entries) })
    })
    enqueueToolInputDelta('c1', 'a1', 'tool1', '{"a":1}')
    flushPendingToolInputsNow()

    expect(captured).toHaveLength(0)
    expect(alt).toHaveLength(1)
  })
})
