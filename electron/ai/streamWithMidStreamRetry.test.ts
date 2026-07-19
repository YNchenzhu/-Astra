import { describe, it, expect } from 'vitest'

import { streamWithMidStreamRetry } from './streamWithMidStreamRetry'
import { isAbortLikeError } from './abortLikeError'

describe('streamWithMidStreamRetry — cancel during backoff (P1-3)', () => {
  it('surfaces an AbortError, not the network error, when cancelled mid-backoff', async () => {
    const controller = new AbortController()
    const netErr = Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' })
    let calls = 0

    const p = streamWithMidStreamRetry({
      signal: controller.signal,
      label: 'test',
      baseDelayMs: 10_000, // long, but irrelevant once the signal is aborted
      isRetryable: () => true,
      runOnce: async () => {
        calls++
        // User clicks Stop while the transient network error is in flight.
        controller.abort()
        throw netErr
      },
    })

    await expect(p).rejects.toSatisfy((e: unknown) => isAbortLikeError(e))
    await expect(p).rejects.not.toMatchObject({ code: 'ECONNRESET' })
    expect(calls).toBe(1) // no retry after the user cancelled
  })

  it('still retries a pre-emission retryable error then succeeds when not cancelled', async () => {
    let calls = 0
    await streamWithMidStreamRetry({
      signal: new AbortController().signal,
      label: 'test',
      baseDelayMs: 1,
      maxDelayMs: 5,
      isRetryable: () => true,
      runOnce: async () => {
        calls++
        if (calls < 2) throw new Error('ECONNRESET')
        // success on the 2nd attempt
      },
    })
    expect(calls).toBe(2)
  })

  it('does not retry once output has been emitted', async () => {
    let calls = 0
    const boom = new Error('mid-stream drop')
    const p = streamWithMidStreamRetry({
      signal: new AbortController().signal,
      label: 'test',
      baseDelayMs: 1,
      isRetryable: () => true,
      runOnce: async (tracker) => {
        calls++
        tracker.markEmitted()
        throw boom
      },
    })
    await expect(p).rejects.toBe(boom)
    expect(calls).toBe(1)
  })
})
