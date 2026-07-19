import { describe, it, expect } from 'vitest'
import { isAbortLikeError } from './abortLikeError'

describe('isAbortLikeError', () => {
  it('returns true for DOMException-style AbortError', () => {
    const e = new DOMException('aborted', 'AbortError')
    expect(isAbortLikeError(e)).toBe(true)
  })

  it('returns true for Error AbortError', () => {
    const e = new Error('aborted')
    e.name = 'AbortError'
    expect(isAbortLikeError(e)).toBe(true)
  })

  it('returns false for other errors', () => {
    expect(isAbortLikeError(new Error('x'))).toBe(false)
    expect(isAbortLikeError(null)).toBe(false)
  })
})
