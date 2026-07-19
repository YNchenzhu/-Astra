import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getExtractionCursor,
  advanceExtractionCursor,
  countMessagesSinceCursor,
  stashPendingContext,
  consumePendingContext,
  recordMainAgentMemoryWrite,
  hasMemoryWritesSince,
  clearMainAgentMemoryWrite,
  recordMemoryApiWrite,
  hasRecentMemoryApiWrite,
  tryAcquireFileLock,
  releaseFileLock,
  isFileLocked,
  withFileLock,
  trackExtraction,
  drainPendingExtractions,
  incrementExtractionRound,
  shouldThrottleExtraction,
  resetExtractionStateForTests,
} from './extractionState'

describe('extractionState — cursor', () => {
  beforeEach(() => {
    resetExtractionStateForTests()
  })

  it('starts with null cursor and count 0', () => {
    const c = getExtractionCursor('conv-1')
    expect(c.lastMemoryMessageUuid).toBeNull()
    expect(c.extractionCount).toBe(0)
  })

  it('advances cursor to the given message UUID', () => {
    advanceExtractionCursor('conv-1', 'msg-003')
    const c = getExtractionCursor('conv-1')
    expect(c.lastMemoryMessageUuid).toBe('msg-003')
    expect(c.extractionCount).toBe(1)
  })

  it('advances the same cursor across multiple calls', () => {
    advanceExtractionCursor('conv-1', 'msg-001')
    advanceExtractionCursor('conv-1', 'msg-002')
    const c = getExtractionCursor('conv-1')
    expect(c.lastMemoryMessageUuid).toBe('msg-002')
    expect(c.extractionCount).toBe(2)
  })

  it('maintains independent cursors per conversation', () => {
    advanceExtractionCursor('conv-A', 'a-005')
    advanceExtractionCursor('conv-B', 'b-010')
    expect(getExtractionCursor('conv-A').lastMemoryMessageUuid).toBe('a-005')
    expect(getExtractionCursor('conv-B').lastMemoryMessageUuid).toBe('b-010')
  })

  it('countMessagesSinceCursor returns total when cursor is null', () => {
    const messages = [
      { id: 'm1' }, { id: 'm2' }, { id: 'm3' },
    ]
    expect(countMessagesSinceCursor(messages, null)).toBe(3)
  })

  it('countMessagesSinceCursor counts only messages after cursor', () => {
    const messages = [
      { id: 'm1' }, { id: 'm2' }, { id: 'm3' }, { id: 'm4' },
    ]
    expect(countMessagesSinceCursor(messages, 'm2')).toBe(2)
  })

  it('countMessagesSinceCursor returns 0 when cursor is the last message', () => {
    const messages = [
      { id: 'm1' }, { id: 'm2' },
    ]
    expect(countMessagesSinceCursor(messages, 'm2')).toBe(0)
  })

  it('countMessagesSinceCursor returns all when cursor not found', () => {
    const messages = [
      { id: 'm1' }, { id: 'm2' },
    ]
    expect(countMessagesSinceCursor(messages, 'nonexistent')).toBe(2)
  })
})

describe('extractionState — coalescing', () => {
  beforeEach(() => {
    resetExtractionStateForTests()
  })

  it('stashes and consumes pending context', () => {
    const ctx = {
      conversationId: 'conv-1',
      messages: [{ role: 'user', content: 'hello' }],
      timestamp: Date.now(),
    }
    stashPendingContext(ctx)
    const consumed = consumePendingContext('conv-1')
    expect(consumed).toEqual(ctx)
  })

  it('returns null when no pending context exists', () => {
    const consumed = consumePendingContext('conv-none')
    expect(consumed).toBeNull()
  })

  it('removes context after consumption', () => {
    stashPendingContext({
      conversationId: 'conv-1',
      messages: [],
      timestamp: 0,
    })
    consumePendingContext('conv-1')
    expect(consumePendingContext('conv-1')).toBeNull()
  })

  it('stashing a second context overwrites the first for the same conversation', () => {
    stashPendingContext({
      conversationId: 'conv-1',
      messages: [{ role: 'user', content: 'first' }],
      timestamp: 1,
    })
    stashPendingContext({
      conversationId: 'conv-1',
      messages: [{ role: 'user', content: 'second' }],
      timestamp: 2,
    })
    const consumed = consumePendingContext('conv-1')
    expect(consumed!.messages[0].content).toBe('second')
  })
})

describe('extractionState — mutual exclusion', () => {
  beforeEach(() => {
    resetExtractionStateForTests()
  })

  it('hasMemoryWritesSince returns false when no write recorded', () => {
    expect(hasMemoryWritesSince('conv-1', 0)).toBe(false)
  })

  it('hasMemoryWritesSince returns true after recording a write', () => {
    recordMainAgentMemoryWrite('conv-1')
    expect(hasMemoryWritesSince('conv-1', 0)).toBe(true)
  })

  it('hasMemoryWritesSince respects the time window', () => {
    recordMainAgentMemoryWrite('conv-1')
    // Write happened now, ask about writes since 1 hour in the future → false
    const futureCutoff = Date.now() + 3_600_000
    expect(hasMemoryWritesSince('conv-1', futureCutoff)).toBe(false)
  })

  it('clearMainAgentMemoryWrite removes the record', () => {
    recordMainAgentMemoryWrite('conv-1')
    clearMainAgentMemoryWrite('conv-1')
    expect(hasMemoryWritesSince('conv-1', 0)).toBe(false)
  })

  it('hasRecentMemoryApiWrite: false by default', () => {
    expect(hasRecentMemoryApiWrite(10_000)).toBe(false)
  })

  it('hasRecentMemoryApiWrite: true after recording', () => {
    recordMemoryApiWrite()
    expect(hasRecentMemoryApiWrite(10_000)).toBe(true)
  })

  it('records are isolated per conversation (F5 — cross-conv non-interference)', () => {
    recordMainAgentMemoryWrite('conv-A')
    // conv-B has not written anything — its mutex check must NOT see conv-A's flag.
    expect(hasMemoryWritesSince('conv-A', 0)).toBe(true)
    expect(hasMemoryWritesSince('conv-B', 0)).toBe(false)
    expect(hasMemoryWritesSince('conv-C', 0)).toBe(false)
    // Clearing conv-A doesn't disturb the others.
    clearMainAgentMemoryWrite('conv-A')
    expect(hasMemoryWritesSince('conv-A', 0)).toBe(false)
  })
})

describe('extractionState — file locks', () => {
  beforeEach(() => {
    resetExtractionStateForTests()
  })

  it('acquires and releases a lock', () => {
    expect(tryAcquireFileLock('/tmp/test.md', 'test')).toBe(true)
    expect(isFileLocked('/tmp/test.md')).toBe(true)
    releaseFileLock('/tmp/test.md')
    expect(isFileLocked('/tmp/test.md')).toBe(false)
  })

  it('cannot acquire a lock that is already held', () => {
    expect(tryAcquireFileLock('/tmp/test.md', 'owner-1')).toBe(true)
    expect(tryAcquireFileLock('/tmp/test.md', 'owner-2')).toBe(false)
  })

  it('different files get independent locks', () => {
    expect(tryAcquireFileLock('/tmp/a.md', 'test')).toBe(true)
    expect(tryAcquireFileLock('/tmp/b.md', 'test')).toBe(true)
    expect(isFileLocked('/tmp/a.md')).toBe(true)
    expect(isFileLocked('/tmp/b.md')).toBe(true)
  })

  it('withFileLock runs the function and releases the lock', async () => {
    const fn = vi.fn().mockResolvedValue('result')
    const result = await withFileLock('/tmp/test.md', 'test', fn)
    expect(result).toBe('result')
    expect(fn).toHaveBeenCalled()
    expect(isFileLocked('/tmp/test.md')).toBe(false)
  })

  it('withFileLock returns null when lock cannot be acquired', async () => {
    tryAcquireFileLock('/tmp/test.md', 'blocker')
    const fn = vi.fn()
    const result = await withFileLock('/tmp/test.md', 'test', fn)
    expect(result).toBeNull()
    expect(fn).not.toHaveBeenCalled()
  })
})

describe('extractionState — throttling', () => {
  beforeEach(() => {
    resetExtractionStateForTests()
  })

  it('does not throttle when interval is 1', () => {
    incrementExtractionRound('conv-1')
    expect(shouldThrottleExtraction('conv-1', 1)).toBe(false)
  })

  it('throttles every Nth round', () => {
    // `shouldThrottleExtraction` returns true when extraction should be SKIPPED.
    // With interval=2, it skips odd rounds and allows even rounds:
    // Round 1 → skip (1 % 2 === 1, !== 0)
    incrementExtractionRound('conv-1')
    expect(shouldThrottleExtraction('conv-1', 2)).toBe(true)
    // Round 2 → allow (2 % 2 === 0)
    incrementExtractionRound('conv-1')
    expect(shouldThrottleExtraction('conv-1', 2)).toBe(false)
    // Round 3 → skip (3 % 2 === 1)
    incrementExtractionRound('conv-1')
    expect(shouldThrottleExtraction('conv-1', 2)).toBe(true)
  })

  it('independent throttling per conversation', () => {
    incrementExtractionRound('conv-A')  // A round 1
    incrementExtractionRound('conv-B')  // B round 1
    incrementExtractionRound('conv-B')  // B round 2
    // A round 1: skip (1 % 2 !== 0)
    expect(shouldThrottleExtraction('conv-A', 2)).toBe(true)
    // B round 2: allow (2 % 2 === 0)
    expect(shouldThrottleExtraction('conv-B', 2)).toBe(false)
  })
})

describe('extractionState — drain', () => {
  beforeEach(() => {
    resetExtractionStateForTests()
  })

  it('drainPendingExtractions resolves immediately when nothing is in-flight', async () => {
    await expect(drainPendingExtractions(100)).resolves.toBeUndefined()
  })

  it('drainPendingExtractions waits for tracked promises', async () => {
    let resolvePromise!: () => void
    const p = new Promise<void>((resolve) => {
      resolvePromise = resolve
    })
    trackExtraction(p)

    setTimeout(() => resolvePromise(), 50)
    await expect(drainPendingExtractions(500)).resolves.toBeUndefined()
  })
})
