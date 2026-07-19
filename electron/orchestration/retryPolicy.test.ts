/**
 * RetryPolicy unit tests.
 *
 * Coverage:
 *   - `maxAttempts: 1` → no retries even on retryable errors.
 *   - Backoff schedule with deterministic `randomSource` matches the formula
 *     `min(initial * factor^(attempt-1), maxInterval)`.
 *   - Jitter == 0 → byte-identical timings (regression guard).
 *   - `retryOn === false` → bubbles immediately.
 *   - `isProgrammerError` covers TypeError / SyntaxError / RangeError.
 *   - AbortSignal cancels before sleeping.
 *   - `onAttempt` telemetry observer receives one event per failed attempt.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_RETRY_POLICY,
  RetryAborted,
  isProgrammerError,
  withRetry,
} from './retryPolicy'

describe('isProgrammerError', () => {
  it('flags TypeError / SyntaxError / RangeError as non-retryable', () => {
    expect(isProgrammerError(new TypeError('x'))).toBe(true)
    expect(isProgrammerError(new SyntaxError('x'))).toBe(true)
    expect(isProgrammerError(new RangeError('x'))).toBe(true)
  })
  it('does NOT flag generic Error or string', () => {
    expect(isProgrammerError(new Error('5xx'))).toBe(false)
    expect(isProgrammerError('fetch failed')).toBe(false)
  })
})

describe('withRetry', () => {
  it('maxAttempts=1 → fn runs once even on retryable errors', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('transient'))
    await expect(
      withRetry(fn, { ...DEFAULT_RETRY_POLICY, maxAttempts: 1 }),
    ).rejects.toThrow('transient')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('succeeds on first attempt: no sleep', async () => {
    const sleep = vi.fn()
    const fn = vi.fn().mockResolvedValue('ok')
    const out = await withRetry(fn, DEFAULT_RETRY_POLICY, { sleep })
    expect(out).toBe('ok')
    expect(sleep).not.toHaveBeenCalled()
  })

  it('succeeds on attempt 3 after two failures (deterministic backoff)', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined)
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('1'))
      .mockRejectedValueOnce(new Error('2'))
      .mockResolvedValue('done')
    const policy = {
      ...DEFAULT_RETRY_POLICY,
      maxAttempts: 3,
      initialIntervalMs: 100,
      backoffFactor: 2,
      maxIntervalMs: 10_000,
      jitter: 0,
    }
    const out = await withRetry(fn, policy, { sleep })
    expect(out).toBe('done')
    expect(fn).toHaveBeenCalledTimes(3)
    expect(sleep).toHaveBeenNthCalledWith(1, 100)
    expect(sleep).toHaveBeenNthCalledWith(2, 200)
  })

  it('caps wait at maxIntervalMs', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined)
    const fn = vi.fn().mockRejectedValue(new Error('keeps failing'))
    const policy = {
      ...DEFAULT_RETRY_POLICY,
      maxAttempts: 5,
      initialIntervalMs: 1000,
      backoffFactor: 10,
      maxIntervalMs: 5_000,
      jitter: 0,
    }
    await expect(withRetry(fn, policy, { sleep })).rejects.toThrow('keeps failing')
    // Attempts 1→2 wait 1000ms; 2→3 → min(10_000, 5_000) = 5_000; 3→4 → 5_000; 4→5 → 5_000.
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([1000, 5000, 5000, 5000])
  })

  it('jitter applied symmetrically around base when randomSource is fixed', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined)
    const fn = vi.fn().mockRejectedValue(new Error('e'))
    // randomSource returns 1 → top of jitter range → wait *= (1 + jitter).
    await expect(
      withRetry(
        fn,
        {
          ...DEFAULT_RETRY_POLICY,
          maxAttempts: 2,
          initialIntervalMs: 100,
          jitter: 0.25,
          backoffFactor: 1,
        },
        { sleep, randomSource: () => 1 },
      ),
    ).rejects.toThrow('e')
    expect(sleep.mock.calls[0][0]).toBe(Math.round(100 * 1.25))
  })

  it('retryOn=false bubbles the error immediately', async () => {
    const sleep = vi.fn()
    const fn = vi.fn().mockRejectedValue(new Error('not retryable'))
    const policy = {
      ...DEFAULT_RETRY_POLICY,
      maxAttempts: 5,
      retryOn: () => false,
    }
    await expect(withRetry(fn, policy, { sleep })).rejects.toThrow('not retryable')
    expect(fn).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('default policy skips programmer errors automatically', async () => {
    const fn = vi.fn().mockRejectedValue(new TypeError('null is not a function'))
    await expect(withRetry(fn, { ...DEFAULT_RETRY_POLICY, maxAttempts: 5 })).rejects.toThrow(
      TypeError,
    )
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('onAttempt fires once per failure with computed delay', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined)
    const onAttempt = vi.fn()
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('1'))
      .mockResolvedValue('ok')
    await withRetry(
      fn,
      {
        ...DEFAULT_RETRY_POLICY,
        maxAttempts: 3,
        initialIntervalMs: 50,
        jitter: 0,
      },
      { sleep, onAttempt },
    )
    expect(onAttempt).toHaveBeenCalledTimes(1)
    expect(onAttempt.mock.calls[0][0]).toMatchObject({
      attempt: 1,
      maxAttempts: 3,
      delayMs: 50,
    })
  })

  it('onAttempt throws → loop continues (telemetry isolation)', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined)
    const onAttempt = vi.fn(() => {
      throw new Error('telemetry pipe down')
    })
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('1'))
      .mockResolvedValue('ok')
    await expect(
      withRetry(
        fn,
        { ...DEFAULT_RETRY_POLICY, maxAttempts: 2, initialIntervalMs: 0, jitter: 0 },
        { sleep, onAttempt },
      ),
    ).resolves.toBe('ok')
  })

  it('AbortSignal fired before first attempt throws RetryAborted', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    const fn = vi.fn().mockResolvedValue('never')
    await expect(
      withRetry(fn, DEFAULT_RETRY_POLICY, { signal: ctrl.signal }),
    ).rejects.toBeInstanceOf(RetryAborted)
    expect(fn).not.toHaveBeenCalled()
  })

  it('AbortSignal fired between attempts throws RetryAborted', async () => {
    const ctrl = new AbortController()
    const sleep = vi.fn().mockImplementation(async () => {
      ctrl.abort()
    })
    const fn = vi.fn().mockRejectedValue(new Error('boom'))
    await expect(
      withRetry(
        fn,
        { ...DEFAULT_RETRY_POLICY, maxAttempts: 5, initialIntervalMs: 0, jitter: 0 },
        { sleep, signal: ctrl.signal },
      ),
    ).rejects.toBeInstanceOf(RetryAborted)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('jitter=0 produces deterministic timings (regression guard for tests)', async () => {
    // The "tests can rely on this" claim from the doc string: two parallel runs with the
    // same policy + jitter=0 hit the same sleep deltas without injecting randomSource.
    const a: number[] = []
    const b: number[] = []
    const runOne = async (out: number[]): Promise<void> => {
      const sleep = (ms: number): Promise<void> => {
        out.push(ms)
        return Promise.resolve()
      }
      const fn = vi.fn().mockRejectedValue(new Error('e'))
      await expect(
        withRetry(
          fn,
          {
            ...DEFAULT_RETRY_POLICY,
            maxAttempts: 4,
            initialIntervalMs: 10,
            backoffFactor: 2,
            jitter: 0,
            maxIntervalMs: 1000,
          },
          { sleep },
        ),
      ).rejects.toBeDefined()
    }
    await runOne(a)
    await runOne(b)
    expect(a).toEqual(b)
    expect(a).toEqual([10, 20, 40])
  })
})
