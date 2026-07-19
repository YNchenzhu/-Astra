import { describe, it, expect } from 'vitest'
import { isLikelyCompactPromptTooLongError } from './compactPtlRetry'

describe('compactPtlRetry', () => {
  it('detects prompt-too-long phrasing', () => {
    expect(isLikelyCompactPromptTooLongError(new Error('prompt is too long'))).toBe(true)
    expect(isLikelyCompactPromptTooLongError(new Error('prompt_too_long'))).toBe(true)
    expect(isLikelyCompactPromptTooLongError(new Error('random failure'))).toBe(false)
  })
})
