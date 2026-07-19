import { describe, it, expect } from 'vitest'
import { userMessageContentToPlainText } from './userMessageText'

describe('userMessageContentToPlainText', () => {
  it('returns string content as-is', () => {
    expect(userMessageContentToPlainText('hello')).toBe('hello')
  })

  it('joins text blocks from Anthropic-style array', () => {
    expect(
      userMessageContentToPlainText([
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b' },
      ]),
    ).toBe('a\nb')
  })

  it('returns empty for non-string non-array', () => {
    expect(userMessageContentToPlainText(null)).toBe('')
    expect(userMessageContentToPlainText({ foo: 1 })).toBe('')
  })
})
