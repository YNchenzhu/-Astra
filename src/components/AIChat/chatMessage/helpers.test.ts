import { describe, expect, it } from 'vitest'
import {
  refPathBasename,
  formatMessageTimestamp,
  extractMessageCopyText,
  describeCompactLevel,
} from './helpers'
import type { ChatMessage } from '../../../types'

describe('refPathBasename', () => {
  it('extracts the basename from posix and windows paths', () => {
    expect(refPathBasename('src/components/Foo.tsx')).toBe('Foo.tsx')
    expect(refPathBasename('C:\\ws\\src\\Bar.ts')).toBe('Bar.ts')
  })

  it('returns the input when there is no separator', () => {
    expect(refPathBasename('file.ts')).toBe('file.ts')
  })

  it('falls back to the original path for a trailing-slash directory', () => {
    expect(refPathBasename('a/b/')).toBe('a/b/')
  })
})

describe('formatMessageTimestamp', () => {
  const now = new Date(2026, 2, 15, 12, 0, 0) // 2026-03-15 12:00 local

  it('returns empty string for an invalid timestamp', () => {
    expect(formatMessageTimestamp(NaN, now)).toBe('')
  })

  it('shows only HH:MM for same-day', () => {
    const ts = new Date(2026, 2, 15, 9, 5, 0).getTime()
    expect(formatMessageTimestamp(ts, now)).toBe('09:05')
  })

  it('prefixes 昨天 for the previous day, even across a month boundary', () => {
    const marchFirst = new Date(2026, 2, 1, 8, 0, 0)
    const febLast = new Date(2026, 1, 28, 23, 30, 0).getTime()
    expect(formatMessageTimestamp(febLast, marchFirst)).toBe('昨天 23:30')
  })

  it('shows MM/DD HH:MM for an earlier day in the same year', () => {
    const ts = new Date(2026, 0, 9, 7, 8, 0).getTime()
    expect(formatMessageTimestamp(ts, now)).toBe('01/09 07:08')
  })

  it('shows YYYY/MM/DD HH:MM for a different year', () => {
    const ts = new Date(2025, 11, 31, 23, 59, 0).getTime()
    expect(formatMessageTimestamp(ts, now)).toBe('2025/12/31 23:59')
  })
})

describe('extractMessageCopyText', () => {
  it('returns raw content for user messages', () => {
    expect(extractMessageCopyText({ role: 'user', content: 'hi' } as ChatMessage)).toBe('hi')
  })

  it('concatenates assistant text blocks, skipping thinking/tool_use', () => {
    const msg = {
      role: 'assistant',
      content: 'fallback',
      blocks: [
        { type: 'thinking', text: 'secret' },
        { type: 'text', text: 'para one' },
        { type: 'tool_use', id: 't', name: 'X', input: {} },
        { type: 'text', text: 'para two' },
      ],
    } as unknown as ChatMessage
    expect(extractMessageCopyText(msg)).toBe('para one\n\npara two')
  })

  it('falls back to content when assistant has no text blocks', () => {
    const msg = {
      role: 'assistant',
      content: 'fallback text',
      blocks: [{ type: 'tool_use', id: 't', name: 'X', input: {} }],
    } as unknown as ChatMessage
    expect(extractMessageCopyText(msg)).toBe('fallback text')
  })

  it('returns empty string when nothing is available', () => {
    expect(extractMessageCopyText({ role: 'assistant' } as ChatMessage)).toBe('')
  })
})

describe('describeCompactLevel', () => {
  it('maps known levels to Chinese labels', () => {
    expect(describeCompactLevel('micro_compact')).toBe('微压缩')
    expect(describeCompactLevel('auto_compact')).toBe('自动压缩')
    expect(describeCompactLevel('block_micro')).toBe('阻塞压缩')
  })

  it('returns the raw token for unknown levels', () => {
    expect(describeCompactLevel('future_level_x')).toBe('future_level_x')
  })
})
