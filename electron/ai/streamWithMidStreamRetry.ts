/**
 * Mid-stream retry helper for streaming providers.
 *
 * Companion to `withRetry.ts` (which retries pure RPC calls) — this
 * helper handles the case where a long-lived streaming response dies
 * mid-flight on a transient network failure. The classic symptom is a
 * Chinese gateway (DeepSeek / packycode / 云雾 / ...) that accepts the
 * POST, starts streaming, then drops the TCP connection after a few
 * deltas. Without retry, every such drop becomes a terminal
 * `model_error` and the user has to resend.
 *
 * Why a separate helper from `withRetry`:
 *   - `withRetry` retries the full operation idempotently. That's fine
 *     for one-shot RPCs but unsafe for streams — once we've emitted
 *     `onTextDelta`, retrying would duplicate the user-visible output.
 *   - This helper takes an `EmissionTracker` and ONLY retries while
 *     `tracker.hasEmitted()` is false, i.e. the stream died before
 *     producing any callback. That covers the dominant case (gateway
 *     resets on early deltas / before the first event) without risking
 *     duplicate output.
 *
 * The provider's existing `fetchWithRetry` (initial-handshake retry)
 * remains untouched — this helper layers ABOVE the per-attempt fetch
 * so the worst-case retry budget is `outer × inner`. With the post-audit
 * defaults (P1-1) that's `(2+1) × 3 = 9` attempts on interactive turns
 * and `(5+1) × 3 = 18` on unattended/background runs (env
 * `CLAUDE_CODE_UNATTENDED_RETRY=1`). Stage 0's 5/10 default was the
 * unattended case applied unconditionally and stacked multiplicatively
 * with `fetchWithRetry(3)`, which spiked the worst-case to 18×—too
 * aggressive for interactive sessions. The new split matches the
 * official SDK path's `defaultStreamExtraRetries()` policy.
 *
 * Usage:
 *
 *   await streamWithMidStreamRetry({
 *     signal,
 *     label: 'AnthropicCompatHttp',
 *     runOnce: async (tracker) => {
 *       // tracker.markEmitted() must be called the first time anything
 *       // user-visible flows out (text delta, thinking delta, tool_use).
 *       await fetchAndConsumeStream({ ..., onTextDelta: (t) => {
 *         tracker.markEmitted()
 *         callbacks.onTextDelta(t)
 *       } })
 *     },
 *   })
 */

import { isAbortLikeError } from './abortLikeError'
import type { StreamCallbacks } from './client'
import { isRetryableStreamHttpError, isUnattendedRetryModeEnabled, sleepAbortable } from './withRetry'

export interface EmissionTracker {
  /** Call before invoking any user-visible callback (onTextDelta, onToolUse, etc). */
  markEmitted(): void
  /** True once {@link markEmitted} has fired in this attempt. */
  hasEmitted(): boolean
}

export interface MidStreamRetryOptions {
  /** Caller's abort signal — retry sleeps reject when this fires. */
  signal: AbortSignal
  /** Short tag for log messages (`[CompatibleClient]`, `[AnthropicCompatHttp]`, …). */
  label: string
  /**
   * Max retries.
   *
   * upstream alignment Part 4 (2026-05-12) + P1-1 audit fix:
   *   - Interactive default: **2** (3 total attempts). This matches the
   *     "outer × inner = 2 × 3" comment in the file header and the
   *     official SDK path's `defaultStreamExtraRetries()` for non-
   *     unattended runs. A persistent gateway failure now surfaces as
   *     `model_error` within ~3 attempts, ~3s of total backoff — short
   *     enough for the user to react.
   *   - Unattended default: **5** (6 total attempts). Picked deliberately
   *     LOWER than `defaultStreamExtraRetries()`'s `10`, because this
   *     helper stacks multiplicatively with `fetchWithRetry(3)`; `5×3 =
   *     18 attempts` is already the upper bound a multi-minute legal
   *     document generation needs to survive a flaky Chinese gateway.
   *
   * Resolution order (see `streamWithMidStreamRetry` body):
   *   1. Caller-supplied `opts.maxRetries`         (explicit override)
   *   2. `opts.isUnattended` true → 5; false → 2   (explicit hint)
   *   3. `isUnattendedRetryModeEnabled()` env true → 5; else → 2
   */
  maxRetries?: number
  /** Base delay in ms for exponential backoff (default 600). */
  baseDelayMs?: number
  /**
   * Max delay between attempts.
   *
   * upstream alignment Part 4 (2026-05-12): bumped from 5000 → 8000 so the
   * exponential backoff can actually use late attempts (600 → 1200 → 2400 →
   * 4800 → 8000) instead of capping out at attempt 4. Tail of the curve
   * matters for gateways that recover slowly under load.
   */
  maxDelayMs?: number
  /**
   * Hint that this stream runs under a non-interactive / background agent
   * (no human to manually retry). When true, the default retry budget
   * grows from 2 → 5 so long async runs survive multi-minute gateway
   * hiccups. Defaults to {@link isUnattendedRetryModeEnabled} so callers
   * that don't thread the flag still benefit when the env var is set.
   */
  isUnattended?: boolean
  /**
   * Predicate for retryable errors. Defaults to {@link isRetryableStreamHttpError},
   * which already covers ECONNRESET / ETIMEDOUT / 408 / 429 / 5xx / etc.
   */
  isRetryable?: (e: unknown) => boolean
  /** Optional per-retry callback (telemetry / log surfaces). */
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown; alreadyEmitted: boolean }) => void
  /**
   * Operation to run. May be invoked multiple times.
   *
   * MUST call `tracker.markEmitted()` immediately before its first
   * user-visible callback. If `runOnce` throws BEFORE
   * `markEmitted` has fired, the helper retries (when retryable).
   * If `runOnce` throws AFTER `markEmitted`, the error is re-thrown
   * immediately to avoid duplicate output.
   */
  runOnce: (tracker: EmissionTracker) => Promise<void>
}

function computeDelay(
  attempt: number,
  base: number,
  cap: number,
): number {
  const exp = base * 2 ** attempt
  const jitter = Math.floor(Math.random() * (0.25 * base))
  return Math.min(exp + jitter, cap)
}

export async function streamWithMidStreamRetry(opts: MidStreamRetryOptions): Promise<void> {
  // P1-1 audit fix: see `MidStreamRetryOptions.maxRetries` jsdoc for the
  // resolution order rationale. Caller flag wins; env-driven unattended
  // mode is the fallback so existing CLAUDE_CODE_UNATTENDED_RETRY=1 setups
  // automatically get the longer budget without needing every call site
  // updated.
  const unattended = opts.isUnattended ?? isUnattendedRetryModeEnabled()
  const defaultMaxRetries = unattended ? 5 : 2
  const maxRetries = opts.maxRetries ?? defaultMaxRetries
  const baseDelayMs = opts.baseDelayMs ?? 600
  const maxDelayMs = opts.maxDelayMs ?? 8_000
  const isRetryable = opts.isRetryable ?? isRetryableStreamHttpError

  let lastError: unknown
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let emitted = false
    const tracker: EmissionTracker = {
      markEmitted: () => { emitted = true },
      hasEmitted: () => emitted,
    }

    try {
      await opts.runOnce(tracker)
      return
    } catch (e) {
      lastError = e
      // User abort wins immediately — no retries.
      if (isAbortLikeError(e)) throw e
      // After emissions, retrying would double-emit user-visible output.
      if (emitted) throw e
      // Non-retryable error — propagate.
      if (attempt >= maxRetries || !isRetryable(e)) throw e

      const delay = computeDelay(attempt, baseDelayMs, maxDelayMs)
      const reason = e instanceof Error ? e.message : String(e)
      console.warn(
        `[${opts.label}] mid-stream retry attempt ${attempt + 1}/${maxRetries + 1} after ${delay}ms — ${reason}`,
      )
      opts.onRetry?.({ attempt: attempt + 1, delayMs: delay, error: e, alreadyEmitted: emitted })

      try {
        await sleepAbortable(delay, opts.signal)
      } catch (sleepErr) {
        // `sleepAbortable` only rejects when the caller's signal fires during
        // the backoff. A user cancel must take priority over the transient
        // network error that triggered this retry — otherwise clicking Stop
        // mid-backoff surfaces "ECONNRESET / timeout" instead of a clean
        // cancellation. `sleepErr` carries `name: 'AbortError'`, so downstream
        // `isAbortLikeError` classifies it as a user cancel rather than a
        // model/network error.
        if (opts.signal.aborted) throw sleepErr
        // Defensive: a non-abort sleep rejection (shouldn't happen with the
        // current `sleepAbortable`) must not mask the real network cause.
        throw e
      }
    }
  }

  // Defensive — every loop branch either returned or threw.
  throw lastError
}

/**
 * Wrap a {@link StreamCallbacks} so every user-visible callback marks
 * emission on the supplied tracker before delegating. Used by providers
 * that integrate with {@link streamWithMidStreamRetry}: hand the wrapped
 * callbacks to the inner stream consumer and the helper will know when
 * partial output has reached the user.
 *
 * Callbacks NOT wrapped (because they don't represent user-visible
 * output): `onMessageEnd` (terminal, fires after the work is done),
 * `onError` (also terminal), `onStreamingFallback` (no payload yet).
 */
export function wrapCallbacksForEmissionTracking(
  inner: StreamCallbacks,
  tracker: EmissionTracker,
): StreamCallbacks {
  return {
    ...inner,
    onTextDelta: (t: string) => {
      tracker.markEmitted()
      inner.onTextDelta(t)
    },
    ...(inner.onToolUse
      ? {
          onToolUse: (tu) => {
            tracker.markEmitted()
            inner.onToolUse?.(tu)
          },
        }
      : {}),
    ...(inner.onThinkingDelta
      ? {
          onThinkingDelta: (t: string) => {
            tracker.markEmitted()
            inner.onThinkingDelta?.(t)
          },
        }
      : {}),
    ...(inner.onThinkingBlock
      ? {
          onThinkingBlock: (block) => {
            tracker.markEmitted()
            inner.onThinkingBlock?.(block)
          },
        }
      : {}),
    ...(inner.onServerToolUse
      ? {
          onServerToolUse: (block) => {
            tracker.markEmitted()
            inner.onServerToolUse?.(block)
          },
        }
      : {}),
    ...(inner.onCodeExecutionResult
      ? {
          onCodeExecutionResult: (r) => {
            tracker.markEmitted()
            inner.onCodeExecutionResult?.(r)
          },
        }
      : {}),
  }
}
