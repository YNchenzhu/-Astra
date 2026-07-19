import { afterEach, describe, expect, it, vi } from 'vitest'
import { isStreamWatchdogEnabled, mergeUserSignalWithStreamWatchdog } from './streamWatchdog'

describe('streamWatchdog', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  it('isStreamWatchdogEnabled is default-on; explicit `0` / `false` disables', () => {
    // A3 — default-on so production stalls abort cleanly.
    expect(isStreamWatchdogEnabled()).toBe(true)
    vi.stubEnv('POLE_STREAM_WATCHDOG', '0')
    expect(isStreamWatchdogEnabled()).toBe(false)
    vi.unstubAllEnvs()
    vi.stubEnv('POLE_ENABLE_STREAM_WATCHDOG', 'false')
    expect(isStreamWatchdogEnabled()).toBe(false)
    vi.unstubAllEnvs()
    vi.stubEnv('CLAUDE_ENABLE_STREAM_WATCHDOG', '1')
    expect(isStreamWatchdogEnabled()).toBe(true)
    vi.unstubAllEnvs()
    vi.stubEnv('POLE_ENABLE_STREAM_WATCHDOG', '1')
    expect(isStreamWatchdogEnabled()).toBe(true)
  })

  it('when explicitly disabled, returns user signal and no-op touch/dispose', () => {
    vi.stubEnv('POLE_STREAM_WATCHDOG', '0')
    const user = new AbortController()
    const w = mergeUserSignalWithStreamWatchdog(user.signal, 'label')
    expect(w.signal).toBe(user.signal)
    expect(() => {
      w.touch()
      w.dispose()
    }).not.toThrow()
  })

  it('when enabled, aborts merged signal after idle ≥ abort threshold (post first-activity)', () => {
    vi.stubEnv('POLE_ENABLE_STREAM_WATCHDOG', '1')
    vi.stubEnv('POLE_STREAM_WATCHDOG_WARN_MS', '20')
    vi.stubEnv('POLE_STREAM_WATCHDOG_ABORT_MS', '50')
    vi.stubEnv('POLE_STREAM_WATCHDOG_TICK_MS', '10')
    // Disable TTFB ceiling so this test focuses purely on the idle path —
    // the new TTFB phase would otherwise fire first (default 90s) and the
    // legacy idle threshold would never run. Production callers transition
    // through TTFB → idle via `touch()`; we simulate that explicitly below
    // so the idle-abort timeline is the one being exercised.
    vi.stubEnv('POLE_STREAM_WATCHDOG_TTFB_MS', '0')
    vi.useFakeTimers()

    const user = new AbortController()
    const w = mergeUserSignalWithStreamWatchdog(user.signal, 'test-idle-abort')
    expect(w.signal).not.toBe(user.signal)
    expect(w.signal.aborted).toBe(false)

    vi.advanceTimersByTime(45)
    expect(w.signal.aborted).toBe(false)
    vi.advanceTimersByTime(20)
    expect(w.signal.aborted).toBe(true)
    w.dispose()
  })

  it('when enabled, touch resets idle countdown', () => {
    vi.stubEnv('POLE_ENABLE_STREAM_WATCHDOG', '1')
    vi.stubEnv('POLE_STREAM_WATCHDOG_WARN_MS', '100')
    vi.stubEnv('POLE_STREAM_WATCHDOG_ABORT_MS', '200')
    vi.stubEnv('POLE_STREAM_WATCHDOG_TICK_MS', '50')
    // Disable TTFB so the test exercises the post-first-activity idle path
    // directly (legacy semantics).
    vi.stubEnv('POLE_STREAM_WATCHDOG_TTFB_MS', '0')
    vi.useFakeTimers()

    const user = new AbortController()
    const w = mergeUserSignalWithStreamWatchdog(user.signal, 'test-touch')
    vi.advanceTimersByTime(150)
    expect(w.signal.aborted).toBe(false)
    w.touch()
    vi.advanceTimersByTime(150)
    expect(w.signal.aborted).toBe(false)
    vi.advanceTimersByTime(100)
    expect(w.signal.aborted).toBe(true)
    w.dispose()
  })

  it('when enabled, user abort is forwarded to merged signal', () => {
    vi.stubEnv('POLE_ENABLE_STREAM_WATCHDOG', '1')
    vi.stubEnv('POLE_STREAM_WATCHDOG_ABORT_MS', '999999')
    // TTFB also disabled so user abort is the only thing that fires.
    vi.stubEnv('POLE_STREAM_WATCHDOG_TTFB_MS', '0')
    vi.useFakeTimers()

    const user = new AbortController()
    const w = mergeUserSignalWithStreamWatchdog(user.signal, 'test-user-abort')
    user.abort()
    expect(w.signal.aborted).toBe(true)
    w.dispose()
  })

  // ─── First-activity (TTFB) phase ───
  //
  // Regression: parallel multi-sub-agent runs would see 4-6 of 6 agents
  // fail with "stream idle 180s" before the gateway even returned headers,
  // because the watchdog conflated "queued-at-gateway" with
  // "stream-stalled-mid-output". A separate, shorter TTFB timer fixes the
  // diagnosis and frees the agentic-loop slot for retry / fallback.

  it('TTFB: aborts when first activity does not arrive within firstActivityWaitMs', () => {
    vi.stubEnv('POLE_ENABLE_STREAM_WATCHDOG', '1')
    vi.stubEnv('POLE_STREAM_WATCHDOG_TTFB_MS', '50')
    // Make idle path very long so it can't be the cause of an early abort.
    vi.stubEnv('POLE_STREAM_WATCHDOG_ABORT_MS', '999999')
    vi.useFakeTimers()

    const user = new AbortController()
    const w = mergeUserSignalWithStreamWatchdog(user.signal, 'test-ttfb')
    expect(w.signal.aborted).toBe(false)
    vi.advanceTimersByTime(40)
    expect(w.signal.aborted).toBe(false)
    vi.advanceTimersByTime(15)
    expect(w.signal.aborted).toBe(true)
    // Reason should attribute the failure to first-activity, not idle —
    // important so the user-facing error mentions gateway queueing.
    const reason = (w.signal as AbortSignal & { reason?: unknown }).reason
    expect(String((reason as Error)?.message ?? reason)).toMatch(
      /first-activity|first.byte/i,
    )
    w.dispose()
  })

  it('TTFB: a single touch() before TTFB threshold cancels the TTFB timer and switches to idle', () => {
    vi.stubEnv('POLE_ENABLE_STREAM_WATCHDOG', '1')
    vi.stubEnv('POLE_STREAM_WATCHDOG_TTFB_MS', '100')
    vi.stubEnv('POLE_STREAM_WATCHDOG_ABORT_MS', '50')
    vi.useFakeTimers()

    const user = new AbortController()
    const w = mergeUserSignalWithStreamWatchdog(user.signal, 'test-promote')
    // Server returns first byte at t=30 (well before TTFB ceiling 100ms).
    vi.advanceTimersByTime(30)
    w.touch()
    expect(w.signal.aborted).toBe(false)
    // Now the regular idle clock (50ms) should govern — no further touches
    // means abort at t=30+50=80ms.
    vi.advanceTimersByTime(45)
    expect(w.signal.aborted).toBe(false)
    vi.advanceTimersByTime(10)
    expect(w.signal.aborted).toBe(true)
    w.dispose()
  })

  it('TTFB: setting POLE_STREAM_WATCHDOG_TTFB_MS=0 disables the TTFB phase (legacy single-threshold)', () => {
    vi.stubEnv('POLE_ENABLE_STREAM_WATCHDOG', '1')
    vi.stubEnv('POLE_STREAM_WATCHDOG_TTFB_MS', '0')
    vi.stubEnv('POLE_STREAM_WATCHDOG_ABORT_MS', '50')
    vi.useFakeTimers()

    const user = new AbortController()
    const w = mergeUserSignalWithStreamWatchdog(user.signal, 'test-ttfb-off')
    // No touch ever — only the idle threshold (50ms) governs.
    vi.advanceTimersByTime(60)
    expect(w.signal.aborted).toBe(true)
    w.dispose()
  })
})
