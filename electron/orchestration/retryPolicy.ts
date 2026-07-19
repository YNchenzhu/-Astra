/**
 * Unified retry policy.
 *
 * Before P2.2 the codebase had at least four hand-rolled retry loops:
 *
 *   - `agenticLoop/stream.ts` — `maxOutputRecoveryCycles` (re-prompt when the model hits the
 *     output-token cap mid-stream).
 *   - `agenticLoop/setup.ts` — `consecutiveCompactFailures` (re-attempt context compaction
 *     when the post-compact stream still over-flows the window).
 *   - `streamText` 5xx / overload backoff (in `electron/ai/client.ts`).
 *   - Per-tool retry inside `streamingToolExecutor` and a handful of MCP shells.
 *
 * Each one has its own backoff defaults, its own "is this exception retry-eligible" rule,
 * and its own ad-hoc telemetry. The policy is the same in spirit (try N times with
 * exponential backoff + jitter, skip on programmer errors) but every variant had to be
 * tuned independently when a number drifted.
 *
 * This module collapses the common parts into a declarative `RetryPolicy` + a `withRetry`
 * runner. Callsites migrate incrementally; the legacy counters (`maxOutputRecoveryCycles`,
 * `consecutiveCompactFailures`) remain valid model-state fields and are not removed
 * (their semantic — "how many times has THIS recovery fired in this iteration" — belongs
 * on the kernel state, not the policy). The win is one place to tune backoff defaults
 * and one predicate to declare "is this error retryable".
 *
 * Aligned with LangGraph `RetryPolicy` (see node-level retry policy doc) so the comparison
 * report in `LangGraph vs 本系统` stays accurate.
 */

/**
 * Configuration for a retry loop.
 *
 * Sensible defaults are bound by {@link DEFAULT_RETRY_POLICY}. Callers typically construct
 * `{ ...DEFAULT_RETRY_POLICY, ...overrides }`.
 */
export type RetryPolicy = {
  /** Total attempts (NOT "extra retries"). `maxAttempts: 1` → fn runs once, no retries. */
  maxAttempts: number
  /** Initial wait before the **2nd** attempt, in milliseconds. */
  initialIntervalMs: number
  /** Each successive wait is multiplied by this factor (1 → constant). */
  backoffFactor: number
  /** Hard ceiling on per-attempt wait, in milliseconds. */
  maxIntervalMs: number
  /**
   * Multiplicative jitter applied to each computed wait. `0` → deterministic,
   * `0.25` → wait is multiplied by a random value in `[0.75, 1.25]`. Cap implicitly at 1.
   *
   * Tests SHOULD pass `0` (combined with `randomSource`) for byte-identical timings; production
   * uses `DEFAULT_RETRY_POLICY.jitter`.
   */
  jitter: number
  /**
   * Predicate. Return `true` to retry, `false` to bubble the error immediately. By default
   * we retry everything except `TypeError`, `SyntaxError`, and `RangeError` — these are
   * programmer mistakes, not transient failures.
   */
  retryOn: (error: unknown, attempt: number) => boolean
}

/** Default policy — mirrors LangGraph's default RetryPolicy parameters. */
export const DEFAULT_RETRY_POLICY: RetryPolicy = Object.freeze({
  maxAttempts: 3,
  initialIntervalMs: 500,
  backoffFactor: 2,
  maxIntervalMs: 128_000,
  jitter: 0.25,
  retryOn: (e) => !isProgrammerError(e),
})

/** Heuristic: a `TypeError` / `SyntaxError` / `RangeError` is almost never retry-eligible. */
export function isProgrammerError(e: unknown): boolean {
  if (e instanceof TypeError) return true
  if (e instanceof SyntaxError) return true
  if (e instanceof RangeError) return true
  return false
}

/** Signals to `withRetry` that the next attempt should be skipped (e.g. AbortSignal fired). */
export class RetryAborted extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RetryAborted'
    Object.setPrototypeOf(this, RetryAborted.prototype)
  }
}

export type WithRetryOptions = {
  /** Optional abort signal — when fired, the next retry is skipped and the underlying error
   * is re-thrown wrapped in `RetryAborted`. */
  signal?: AbortSignal
  /** Optional per-attempt observer for telemetry / structured logging. */
  onAttempt?: (info: {
    attempt: number
    maxAttempts: number
    error: unknown
    delayMs: number
  }) => void
  /**
   * Optional sleeper override — tests inject `vi.fn()` to skip real timers. Defaults to
   * `setTimeout`-based promise.
   */
  sleep?: (ms: number) => Promise<void>
  /**
   * Optional [0, 1) random source for jitter — tests pass `() => 0.5` for determinism.
   * Defaults to `Math.random`.
   */
  randomSource?: () => number
}

/**
 * Run `fn` according to `policy`, returning its result on success. On failure: if
 * `policy.retryOn` returns true AND we haven't reached `maxAttempts`, wait and try again.
 *
 * Wait formula (matches LangGraph): `min(initial * factor^(attempt-1), maxInterval)` with
 * multiplicative jitter applied last.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  options?: WithRetryOptions,
): Promise<T> {
  const maxAttempts = Math.max(1, policy.maxAttempts)
  const jitter = Math.max(0, Math.min(1, policy.jitter))
  const sleep = options?.sleep ?? defaultSleep
  const rand = options?.randomSource ?? Math.random

  let attempt = 0
  let lastErr: unknown = undefined
  while (attempt < maxAttempts) {
    attempt++
    if (options?.signal?.aborted) {
      throw new RetryAborted(
        `withRetry aborted before attempt ${attempt}` +
          (lastErr instanceof Error ? `: ${lastErr.message}` : ''),
      )
    }
    try {
      return await fn()
    } catch (e) {
      lastErr = e
      const shouldRetry =
        attempt < maxAttempts && policy.retryOn(e, attempt)
      if (!shouldRetry) throw e
      const baseDelay = Math.min(
        policy.initialIntervalMs * Math.pow(policy.backoffFactor, attempt - 1),
        policy.maxIntervalMs,
      )
      const jitterMult = jitter === 0 ? 1 : 1 + (rand() * 2 - 1) * jitter
      const delayMs = Math.max(0, Math.round(baseDelay * jitterMult))
      try {
        options?.onAttempt?.({
          attempt,
          maxAttempts,
          error: e,
          delayMs,
        })
      } catch {
        /* telemetry must never break the retry loop */
      }
      if (options?.signal?.aborted) {
        throw new RetryAborted(
          `withRetry aborted after attempt ${attempt}` +
            (e instanceof Error ? `: ${e.message}` : ''),
        )
      }
      await sleep(delayMs)
    }
  }
  // Should be unreachable: loop body either returns success or throws on the final attempt.
  throw lastErr
}

function defaultSleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve) => setTimeout(resolve, ms))
}
