/**
 * Unit tests for the pure delta batcher.
 *
 * These tests never touch zustand / DOM — the batcher exposes a flush
 * callback seam specifically so it can be driven in node without mocking
 * the whole chat store. The integration tests (mainStreamRouter.*.test.ts)
 * cover the end-to-end story with the real store wired in.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  __peekPendingForTests,
  __resetDeltaBatcherForTests,
  enqueueReasoningSummaryDelta,
  enqueueTextDelta,
  enqueueThinkingDelta,
  flushPendingDeltasNow,
  installDeltaBatchFlush,
  type DeltaFlushPayload,
} from './streamingDeltaBatcher'

// The test env is `environment: 'node'` → no requestAnimationFrame. We
// deliberately do NOT polyfill rAF here; the batcher's microtask fallback
// is the code path tests should exercise, because it's also the one tests
// need to step through deterministically.

const collected: Array<{ convId: string; payload: DeltaFlushPayload }> = []

beforeEach(() => {
  __resetDeltaBatcherForTests()
  collected.length = 0
  installDeltaBatchFlush((convId, payload) => {
    collected.push({ convId, payload })
  })
})

afterEach(() => {
  __resetDeltaBatcherForTests()
})

describe('enqueue + coalesce', () => {
  it('coalesces N text deltas into one flush payload per conversation', () => {
    enqueueTextDelta('c1', 'a1', 'hel')
    enqueueTextDelta('c1', 'a1', 'lo ')
    enqueueTextDelta('c1', 'a1', 'world')
    expect(collected).toHaveLength(0)
    flushPendingDeltasNow()
    expect(collected).toHaveLength(1)
    expect(collected[0]).toEqual({
      convId: 'c1',
      payload: { assistantId: 'a1', text: 'hello world', thinking: '', reasoningSummary: '' },
    })
  })

  it('keeps text and thinking deltas in the same payload per convId', () => {
    enqueueThinkingDelta('c1', 'a1', 'let me think... ')
    enqueueTextDelta('c1', 'a1', 'final answer')
    flushPendingDeltasNow()
    expect(collected).toHaveLength(1)
    expect(collected[0].payload).toEqual({
      assistantId: 'a1',
      text: 'final answer',
      thinking: 'let me think... ',
      reasoningSummary: '',
    })
  })

  it('keeps per-conversation payloads isolated', () => {
    enqueueTextDelta('c1', 'a1', 'one')
    enqueueTextDelta('c2', 'a2', 'two')
    enqueueTextDelta('c1', 'a1', ' more')
    flushPendingDeltasNow()
    expect(collected).toHaveLength(2)
    const byConv = new Map(collected.map((c) => [c.convId, c.payload]))
    expect(byConv.get('c1')).toEqual({ assistantId: 'a1', text: 'one more', thinking: '', reasoningSummary: '' })
    expect(byConv.get('c2')).toEqual({ assistantId: 'a2', text: 'two', thinking: '', reasoningSummary: '' })
  })

  it('flushes the previous payload if the assistantId changes mid-conversation', () => {
    enqueueTextDelta('c1', 'a1', 'hello')
    enqueueTextDelta('c1', 'a2', 'new turn')
    // a1's payload should have been flushed synchronously when a2 arrived.
    expect(collected).toHaveLength(1)
    expect(collected[0]).toEqual({
      convId: 'c1',
      payload: { assistantId: 'a1', text: 'hello', thinking: '', reasoningSummary: '' },
    })
    flushPendingDeltasNow()
    expect(collected).toHaveLength(2)
    expect(collected[1]).toEqual({
      convId: 'c1',
      payload: { assistantId: 'a2', text: 'new turn', thinking: '', reasoningSummary: '' },
    })
  })

  it('is a no-op for empty deltas', () => {
    enqueueTextDelta('c1', 'a1', '')
    enqueueThinkingDelta('c1', 'a1', '')
    enqueueReasoningSummaryDelta('c1', 'a1', '')
    expect(__peekPendingForTests().size).toBe(0)
    flushPendingDeltasNow()
    expect(collected).toHaveLength(0)
  })

  it('coalesces reasoning_summary deltas alongside text + thinking on the same convId (B / OpenAI Responses)', () => {
    // Per-token interleaved deltas across all three soft-merge peers
    // (text + thinking + reasoning_summary). The batcher should produce
    // ONE flush payload per frame carrying the concatenated text of
    // each channel — the renderer's `applyBatchedDeltasToSlice` then
    // lands each on the matching ChatBlock kind in one setState pass.
    enqueueReasoningSummaryDelta('c1', 'a1', 'I considered ')
    enqueueThinkingDelta('c1', 'a1', 'step 1, ')
    enqueueReasoningSummaryDelta('c1', 'a1', 'two approaches.')
    enqueueTextDelta('c1', 'a1', 'Done.')
    enqueueThinkingDelta('c1', 'a1', 'step 2.')
    flushPendingDeltasNow()
    expect(collected).toHaveLength(1)
    expect(collected[0].payload).toEqual({
      assistantId: 'a1',
      text: 'Done.',
      thinking: 'step 1, step 2.',
      reasoningSummary: 'I considered two approaches.',
    })
  })

  it('does not flush empty-but-present payloads', () => {
    enqueueTextDelta('c1', 'a1', 'hi')
    // Drain — pending should go back to empty.
    flushPendingDeltasNow()
    expect(collected).toHaveLength(1)
    // Flushing again is a no-op.
    flushPendingDeltasNow()
    expect(collected).toHaveLength(1)
  })
})

describe('scheduleFlush via microtask (node fallback)', () => {
  it('auto-flushes on the next microtask tick when no caller drains it', async () => {
    enqueueTextDelta('c1', 'a1', 'auto')
    expect(collected).toHaveLength(0)
    // Yield a microtask — the batcher's queueMicrotask callback runs before
    // the next macrotask.
    await Promise.resolve()
    expect(collected).toHaveLength(1)
    expect(collected[0].payload).toEqual({
      assistantId: 'a1',
      text: 'auto',
      thinking: '',
      reasoningSummary: '',
    })
  })

  it('cancelling the scheduled flush (explicit flush) prevents double fire', async () => {
    enqueueTextDelta('c1', 'a1', 'x')
    flushPendingDeltasNow()
    await Promise.resolve()
    // The queued microtask still fires but sees an empty map, so no extra flush.
    expect(collected).toHaveLength(1)
  })
})

describe('installDeltaBatchFlush replacement', () => {
  it('the most recent install wins', () => {
    const alt = vi.fn()
    installDeltaBatchFlush(alt)
    enqueueTextDelta('c1', 'a1', 'replaced')
    flushPendingDeltasNow()
    expect(collected).toHaveLength(0)
    expect(alt).toHaveBeenCalledTimes(1)
  })
})
