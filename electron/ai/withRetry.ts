/**
 * upstream report §12 — API stream retry: which errors retry, backoff, Retry-After,
 * unattended mode (`CLAUDE_CODE_UNATTENDED_RETRY`), and typed overload fallback (§12.5).
 */

import { APIConnectionError, APIError } from '@anthropic-ai/sdk'
// P2-7: route abort detection through the shared helper so non-Error
// throwables (DOMException variants, plain `{ name: 'AbortError' }`
// objects) are handled identically across the codebase.
import { isAbortLikeError } from './abortLikeError'

export const API_RETRY_BASE_DELAY_MS = 500
/** §12.2 — cap exponential backoff for interactive sessions */
export const API_RETRY_MAX_DELAY_MS = 32_000
/** §12.3 — unattended mode max delay between attempts */
export const API_RETRY_UNATTENDED_MAX_DELAY_MS = 300_000
/** §12.3 — stop retrying unattended after this wall-clock span */
export const API_RETRY_UNATTENDED_MAX_WALL_MS = 6 * 60 * 60 * 1000
/** §12.3 — chunk long sleeps so callers can pulse keep-alive */
export const API_RETRY_KEEPALIVE_CHUNK_MS = 30_000

/** §12.4 — short Retry-After (seconds) keeps fast-mode beta; longer enters cooldown */
export const FAST_MODE_SHORT_RETRY_AFTER_SEC = 20
/** §12.4 — minimum fast-mode cooldown after a long wait */
export const FAST_MODE_COOLDOWN_MIN_MS = 10 * 60 * 1000

export class FallbackTriggeredError extends Error {
  readonly fallbackModel: string
  constructor(fallbackModel: string, message?: string) {
    super(message ?? `Overload fallback: switching model to ${fallbackModel}`)
    this.name = 'FallbackTriggeredError'
    this.fallbackModel = fallbackModel
  }
}

export function isUnattendedRetryModeEnabled(): boolean {
  const v = process.env.CLAUDE_CODE_UNATTENDED_RETRY
  return v !== undefined && v !== '' && v !== '0' && v.toLowerCase() !== 'false'
}

export function defaultStreamExtraRetries(): number {
  return isUnattendedRetryModeEnabled() ? 10 : 2
}

function readNodeCauseCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined
  const c = (error as { cause?: unknown }).cause
  if (c && typeof c === 'object' && 'code' in c) {
    const code = (c as { code?: unknown }).code
    return typeof code === 'string' ? code : undefined
  }
  return undefined
}

/**
 * §12.1 — transient failures worth retrying for streaming chat.
 * 401/403: static API keys do not self-heal on retry; repeating POSTs often trips WAF / “attack” rules.
 * Opt-in old behavior: `POLE_STREAM_RETRY_HTTP_401=1` (OAuth-style refresh scenarios).
 *
 * A2 — broaden the network-error patterns. Production logs from Chinese
 * gateways (DeepSeek / packycode / 云雾 / ...) showed many mid-stream
 * disconnects landing as `socket hang up` / `ETIMEDOUT` /
 * `ECONNABORTED` / `EAI_AGAIN` / `ENETUNREACH`, all of which previously
 * fell through `isRetryableStreamHttpError` and were promoted to a
 * terminal `model_error`. Whitelisting them here lets {@link withRetry}
 * (and the per-provider retry loops that share this predicate) recover
 * automatically.
 */
const RETRYABLE_ERRNO_CODES: ReadonlyArray<string> = [
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

const RETRYABLE_MESSAGE_PATTERNS: ReadonlyArray<RegExp> = [
  /\bECONNRESET\b/i,
  /\bECONNABORTED\b/i,
  /\bECONNREFUSED\b/i,
  /\bETIMEDOUT\b/i,
  /\bEPIPE\b/i,
  /\bEAI_AGAIN\b/i,
  /\bENETUNREACH\b/i,
  /\bENETDOWN\b/i,
  /\bENOTFOUND\b/i,
  /\bEHOSTUNREACH\b/i,
  /fetch failed/i,
  /socket(?:\s+hang\s+up|\s+disconnected|\s+closed|\s+timeout)/i,
  /network\s+(?:is\s+down|error|unreachable)/i,
  /the\s+stream\s+(?:has\s+been\s+aborted|was\s+closed)/i,
  /premature\s+close/i,
  /upstream\s+(?:closed|disconnected|reset)/i,
  /connection\s+(?:reset|aborted|closed|terminated|lost)/i,
  /request\s+timed?\s*out/i,
  /read\s+ECONNRESET/i,
]

export function isRetryableStreamHttpError(error: unknown): boolean {
  if (error instanceof APIConnectionError) return true
  const code = readNodeCauseCode(error)
  if (code && RETRYABLE_ERRNO_CODES.includes(code)) return true
  if (error instanceof Error) {
    for (const re of RETRYABLE_MESSAGE_PATTERNS) {
      if (re.test(error.message)) return true
    }
  }

  const s = readHttpStatus(error)
  if (s === undefined) return false
  if (s === 408 || s === 409 || s === 425 || s === 429 || s === 529) return true
  if (s === 401 || s === 403) {
    const v = process.env.POLE_STREAM_RETRY_HTTP_401
    return v !== undefined && v !== '' && v !== '0' && v.toLowerCase() !== 'false'
  }
  if (s >= 500 && s <= 599) return true
  return false
}

export function readHttpStatus(error: unknown): number | undefined {
  if (error && typeof error === 'object' && 'status' in error) {
    const s = (error as { status: unknown }).status
    return typeof s === 'number' && Number.isFinite(s) ? s : undefined
  }
  return undefined
}

function parseRetryAfterSeconds(value: string): number | undefined {
  const t = value.trim()
  if (!t) return undefined
  const sec = Number.parseInt(t, 10)
  if (Number.isFinite(sec) && sec >= 0) return sec
  const dateMs = Date.parse(t)
  if (Number.isFinite(dateMs)) {
    const delta = Math.ceil((dateMs - Date.now()) / 1000)
    return Math.max(0, delta)
  }
  return undefined
}

/** Prefer `Retry-After` (seconds or HTTP-date); returns milliseconds. */
export function parseRetryAfterMsFromError(error: unknown): number | undefined {
  const tryHeaders = (headers: { get?: (name: string) => string | null } | undefined): number | undefined => {
    if (!headers || typeof headers.get !== 'function') return undefined
    const raw = headers.get('retry-after')
    if (!raw) return undefined
    const sec = parseRetryAfterSeconds(raw)
    if (sec === undefined) return undefined
    return sec * 1000
  }
  if (error instanceof APIError && error.headers) {
    const fromAnthropic = tryHeaders(error.headers as { get?: (name: string) => string | null })
    if (fromAnthropic != null) return fromAnthropic
  }
  if (error && typeof error === 'object' && 'response' in error) {
    const res = (error as { response?: { headers?: { get?: (n: string) => string | null } } }).response
    const fromSdk = tryHeaders(res?.headers)
    if (fromSdk != null) return fromSdk
  }
  return undefined
}

export function computeApiRetryDelayMs(
  retryIndexZeroBased: number,
  options: {
    retryAfterMs?: number
    unattended: boolean
  },
): number {
  const base = API_RETRY_BASE_DELAY_MS
  const cap = options.unattended ? API_RETRY_UNATTENDED_MAX_DELAY_MS : API_RETRY_MAX_DELAY_MS
  const exp = base * 2 ** retryIndexZeroBased
  const jitter = Math.floor(Math.random() * (0.25 * base))
  let delay = exp + jitter
  if (
    options.retryAfterMs != null &&
    Number.isFinite(options.retryAfterMs) &&
    options.retryAfterMs > 0
  ) {
    delay = Math.max(delay, options.retryAfterMs)
  }
  return Math.min(delay, cap)
}

export function unattendedWallClockExceeded(startedAtMs: number | null): boolean {
  if (!isUnattendedRetryModeEnabled() || startedAtMs == null) return false
  return Date.now() - startedAtMs >= API_RETRY_UNATTENDED_MAX_WALL_MS
}

/** §12.5 — standard Opus SKUs (not custom / finetune ids). */
export function isNonCustomOpusModel(model: string): boolean {
  const m = model.trim().toLowerCase()
  if (!m) return false
  if (/ft:|finetune|fine-tune|custom-deployment/i.test(model)) return false
  return m.includes('opus')
}

/** §12.4 — permanent disable when API rejects fast-mode beta */
export function isFastModeNotEnabledError(error: unknown): boolean {
  const msg = extractErrorMessage(error)
  return /fast mode is not enabled/i.test(msg)
}

function extractErrorMessage(error: unknown): string {
  if (error == null) return ''
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * Generic §12.1-style retry runner (non-stream callers).
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: {
    maxRetries?: number
    signal?: AbortSignal
    unattended?: boolean
    label?: string
    isRetryable?: (error: unknown) => boolean
    onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void
  },
): Promise<T> {
  const maxRetries = options.maxRetries ?? 10
  const unattended = options.unattended ?? isUnattendedRetryModeEnabled()
  const isRetryable = options.isRetryable ?? isRetryableStreamHttpError
  let unattendedStart: number | null = null
  let lastError: unknown

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn(attempt)
    } catch (e) {
      lastError = e
      if (isAbortLikeError(e)) throw e
      if (attempt >= maxRetries || !isRetryable(e)) throw e
      if (unattended) {
        if (unattendedStart == null) unattendedStart = Date.now()
        else if (unattendedWallClockExceeded(unattendedStart)) throw e
      }
      const delayMs = computeApiRetryDelayMs(attempt, {
        retryAfterMs: parseRetryAfterMsFromError(e),
        unattended,
      })
      options.onRetry?.({ attempt: attempt + 1, delayMs, error: e })
      if (options.label) {
        console.warn(
          `[withRetry] ${options.label} attempt ${attempt + 1}/${maxRetries + 1} failed, wait ${delayMs}ms`,
          extractErrorMessage(e),
        )
      }
      await sleepAbortableChunked(delayMs, options.signal, unattended, undefined)
    }
  }
  throw lastError
}

export async function sleepAbortableChunked(
  totalMs: number,
  signal: AbortSignal | undefined,
  useKeepAliveChunks: boolean,
  onKeepAlive?: () => void,
): Promise<void> {
  if (totalMs <= 0) return
  const chunk = useKeepAliveChunks ? API_RETRY_KEEPALIVE_CHUNK_MS : totalMs
  let remaining = totalMs
  while (remaining > 0) {
    const step = Math.min(chunk, remaining)
    await sleepAbortable(step, signal)
    remaining -= step
    if (remaining > 0) onKeepAlive?.()
  }
}

export function sleepAbortable(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (!signal) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }))
      return
    }
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(t)
      signal.removeEventListener('abort', onAbort)
      reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
