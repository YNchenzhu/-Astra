import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ANTHROPIC_EFFORT_BETA_HEADER,
  buildAnthropicStreamBetaHeaders,
  recordAnthropicStreamSuccessForThinkingClearLatch,
  registerAnthropicEffortBetaLatch,
  registerLatchedCacheEditingBetasForConversation,
  resetAnthropicBetaHeaderLatchForTests,
} from './anthropicBetaHeaderLatch'

describe('anthropicBetaHeaderLatch (§9.4)', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
    resetAnthropicBetaHeaderLatchForTests()
  })

  it('without latch env, only forwards request betas', () => {
    const h = buildAnthropicStreamBetaHeaders({
      conversationId: 'c1',
      requestBetaTokens: [ANTHROPIC_EFFORT_BETA_HEADER],
    })
    expect(h['anthropic-beta']).toBe(ANTHROPIC_EFFORT_BETA_HEADER)
  })

  it('with latch + LATCH_EFFORT, merges effort after register', () => {
    vi.stubEnv('POLE_ANTHROPIC_BETA_HEADER_LATCH', '1')
    vi.stubEnv('POLE_ANTHROPIC_LATCH_EFFORT_BETA', '1')
    registerAnthropicEffortBetaLatch('c1')
    const h = buildAnthropicStreamBetaHeaders({
      conversationId: 'c1',
      requestBetaTokens: [],
    })
    expect(h['anthropic-beta']).toBe(ANTHROPIC_EFFORT_BETA_HEADER)
  })

  it('merges request betas with latched cache-editing tokens from env', () => {
    vi.stubEnv('POLE_ANTHROPIC_BETA_HEADER_LATCH', '1')
    vi.stubEnv('POLE_ANTHROPIC_LATCHED_CACHE_EDITING_BETA', 'extended-cache-ttl-2025-04-11, foo-beta')
    registerLatchedCacheEditingBetasForConversation('c2')
    const h = buildAnthropicStreamBetaHeaders({
      conversationId: 'c2',
      requestBetaTokens: [ANTHROPIC_EFFORT_BETA_HEADER],
    })
    expect(h['anthropic-beta']).toContain(ANTHROPIC_EFFORT_BETA_HEADER)
    expect(h['anthropic-beta']).toContain('extended-cache-ttl-2025-04-11')
    expect(h['anthropic-beta']).toContain('foo-beta')
  })

  it('does not add cache-editing tokens if register was skipped', () => {
    vi.stubEnv('POLE_ANTHROPIC_BETA_HEADER_LATCH', '1')
    vi.stubEnv('POLE_ANTHROPIC_LATCHED_CACHE_EDITING_BETA', 'only-if-registered')
    const h = buildAnthropicStreamBetaHeaders({
      conversationId: 'c3',
      requestBetaTokens: [],
    })
    expect(h['anthropic-beta']).toBeUndefined()
  })

  it('§10.4 thinkingClearLatched: merges beta after idle gap since last stream success', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    vi.stubEnv('POLE_ANTHROPIC_BETA_HEADER_LATCH', '1')
    vi.stubEnv('POLE_ANTHROPIC_LATCHED_THINKING_CLEAR_BETA', 'thinking-clear-test-beta')
    vi.stubEnv('POLE_ANTHROPIC_THINKING_CLEAR_IDLE_LATCH_MS', '1000')
    recordAnthropicStreamSuccessForThinkingClearLatch('idle1')
    const h0 = buildAnthropicStreamBetaHeaders({ conversationId: 'idle1', requestBetaTokens: [] })
    expect(h0['anthropic-beta']).toBeUndefined()
    vi.setSystemTime(500)
    const h1 = buildAnthropicStreamBetaHeaders({ conversationId: 'idle1', requestBetaTokens: [] })
    expect(h1['anthropic-beta']).toBeUndefined()
    vi.setSystemTime(1000)
    const h2 = buildAnthropicStreamBetaHeaders({ conversationId: 'idle1', requestBetaTokens: [] })
    expect(h2['anthropic-beta']).toBe('thinking-clear-test-beta')
    vi.setSystemTime(2000)
    const h3 = buildAnthropicStreamBetaHeaders({ conversationId: 'idle1', requestBetaTokens: [] })
    expect(h3['anthropic-beta']).toBe('thinking-clear-test-beta')
  })
})
