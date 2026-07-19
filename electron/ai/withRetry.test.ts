import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import {
  computeApiRetryDelayMs,
  isNonCustomOpusModel,
  isRetryableStreamHttpError,
  parseRetryAfterMsFromError,
  withRetry,
} from './withRetry'

describe('parseRetryAfterMsFromError', () => {
  it('reads Retry-After from SDK-style response headers', () => {
    const err = {
      response: { headers: new Headers({ 'retry-after': '12' }) },
    }
    expect(parseRetryAfterMsFromError(err)).toBe(12_000)
  })
})

describe('computeApiRetryDelayMs', () => {
  it('respects Retry-After when larger than exponential backoff', () => {
    const d = computeApiRetryDelayMs(0, { retryAfterMs: 9000, unattended: false })
    expect(d).toBeGreaterThanOrEqual(9000)
    expect(d).toBeLessThanOrEqual(32_000)
  })
})

describe('isRetryableStreamHttpError', () => {
  it('treats 408/409/529 as retryable', () => {
    expect(isRetryableStreamHttpError({ status: 408 })).toBe(true)
    expect(isRetryableStreamHttpError({ status: 409 })).toBe(true)
    expect(isRetryableStreamHttpError({ status: 529 })).toBe(true)
  })

  it('does not retry 401/403 unless POLE_STREAM_RETRY_HTTP_401 is set', () => {
    const prev = process.env.POLE_STREAM_RETRY_HTTP_401
    delete process.env.POLE_STREAM_RETRY_HTTP_401
    expect(isRetryableStreamHttpError({ status: 401 })).toBe(false)
    expect(isRetryableStreamHttpError({ status: 403 })).toBe(false)
    process.env.POLE_STREAM_RETRY_HTTP_401 = '1'
    expect(isRetryableStreamHttpError({ status: 401 })).toBe(true)
    expect(isRetryableStreamHttpError({ status: 403 })).toBe(true)
    if (prev === undefined) delete process.env.POLE_STREAM_RETRY_HTTP_401
    else process.env.POLE_STREAM_RETRY_HTTP_401 = prev
  })

  // Layer-A2 — expanded transient-network classification.
  describe('expanded transient-network coverage (A2)', () => {
    it('treats common Node errno codes from `cause` as retryable', () => {
      const codes = [
        'ECONNRESET',
        'ECONNABORTED',
        'ECONNREFUSED',
        'ETIMEDOUT',
        'EPIPE',
        'EAI_AGAIN',
        'ENETUNREACH',
        'ENETDOWN',
        'EHOSTUNREACH',
        'ENOTFOUND',
      ]
      for (const code of codes) {
        const err = new Error('boom')
        ;(err as unknown as { cause: { code: string } }).cause = { code }
        expect(isRetryableStreamHttpError(err)).toBe(true)
      }
    })

    it('matches transient-network message patterns even when no errno is exposed', () => {
      const messages = [
        'fetch failed',
        'socket hang up',
        'socket closed',
        'premature close',
        'upstream closed connection',
        'connection reset by peer',
        'request timed out',
        'read ECONNRESET',
      ]
      for (const m of messages) {
        expect(isRetryableStreamHttpError(new Error(m))).toBe(true)
      }
    })

    it('still returns false for genuinely fatal errors', () => {
      expect(isRetryableStreamHttpError(new Error('Invalid model id'))).toBe(false)
      expect(isRetryableStreamHttpError({ status: 400 })).toBe(false)
    })
  })
})

describe('isNonCustomOpusModel', () => {
  it('detects opus ids', () => {
    expect(isNonCustomOpusModel('claude-opus-4-20250514')).toBe(true)
    expect(isNonCustomOpusModel('claude-sonnet-4-20250514')).toBe(false)
  })
})

describe('withRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('retries until success', async () => {
    let n = 0
    const p = withRetry(
      async () => {
        n++
        if (n < 2) throw Object.assign(new Error('429'), { status: 429 })
        return 'ok'
      },
      { maxRetries: 3, unattended: false },
    )
    await vi.runAllTimersAsync()
    await expect(p).resolves.toBe('ok')
    expect(n).toBe(2)
  })
})
