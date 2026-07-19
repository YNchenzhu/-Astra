/**
 * LoopSignal — structured signal that the agentic loop control flow observes.
 *
 * Replaces the late string-regex classifiers (`streamErrorClassification.ts`,
 * `contextLengthError.ts`) with one typed signal produced at the boundary
 * where the information is freshest (provider catch block, tool batch
 * guard) and consumed by the loop without re-parsing strings.
 *
 * upstream parity:
 *   - upstream's `getAssistantMessageFromError` (src/services/api/errors.ts)
 *     builds a typed `AssistantMessage` with `apiError` enum + `errorDetails`
 *     raw + content; the loop reads `msg.apiError === 'max_output_tokens'`
 *     etc. directly. We use a separate envelope (rather than tagging an
 *     `AssistantMessage`) because the streaming callback shape never
 *     produces an `AssistantMessage` at the error site — the error is
 *     reported via `onError` and the envelope sits alongside.
 *   - Granular `kind` enum mirrors upstream's `apiError` values plus our
 *     own provider-stream-specific kinds (we also surface `max_output_tokens`
 *     via stop_reason rather than as an SDK error class).
 *
 * Two domains share this taxonomy:
 *   - `stream:*` — provider stream / HTTP-level events. Produced by
 *     `classifyProviderError` in each provider's catch block.
 *   - `tool:*` — loop-level structured signals from the tool batch
 *     (repetition guard halt / warn). Produced by the tool executor.
 *
 * Migration plan (this module = Phase 1):
 *   - Phase 1 (this file): types + classifier + termination mapper.
 *     ZERO behaviour change. Nothing imports this module yet.
 *   - Phase 2: provider catch blocks call `classifyProviderError(err, …)`
 *     and emit the envelope to `callbacks.onLoopSignal?.(env)`. The
 *     existing `onError(string)` path stays intact for back-compat.
 *   - Phase 3: `agenticLoop/stream.ts` reads `state.streamSignal` (an
 *     envelope) instead of `state.withheldStreamError` (a string).
 *     `contextLengthExceededRef` becomes redundant: `streamSignal.kind
 *     === 'stream:prompt_too_long'`.
 *   - Phase 4: delete the regex tables in `streamErrorClassification.ts`
 *     and `contextLengthError.ts`.
 *   - Phase 5: `agenticToolBatch.ts` emits a tool-domain envelope
 *     alongside the existing `RepetitionAdvice` flow.
 */

import type { TerminationReason } from './queryTermination'

// ─────────────────────────────────────────────────────────────────────
// Kinds
// ─────────────────────────────────────────────────────────────────────

/**
 * Stream-domain kinds — produced at a provider's catch block when an
 * upstream HTTP / SDK call fails OR finishes with a recoverable
 * non-error status (e.g. `max_tokens`).
 */
export type LoopSignalStreamKind =
  /** HTTP 413 / Anthropic "prompt is too long" / OpenAI context_length_exceeded. */
  | 'stream:prompt_too_long'
  /** HTTP 400 "image exceeds maximum" / many-image dimension / PDF page limit. */
  | 'stream:image_too_large'
  /** Stop reason `max_tokens` or `length` — recoverable via output-budget escalation. */
  | 'stream:max_output_tokens'
  /** HTTP 529 / `overloaded_error` body — recoverable via Anthropic fallback model. */
  | 'stream:overloaded'
  /** HTTP 429 — recoverable via backoff. */
  | 'stream:rate_limit'
  /** HTTP 401 / 403 / `x-api-key` / OAuth revoked. */
  | 'stream:auth_failed'
  /**
   * Account / billing-side rejection — credit balance too low, payment
   * required, etc. upstream equivalent: `apiError: 'billing_error'`
   * (`CREDIT_BALANCE_TOO_LOW_ERROR_MESSAGE` path). Maps to `model_error`
   * for control-flow purposes, but kept as a distinct kind so UI can
   * render "top up your account" hints instead of a generic auth-error
   * banner.
   */
  | 'stream:billing_error'
  /** Other HTTP 400 (tool_use mismatch, invalid model, invalid_request_error body). */
  | 'stream:invalid_request'
  /** APIConnectionTimeoutError or watchdog-driven idle abort. */
  | 'stream:timeout'
  /** APIConnectionError (non-timeout), fetch failed, ECONNRESET/ECONNREFUSED. */
  | 'stream:connection'
  /**
   * Request was aborted by signal. NOT mapped to a TerminationReason
   * here — the loop already owns the abort path via `state.signal.aborted`
   * and distinguishes `aborted_streaming` from `aborted_tools` based on
   * which phase observed the abort.
   */
  | 'stream:aborted'
  /**
   * Model refused to respond — `stop_reason: 'refusal'` (Anthropic) /
   * `finish_reason: 'content_filter'` (OpenAI) / `finishReason: 'SAFETY'`
   * (Gemini). NOT produced by {@link classifyProviderError} — refusal
   * is a normal stream completion, not a thrown error. The stream
   * phase synthesises this envelope when {@link stopReasonMap} yields
   * `'refusal'`, mirroring upstream's `getErrorMessageIfRefusal` in
   * `services/api/errors.ts`. Maps to `model_error` (upstream
   * equivalent: `apiError: 'invalid_request'`).
   */
  | 'stream:refusal'
  /** Fallback when no narrower kind matches. Maps to `model_error`. */
  | 'stream:unknown'

/**
 * Tool-domain kinds — produced by the agentic tool batch when a
 * structured halt/warn signal short-circuits a tool call.
 */
export type LoopSignalToolKind =
  /** RepetitionGuard issued a `warn` advisory; tool still executes. */
  | 'tool:repetition_warn'
  /** RepetitionGuard issued a `halt` directive; tool short-circuits. */
  | 'tool:repetition_halt'

export type LoopSignalKind = LoopSignalStreamKind | LoopSignalToolKind

/** Identifiers the classifier accepts. `compat` covers anthropic-compat HTTP gateway + the openai-compat client. */
export type LoopSignalProvider =
  | 'anthropic'
  | 'openai'
  | 'gemini'
  | 'compat'
  | 'tool'

// ─────────────────────────────────────────────────────────────────────
// Envelope
// ─────────────────────────────────────────────────────────────────────

export interface LoopSignal {
  kind: LoopSignalKind
  /**
   * Human-readable original message. Used by UI display, telemetry, and
   * the few legitimate downstream parsers (e.g. `parsePromptTooLongTokenCounts`
   * peeks at the raw `"… 137500 tokens > 135000 …"` for reactive compact).
   *
   * For `tool:*` kinds, this is the advisory text the executor would
   * have surfaced as a synthetic tool_result content string.
   */
  rawMessage: string
  /** HTTP status when known (typed from APIError.status). */
  status?: number
  /** Server-suggested retry delay parsed from rate-limit response headers. */
  retryAfterMs?: number
  /** Provider where the signal originated. Useful for fallback routing. */
  provider?: LoopSignalProvider
  /**
   * Free-form provider-specific details preserved for downstream parsers.
   * Examples:
   *   - `{actualTokens, limitTokens}` parsed from a PTL message body.
   *   - `{consecutiveCount, toolName}` for `tool:repetition_*`.
   */
  details?: Record<string, unknown>
}

// ─────────────────────────────────────────────────────────────────────
// TerminationReason mapping
// ─────────────────────────────────────────────────────────────────────

/**
 * Map a LoopSignal kind to the TerminationReason the loop should report
 * IF this signal survives the recovery layers (reactive compact, overload
 * fallback, max-output recovery, retry backoff, image strip-retry).
 *
 * Returns `null` for signals that:
 *   - the loop owns through a different code path (e.g. `stream:aborted`
 *     is routed to `aborted_streaming`/`aborted_tools` by the loop, not
 *     by this mapper);
 *   - never terminate the loop on their own (`tool:repetition_warn`,
 *     `tool:repetition_halt`).
 *
 * upstream equivalent: the routing inside `query.ts` that decides which
 * `Terminal.reason` to return for each withheld-error path.
 */
export function loopSignalToTerminationReason(
  kind: LoopSignalKind,
): TerminationReason | null {
  switch (kind) {
    case 'stream:prompt_too_long':
      return 'prompt_too_long'
    case 'stream:image_too_large':
      return 'image_error'
    // After all recovery paths exhaust, these collapse into `model_error`.
    // The loop's recovery layers consume them earlier; reaching termination
    // means recovery was either disabled or itself failed. Refusal is in
    // this bucket too — upstream tags it `apiError: 'invalid_request'`
    // which routes to the same `model_error` Terminal.
    case 'stream:max_output_tokens':
    case 'stream:overloaded':
    case 'stream:rate_limit':
    case 'stream:auth_failed':
    case 'stream:billing_error':
    case 'stream:invalid_request':
    case 'stream:timeout':
    case 'stream:connection':
    case 'stream:refusal':
    case 'stream:unknown':
      return 'model_error'
    // Loop owns these via its own state machine — don't terminate here.
    case 'stream:aborted':
    case 'tool:repetition_warn':
    case 'tool:repetition_halt':
      return null
  }
}

// ─────────────────────────────────────────────────────────────────────
// Classifier
// ─────────────────────────────────────────────────────────────────────

/**
 * Duck-typed view of an SDK error / fetch error / plain Error.
 * Avoids importing `@anthropic-ai/sdk` / `openai` SDK classes so this
 * module stays pure and cheaply testable.
 *
 * Real producers populate the relevant fields:
 *   - Anthropic SDK `APIError`: `status`, `message`, optional `headers.get`.
 *   - OpenAI SDK `APIError`:    `status`, `message`, optional `code`.
 *   - Gemini SDK errors:        `status` (HTTP status) + `message`.
 *   - Fetch / HTTP layer:       `status`, `statusCode`, or nested `response.status`.
 */
interface ErrorShape {
  status?: number
  statusCode?: number
  message?: string
  code?: string
  response?: { status?: number; headers?: { get?: (k: string) => string | null } }
  headers?: { get?: (k: string) => string | null }
  error?: { message?: string; type?: string; code?: string }
  name?: string
}

function readStatus(err: ErrorShape): number | undefined {
  if (typeof err.status === 'number') return err.status
  if (typeof err.statusCode === 'number') return err.statusCode
  if (typeof err.response?.status === 'number') return err.response.status
  return undefined
}

function readMessage(err: ErrorShape, fallback: unknown): string {
  // Prefer top-level .message (Error / SDK APIError).
  if (typeof err.message === 'string' && err.message.trim().length > 0) {
    return err.message
  }
  // Some SDKs nest the human-readable message under `.error.message`.
  if (typeof err.error?.message === 'string' && err.error.message.trim().length > 0) {
    return err.error.message
  }
  if (typeof fallback === 'string' && fallback.trim().length > 0) return fallback
  try {
    return String(fallback ?? '')
  } catch {
    return ''
  }
}

function parseRetryAfter(err: ErrorShape): number | undefined {
  const h = err.headers?.get?.('retry-after') ?? err.response?.headers?.get?.('retry-after')
  if (!h) return undefined
  // Either "120" (seconds) or an HTTP-date. We only honour the integer form.
  const n = Number(h.trim())
  if (Number.isFinite(n) && n >= 0) return Math.round(n * 1000)
  return undefined
}

/**
 * Substring batteries. Kept as plain `lower.includes(...)` checks (not
 * regex) so they're cheap, predictable, and trivial to extend when a
 * new provider surfaces a new wording. Conjunctive checks (must include
 * BOTH X and Y) keep false-positive rates low.
 *
 * Order of evaluation in {@link classifyProviderError}:
 *   1. abort        — must run first (abort during stream looks like a status-less error)
 *   2. timeout      — typed via APIConnectionTimeoutError naming + message hint
 *   3. status code  — typed signal, most reliable when present
 *   4. message-only substring fallbacks — last-resort for status-less errors
 */

function looksLikePromptTooLong(lower: string): boolean {
  return (
    lower.includes('prompt is too long') ||
    lower.includes('prompt too long') ||
    lower.includes('prompt_too_long') ||
    lower.includes('context_length_exceeded') ||
    lower.includes('context_length') ||
    lower.includes('context length') ||
    lower.includes('context window') ||
    lower.includes('maximum context') ||
    lower.includes('max context') ||
    lower.includes('maximum number of tokens') ||
    lower.includes('exceeds the context') ||
    lower.includes('too many tokens') ||
    lower.includes('token limit') ||
    lower.includes('input is too long') ||
    lower.includes('request too large') ||
    lower.includes('payload too large') ||
    lower.includes('string_above_max_length') ||
    // Canonical post-compact wording emitted by the loop itself when
    // reactive compact fails. The phrasing is distinctive enough that
    // we accept "prompt or context" + "too large" as a sufficient pair.
    (lower.includes('prompt or context') && lower.includes('too large')) ||
    // Conjunctive: "too large" alone matches image errors too — require token.
    (lower.includes('too large') && lower.includes('token'))
  )
}

function looksLikeImageTooLarge(lower: string): boolean {
  // Conjunctive checks only — bare "image" is too broad and would
  // mis-classify rate-limit messages that mention attached images.
  //
  // The "image + exceed + maximum" triple (with `exceed` allowed to
  // appear with arbitrary text between it and `maximum`, e.g.
  // "exceeds 5 MB maximum") covers Anthropic's actual 400 wording —
  // `streamErrorClassification.ts` matched the same with
  // `/image.*(too large|exceeds? maximum|...)/i`.
  return (
    (lower.includes('image') &&
      (lower.includes('size limit') ||
        lower.includes('too large') ||
        lower.includes('could not be decoded') ||
        lower.includes('could not be processed') ||
        (lower.includes('exceed') && lower.includes('maximum')) ||
        (lower.includes('dimensions') && lower.includes('exceed')))) ||
    (lower.includes('media') && lower.includes('size error')) ||
    (lower.includes('image') && lower.includes('size error')) ||
    (lower.includes('unsupported') &&
      lower.includes('image') &&
      (lower.includes('format') ||
        lower.includes('type') ||
        lower.includes('encoding'))) ||
    (lower.includes('invalid') && lower.includes('image data')) ||
    (lower.includes('attached') &&
      lower.includes('media') &&
      lower.includes('could not be loaded')) ||
    // PDF page limit — Anthropic wording, treat as image_too_large for
    // recovery routing (upstream groups these under media-strip-retry).
    /maximum of \d+ pdf pages/.test(lower)
  )
}

function looksLikeAbort(lower: string, name?: string): boolean {
  if (name === 'AbortError') return true
  return (
    lower === 'request was aborted.' ||
    lower === 'request was aborted' ||
    lower.includes('the operation was aborted') ||
    lower.includes('aborterror')
  )
}

function looksLikeTimeout(lower: string, name?: string): boolean {
  if (name === 'APIConnectionTimeoutError') return true
  return (
    lower.includes('etimedout') ||
    lower.includes('timed out') ||
    lower.includes('timeout')
  )
}

function looksLikeConnection(lower: string, name?: string): boolean {
  if (name === 'APIConnectionError') return true
  return (
    lower.includes('econnreset') ||
    lower.includes('econnrefused') ||
    lower.includes('enotfound') ||
    lower.includes('fetch failed') ||
    lower.includes('socket hang up') ||
    lower.includes('network error')
  )
}

function looksLikeBillingError(lower: string): boolean {
  // Conjunctive: bare "credit" is too broad (rate-limit messages often
  // mention "credits"). Anthropic's wording is "Your credit balance is
  // too low" — require all three tokens. Other providers' billing
  // signals (payment_required, insufficient_quota body) covered too.
  return (
    (lower.includes('credit') && lower.includes('balance') && lower.includes('too low')) ||
    lower.includes('payment required') ||
    lower.includes('insufficient_quota') ||
    lower.includes('insufficient quota') ||
    lower.includes('billing')
  )
}

/**
 * Build a {@link LoopSignal} from a provider error.
 *
 * **Producers MUST call this inside the provider catch block** — before
 * the error is stringified or wrapped. Calling it later (on
 * `String(error)`) loses the typed status code and class-name hints
 * the function relies on for non-regex routing.
 *
 * Contract:
 *   - Returns a non-null `LoopSignal` for every input. `kind` falls back
 *     to `stream:unknown` when nothing else matches.
 *   - The decision tree is **type-first, substring-last**: status codes
 *     and error class names are checked before any message inspection.
 *     The substring fallbacks are deliberately narrow (conjunctive
 *     "must include X and Y") to avoid the false-positive cascade that
 *     `streamErrorClassification.IMAGE_ERROR_PATTERNS` (regex with bare
 *     `image.*`) suffered from.
 *   - HTTP 400 with body substrings is treated as the most likely
 *     classification source for both image and PTL errors — providers
 *     return 400 with rich messages here (vs 413 which Vertex uses for
 *     PTL specifically).
 */
export function classifyProviderError(
  error: unknown,
  provider: LoopSignalProvider,
): LoopSignal {
  // Null / undefined → unknown (caller should never pass these but we
  // tolerate it because some upstream paths build envelopes from
  // synthetic events).
  if (error == null) {
    return { kind: 'stream:unknown', rawMessage: '', provider }
  }

  // Plain string error — common in older callbacks. We can still classify
  // via the substring batteries, but lose status / class signals.
  if (typeof error === 'string') {
    return classifyFromMessageOnly(error, provider)
  }

  // Non-object, non-string — coerce and fall through.
  if (typeof error !== 'object') {
    return classifyFromMessageOnly(String(error), provider)
  }

  const err = error as ErrorShape
  const message = readMessage(err, error)
  const lower = message.toLowerCase()
  const status = readStatus(err)
  const errName = (err.name ?? (error as object).constructor?.name) as string | undefined

  // ── 1. Abort: must precede every other branch.
  // Aborted requests often surface as a status-less error with the
  // generic "Request was aborted." message.
  if (looksLikeAbort(lower, errName)) {
    return { kind: 'stream:aborted', rawMessage: message, provider, status }
  }

  // ── 2. Class-name based hints (timeout / connection) — these can
  // arrive WITH or WITHOUT a status code; check the class name first
  // because the SDK explicitly names them.
  if (looksLikeTimeout(lower, errName)) {
    return { kind: 'stream:timeout', rawMessage: message, provider, status }
  }
  if (errName === 'APIConnectionError') {
    return { kind: 'stream:connection', rawMessage: message, provider, status }
  }

  // ── 3. Status-code routing — most reliable when we have it.
  if (typeof status === 'number') {
    if (status === 413) {
      return { kind: 'stream:prompt_too_long', rawMessage: message, provider, status }
    }
    if (status === 401 || status === 403) {
      return { kind: 'stream:auth_failed', rawMessage: message, provider, status }
    }
    if (status === 429) {
      const retry = parseRetryAfter(err)
      return {
        kind: 'stream:rate_limit',
        rawMessage: message,
        provider,
        status,
        ...(retry !== undefined ? { retryAfterMs: retry } : {}),
      }
    }
    if (status === 529) {
      return { kind: 'stream:overloaded', rawMessage: message, provider, status }
    }
    if (status === 400) {
      // Anthropic returns 400 for PTL on direct API (Vertex uses 413).
      if (looksLikePromptTooLong(lower)) {
        return { kind: 'stream:prompt_too_long', rawMessage: message, provider, status }
      }
      // 400 + image substring → image_too_large.
      if (looksLikeImageTooLarge(lower)) {
        return { kind: 'stream:image_too_large', rawMessage: message, provider, status }
      }
      // 400 + credit/billing wording → billing_error (Anthropic surfaces
      // "Credit balance is too low" with a 400 — not 402).
      if (looksLikeBillingError(lower)) {
        return { kind: 'stream:billing_error', rawMessage: message, provider, status }
      }
      return { kind: 'stream:invalid_request', rawMessage: message, provider, status }
    }
    if (status >= 500 && status < 600) {
      // 5xx are server-side; treat as transient connection-ish.
      // Anthropic 529 is already caught above as overloaded.
      return { kind: 'stream:connection', rawMessage: message, provider, status }
    }
    if (status >= 400 && status < 500) {
      return { kind: 'stream:invalid_request', rawMessage: message, provider, status }
    }
  }

  // ── 4. Message-only substring fallbacks (status missing).
  if (looksLikePromptTooLong(lower)) {
    return { kind: 'stream:prompt_too_long', rawMessage: message, provider, status }
  }
  if (looksLikeImageTooLarge(lower)) {
    return { kind: 'stream:image_too_large', rawMessage: message, provider, status }
  }
  if (looksLikeConnection(lower, errName)) {
    return { kind: 'stream:connection', rawMessage: message, provider, status }
  }
  if (lower.includes('overload')) {
    return { kind: 'stream:overloaded', rawMessage: message, provider, status }
  }
  if (lower.includes('rate limit') || lower.includes('too many requests')) {
    return { kind: 'stream:rate_limit', rawMessage: message, provider, status }
  }
  if (
    lower.includes('x-api-key') ||
    lower.includes('invalid api key') ||
    lower.includes('unauthorized') ||
    lower.includes('unauthorised') ||
    lower.includes('oauth token has been revoked')
  ) {
    return { kind: 'stream:auth_failed', rawMessage: message, provider, status }
  }
  // Billing kept AFTER auth — both 401/403 are auth-shaped but
  // a 400 with "credit balance too low" wording (Anthropic-specific)
  // is billing.
  if (looksLikeBillingError(lower)) {
    return { kind: 'stream:billing_error', rawMessage: message, provider, status }
  }

  return { kind: 'stream:unknown', rawMessage: message, provider, status }
}

function classifyFromMessageOnly(raw: string, provider: LoopSignalProvider): LoopSignal {
  const lower = raw.toLowerCase()
  if (looksLikeAbort(lower, undefined)) {
    return { kind: 'stream:aborted', rawMessage: raw, provider }
  }
  if (looksLikeTimeout(lower, undefined)) {
    return { kind: 'stream:timeout', rawMessage: raw, provider }
  }
  if (looksLikePromptTooLong(lower)) {
    return { kind: 'stream:prompt_too_long', rawMessage: raw, provider }
  }
  if (looksLikeImageTooLarge(lower)) {
    return { kind: 'stream:image_too_large', rawMessage: raw, provider }
  }
  if (looksLikeConnection(lower, undefined)) {
    return { kind: 'stream:connection', rawMessage: raw, provider }
  }
  if (lower.includes('overload')) {
    return { kind: 'stream:overloaded', rawMessage: raw, provider }
  }
  if (lower.includes('rate limit') || lower.includes('too many requests')) {
    return { kind: 'stream:rate_limit', rawMessage: raw, provider }
  }
  if (
    lower.includes('x-api-key') ||
    lower.includes('invalid api key') ||
    lower.includes('unauthorized') ||
    lower.includes('unauthorised') ||
    lower.includes('oauth token has been revoked')
  ) {
    return { kind: 'stream:auth_failed', rawMessage: raw, provider }
  }
  if (looksLikeBillingError(lower)) {
    return { kind: 'stream:billing_error', rawMessage: raw, provider }
  }
  return { kind: 'stream:unknown', rawMessage: raw, provider }
}

// ─────────────────────────────────────────────────────────────────────
// Convenience predicates (parity with existing call-site idioms)
// ─────────────────────────────────────────────────────────────────────

/**
 * True when this signal indicates the request was rejected because the
 * prompt / context exceeds limits. Parallels `isContextLengthExceededError`
 * in `contextLengthError.ts` but operates on the typed envelope.
 */
export function isPromptTooLongSignal(s: LoopSignal | null | undefined): boolean {
  return s?.kind === 'stream:prompt_too_long'
}

/**
 * True when this signal indicates an image / media size problem that
 * the image-strip-retry layer can recover. Parallels
 * `isWithheldMediaSizeError` in `streamErrorClassification.ts`.
 */
export function isImageTooLargeSignal(s: LoopSignal | null | undefined): boolean {
  return s?.kind === 'stream:image_too_large'
}

/**
 * True when stream-domain recovery layers should be SKIPPED because the
 * signal originates from a non-recoverable cause (abort / auth /
 * invalid_request) or recovery exhaustion.
 */
export function isTerminalStreamSignal(s: LoopSignal | null | undefined): boolean {
  if (!s) return false
  // `stream:aborted` is handled by the loop's abort path, not as a
  // terminal stream error.
  if (s.kind === 'stream:aborted') return false
  return loopSignalToTerminationReason(s.kind) !== null
}
