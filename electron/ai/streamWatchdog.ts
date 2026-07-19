/**
 * upstream §11.3 — Stream watchdog: idle timeout, idle warning, and stall detection.
 *
 * Protects against hung API streams that stop producing content_block_delta events.
 * - Idle warning at 60 seconds of no data
 * - Hard abort at 600 seconds (10 min) of no data (default-on; opt-out via env)
 * - Stall detection: 30-second interval checks, records stall_count and total_stall_time
 *
 * A3 — switched to default-on. Production logs from Chinese gateways
 * (DeepSeek / packycode / ...) showed multi-minute stalls that the
 * agentic loop could not interrupt. Default-on means stalled streams
 * abort cleanly, the existing fetch-retry path can re-issue the
 * request, and the user no longer waits indefinitely for a dead
 * connection. The threshold (600s / 10 min) tolerates long thinking-
 * model silences — DeepSeek-v4-pro / GLM-thinking gateways can stop
 * sending bytes for several minutes mid-reasoning before the next
 * delta lands. Set `POLE_STREAM_WATCHDOG=0` to disable explicitly, or
 * `POLE_STREAM_WATCHDOG_ABORT_MS` to retune.
 */

const DEFAULT_IDLE_WARNING_MS = 60_000
const DEFAULT_IDLE_ABORT_MS = 600_000
const DEFAULT_STALL_CHECK_INTERVAL_MS = 30_000
/**
 * Default time-to-first-activity ceiling — how long the watchdog tolerates
 * silence BEFORE the first `notifyActivity()` call.
 *
 * Why this exists separately from `idleAbortMs`:
 *
 * The idle abort threshold (180s) was tuned for the reasonable case "server
 * is streaming, but the next chunk hasn't arrived". Reusing it for the
 * pre-first-byte phase silently eats the request setup time too — if the
 * upstream gateway queues the request (third-party Anthropic/OpenAI
 * proxies routinely do this when the same API key is parallelized with
 * 4-6 concurrent streams), the watchdog aborts the fetch BEFORE the
 * server has had a chance to return headers, attributing "queue wait" to
 * "stream stalled mid-output".
 *
 * Production symptom: parallel multi-sub-agent batches saw 4-6 of 6 sub-
 * agents fail with `Stream watchdog idle timeout: 180000ms` even though
 * the agents had not received a single byte; the failures cascaded
 * through `Promise.all` and the user perceived the whole batch as
 * "stuck".
 *
 * 90s is a deliberately conservative TTFB ceiling — generous enough to
 * tolerate a slow third-party proxy + a thinking-mode prefill on a heavy
 * model, but tight enough that a queued request fails fast and frees the
 * agentic-loop slot for retry / fallback.
 *
 * Override per request via `firstActivityWaitMs` in
 * {@link StreamWatchdogConfig}, or globally via the env var
 * `POLE_STREAM_WATCHDOG_TTFB_MS`.
 */
const DEFAULT_FIRST_ACTIVITY_WAIT_MS = 90_000

export interface StreamWatchdogConfig {
  /** Milliseconds before idle warning is emitted. Default 45s. */
  idleWarningMs?: number
  /** Milliseconds before abort (when enabled). Default 90s. */
  idleAbortMs?: number
  /** Stall check interval. Default 30s. */
  stallCheckIntervalMs?: number
  /**
   * Pre-first-activity ceiling. Bounds the time between `start()` and the
   * first `notifyActivity()` call — roughly equivalent to "time to first
   * streamed byte" for callers wired through `compatibleClient` /
   * `anthropicCompatHttp` (where `touch()` runs inside the SSE reader
   * loop). Once first activity is observed this timer is cleared and the
   * normal `idleAbortMs` schedule takes over.
   *
   * Without this dimension the same 180s `idleAbortMs` covered both
   * "stream stalled mid-output" and "server hasn't replied yet" — the
   * latter caused parallel multi-sub-agent runs through queue-style
   * gateways to fail before the server even sent headers.
   *
   * Set `0` to disable (fall back to legacy single-threshold behaviour).
   * Default {@link DEFAULT_FIRST_ACTIVITY_WAIT_MS} (90s).
   */
  firstActivityWaitMs?: number
  /** Called when the idle warning threshold is reached. */
  onIdleWarning?: (elapsedMs: number) => void
  /** Called when the hard abort threshold is reached. Return true to actually abort. */
  onIdleAbort?: (elapsedMs: number) => boolean
  /** Called each stall check interval with cumulative stats. */
  onStallCheck?: (stats: StreamWatchdogStats) => void
  /**
   * Called when the pre-first-activity ceiling fires. Return true to
   * actually abort. Defaults to true if unset.
   */
  onFirstActivityTimeout?: (elapsedMs: number) => boolean
}

export interface StreamWatchdogStats {
  stallCount: number
  totalStallTimeMs: number
  lastActivityMs: number
  elapsedSinceLastActivityMs: number
}

export function isStreamWatchdogEnabled(): boolean {
  // A3 — default-on. Explicit `0` / `false` disables; anything else
  // (including unset) keeps the watchdog active so production stalls
  // get aborted within `idleAbortMs` instead of hanging.
  const raw = (
    process.env.POLE_STREAM_WATCHDOG ??
    process.env.POLE_ENABLE_STREAM_WATCHDOG ??
    process.env.CLAUDE_ENABLE_STREAM_WATCHDOG ??
    ''
  ).trim().toLowerCase()
  if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') {
    return false
  }
  return true
}

export class StreamWatchdog {
  private config: Required<
    Pick<
      StreamWatchdogConfig,
      'idleWarningMs' | 'idleAbortMs' | 'stallCheckIntervalMs' | 'firstActivityWaitMs'
    >
  >
  private callbacks: Pick<
    StreamWatchdogConfig,
    'onIdleWarning' | 'onIdleAbort' | 'onStallCheck' | 'onFirstActivityTimeout'
  >
  private lastActivityTs: number
  private warningFired = false
  private firstActivitySeen = false
  private startedAtTs: number = 0
  private stallCount = 0
  private totalStallTimeMs = 0
  private stallCheckTimer: ReturnType<typeof setInterval> | null = null
  private warningTimer: ReturnType<typeof setTimeout> | null = null
  private abortTimer: ReturnType<typeof setTimeout> | null = null
  private firstActivityTimer: ReturnType<typeof setTimeout> | null = null
  private abortController: AbortController | null = null
  private disposed = false

  constructor(config: StreamWatchdogConfig = {}, abortController?: AbortController) {
    this.config = {
      idleWarningMs: config.idleWarningMs ?? DEFAULT_IDLE_WARNING_MS,
      idleAbortMs: config.idleAbortMs ?? DEFAULT_IDLE_ABORT_MS,
      stallCheckIntervalMs: config.stallCheckIntervalMs ?? DEFAULT_STALL_CHECK_INTERVAL_MS,
      firstActivityWaitMs:
        config.firstActivityWaitMs ?? DEFAULT_FIRST_ACTIVITY_WAIT_MS,
    }
    this.callbacks = {
      onIdleWarning: config.onIdleWarning,
      onIdleAbort: config.onIdleAbort,
      onStallCheck: config.onStallCheck,
      onFirstActivityTimeout: config.onFirstActivityTimeout,
    }
    this.abortController = abortController ?? null
    this.lastActivityTs = Date.now()
  }

  /** Call when the watchdog should start monitoring. */
  start(): void {
    if (this.disposed) return
    const now = Date.now()
    this.lastActivityTs = now
    this.startedAtTs = now
    this.warningFired = false
    this.firstActivitySeen = false
    this.stallCount = 0
    this.totalStallTimeMs = 0
    // Audit Bug 11 — when the watchdog feature flag is off, the warning
    // / stall timers used to keep ticking with no consumer (the abort
    // path is the only state these timers feed). Skip scheduling
    // entirely so disabled installs pay zero recurring cost.
    if (!isStreamWatchdogEnabled()) return
    // Phase 1 — pre-first-activity (TTFB) ceiling. The idle/warning/stall
    // timers are deliberately deferred until first activity so a slow
    // gateway response is not double-counted as "stream stalled".
    if (this.config.firstActivityWaitMs > 0) {
      this.scheduleFirstActivityTimer()
    } else {
      // Legacy single-threshold behaviour when explicitly opted out.
      this.scheduleTimers()
    }
  }

  /** Call on every content_block_delta or any meaningful stream data event. */
  notifyActivity(): void {
    if (this.disposed) return
    this.lastActivityTs = Date.now()
    if (this.warningFired) {
      this.warningFired = false
    }
    if (!this.firstActivitySeen) {
      this.firstActivitySeen = true
      // Promote: clear the TTFB timer and start the normal idle / stall
      // schedule. From here on the watchdog behaves exactly like the
      // legacy single-threshold version.
      if (this.firstActivityTimer) {
        clearTimeout(this.firstActivityTimer)
        this.firstActivityTimer = null
      }
      this.scheduleTimers()
      return
    }
    this.resetIdleTimers()
  }

  /** Permanently stop the watchdog and clean up timers. */
  dispose(): void {
    this.disposed = true
    this.clearAllTimers()
  }

  getStats(): StreamWatchdogStats {
    const now = Date.now()
    return {
      stallCount: this.stallCount,
      totalStallTimeMs: this.totalStallTimeMs,
      lastActivityMs: this.lastActivityTs,
      elapsedSinceLastActivityMs: now - this.lastActivityTs,
    }
  }

  /**
   * Phase 1 timer — fires when the watchdog has been started for
   * `firstActivityWaitMs` and `notifyActivity()` has never been called.
   * Distinct from the idle/warning/stall timers so the abort error
   * message can correctly attribute the failure to "no first byte"
   * rather than "stream stalled".
   */
  private scheduleFirstActivityTimer(): void {
    if (this.firstActivityTimer) {
      clearTimeout(this.firstActivityTimer)
      this.firstActivityTimer = null
    }
    if (this.config.firstActivityWaitMs <= 0) return
    this.firstActivityTimer = setTimeout(() => {
      if (this.disposed || this.firstActivitySeen) return
      const elapsed = Date.now() - this.startedAtTs
      console.error(
        `[StreamWatchdog] First-activity timeout: no data received for ${elapsed}ms`,
      )
      const shouldAbort =
        this.callbacks.onFirstActivityTimeout?.(elapsed) ?? true
      if (shouldAbort && this.abortController) {
        this.abortController.abort(
          new Error(
            `Stream first-activity timeout: ${elapsed}ms with no data ` +
              '(server has not started responding — likely gateway queue ' +
              'or rate-limit pressure)',
          ),
        )
      }
    }, this.config.firstActivityWaitMs)
  }

  private scheduleTimers(): void {
    this.clearAllTimers()

    this.warningTimer = setTimeout(() => {
      if (this.disposed) return
      const elapsed = Date.now() - this.lastActivityTs
      if (elapsed >= this.config.idleWarningMs && !this.warningFired) {
        this.warningFired = true
        console.warn(`[StreamWatchdog] Idle warning: no data for ${elapsed}ms`)
        this.callbacks.onIdleWarning?.(elapsed)
      }
    }, this.config.idleWarningMs)

    if (isStreamWatchdogEnabled()) {
      this.abortTimer = setTimeout(() => {
        if (this.disposed) return
        const elapsed = Date.now() - this.lastActivityTs
        if (elapsed >= this.config.idleAbortMs) {
          console.error(`[StreamWatchdog] Idle abort: no data for ${elapsed}ms`)
          const shouldAbort = this.callbacks.onIdleAbort?.(elapsed) ?? true
          if (shouldAbort && this.abortController) {
            this.abortController.abort(new Error(`Stream idle timeout: ${elapsed}ms with no data`))
          }
        }
      }, this.config.idleAbortMs)
    }

    this.stallCheckTimer = setInterval(() => {
      if (this.disposed) return
      const now = Date.now()
      const elapsed = now - this.lastActivityTs
      if (elapsed >= this.config.stallCheckIntervalMs) {
        this.stallCount++
        this.totalStallTimeMs += this.config.stallCheckIntervalMs
        const stats = this.getStats()
        console.warn(
          `[StreamWatchdog] Stall detected: count=${stats.stallCount}, ` +
            `total_stall_time=${stats.totalStallTimeMs}ms`,
        )
        this.callbacks.onStallCheck?.(stats)
      }
    }, this.config.stallCheckIntervalMs)
  }

  private resetIdleTimers(): void {
    if (this.warningTimer) {
      clearTimeout(this.warningTimer)
      this.warningTimer = null
    }
    if (this.abortTimer) {
      clearTimeout(this.abortTimer)
      this.abortTimer = null
    }
    if (!this.disposed) {
      this.scheduleTimers()
    }
  }

  private clearAllTimers(): void {
    if (this.warningTimer) {
      clearTimeout(this.warningTimer)
      this.warningTimer = null
    }
    if (this.abortTimer) {
      clearTimeout(this.abortTimer)
      this.abortTimer = null
    }
    if (this.stallCheckTimer) {
      clearInterval(this.stallCheckTimer)
      this.stallCheckTimer = null
    }
    if (this.firstActivityTimer) {
      clearTimeout(this.firstActivityTimer)
      this.firstActivityTimer = null
    }
  }
}

/**
 * Lightweight handle used by `client.ts` / `compatibleClient.ts` at the
 * per-stream-attempt level.  Wraps the user-provided `AbortSignal` with an
 * internal `AbortController` so the watchdog can abort independently.
 */
export interface StreamWatchdogHandle {
  /** Signal that merges the user abort *and* the watchdog idle-abort. */
  signal: AbortSignal
  /** Notify the watchdog that the stream produced data (resets idle timers). */
  touch(): void
  /** Permanently stop timers and detach the merged signal. */
  dispose(): void
}

/**
 * Create a merged signal + watchdog pair.
 *
 * When disabled (none of the env flags are set), returns a lightweight
 * passthrough handle: `signal` === `userSignal` and `touch`/`dispose`
 * are no-ops.
 *
 * When enabled, the returned `signal` will abort after the configured
 * idle timeout (via `.touch()` resets).  User abort is also forwarded.
 *
 * Environment variables:
 *  - `POLE_STREAM_WATCHDOG` / `POLE_ENABLE_STREAM_WATCHDOG` / `CLAUDE_ENABLE_STREAM_WATCHDOG` = '1' to enable
 *  - `POLE_STREAM_WATCHDOG_WARN_MS` – idle warning threshold (default 45000)
 *  - `POLE_STREAM_WATCHDOG_ABORT_MS` – idle abort threshold (default 90000)
 *  - `POLE_STREAM_WATCHDOG_TICK_MS` – stall check interval (default 30000)
 *
 * @param userSignal  The caller's `AbortSignal` (e.g. from `params.signal`).
 * @param label       A short human-readable tag for log messages.
 */
export function mergeUserSignalWithStreamWatchdog(
  userSignal: AbortSignal,
  label?: string,
): StreamWatchdogHandle {
  if (!isStreamWatchdogEnabled()) {
    return {
      signal: userSignal,
      touch() {},
      dispose() {},
    }
  }

  const idleWarningMs =
    process.env.POLE_STREAM_WATCHDOG_WARN_MS != null
      ? Number(process.env.POLE_STREAM_WATCHDOG_WARN_MS)
      : undefined
  const idleAbortMs =
    process.env.POLE_STREAM_WATCHDOG_ABORT_MS != null
      ? Number(process.env.POLE_STREAM_WATCHDOG_ABORT_MS)
      : undefined
  const stallCheckIntervalMs =
    process.env.POLE_STREAM_WATCHDOG_TICK_MS != null
      ? Number(process.env.POLE_STREAM_WATCHDOG_TICK_MS)
      : undefined
  // Pre-first-activity (TTFB) ceiling — separate from idle abort so
  // queued requests at gateway side fail fast with the right diagnostic
  // instead of "stream idle 180s" misleading the user.
  const firstActivityWaitMs =
    process.env.POLE_STREAM_WATCHDOG_TTFB_MS != null
      ? Number(process.env.POLE_STREAM_WATCHDOG_TTFB_MS)
      : undefined

  const ac = new AbortController()

  const onUserAbort = () => {
    if (!ac.signal.aborted) ac.abort(userSignal.reason)
  }
  if (userSignal.aborted) {
    ac.abort(userSignal.reason)
  } else {
    userSignal.addEventListener('abort', onUserAbort, { once: true })
  }

  const watchdog = new StreamWatchdog(
    {
      idleWarningMs,
      idleAbortMs,
      stallCheckIntervalMs,
      firstActivityWaitMs,
      onIdleWarning: (elapsed) => {
        console.warn(`[StreamWatchdog] ${label ?? 'stream'} idle warning: ${elapsed}ms`)
      },
      onIdleAbort: (elapsed) => {
        console.error(`[StreamWatchdog] ${label ?? 'stream'} idle abort: ${elapsed}ms`)
        if (!ac.signal.aborted) {
          ac.abort(new Error(`Stream watchdog idle timeout: ${elapsed}ms (${label})`))
        }
        return false
      },
      onStallCheck: (stats) => {
        console.warn(
          `[StreamWatchdog] ${label ?? 'stream'} stall #${stats.stallCount}, ` +
            `total=${stats.totalStallTimeMs}ms`,
        )
      },
      onFirstActivityTimeout: (elapsed) => {
        console.error(
          `[StreamWatchdog] ${label ?? 'stream'} first-activity timeout: ${elapsed}ms`,
        )
        if (!ac.signal.aborted) {
          ac.abort(
            new Error(
              `Stream first-activity timeout: ${elapsed}ms (${label}) — ` +
                'gateway has not started responding; common when the same API ' +
                'key is parallelized beyond the upstream concurrency cap. The ' +
                'agentic loop will retry this turn or surface the error.',
            ),
          )
        }
        return false
      },
    },
  )
  watchdog.start()

  return {
    signal: ac.signal,
    touch() {
      watchdog.notifyActivity()
    },
    dispose() {
      watchdog.dispose()
      userSignal.removeEventListener('abort', onUserAbort)
    },
  }
}
