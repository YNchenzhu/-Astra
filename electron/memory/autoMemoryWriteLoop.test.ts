import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the memory service before importing the module under test. The
// loop calls `createMemory` for side-effect writes; we want to assert
// what arguments it gets without touching disk.
const createMemoryMock = vi.fn()
vi.mock('./service', () => ({
  createMemory: (...args: unknown[]) => createMemoryMock(...args),
}))

import {
  __resetAutoMemoryWriteLoopForTests,
  captureAutoMemorySignal,
  detectAutoMemorySignal,
} from './autoMemoryWriteLoop'

describe('detectAutoMemorySignal', () => {
  it('flags a correction when the user pushes back on the assistant', () => {
    const sig = detectAutoMemorySignal({
      previousAssistantText: "I'll use Foo.",
      currentUserText: 'No, that is wrong — use Bar instead.',
    })
    expect(sig?.kind).toBe('correction')
    expect(sig?.excerpt).toContain('wrong')
  })

  it('flags a preference when the user uses imperative wording', () => {
    const sig = detectAutoMemorySignal({
      currentUserText: 'Remember that we always use npm run typecheck for verification.',
    })
    expect(sig?.kind).toBe('preference')
  })

  it('flags success on confirmation phrases', () => {
    const sig = detectAutoMemorySignal({
      currentUserText: 'Perfect, keep doing that.',
    })
    expect(sig?.kind).toBe('success')
  })

  it('returns null for unrelated chatter', () => {
    expect(
      detectAutoMemorySignal({ currentUserText: 'Can you also explain the cache layer?' }),
    ).toBeNull()
  })

  it('detects Chinese correction patterns at the head of the turn', () => {
    const sig = detectAutoMemorySignal({
      currentUserText: '不对,应该改成用 vitest 跑单测',
    })
    expect(sig?.kind).toBe('correction')
  })

  it('does not misclassify benign Chinese sentences containing 不是 / 不要 as corrections', () => {
    expect(
      detectAutoMemorySignal({ currentUserText: '我不是想问性能,我是想问安全性' }),
    ).toBeNull()
    expect(
      detectAutoMemorySignal({ currentUserText: '你不要紧的话我先继续写测试' }),
    ).toBeNull()
  })

  it('still detects mid-sentence Chinese corrections with imperative wrappers', () => {
    expect(
      detectAutoMemorySignal({ currentUserText: '哦稍等,这块应该改成用 vitest 而不是 jest' })?.kind,
    ).toBe('correction')
    expect(
      detectAutoMemorySignal({ currentUserText: '换成 ESM 写法吧' })?.kind,
    ).toBe('correction')
  })
})

describe('captureAutoMemorySignal', () => {
  beforeEach(() => {
    __resetAutoMemoryWriteLoopForTests()
    createMemoryMock.mockReset()
    delete process.env.POLE_AUTO_MEMORY_CAPTURE
  })

  it('returns null when no signal is detected', () => {
    const result = captureAutoMemorySignal({
      conversationId: 'c1',
      currentUserText: 'tell me about the cache layer',
    })
    expect(result).toBeNull()
    expect(createMemoryMock).not.toHaveBeenCalled()
  })

  it('returns a record with skipReason when capture flag is off', () => {
    const result = captureAutoMemorySignal({
      conversationId: 'c1',
      currentUserText: 'remember: always use npm test',
    })
    expect(result?.written).toBe(false)
    expect(result?.skipReason).toBe('capture-flag-disabled')
    expect(createMemoryMock).not.toHaveBeenCalled()
  })

  it('writes a memory through service.createMemory when capture is enabled', () => {
    createMemoryMock.mockReturnValue({ filename: 'auto-preference-2026-05-20-remember.md' })
    const result = captureAutoMemorySignal({
      conversationId: 'c1',
      currentUserText: 'remember: always run npm run typecheck before commits',
      forceEnabled: true,
      now: Date.parse('2026-05-20T00:00:00Z'),
    })
    expect(result?.written).toBe(true)
    expect(createMemoryMock).toHaveBeenCalledTimes(1)
    const call = createMemoryMock.mock.calls[0][0] as Record<string, unknown>
    expect(call.scope).toBe('user')
    expect(call.tags).toEqual(['auto-memory', 'auto:preference'])
    expect(String(call.content)).toContain('always run npm run typecheck')
  })

  it('dedupes identical signals within the same conversation', () => {
    createMemoryMock.mockReturnValue({ filename: 'first.md' })
    const text = 'remember: prefer ESM imports'
    const a = captureAutoMemorySignal({
      conversationId: 'c1',
      currentUserText: text,
      forceEnabled: true,
    })
    const b = captureAutoMemorySignal({
      conversationId: 'c1',
      currentUserText: text,
      forceEnabled: true,
    })
    expect(a?.written).toBe(true)
    expect(b?.written).toBe(false)
    expect(b?.skipReason).toBe('duplicate-signal-in-conversation')
    expect(createMemoryMock).toHaveBeenCalledTimes(1)
  })

  it('records skipReason when the service throws (e.g. user dir unset)', () => {
    createMemoryMock.mockImplementation(() => {
      throw new Error('User memory dir not initialised')
    })
    const result = captureAutoMemorySignal({
      conversationId: 'c1',
      currentUserText: '不对,这里应该用 monorepo 路径',
      forceEnabled: true,
    })
    expect(result?.written).toBe(false)
    expect(result?.skipReason).toContain('User memory dir not initialised')
  })

  it('evicts old conversation capture state once the bucket cap is reached', () => {
    // Seed 35 chats with a recorded preference; then a brand-new
    // observation on chat 0 should be treated as first-seen (the same
    // signal will not be marked as duplicate).
    for (let i = 0; i < 35; i++) {
      captureAutoMemorySignal({
        conversationId: `c${i}`,
        currentUserText: 'remember: prefer ESM imports',
        forceEnabled: false, // disabled write so we only exercise state
      })
    }
    // c0 should have been evicted by the 32-bucket cap; re-observing
    // the same signal must NOT be marked duplicate-in-conversation.
    const replay = captureAutoMemorySignal({
      conversationId: 'c0',
      currentUserText: 'remember: prefer ESM imports',
      forceEnabled: false,
    })
    expect(replay?.skipReason).toBe('capture-flag-disabled')
  })

  it('returns null for empty conversation id (no cross-conversation leak)', () => {
    expect(
      captureAutoMemorySignal({
        conversationId: '   ',
        currentUserText: 'remember: always use ESM',
        forceEnabled: true,
      }),
    ).toBeNull()
    expect(createMemoryMock).not.toHaveBeenCalled()
  })
})
