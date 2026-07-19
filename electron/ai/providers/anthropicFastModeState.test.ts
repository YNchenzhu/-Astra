/**
 * Unit tests for the Anthropic fast-mode state manager.
 *
 * Purpose: lock down the semantics we moved out of `client.ts` so a future
 * touch to the extracted module can't silently regress the cooldown /
 * process-lifetime latch behaviour that `streamAnthropic` depends on.
 *
 * These tests use the `__resetAnthropicFastModeStateForTests` escape hatch
 * between runs because the module holds genuinely process-lifetime state.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { StreamTextParams } from '../client'
import {
  __resetAnthropicFastModeStateForTests,
  applyLongRetryAfterCooldown,
  disableFastModeGlobally,
  shouldSendFastModeBeta,
} from './anthropicFastModeState'

const baseParams = { anthropicFastMode: true } as unknown as StreamTextParams

beforeEach(() => {
  __resetAnthropicFastModeStateForTests()
  delete process.env.POLE_FAST_MODE_DISABLED
})

afterEach(() => {
  vi.useRealTimers()
})

describe('shouldSendFastModeBeta', () => {
  it('returns false when fast mode was not requested', () => {
    expect(
      shouldSendFastModeBeta({ anthropicFastMode: false } as StreamTextParams, 'c1'),
    ).toBe(false)
    expect(shouldSendFastModeBeta({} as StreamTextParams, 'c1')).toBe(false)
  })

  it('returns true for a fresh request with fast mode requested', () => {
    expect(shouldSendFastModeBeta(baseParams, 'c1')).toBe(true)
  })

  it('treats an empty / whitespace conversation id as no cooldown lookup', () => {
    // No conversation id means we can't store a cooldown, but we still
    // allow the beta header through (matches the original behaviour).
    expect(shouldSendFastModeBeta(baseParams, undefined)).toBe(true)
    expect(shouldSendFastModeBeta(baseParams, '   ')).toBe(true)
  })

  it('returns false while the env kill-switch is set', () => {
    process.env.POLE_FAST_MODE_DISABLED = '1'
    expect(shouldSendFastModeBeta(baseParams, 'c1')).toBe(false)
  })

  it('returns false for the rest of the process once globally disabled', () => {
    disableFastModeGlobally()
    expect(shouldSendFastModeBeta(baseParams, 'c1')).toBe(false)
    expect(shouldSendFastModeBeta(baseParams, 'c2')).toBe(false)
  })
})

describe('applyLongRetryAfterCooldown', () => {
  it('no-ops if fast mode was not requested', () => {
    applyLongRetryAfterCooldown('c1', 60_000, false)
    expect(shouldSendFastModeBeta(baseParams, 'c1')).toBe(true)
  })

  it('no-ops if retryAfter is missing or short', () => {
    applyLongRetryAfterCooldown('c1', undefined, true)
    applyLongRetryAfterCooldown('c1', 1_000, true)
    expect(shouldSendFastModeBeta(baseParams, 'c1')).toBe(true)
  })

  it('no-ops if conversation id is missing', () => {
    applyLongRetryAfterCooldown(undefined, 60_000, true)
    // With no id, there is no per-conv cooldown map entry — and the
    // "no id" path short-circuits to true in shouldSendFastModeBeta.
    expect(shouldSendFastModeBeta(baseParams, undefined)).toBe(true)
  })

  it('installs a cooldown that suppresses the beta until it expires', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))

    // retry-after of 30s clears the 20s threshold. `FAST_MODE_COOLDOWN_MIN_MS`
    // (10 min) is the lower bound, so the effective cooldown ends up being
    // 10 min regardless of the server-hinted value.
    applyLongRetryAfterCooldown('c1', 30_000, true)
    expect(shouldSendFastModeBeta(baseParams, 'c1')).toBe(false)

    // Other conversations are unaffected.
    expect(shouldSendFastModeBeta(baseParams, 'c2')).toBe(true)

    // Still inside the 10-min window.
    vi.setSystemTime(new Date('2026-01-01T00:05:00Z'))
    expect(shouldSendFastModeBeta(baseParams, 'c1')).toBe(false)

    // Advance past the 10-min floor — beta is re-enabled for that conv.
    vi.setSystemTime(new Date('2026-01-01T00:11:00Z'))
    expect(shouldSendFastModeBeta(baseParams, 'c1')).toBe(true)
  })

  it('uses the server retry-after when it exceeds the 10-min floor', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))

    // 30 min server retry-after > 10 min floor → cooldown is 30 min.
    applyLongRetryAfterCooldown('c1', 30 * 60_000, true)

    vi.setSystemTime(new Date('2026-01-01T00:15:00Z'))
    expect(shouldSendFastModeBeta(baseParams, 'c1')).toBe(false)

    vi.setSystemTime(new Date('2026-01-01T00:31:00Z'))
    expect(shouldSendFastModeBeta(baseParams, 'c1')).toBe(true)
  })
})
