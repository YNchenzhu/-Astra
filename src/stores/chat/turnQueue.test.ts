import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  mainChatTurnQueue,
  enqueueMainChatTurn,
  clearMainChatTurnQueue,
  flushMainChatTurnQueueForConversation,
} from './turnQueue'
import { pendingAssistantByConversation } from './sessionSlice'
import type { ChatState, QueuedMainChatTurn } from './types'

function turn(inputText: string): QueuedMainChatTurn {
  return { inputText, referencedFiles: [], pendingAttachments: [] }
}

function fakeState(over: Partial<ChatState> = {}): ChatState {
  return {
    currentConversationId: 'c1',
    isTyping: false,
    ...over,
  } as unknown as ChatState
}

afterEach(() => {
  mainChatTurnQueue.clear()
  pendingAssistantByConversation.clear()
  vi.restoreAllMocks()
})

describe('enqueue / clear', () => {
  it('appends and reports queue length', () => {
    expect(enqueueMainChatTurn('c1', turn('a'))).toBe(1)
    expect(enqueueMainChatTurn('c1', turn('b'))).toBe(2)
    expect(mainChatTurnQueue.get('c1')).toHaveLength(2)
  })

  it('clear removes the queue', () => {
    enqueueMainChatTurn('c1', turn('a'))
    clearMainChatTurnQueue('c1')
    expect(mainChatTurnQueue.has('c1')).toBe(false)
  })
})

describe('flushMainChatTurnQueueForConversation', () => {
  it('is a no-op when the queue is empty', () => {
    const setState = vi.fn()
    const send = vi.fn().mockResolvedValue(undefined)
    flushMainChatTurnQueueForConversation(() => fakeState(), setState, send, 'c1')
    expect(setState).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('releases the next turn into the input slot and sends', () => {
    enqueueMainChatTurn('c1', turn('hello'))
    const setState = vi.fn()
    const send = vi.fn().mockResolvedValue(undefined)
    flushMainChatTurnQueueForConversation(() => fakeState(), setState, send, 'c1')
    expect(setState).toHaveBeenCalledWith(
      expect.objectContaining({ inputText: 'hello', referencedFiles: [], pendingAttachments: [] }),
    )
    expect(send).toHaveBeenCalledOnce()
    // queue emptied
    expect(mainChatTurnQueue.has('c1')).toBe(false)
  })

  it('keeps remaining turns in the queue (FIFO)', () => {
    enqueueMainChatTurn('c1', turn('first'))
    enqueueMainChatTurn('c1', turn('second'))
    const setState = vi.fn()
    const send = vi.fn().mockResolvedValue(undefined)
    flushMainChatTurnQueueForConversation(() => fakeState(), setState, send, 'c1')
    expect(setState).toHaveBeenCalledWith(expect.objectContaining({ inputText: 'first' }))
    expect(mainChatTurnQueue.get('c1')).toHaveLength(1)
    expect(mainChatTurnQueue.get('c1')![0].inputText).toBe('second')
  })

  it('does not flush while a main turn is in flight (pendingAssistant guard)', () => {
    enqueueMainChatTurn('c1', turn('x'))
    pendingAssistantByConversation.set('c1', 'assistant-row')
    const setState = vi.fn()
    const send = vi.fn()
    flushMainChatTurnQueueForConversation(() => fakeState(), setState, send, 'c1')
    expect(send).not.toHaveBeenCalled()
    expect(mainChatTurnQueue.get('c1')).toHaveLength(1)
  })

  it('does not flush into a non-visible conversation', () => {
    enqueueMainChatTurn('c2', turn('x'))
    const setState = vi.fn()
    const send = vi.fn()
    flushMainChatTurnQueueForConversation(() => fakeState({ currentConversationId: 'c1' }), setState, send, 'c2')
    expect(send).not.toHaveBeenCalled()
    expect(mainChatTurnQueue.get('c2')).toHaveLength(1)
  })

  it('does not flush while the renderer is typing', () => {
    enqueueMainChatTurn('c1', turn('x'))
    const setState = vi.fn()
    const send = vi.fn()
    flushMainChatTurnQueueForConversation(() => fakeState({ isTyping: true }), setState, send, 'c1')
    expect(send).not.toHaveBeenCalled()
  })

  it('passes fresh copies of referencedFiles / pendingAttachments (not the queued arrays)', () => {
    const original = turn('x')
    original.referencedFiles = ['a.ts']
    enqueueMainChatTurn('c1', original)
    let captured: Partial<ChatState> = {}
    const setState = vi.fn((p: Partial<ChatState>) => { captured = p })
    flushMainChatTurnQueueForConversation(() => fakeState(), setState, vi.fn(), 'c1')
    expect(captured.referencedFiles).toEqual(['a.ts'])
    expect(captured.referencedFiles).not.toBe(original.referencedFiles)
  })
})
