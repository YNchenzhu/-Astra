/**
 * Unit tests for chat renderable weight estimation.
 *
 * ChatPanel uses this to decide whether to switch from flat rendering
 * to the virtualised list. Thresholds are pure constants — these tests
 * ensure they don't accidentally change.
 */

import { describe, expect, it } from 'vitest'
import {
  CHAT_VIRTUALIZE_CHAR_THRESHOLD,
  CHAT_VIRTUALIZE_MESSAGE_COUNT_THRESHOLD,
  estimateConversationRenderableChars,
} from '../../utils/chatRenderableWeight'
import type { ChatMessage } from '../../types'

function msg(content: string): ChatMessage {
  return {
    id: 'm1',
    role: 'assistant',
    content,
    timestamp: Date.now(),
    isStreaming: false,
  }
}

describe('estimateConversationRenderableChars', () => {
  it('returns 0 for empty array', () => {
    expect(estimateConversationRenderableChars([])).toBe(0)
  })

  it('sums content.length for each message', () => {
    const messages = [msg('hello'), msg('world')]
    expect(estimateConversationRenderableChars(messages)).toBe(10)
  })

  it('counts tool_use content as well', () => {
    const m: ChatMessage = {
      id: 'm1',
      role: 'assistant',
      content: 'abc',
      timestamp: Date.now(),
      isStreaming: false,
      toolUses: [
        { id: 't1', name: 'read', input: {}, status: 'completed', result: 'result content here' },
      ],
    }
    // content 'abc' (3) + result 'result content here' (20) = 23
    const chars = estimateConversationRenderableChars([m])
    expect(chars).toBeGreaterThanOrEqual(3)
  })
})

describe('virtualize thresholds', () => {
  it('CHAT_VIRTUALIZE_CHAR_THRESHOLD is a positive number', () => {
    expect(CHAT_VIRTUALIZE_CHAR_THRESHOLD).toBeGreaterThan(0)
  })

  it('CHAT_VIRTUALIZE_MESSAGE_COUNT_THRESHOLD is a positive number', () => {
    expect(CHAT_VIRTUALIZE_MESSAGE_COUNT_THRESHOLD).toBeGreaterThan(0)
  })

  it('thresholds are reasonable (not 0, not absurdly large)', () => {
    expect(CHAT_VIRTUALIZE_CHAR_THRESHOLD).toBeGreaterThan(1000)
    expect(CHAT_VIRTUALIZE_CHAR_THRESHOLD).toBeLessThan(1_000_000)
    expect(CHAT_VIRTUALIZE_MESSAGE_COUNT_THRESHOLD).toBeGreaterThan(10)
    expect(CHAT_VIRTUALIZE_MESSAGE_COUNT_THRESHOLD).toBeLessThan(1000)
  })
})
