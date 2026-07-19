/**
 * Unit tests for `loopSignalEmit.emitProviderErrorSignal`.
 *
 * The helper is the single producer of `LoopSignal` envelopes at every
 * provider catch boundary. Its contract:
 *   1. ALWAYS classifies — never returns null/undefined for `signal`.
 *   2. ALWAYS invokes `onLoopSignal` when present (swallowing thrown
 *      consumers — never bubbles into the provider's error flow).
 *   3. Mirrors `signal.kind === 'stream:prompt_too_long'` to the legacy
 *      `contextLengthExceededRef.value` (only when ref is supplied).
 *      Non-PTL kinds DO NOT touch the ref.
 *   4. Returns `{signal, isPromptTooLong}` so producers can both:
 *        - early-return (PTL → handled by reactive compact)
 *        - inspect `signal.kind` for telemetry / branching
 */

import { describe, it, expect, vi } from 'vitest'
import { emitProviderErrorSignal } from './loopSignalEmit'
import type { StreamCallbacks } from './client'

/** Builds a minimal StreamCallbacks; tests selectively override `onLoopSignal`. */
function makeCallbacks(overrides?: Partial<StreamCallbacks>): StreamCallbacks {
  return {
    onTextDelta: () => {},
    onMessageEnd: () => {},
    onError: () => {},
    ...overrides,
  }
}

describe('emitProviderErrorSignal — invariant 1: always classifies', () => {
  it('returns a non-null signal for any input shape (object error)', () => {
    const { signal } = emitProviderErrorSignal(
      { status: 429, message: 'too many requests' },
      'anthropic',
      makeCallbacks(),
    )
    expect(signal).toBeDefined()
    expect(signal.kind).toBe('stream:rate_limit')
    expect(signal.provider).toBe('anthropic')
  })

  it('returns a non-null signal for string error', () => {
    // "Network error" hits the connection-substring battery. Pick a
    // string that matches no battery → falls back to `stream:unknown`.
    const { signal } = emitProviderErrorSignal('mystery vendor failure', 'openai', makeCallbacks())
    expect(signal.kind).toBe('stream:unknown')
  })

  it('returns a non-null signal even for null / undefined error', () => {
    const r1 = emitProviderErrorSignal(null, 'gemini', makeCallbacks())
    const r2 = emitProviderErrorSignal(undefined, 'gemini', makeCallbacks())
    expect(r1.signal.kind).toBe('stream:unknown')
    expect(r2.signal.kind).toBe('stream:unknown')
  })

  it('preserves the typed kind contract (one of LoopSignalKind values)', () => {
    const validStreamKinds = new Set([
      'stream:prompt_too_long',
      'stream:image_too_large',
      'stream:max_output_tokens',
      'stream:overloaded',
      'stream:rate_limit',
      'stream:auth_failed',
      'stream:invalid_request',
      'stream:timeout',
      'stream:connection',
      'stream:aborted',
      'stream:unknown',
    ])
    const cases: Array<[unknown, string]> = [
      [{ status: 413 }, 'stream:prompt_too_long'],
      [{ status: 401 }, 'stream:auth_failed'],
      [{ status: 529 }, 'stream:overloaded'],
      [{ status: 504 }, 'stream:connection'],
      ['Request was aborted.', 'stream:aborted'],
    ]
    for (const [input, _expectedKind] of cases) {
      const { signal } = emitProviderErrorSignal(input, 'anthropic', makeCallbacks())
      expect(validStreamKinds.has(signal.kind), `kind: ${signal.kind}`).toBe(true)
    }
  })
})

describe('emitProviderErrorSignal — invariant 2: onLoopSignal dispatch + crash isolation', () => {
  it('invokes onLoopSignal exactly once with the signal it returned', () => {
    const seen: unknown[] = []
    const cb = makeCallbacks({
      onLoopSignal: (s) => seen.push(s),
    })
    const { signal } = emitProviderErrorSignal({ status: 429 }, 'anthropic', cb)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toBe(signal) // identity match — same object handed to consumer
  })

  it('is a no-op (apart from classification) when onLoopSignal is omitted', () => {
    const cb = makeCallbacks() // no onLoopSignal
    const { signal } = emitProviderErrorSignal({ status: 401 }, 'openai', cb)
    expect(signal.kind).toBe('stream:auth_failed')
    // No throws, no crashes. The return value is still well-formed.
  })

  it('swallows a thrown onLoopSignal consumer — never bubbles into provider flow', () => {
    const cb = makeCallbacks({
      onLoopSignal: () => {
        throw new Error('consumer is broken')
      },
    })
    // Provider expects emit to return normally so it can continue its catch
    // flow (e.g. reach callbacks.onError(message) right after). A bubble
    // here would make the entire stream pipeline crash on a misbehaving
    // consumer.
    expect(() => emitProviderErrorSignal({ status: 500 }, 'compat', cb)).not.toThrow()
  })

  it('swallows consumer throw but still mirrors PTL to ref (post-handler side-effect runs)', () => {
    // Documents the design: ref-mirror happens AFTER onLoopSignal, but
    // because the throw is swallowed, the post-onLoopSignal side-effects
    // still execute deterministically.
    const ref = { value: false }
    const cb = makeCallbacks({
      onLoopSignal: () => {
        throw new Error('consumer is broken')
      },
    })
    const { isPromptTooLong } = emitProviderErrorSignal({ status: 413 }, 'anthropic', cb, ref)
    expect(isPromptTooLong).toBe(true)
    expect(ref.value).toBe(true)
  })
})

describe('emitProviderErrorSignal — invariant 3: PTL ref mirror', () => {
  it('sets ref.value = true when signal.kind === stream:prompt_too_long', () => {
    const ref = { value: false }
    const { isPromptTooLong } = emitProviderErrorSignal(
      { status: 413, message: 'prompt is too long' },
      'anthropic',
      makeCallbacks(),
      ref,
    )
    expect(isPromptTooLong).toBe(true)
    expect(ref.value).toBe(true)
  })

  it('leaves ref.value alone for non-PTL kinds', () => {
    const ref = { value: false }
    const { isPromptTooLong } = emitProviderErrorSignal(
      { status: 401 },
      'anthropic',
      makeCallbacks(),
      ref,
    )
    expect(isPromptTooLong).toBe(false)
    expect(ref.value).toBe(false)
  })

  it('does NOT clobber ref.value when it was already true (no false-write)', () => {
    // Defensive: a stale ref from a previous attempt shouldn't be cleared
    // by a non-PTL classification on the next attempt. The helper only
    // ever WRITES `true` on PTL — never writes `false`.
    const ref = { value: true }
    emitProviderErrorSignal({ status: 401 }, 'anthropic', makeCallbacks(), ref)
    expect(ref.value).toBe(true)
  })

  it('does not touch ref when omitted (legacy emit-only call sites)', () => {
    // The watchdog / fatalCheck call sites in anthropicCompatHttp pass no
    // ref because they don't participate in PTL recovery. Helper must
    // tolerate the omission.
    const { isPromptTooLong } = emitProviderErrorSignal(
      { status: 413 },
      'compat',
      makeCallbacks(),
    )
    expect(isPromptTooLong).toBe(true) // flag still computed
    // No ref → nothing to assert on the mirror side.
  })
})

describe('emitProviderErrorSignal — invariant 4: return shape', () => {
  it('returns both `signal` (full envelope) and `isPromptTooLong` (convenience flag)', () => {
    const r = emitProviderErrorSignal({ status: 413 }, 'anthropic', makeCallbacks())
    expect(r).toMatchObject({
      signal: expect.objectContaining({
        kind: 'stream:prompt_too_long',
        provider: 'anthropic',
        status: 413,
      }),
      isPromptTooLong: true,
    })
  })

  it('isPromptTooLong agrees with signal.kind === stream:prompt_too_long', () => {
    // Property: the convenience flag is never out of sync with the kind.
    const cases: unknown[] = [
      { status: 413 },
      { status: 400, message: 'prompt is too long' },
      { status: 429 },
      'context_length_exceeded',
      'some random error',
      null,
    ]
    for (const input of cases) {
      const r = emitProviderErrorSignal(input, 'anthropic', makeCallbacks())
      expect(r.isPromptTooLong).toBe(r.signal.kind === 'stream:prompt_too_long')
    }
  })
})

describe('emitProviderErrorSignal — provider tag flows through', () => {
  it('attaches the requested provider tag to the envelope', () => {
    const providers = ['anthropic', 'openai', 'gemini', 'compat'] as const
    for (const p of providers) {
      const { signal } = emitProviderErrorSignal(
        { status: 429 },
        p,
        makeCallbacks(),
      )
      expect(signal.provider, `provider: ${p}`).toBe(p)
    }
  })

  it('preserves HTTP status when present', () => {
    const seen = vi.fn()
    const cb = makeCallbacks({ onLoopSignal: seen })
    emitProviderErrorSignal({ status: 529, message: 'Overloaded' }, 'anthropic', cb)
    expect(seen).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'stream:overloaded', status: 529 }),
    )
  })
})
