/**
 * P0-3 — Tests for the drain-only context-recovery layer.
 *
 * The layer should:
 *   1. No-op when contextLengthExceeded is false.
 *   2. No-op when the abort signal is already aborted.
 *   3. No-op when conversationKey is empty.
 *   4. No-op when the collapse store has no queued summaries.
 *   5. Drain summaries, retry the stream, return `recovered` on a clean
 *      retry result.
 *   6. Drain summaries, retry the stream, return `fall_through` when the
 *      retry STILL has contextLengthExceeded set (so the caller proceeds
 *      to full reactive compact).
 *   7. Return `aborted` when the abort signal fires during the retry.
 *   8. NEVER consume summaries when it falls through without retrying
 *      (peek-before-consume invariant).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tryDrainOnlyContextRecovery } from './recoverFromContext'
import {
  appendContextCollapseSummary,
  clearContextCollapseStoreForTests,
  hasContextCollapseSummaries,
} from '../../../context/contextCollapseStore'

interface FakeResult {
  contextLengthExceeded: boolean
  accumulatedText: string
  toolUseBlocks: Array<unknown>
  thinkingBlocks: Array<unknown>
  lastStreamEndMs: number
}

function makeState(overrides: {
  signal?: AbortSignal
  collapseConversationKey?: string
  apiMessages?: Array<Record<string, unknown>>
}) {
  return {
    iteration: 1,
    signal: overrides.signal ?? new AbortController().signal,
    collapseConversationKey: overrides.collapseConversationKey ?? 'ws::conv-x',
    apiMessages: overrides.apiMessages ?? [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' },
    ],
    transition: 'init',
    profiler: {
      startCheckpoint: vi.fn(() => () => undefined),
    },
    loopContextManager: {
      clearUsageSnapshot: vi.fn(),
    },
    callbacks: {
      onContextCompact: vi.fn(),
    },
    appendixReport: vi.fn(),
  } as unknown as import('../loopShared').LoopState
}

function makeResult(over: Partial<FakeResult> = {}): FakeResult {
  return {
    contextLengthExceeded: true,
    accumulatedText: '',
    toolUseBlocks: [],
    thinkingBlocks: [],
    lastStreamEndMs: 0,
    ...over,
  }
}

describe('tryDrainOnlyContextRecovery', () => {
  beforeEach(() => {
    clearContextCollapseStoreForTests()
  })
  afterEach(() => {
    clearContextCollapseStoreForTests()
  })

  it('no-ops when contextLengthExceeded is false', async () => {
    const state = makeState({})
    const result = makeResult({ contextLengthExceeded: false })
    const retry = vi.fn()
    const out = await tryDrainOnlyContextRecovery(state, result, retry as never)
    expect(out.kind).toBe('fall_through')
    expect(retry).not.toHaveBeenCalled()
  })

  it('returns aborted when signal already fired', async () => {
    const ac = new AbortController()
    ac.abort()
    const state = makeState({ signal: ac.signal })
    const result = makeResult()
    const retry = vi.fn()
    const out = await tryDrainOnlyContextRecovery(state, result, retry as never)
    expect(out.kind).toBe('aborted')
    expect(retry).not.toHaveBeenCalled()
  })

  it('no-ops when collapseConversationKey is empty', async () => {
    const state = makeState({ collapseConversationKey: '' })
    const result = makeResult()
    const retry = vi.fn()
    const out = await tryDrainOnlyContextRecovery(state, result, retry as never)
    expect(out.kind).toBe('fall_through')
    expect(retry).not.toHaveBeenCalled()
  })

  it('no-ops when collapse store has no entries (peek-before-consume invariant)', async () => {
    const state = makeState({ collapseConversationKey: 'ws::empty' })
    const result = makeResult()
    const retry = vi.fn()
    const out = await tryDrainOnlyContextRecovery(state, result, retry as never)
    expect(out.kind).toBe('fall_through')
    expect(retry).not.toHaveBeenCalled()
    // Sanity: nothing was added or consumed.
    expect(hasContextCollapseSummaries('ws::empty')).toBe(false)
  })

  it('drains summaries, retries, returns recovered on a clean retry', async () => {
    appendContextCollapseSummary('ws::live', 'Segment 1 summary')
    appendContextCollapseSummary('ws::live', 'Segment 2 summary')
    expect(hasContextCollapseSummaries('ws::live')).toBe(true)

    const state = makeState({ collapseConversationKey: 'ws::live' })
    const result = makeResult({ accumulatedText: 'partial that should clear' })
    const retried: FakeResult = makeResult({ contextLengthExceeded: false })
    const retry = vi.fn().mockResolvedValue(retried)

    const out = await tryDrainOnlyContextRecovery(state, result, retry as never)

    expect(out.kind).toBe('recovered')
    expect(out.result.contextLengthExceeded).toBe(false)
    expect(retry).toHaveBeenCalledTimes(1)
    // Drain consumed the summaries — second call would be a no-op.
    expect(hasContextCollapseSummaries('ws::live')).toBe(false)
    // apiMessages prepended with the recap user turn.
    expect((state as unknown as { apiMessages: Array<Record<string, unknown>> }).apiMessages[0])
      .toMatchObject({ role: 'user' })
    // Pre-drain partial cleared on result (the input ref is mutated).
    expect(result.accumulatedText).toBe('')
  })

  it('returns fall_through when retry still has contextLengthExceeded', async () => {
    appendContextCollapseSummary('ws::stillFails', 'Segment X')
    const state = makeState({ collapseConversationKey: 'ws::stillFails' })
    const result = makeResult()
    const retried = makeResult({ contextLengthExceeded: true })
    const retry = vi.fn().mockResolvedValue(retried)

    const out = await tryDrainOnlyContextRecovery(state, result, retry as never)

    expect(out.kind).toBe('fall_through')
    expect(out.result.contextLengthExceeded).toBe(true)
    expect(retry).toHaveBeenCalledTimes(1)
  })

  it('returns aborted when signal fires during retry', async () => {
    appendContextCollapseSummary('ws::midAbort', 'Segment A')
    const ac = new AbortController()
    const state = makeState({
      collapseConversationKey: 'ws::midAbort',
      signal: ac.signal,
    })
    const result = makeResult()
    const retried = makeResult({ contextLengthExceeded: false })
    const retry = vi.fn().mockImplementation(async () => {
      ac.abort()
      return retried
    })
    const out = await tryDrainOnlyContextRecovery(state, result, retry as never)
    expect(out.kind).toBe('aborted')
  })
})
