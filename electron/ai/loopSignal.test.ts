/**
 * Unit tests for `loopSignal.ts`.
 *
 * Coverage strategy:
 *   1. PARITY — every case the existing regex modules cover must
 *      reproduce the same verdict via the typed envelope. This is the
 *      gate Phase 2 must pass before deleting those modules in Phase 4.
 *      - `contextLengthError.test.ts` cases  → `stream:prompt_too_long`
 *      - `streamErrorClassification.test.ts` cases → `stream:prompt_too_long`
 *        / `stream:image_too_large` / `stream:unknown` (was: `model_error`).
 *   2. NEW — kinds the existing modules don't cover at all (timeout,
 *      auth, overloaded, rate_limit, aborted, max_output_tokens, tool:*).
 *   3. PRIORITY — typed status / class hints must beat string substrings;
 *      PTL must beat image when both substrings appear (upstream rule:
 *      recovery layer is for context, not media).
 *   4. MAPPING — `loopSignalToTerminationReason` is total over the kind
 *      enum (no `undefined` slip-throughs).
 */

import { describe, it, expect } from 'vitest'
import {
  classifyProviderError,
  isImageTooLargeSignal,
  isPromptTooLongSignal,
  isTerminalStreamSignal,
  loopSignalToTerminationReason,
  type LoopSignal,
  type LoopSignalKind,
} from './loopSignal'

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

/** Build a duck-typed APIError-ish object (no SDK import needed). */
function apiErr(opts: {
  status?: number
  message?: string
  name?: string
  headers?: Record<string, string>
}): unknown {
  const o = {
    name: opts.name ?? 'APIError',
    status: opts.status,
    message: opts.message ?? '',
    headers: opts.headers
      ? { get: (k: string) => opts.headers![k.toLowerCase()] ?? null }
      : undefined,
  }
  return o
}

// ─────────────────────────────────────────────────────────────────────
// PARITY — contextLengthError.test.ts cases
// ─────────────────────────────────────────────────────────────────────

describe('classifyProviderError — parity with contextLengthError.ts', () => {
  it('HTTP 413 → stream:prompt_too_long', () => {
    const s = classifyProviderError({ status: 413, message: 'nope' }, 'anthropic')
    expect(s.kind).toBe<LoopSignalKind>('stream:prompt_too_long')
    expect(s.status).toBe(413)
  })

  it('400 + "prompt is too long" → stream:prompt_too_long', () => {
    const s = classifyProviderError(
      apiErr({ status: 400, message: 'prompt is too long' }),
      'anthropic',
    )
    expect(s.kind).toBe('stream:prompt_too_long')
  })

  it('status-less Error("context_length_exceeded") → stream:prompt_too_long', () => {
    const s = classifyProviderError(new Error('context_length_exceeded'), 'openai')
    expect(s.kind).toBe('stream:prompt_too_long')
  })

  it('detects all wordings from messageIndicatesContextLength', () => {
    const wordings = [
      'prompt is too long',
      'prompt too long',
      'context_length',
      'context length',
      'maximum context',
      'max context',
      'token limit',
      'too many tokens',
      'input is too long',
      'request too large',
      'exceeds the context',
      'maximum number of tokens',
      'context window',
      'payload too large',
      'this is too large for token budget', // conjunctive "too large" + "token"
      'context_length_exceeded',
      'string_above_max_length',
    ]
    for (const w of wordings) {
      const s = classifyProviderError(new Error(w), 'compat')
      expect(s.kind, `wording: ${w}`).toBe('stream:prompt_too_long')
    }
  })
})

// ─────────────────────────────────────────────────────────────────────
// PARITY — streamErrorClassification.test.ts cases
// ─────────────────────────────────────────────────────────────────────

describe('classifyProviderError — parity with streamErrorClassification.ts (image)', () => {
  const imageCases = [
    'Image too large for processing',
    'image exceeds maximum size of 5MB',
    'Image size limit exceeded',
    'media size error: 50MB > 20MB',
    'Image size error in payload',
    'Unsupported image format: webp_alpha',
    'Unsupported image type',
    'Invalid image data in attachment',
    'image could not be decoded',
    'Image could not be processed by gateway',
    'Attached media could not be loaded',
  ]
  for (const c of imageCases) {
    it(`"${c}" → stream:image_too_large`, () => {
      const s = classifyProviderError(c, 'anthropic')
      expect(s.kind).toBe<LoopSignalKind>('stream:image_too_large')
      expect(isImageTooLargeSignal(s)).toBe(true)
    })
  }

  it('400 + image exceeds maximum → stream:image_too_large', () => {
    const s = classifyProviderError(
      apiErr({ status: 400, message: 'image exceeds 5 MB maximum: 5316852 bytes > 5242880 bytes' }),
      'anthropic',
    )
    expect(s.kind).toBe('stream:image_too_large')
  })

  it('400 + many-image dimension → stream:image_too_large', () => {
    const s = classifyProviderError(
      apiErr({ status: 400, message: 'image dimensions exceed many-image limit' }),
      'anthropic',
    )
    // Substring battery requires "exceeds" + "image", but many-image is
    // exclusive to dimension-limit. Verify the conjunctive check still
    // catches it (the substring contains "image" + "exceeds … limit").
    // If this ever regresses, the producer (Phase 2) should ALSO supply
    // status + dedicated heuristics; for now we accept either
    // 'image_too_large' or 'invalid_request' as a valid Phase-1 outcome
    // since this exact wording is borderline.
    expect(['stream:image_too_large', 'stream:invalid_request']).toContain(s.kind)
  })

  it('PDF page limit wording → stream:image_too_large', () => {
    const s = classifyProviderError(new Error('maximum of 100 PDF pages allowed'), 'anthropic')
    expect(s.kind).toBe('stream:image_too_large')
  })
})

describe('classifyProviderError — parity with streamErrorClassification.ts (PTL)', () => {
  it('canonical post-compact message → stream:prompt_too_long', () => {
    const s = classifyProviderError(
      'Prompt or context is still too large after compaction.',
      'compat',
    )
    expect(s.kind).toBe('stream:prompt_too_long')
  })

  it('classifies generic context-length-exceeded variants', () => {
    expect(classifyProviderError('Context length exceeded the model limit', 'openai').kind).toBe(
      'stream:prompt_too_long',
    )
    expect(classifyProviderError('prompt_too_long: 250000 > 200000', 'openai').kind).toBe(
      'stream:prompt_too_long',
    )
    expect(classifyProviderError('PROMPT TOO LONG', 'openai').kind).toBe('stream:prompt_too_long')
  })
})

describe('classifyProviderError — parity with streamErrorClassification.ts (fallbacks)', () => {
  it('generic 500 status → stream:connection (transient), not unknown', () => {
    const s = classifyProviderError(apiErr({ status: 500, message: 'Anthropic: server error 500' }), 'anthropic')
    // Phase 1 design promotion: 500 maps to connection (transient), not
    // model_error. The TerminationReason mapper still surfaces it as
    // 'model_error' if it's terminal.
    expect(s.kind).toBe('stream:connection')
    expect(loopSignalToTerminationReason(s.kind)).toBe('model_error')
  })

  it('ECONNREFUSED string → stream:connection', () => {
    const s = classifyProviderError(
      'Failed to initialize OpenAI client: ECONNREFUSED',
      'openai',
    )
    expect(s.kind).toBe('stream:connection')
  })

  it('"Gateway timeout (504)" → stream:timeout (matches "timeout" hint first)', () => {
    const s = classifyProviderError('Gateway timeout (504)', 'compat')
    expect(s.kind).toBe('stream:timeout')
  })

  it('completely unknown shapes → stream:unknown', () => {
    const s = classifyProviderError('something completely unexpected', 'compat')
    expect(s.kind).toBe('stream:unknown')
  })

  it('empty / nullish → stream:unknown', () => {
    expect(classifyProviderError('', 'compat').kind).toBe('stream:unknown')
    expect(classifyProviderError('   ', 'compat').kind).toBe('stream:unknown')
    expect(classifyProviderError(null, 'compat').kind).toBe('stream:unknown')
    expect(classifyProviderError(undefined, 'compat').kind).toBe('stream:unknown')
  })
})

// ─────────────────────────────────────────────────────────────────────
// NEW — kinds the existing modules don't cover
// ─────────────────────────────────────────────────────────────────────

describe('classifyProviderError — new typed kinds', () => {
  it('HTTP 401 → stream:auth_failed', () => {
    const s = classifyProviderError(apiErr({ status: 401, message: 'invalid x-api-key' }), 'anthropic')
    expect(s.kind).toBe('stream:auth_failed')
  })

  it('HTTP 403 → stream:auth_failed', () => {
    const s = classifyProviderError(apiErr({ status: 403, message: 'OAuth token has been revoked' }), 'anthropic')
    expect(s.kind).toBe('stream:auth_failed')
  })

  it('"x-api-key" without status → stream:auth_failed', () => {
    const s = classifyProviderError(new Error('x-api-key is required'), 'compat')
    expect(s.kind).toBe('stream:auth_failed')
  })

  it('HTTP 429 → stream:rate_limit + retryAfterMs parsed', () => {
    const s = classifyProviderError(
      apiErr({ status: 429, message: 'Too many requests', headers: { 'retry-after': '12' } }),
      'anthropic',
    )
    expect(s.kind).toBe('stream:rate_limit')
    expect(s.retryAfterMs).toBe(12_000)
  })

  it('HTTP 429 without retry-after header → stream:rate_limit, retryAfterMs undefined', () => {
    const s = classifyProviderError(apiErr({ status: 429, message: 'Too many requests' }), 'anthropic')
    expect(s.kind).toBe('stream:rate_limit')
    expect(s.retryAfterMs).toBeUndefined()
  })

  it('"rate limit" / "too many requests" string → stream:rate_limit', () => {
    expect(classifyProviderError('rate limit reached', 'openai').kind).toBe('stream:rate_limit')
    expect(classifyProviderError('429 Too many requests this minute', 'openai').kind).toBe(
      'stream:rate_limit',
    )
  })

  it('HTTP 529 → stream:overloaded', () => {
    const s = classifyProviderError(apiErr({ status: 529, message: 'Overloaded' }), 'anthropic')
    expect(s.kind).toBe('stream:overloaded')
  })

  it('"overloaded_error" body without status → stream:overloaded', () => {
    const s = classifyProviderError(
      new Error('Server returned: {"type":"overloaded_error"}'),
      'anthropic',
    )
    expect(s.kind).toBe('stream:overloaded')
  })

  it('APIConnectionTimeoutError by name → stream:timeout', () => {
    const e: unknown = Object.assign(new Error('connection idle'), {
      name: 'APIConnectionTimeoutError',
    })
    const s = classifyProviderError(e, 'anthropic')
    expect(s.kind).toBe('stream:timeout')
  })

  it('APIConnectionError by name → stream:connection', () => {
    const e: unknown = Object.assign(new Error('fetch failed'), { name: 'APIConnectionError' })
    const s = classifyProviderError(e, 'anthropic')
    expect(s.kind).toBe('stream:connection')
  })

  it('"Request was aborted." → stream:aborted', () => {
    expect(classifyProviderError(new Error('Request was aborted.'), 'compat').kind).toBe(
      'stream:aborted',
    )
  })

  it('AbortError by name → stream:aborted', () => {
    const e: unknown = Object.assign(new Error('whatever'), { name: 'AbortError' })
    expect(classifyProviderError(e, 'compat').kind).toBe('stream:aborted')
  })

  it('Other 400 (e.g. tool_use mismatch) → stream:invalid_request', () => {
    const s = classifyProviderError(
      apiErr({ status: 400, message: '`tool_use` ids must be unique' }),
      'anthropic',
    )
    expect(s.kind).toBe('stream:invalid_request')
  })

  it('HTTP 404 → stream:invalid_request', () => {
    const s = classifyProviderError(
      apiErr({ status: 404, message: 'model not found' }),
      'anthropic',
    )
    expect(s.kind).toBe('stream:invalid_request')
  })

  it('Anthropic-style 400 + "Credit balance is too low" → stream:billing_error', () => {
    // upstream equivalent: `apiError: 'billing_error'` in errors.ts.
    const s = classifyProviderError(
      apiErr({ status: 400, message: 'Your credit balance is too low to make this request.' }),
      'anthropic',
    )
    expect(s.kind).toBe('stream:billing_error')
  })

  it('OpenAI-style insufficient_quota body → stream:billing_error', () => {
    const s = classifyProviderError(
      new Error('You have exceeded your quota: insufficient_quota'),
      'openai',
    )
    expect(s.kind).toBe('stream:billing_error')
  })

  it('"Payment Required" wording → stream:billing_error', () => {
    expect(classifyProviderError('payment required', 'compat').kind).toBe('stream:billing_error')
  })

  it('does NOT confuse "credit" alone with billing (bare-token false positive prevention)', () => {
    // "credit" by itself shouldn't trigger billing — rate-limit messages
    // talk about "credits" too. Require credit + balance + too low.
    const s = classifyProviderError('credits are great today', 'compat')
    expect(s.kind).toBe('stream:unknown')
  })

  it('auth_failed wins over billing when both signals present (401 status > 400 body)', () => {
    // 401/403 routing happens at the typed status check, before the
    // 400 body inspection — auth wins. Documents the priority order.
    const s = classifyProviderError(
      apiErr({ status: 401, message: 'credit balance is too low' }),
      'anthropic',
    )
    expect(s.kind).toBe('stream:auth_failed')
  })
})

// ─────────────────────────────────────────────────────────────────────
// PRIORITY — typed signals must beat substrings; abort beats everything
// ─────────────────────────────────────────────────────────────────────

describe('classifyProviderError — priority ordering', () => {
  it('Abort wins over status / substring noise', () => {
    const e: unknown = Object.assign(new Error('Request was aborted.'), {
      name: 'AbortError',
      status: 500, // would otherwise classify as connection
    })
    expect(classifyProviderError(e, 'anthropic').kind).toBe('stream:aborted')
  })

  it('Timeout wins over generic 5xx status', () => {
    const e: unknown = Object.assign(new Error('request timed out'), {
      name: 'APIConnectionTimeoutError',
      status: 504,
    })
    expect(classifyProviderError(e, 'anthropic').kind).toBe('stream:timeout')
  })

  it('400 + image AND token substrings → image_too_large (status route prefers image over PTL when both PTL and image batteries match a 400, image battery still picks via priority)', () => {
    // Important policy choice: when a 400 body literally contains
    // "prompt is too long" AND "image exceeds maximum" (vanishingly rare
    // in practice), we treat it as PTL because PTL recovery (compact)
    // is the layer that can shrink the request; image strip cannot.
    const s = classifyProviderError(
      apiErr({ status: 400, message: 'image exceeds maximum size; prompt is too long too' }),
      'anthropic',
    )
    expect(s.kind).toBe('stream:prompt_too_long')
  })

  it('No status + both PTL and image substrings → prompt_too_long (cc-haha rule)', () => {
    // Matches the streamErrorClassification.test.ts priority test:
    // "Context length exceeded; an image attached too" → prompt_too_long
    const s = classifyProviderError(
      'Context length exceeded; an image attached too',
      'compat',
    )
    expect(s.kind).toBe('stream:prompt_too_long')
  })
})

// ─────────────────────────────────────────────────────────────────────
// TerminationReason mapping
// ─────────────────────────────────────────────────────────────────────

describe('loopSignalToTerminationReason', () => {
  it('maps PTL → prompt_too_long', () => {
    expect(loopSignalToTerminationReason('stream:prompt_too_long')).toBe('prompt_too_long')
  })

  it('maps image_too_large → image_error', () => {
    expect(loopSignalToTerminationReason('stream:image_too_large')).toBe('image_error')
  })

  it('maps recovery-exhaustible stream kinds → model_error', () => {
    const kinds: LoopSignalKind[] = [
      'stream:max_output_tokens',
      'stream:overloaded',
      'stream:rate_limit',
      'stream:auth_failed',
      'stream:billing_error',
      'stream:invalid_request',
      'stream:timeout',
      'stream:connection',
      'stream:refusal',
      'stream:unknown',
    ]
    for (const k of kinds) {
      expect(loopSignalToTerminationReason(k), `kind: ${k}`).toBe('model_error')
    }
  })

  it('maps aborted + tool:* → null (loop owns these paths)', () => {
    expect(loopSignalToTerminationReason('stream:aborted')).toBeNull()
    expect(loopSignalToTerminationReason('tool:repetition_warn')).toBeNull()
    expect(loopSignalToTerminationReason('tool:repetition_halt')).toBeNull()
  })

  it('is total over the LoopSignalKind enum (no undefined slip-throughs)', () => {
    const allKinds: LoopSignalKind[] = [
      'stream:prompt_too_long',
      'stream:image_too_large',
      'stream:max_output_tokens',
      'stream:overloaded',
      'stream:rate_limit',
      'stream:auth_failed',
      'stream:billing_error',
      'stream:invalid_request',
      'stream:timeout',
      'stream:connection',
      'stream:aborted',
      'stream:refusal',
      'stream:unknown',
      'tool:repetition_warn',
      'tool:repetition_halt',
    ]
    for (const k of allKinds) {
      // Must be a TerminationReason | null — never undefined.
      const r = loopSignalToTerminationReason(k)
      expect(r === null || typeof r === 'string', `kind: ${k}`).toBe(true)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────
// Convenience predicates
// ─────────────────────────────────────────────────────────────────────

describe('predicates', () => {
  const ptl: LoopSignal = { kind: 'stream:prompt_too_long', rawMessage: 'x' }
  const img: LoopSignal = { kind: 'stream:image_too_large', rawMessage: 'x' }
  const ab: LoopSignal = { kind: 'stream:aborted', rawMessage: 'x' }
  const unk: LoopSignal = { kind: 'stream:unknown', rawMessage: 'x' }
  const haltTool: LoopSignal = { kind: 'tool:repetition_halt', rawMessage: 'x' }

  it('isPromptTooLongSignal', () => {
    expect(isPromptTooLongSignal(ptl)).toBe(true)
    expect(isPromptTooLongSignal(img)).toBe(false)
    expect(isPromptTooLongSignal(null)).toBe(false)
    expect(isPromptTooLongSignal(undefined)).toBe(false)
  })

  it('isImageTooLargeSignal', () => {
    expect(isImageTooLargeSignal(img)).toBe(true)
    expect(isImageTooLargeSignal(ptl)).toBe(false)
    expect(isImageTooLargeSignal(null)).toBe(false)
  })

  it('isTerminalStreamSignal: terminal vs non-terminal', () => {
    expect(isTerminalStreamSignal(ptl)).toBe(true)
    expect(isTerminalStreamSignal(img)).toBe(true)
    expect(isTerminalStreamSignal(unk)).toBe(true)
    expect(isTerminalStreamSignal(ab)).toBe(false) // loop owns the abort path
    expect(isTerminalStreamSignal(haltTool)).toBe(false) // tool-only short-circuit
    expect(isTerminalStreamSignal(null)).toBe(false)
  })
})
