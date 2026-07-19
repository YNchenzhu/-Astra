import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { streamCompatibleFormat } from './compatibleClient'
import type { ProviderConfig, StreamCallbacks, StreamTextParams } from './client'

/**
 * Regression: parallel multi-sub-agent batches saw spurious "stream idle 180s"
 * timeouts when the upstream gateway queued requests behind its concurrency
 * cap. The watchdog conflated "queued at gateway" (no headers yet) with
 * "stream stalled mid-output", aborting the fetch BEFORE the server even
 * started replying.
 *
 * The fix carved out a separate first-activity (TTFB) ceiling. These tests
 * lock in two contracts:
 *   1. A fetch that never starts replying is aborted at `firstActivityWaitMs`,
 *      not at the longer `idleAbortMs`.
 *   2. The TTFB-timeout error is routed to `onError` (NOT silently swallowed
 *      as a clean `onMessageEnd`) so the sub-agent surfaces the failure and
 *      the agentic loop can retry / fall back instead of treating an empty
 *      response as a successful turn.
 */

function mkConfig(): ProviderConfig {
  return {
    id: 'openai2',
    name: 'OpenAI2',
    apiKey: 'sk-test',
    baseUrl: 'https://mock.example/v1',
  }
}

function mkParams(): StreamTextParams {
  return {
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'hello' }],
  }
}

function makeCollector(): {
  calls: StreamCallbacks
  errors: string[]
  ends: number
  text: string[]
} {
  const text: string[] = []
  const errors: string[] = []
  let ends = 0
  return {
    calls: {
      onTextDelta: (t) => text.push(t),
      onMessageEnd: () => {
        ends += 1
      },
      onError: (e) => errors.push(e),
    },
    errors,
    text,
    get ends() {
      return ends
    },
  } as ReturnType<typeof makeCollector>
}

describe('streamCompatibleFormat — first-activity (TTFB) timeout routing', () => {
  const origFetch = globalThis.fetch
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })
  afterEach(() => {
    globalThis.fetch = origFetch
    vi.unstubAllEnvs()
  })

  it('TTFB timeout surfaces as an error (NOT a silent success) and the request is retried before giving up', async () => {
    // Tight TTFB window so the test runs fast; idle threshold pushed out so
    // it can't be the cause of the abort under test.
    vi.stubEnv('POLE_ENABLE_STREAM_WATCHDOG', '1')
    vi.stubEnv('POLE_STREAM_WATCHDOG_TTFB_MS', '50')
    vi.stubEnv('POLE_STREAM_WATCHDOG_ABORT_MS', '999999')

    // Mock fetch: hang forever, but respect the abort signal so the
    // watchdog's TTFB timer can take effect.
    let fetchCalls = 0
    globalThis.fetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      fetchCalls += 1
      const sig = init.signal
      return new Promise<Response>((_resolve, reject) => {
        if (!sig) return // never resolves
        if (sig.aborted) {
          reject(
            Object.assign(new Error('Aborted'), {
              name: 'AbortError',
              cause: sig.reason,
            }),
          )
          return
        }
        sig.addEventListener(
          'abort',
          () => {
            reject(
              Object.assign(new Error('Aborted'), {
                name: 'AbortError',
                cause: sig.reason,
              }),
            )
          },
          { once: true },
        )
      })
    })

    const coll = makeCollector()
    await streamCompatibleFormat(
      mkConfig(),
      mkParams(),
      coll.calls,
      new AbortController().signal,
    )

    // Contract 1: TTFB timeout is NOT swallowed as a clean end. The
    // sub-agent / parent loop must see an explicit error so it can
    // retry / fall back instead of accepting an empty success.
    expect(coll.errors.length).toBeGreaterThan(0)
    const errMsg = coll.errors.join(' | ')
    expect(errMsg).toMatch(/first-activity|first.byte/i)

    // Contract 2: streamCompatibleFormat retried before giving up.
    // The compat client's outer retry loop has maxAttempts=3; with a
    // hung-forever fetch we expect at least 2 attempts before exhaustion.
    expect(fetchCalls).toBeGreaterThanOrEqual(2)
  }, 20_000)
})
