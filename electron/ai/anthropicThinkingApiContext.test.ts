/**
 * Coverage for the upstream-style server-side thinking-context controls
 * (`anthropicThinkingApiContext.ts`). The module is the single source of
 * truth for what `anthropic-beta` tokens and `context_management`
 * payloads we add to outgoing first-party Anthropic requests on behalf
 * of P1 (REDACT_THINKING) / P2 (clear_thinking_20251015) / P3
 * (INTERLEAVED_THINKING). Each path has a non-trivial gate (model
 * support / user setting / idle latch) — the tests pin all of them.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  CONTEXT_MANAGEMENT_BETA_HEADER,
  INTERLEAVED_THINKING_BETA_HEADER,
  REDACT_THINKING_BETA_HEADER,
} from '../constants/betas'

vi.mock('../settings/settingsAccess', () => ({
  readDiskSettings: vi.fn(() => ({})),
}))

import { readDiskSettings } from '../settings/settingsAccess'
import {
  cleanupAnthropicThinkingApiContextForConversation,
  getAnthropicThinkingApiContext,
  isClearAllThinkingLatched,
  recordAnthropicThinkingStreamSuccess,
  resetThinkingClearLatchOnly,
  resetAnthropicThinkingApiContextForTests,
} from './anthropicThinkingApiContext'

const SUPPORTED_MODEL = 'claude-sonnet-4-5-20250929'
const UNSUPPORTED_MODEL = 'claude-3-5-sonnet-20240620'

beforeEach(() => {
  resetAnthropicThinkingApiContextForTests()
  vi.mocked(readDiskSettings).mockReturnValue({})
  // Plan Phase 4 — REDACT_THINKING 端到端 pipeline 已经打通，默认开启
  // (`isRedactThinkingEndToEndReady()` 在 env != '0' 时返回 true)。
  // 这里 stub 成 undefined 即可——默认行为就是开启。dedicated
  // "POLE_ANTHROPIC_REDACT_THINKING=0 关闭" 测试在下方单独设置。
})

afterEach(() => {
  resetAnthropicThinkingApiContextForTests()
  vi.unstubAllEnvs()
})

// ─── Capability gating ────────────────────────────────────────────────

describe('getAnthropicThinkingApiContext — model gating', () => {
  it('returns no betas + no context_management for unsupported (Claude 3.5) models', () => {
    const out = getAnthropicThinkingApiContext({
      hasThinkingActiveOnRequest: true,
      model: UNSUPPORTED_MODEL,
      conversationId: 'c1',
      isAgenticQuery: true,
    })
    expect(out.extraBetas).toEqual([])
    expect(out.contextManagement).toBeUndefined()
    expect(out.isRedactThinkingActive).toBe(false)
  })

  it('emits all three betas for a supported (Claude 4.5 sonnet) model with thinking active', () => {
    const out = getAnthropicThinkingApiContext({
      hasThinkingActiveOnRequest: true,
      model: SUPPORTED_MODEL,
      conversationId: 'c1',
      isAgenticQuery: true,
    })
    expect(out.extraBetas).toContain(INTERLEAVED_THINKING_BETA_HEADER)
    expect(out.extraBetas).toContain(REDACT_THINKING_BETA_HEADER)
    // CONTEXT_MANAGEMENT is suppressed when REDACT is active (parity with upstream).
    expect(out.extraBetas).not.toContain(CONTEXT_MANAGEMENT_BETA_HEADER)
    expect(out.isRedactThinkingActive).toBe(true)
    // No context_management when redact is on — redacted blocks have no
    // model-visible content for clear_thinking to operate on.
    expect(out.contextManagement).toBeUndefined()
  })

  it('also covers Claude opus 4 / haiku 4 / 3.7 sonnet model id variants', () => {
    for (const model of [
      'claude-opus-4-20250514',
      'claude-haiku-4-20251002',
      'claude-3-7-sonnet-20250219',
      'us.anthropic.claude-sonnet-4-20250514',
    ]) {
      const out = getAnthropicThinkingApiContext({
        hasThinkingActiveOnRequest: true,
        model,
        conversationId: 'c-' + model,
        isAgenticQuery: true,
      })
      expect(out.extraBetas.length).toBeGreaterThan(0)
    }
  })

  // P3 audit fix (2026-07) — forward-compatible generation matching. The
  // old exact-substring whitelist silently disabled all thinking betas
  // for any future Claude naming; the gate now matches generation ≥ 4 in
  // either naming order.
  it('matches future Claude 5+ / alternate-order namings (forward compat)', () => {
    for (const model of [
      'claude-sonnet-5-20270101',
      'claude-opus-5',
      'claude-haiku-6-20280301',
      'claude-4-sonnet', // family-after-generation order
      'us.anthropic.claude-sonnet-5-20270101-v1:0',
      'claude-opus-4-6', // current dotted-generation variants keep working
    ]) {
      const out = getAnthropicThinkingApiContext({
        hasThinkingActiveOnRequest: true,
        model,
        conversationId: 'c-' + model,
        isAgenticQuery: true,
      })
      expect(out.extraBetas.length, `model ${model} should pass the gate`).toBeGreaterThan(0)
    }
  })

  it('still rejects pre-beta generations (Claude 3 / 3.5)', () => {
    for (const model of ['claude-3-opus-20240229', 'claude-3-5-sonnet-20240620', 'claude-3-5-haiku']) {
      const out = getAnthropicThinkingApiContext({
        hasThinkingActiveOnRequest: true,
        model,
        conversationId: 'c-' + model,
        isAgenticQuery: true,
      })
      expect(out.extraBetas, `model ${model} should NOT pass the gate`).toEqual([])
    }
  })
})

// ─── INTERLEAVED_THINKING (P3) ────────────────────────────────────────

describe('INTERLEAVED_THINKING beta', () => {
  it('is added even when this turn does NOT request thinking (interleaved is about future tool-loop thinking)', () => {
    const out = getAnthropicThinkingApiContext({
      hasThinkingActiveOnRequest: false, // no thinking this request
      model: SUPPORTED_MODEL,
      conversationId: 'c1',
      isAgenticQuery: true,
    })
    expect(out.extraBetas).toContain(INTERLEAVED_THINKING_BETA_HEADER)
    expect(out.extraBetas).not.toContain(REDACT_THINKING_BETA_HEADER)
    expect(out.contextManagement).toBeUndefined()
  })

  it('is suppressed by `disableInterleaved: true` opt-out', () => {
    const out = getAnthropicThinkingApiContext({
      hasThinkingActiveOnRequest: true,
      model: SUPPORTED_MODEL,
      conversationId: 'c1',
      isAgenticQuery: true,
      disableInterleaved: true,
    })
    expect(out.extraBetas).not.toContain(INTERLEAVED_THINKING_BETA_HEADER)
    // Redact + context_management still apply independently.
    expect(out.extraBetas).toContain(REDACT_THINKING_BETA_HEADER)
  })
})

// ─── REDACT_THINKING (P1) ─────────────────────────────────────────────

describe('REDACT_THINKING beta', () => {
  it('is suppressed when user enabled `showThinkingSummaries`', () => {
    vi.mocked(readDiskSettings).mockReturnValue({ showThinkingSummaries: true })
    const out = getAnthropicThinkingApiContext({
      hasThinkingActiveOnRequest: true,
      model: SUPPORTED_MODEL,
      conversationId: 'c1',
      isAgenticQuery: true,
    })
    expect(out.extraBetas).not.toContain(REDACT_THINKING_BETA_HEADER)
    expect(out.isRedactThinkingActive).toBe(false)
    // With redact off, context_management IS sent (clear_thinking strategy
    // can do useful pruning on visible blocks).
    expect(out.extraBetas).toContain(CONTEXT_MANAGEMENT_BETA_HEADER)
    expect(out.contextManagement?.edits[0].type).toBe('clear_thinking_20251015')
  })

  it('is suppressed when current request has thinking off (nothing to redact)', () => {
    const out = getAnthropicThinkingApiContext({
      hasThinkingActiveOnRequest: false,
      model: SUPPORTED_MODEL,
      conversationId: 'c1',
      isAgenticQuery: true,
    })
    expect(out.extraBetas).not.toContain(REDACT_THINKING_BETA_HEADER)
    // Same gate also keeps context_management off.
    expect(out.extraBetas).not.toContain(CONTEXT_MANAGEMENT_BETA_HEADER)
  })

  it('falls back to redacting when settings read throws (privacy-leaning default)', () => {
    vi.mocked(readDiskSettings).mockImplementationOnce(() => {
      throw new Error('settings unavailable')
    })
    const out = getAnthropicThinkingApiContext({
      hasThinkingActiveOnRequest: true,
      model: SUPPORTED_MODEL,
      conversationId: 'c1',
      isAgenticQuery: true,
    })
    // Throw → assume user did NOT enable summaries → redact.
    expect(out.extraBetas).toContain(REDACT_THINKING_BETA_HEADER)
    expect(out.isRedactThinkingActive).toBe(true)
  })
})

// L1.1 — REDACT_THINKING is end-to-end-ready-only (env opt-in).
//
// The renderer + provider + persistence pipeline doesn't yet handle
// `redacted_thinking` blocks; enabling the beta unconditionally would
// make the chat UI go blank when the model thinks. Default OFF until
// the rest of the pipeline catches up.
// Plan Phase 4 — end-to-end pipeline 已经打通，REDACT_THINKING 默认开启
// （`isRedactThinkingEndToEndReady()` 在 env != '0' 时返回 true）。
describe('REDACT_THINKING — default-on env gate (Plan Phase 4)', () => {
  it('emits REDACT_THINKING by default when env is unset', () => {
    vi.unstubAllEnvs()
    vi.mocked(readDiskSettings).mockReturnValue({})
    const out = getAnthropicThinkingApiContext({
      hasThinkingActiveOnRequest: true,
      model: SUPPORTED_MODEL,
      conversationId: 'c1',
      isAgenticQuery: true,
    })
    expect(out.extraBetas).toContain(REDACT_THINKING_BETA_HEADER)
    expect(out.isRedactThinkingActive).toBe(true)
    // 当 REDACT 启用时不应同时下发 CONTEXT_MANAGEMENT 的 clear_thinking
    // strategy — redacted 块没有 model-visible 文本可清理（互斥契约）。
    expect(out.extraBetas).not.toContain(CONTEXT_MANAGEMENT_BETA_HEADER)
  })

  it('emits REDACT_THINKING when env is "1" (legacy explicit-opt-in path still works)', () => {
    vi.stubEnv('POLE_ANTHROPIC_REDACT_THINKING', '1')
    const out = getAnthropicThinkingApiContext({
      hasThinkingActiveOnRequest: true,
      model: SUPPORTED_MODEL,
      conversationId: 'c1',
      isAgenticQuery: true,
    })
    expect(out.extraBetas).toContain(REDACT_THINKING_BETA_HEADER)
  })

  it('emits REDACT_THINKING for arbitrary truthy env values (only "0" disables)', () => {
    vi.stubEnv('POLE_ANTHROPIC_REDACT_THINKING', 'true')
    const out = getAnthropicThinkingApiContext({
      hasThinkingActiveOnRequest: true,
      model: SUPPORTED_MODEL,
      conversationId: 'c1',
      isAgenticQuery: true,
    })
    expect(out.extraBetas).toContain(REDACT_THINKING_BETA_HEADER)
  })

  it('does NOT emit REDACT_THINKING when env is exactly "0" (explicit opt-out)', () => {
    vi.stubEnv('POLE_ANTHROPIC_REDACT_THINKING', '0')
    const out = getAnthropicThinkingApiContext({
      hasThinkingActiveOnRequest: true,
      model: SUPPORTED_MODEL,
      conversationId: 'c1',
      isAgenticQuery: true,
    })
    expect(out.extraBetas).not.toContain(REDACT_THINKING_BETA_HEADER)
    expect(out.isRedactThinkingActive).toBe(false)
    // 关闭 REDACT 时 CONTEXT_MANAGEMENT clear_thinking 策略接管
    expect(out.extraBetas).toContain(CONTEXT_MANAGEMENT_BETA_HEADER)
  })
})

// ─── CONTEXT_MANAGEMENT + clear_thinking_20251015 (P2) ───────────────

describe('clear_thinking_20251015 strategy', () => {
  it('emits `keep: "all"` on first request (no prior success → no idle latch)', () => {
    vi.mocked(readDiskSettings).mockReturnValue({ showThinkingSummaries: true })
    const out = getAnthropicThinkingApiContext({
      hasThinkingActiveOnRequest: true,
      model: SUPPORTED_MODEL,
      conversationId: 'c1',
      isAgenticQuery: true,
    })
    expect(out.contextManagement).toEqual({
      edits: [{ type: 'clear_thinking_20251015', keep: 'all' }],
    })
  })

  it('flips to `keep: { thinking_turns: 1 }` after >1h since last successful stream', () => {
    vi.mocked(readDiskSettings).mockReturnValue({ showThinkingSummaries: true })
    const cid = 'c-idle'
    // Simulate a stream that finished ~2 hours ago.
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-05-13T10:00:00Z'))
      recordAnthropicThinkingStreamSuccess(cid, true)
      vi.setSystemTime(new Date('2026-05-13T12:30:00Z')) // +2.5h
      const out = getAnthropicThinkingApiContext({
        hasThinkingActiveOnRequest: true,
        model: SUPPORTED_MODEL,
        conversationId: cid,
        isAgenticQuery: true,
      })
      expect(out.contextManagement?.edits[0]).toEqual({
        type: 'clear_thinking_20251015',
        keep: { type: 'thinking_turns', value: 1 },
      })
      expect(isClearAllThinkingLatched(cid)).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('latch is sticky — even after a fresh recordAnthropicThinkingStreamSuccess the keep-1 stays', () => {
    vi.mocked(readDiskSettings).mockReturnValue({ showThinkingSummaries: true })
    const cid = 'c-sticky'
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-05-13T10:00:00Z'))
      recordAnthropicThinkingStreamSuccess(cid, true)
      vi.setSystemTime(new Date('2026-05-13T12:30:00Z'))
      // First call after the long pause flips the latch.
      getAnthropicThinkingApiContext({
        hasThinkingActiveOnRequest: true,
        model: SUPPORTED_MODEL,
        conversationId: cid,
        isAgenticQuery: true,
      })
      expect(isClearAllThinkingLatched(cid)).toBe(true)
      // Subsequent stream success — only 30s later — does NOT clear latch.
      recordAnthropicThinkingStreamSuccess(cid, true)
      vi.setSystemTime(new Date('2026-05-13T12:30:30Z'))
      const out2 = getAnthropicThinkingApiContext({
        hasThinkingActiveOnRequest: true,
        model: SUPPORTED_MODEL,
        conversationId: cid,
        isAgenticQuery: true,
      })
      expect(out2.contextManagement?.edits[0]).toMatchObject({
        keep: { type: 'thinking_turns', value: 1 },
      })
      expect(isClearAllThinkingLatched(cid)).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('only agentic queries flip the latch (classifier mid-turn must not change main-thread policy)', () => {
    vi.mocked(readDiskSettings).mockReturnValue({ showThinkingSummaries: true })
    const cid = 'c-classifier'
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-05-13T10:00:00Z'))
      recordAnthropicThinkingStreamSuccess(cid, true)
      vi.setSystemTime(new Date('2026-05-13T12:00:00Z'))
      getAnthropicThinkingApiContext({
        hasThinkingActiveOnRequest: true,
        model: SUPPORTED_MODEL,
        conversationId: cid,
        isAgenticQuery: false, // ← classifier / side-query
      })
      expect(isClearAllThinkingLatched(cid)).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})

// ─── L6.1 — Sub-agent stream completions must not refresh parent latch ──

describe('recordAnthropicThinkingStreamSuccess — main/sub-agent gating (L6.1 fix)', () => {
  it('writes timestamp when isMainAgent: true', () => {
    vi.mocked(readDiskSettings).mockReturnValue({ showThinkingSummaries: true })
    const cid = 'c-main'
    vi.useFakeTimers()
    try {
      // No prior success → first call sets the baseline.
      vi.setSystemTime(new Date('2026-05-13T10:00:00Z'))
      recordAnthropicThinkingStreamSuccess(cid, true)
      // Latch should NOT flip yet (gap < 1h).
      vi.setSystemTime(new Date('2026-05-13T10:30:00Z'))
      getAnthropicThinkingApiContext({
        hasThinkingActiveOnRequest: true,
        model: SUPPORTED_MODEL,
        conversationId: cid,
        isAgenticQuery: true,
      })
      expect(isClearAllThinkingLatched(cid)).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does NOT write timestamp when isMainAgent: false (sub-agent stream)', () => {
    vi.mocked(readDiskSettings).mockReturnValue({ showThinkingSummaries: true })
    const cid = 'c-shared'
    vi.useFakeTimers()
    try {
      // Main agent finished a turn ~3h ago.
      vi.setSystemTime(new Date('2026-05-13T07:00:00Z'))
      recordAnthropicThinkingStreamSuccess(cid, true)
      // Sub-agent (sharing parent's convId) finishes mid-task NOW. The
      // sub-agent flag is false → must NOT refresh the timestamp.
      vi.setSystemTime(new Date('2026-05-13T10:00:00Z'))
      recordAnthropicThinkingStreamSuccess(cid, false)
      // Parent now sends its next agentic query — must see the original
      // 3h gap and flip the latch (proving the sub-agent call was a no-op).
      vi.setSystemTime(new Date('2026-05-13T10:00:30Z'))
      getAnthropicThinkingApiContext({
        hasThinkingActiveOnRequest: true,
        model: SUPPORTED_MODEL,
        conversationId: cid,
        isAgenticQuery: true,
      })
      expect(isClearAllThinkingLatched(cid)).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})

// ─── Cleanup ─────────────────────────────────────────────────────────

describe('cleanupAnthropicThinkingApiContextForConversation', () => {
  it('drops latch + last-success state for the given conversation', () => {
    const cid = 'c-cleanup'
    recordAnthropicThinkingStreamSuccess(cid, true)
    // Force-latch by manipulating internal state via the public API (we
    // can't poke the latch directly without flipping a real >1h clock).
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-05-13T10:00:00Z'))
      recordAnthropicThinkingStreamSuccess(cid, true)
      vi.setSystemTime(new Date('2026-05-13T13:00:00Z'))
      vi.mocked(readDiskSettings).mockReturnValue({ showThinkingSummaries: true })
      getAnthropicThinkingApiContext({
        hasThinkingActiveOnRequest: true,
        model: SUPPORTED_MODEL,
        conversationId: cid,
        isAgenticQuery: true,
      })
      expect(isClearAllThinkingLatched(cid)).toBe(true)

      cleanupAnthropicThinkingApiContextForConversation(cid)
      expect(isClearAllThinkingLatched(cid)).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('resetThinkingClearLatchOnly', () => {
  it('drops latch but preserves lastStreamSuccessMs (post-compact / /clear refresh)', () => {
    const cid = 'c-reset-only'
    vi.useFakeTimers()
    try {
      // Establish a real success timestamp at t0
      vi.setSystemTime(new Date('2026-05-13T10:00:00Z'))
      recordAnthropicThinkingStreamSuccess(cid, true)

      // Jump >1h forward + invoke the context to flip the latch on
      vi.setSystemTime(new Date('2026-05-13T13:00:00Z'))
      vi.mocked(readDiskSettings).mockReturnValue({ showThinkingSummaries: true })
      getAnthropicThinkingApiContext({
        hasThinkingActiveOnRequest: true,
        model: SUPPORTED_MODEL,
        conversationId: cid,
        isAgenticQuery: true,
      })
      expect(isClearAllThinkingLatched(cid)).toBe(true)

      // Reset-only: latch off, BUT lastSuccess timestamp must still be there
      // so the next idle evaluation works on the same clock.
      resetThinkingClearLatchOnly(cid)
      expect(isClearAllThinkingLatched(cid)).toBe(false)

      // Confirm lastSuccess is preserved: another >1h jump should re-latch
      // (which it wouldn't if reset had wiped the timestamp).
      vi.setSystemTime(new Date('2026-05-13T15:00:00Z'))
      getAnthropicThinkingApiContext({
        hasThinkingActiveOnRequest: true,
        model: SUPPORTED_MODEL,
        conversationId: cid,
        isAgenticQuery: true,
      })
      expect(isClearAllThinkingLatched(cid)).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('is a no-op on empty / missing conversation id', () => {
    expect(() => resetThinkingClearLatchOnly(undefined)).not.toThrow()
    expect(() => resetThinkingClearLatchOnly('')).not.toThrow()
    expect(() => resetThinkingClearLatchOnly('   ')).not.toThrow()
  })
})
