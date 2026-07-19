import { describe, expect, it } from 'vitest'
import {
  estimateTokens,
  estimateMessageTokens,
  estimateConversationTokens,
  wouldExceedTokenLimit,
} from './tokens'
import type { Message } from './messages'

function textMsg(text: string): Message {
  return { id: 'm', role: 'user', content: [{ type: 'text', text }], timestamp: 0 }
}

describe('estimateTokens', () => {
  it('uses ceil of chars/4', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('a')).toBe(1)
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('abcde')).toBe(2)
    expect(estimateTokens('a'.repeat(400))).toBe(100)
  })
})

describe('estimateMessageTokens', () => {
  it('sums text blocks', () => {
    const m = textMsg('a'.repeat(8))
    expect(estimateMessageTokens(m)).toBe(2)
  })

  it('counts tool_use input json + name', () => {
    const m: Message = {
      id: 'm',
      role: 'assistant',
      content: [{ type: 'tool_use', name: 'Read', input: { path: 'x' } }],
      timestamp: 0,
    }
    // JSON.stringify({path:'x'}) = {"path":"x"} (12 chars => 3 tokens) + name 'Read' (4 => 1)
    expect(estimateMessageTokens(m)).toBe(4)
  })

  it('counts tool_result content', () => {
    const m: Message = {
      id: 'm',
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't', content: 'a'.repeat(16) }],
      timestamp: 0,
    }
    expect(estimateMessageTokens(m)).toBe(4)
  })

  it('handles empty content array', () => {
    const m: Message = { id: 'm', role: 'user', content: [], timestamp: 0 }
    expect(estimateMessageTokens(m)).toBe(0)
  })

  it('handles tool_use with missing input', () => {
    const m: Message = {
      id: 'm',
      role: 'assistant',
      content: [{ type: 'tool_use', name: 'X' }],
      timestamp: 0,
    }
    // JSON.stringify({}) = '{}' => ceil(2/4)=1 ; name 'X' => 1
    expect(estimateMessageTokens(m)).toBe(2)
  })
})

describe('estimateConversationTokens', () => {
  it('sums across messages', () => {
    const msgs = [textMsg('a'.repeat(4)), textMsg('a'.repeat(4))]
    expect(estimateConversationTokens(msgs)).toBe(2)
  })

  it('returns 0 for empty conversation', () => {
    expect(estimateConversationTokens([])).toBe(0)
  })
})

describe('wouldExceedTokenLimit', () => {
  it('false when within limit', () => {
    expect(wouldExceedTokenLimit([textMsg('a'.repeat(4))], textMsg('a'.repeat(4)), 10)).toBe(false)
  })

  it('true when over limit', () => {
    expect(wouldExceedTokenLimit([textMsg('a'.repeat(40))], textMsg('a'.repeat(40)), 10)).toBe(true)
  })

  it('boundary: equal to limit is NOT exceeding (strict >)', () => {
    // 2 + 2 = 4 tokens, limit 4 => not exceeding
    expect(wouldExceedTokenLimit([textMsg('a'.repeat(8))], textMsg('a'.repeat(8)), 4)).toBe(false)
  })
})
