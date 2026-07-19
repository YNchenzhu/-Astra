import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  consumeMicroCompactMessageCacheForkShiftOnce,
  resetCachedMicrocompactPromptCacheForTests,
  signalMicroCompactForPromptCache,
} from './cachedMicrocompactPromptCache'
import {
  buildAnthropicStreamBetaHeaders,
  resetAnthropicBetaHeaderLatchForTests,
} from '../ai/anthropicBetaHeaderLatch'
import * as agentContext from '../agents/agentContext'
import type { AgentContext } from '../agents/agentContext'

describe('cachedMicrocompactPromptCache (§9.3)', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    resetCachedMicrocompactPromptCacheForTests()
    resetAnthropicBetaHeaderLatchForTests()
  })

  it('no-ops when CACHED_MICROCOMPACT is off', () => {
    signalMicroCompactForPromptCache('s1')
    expect(consumeMicroCompactMessageCacheForkShiftOnce('s1')).toBe(false)
  })

  it('consume returns true once per conversation when signaled', () => {
    vi.stubEnv('POLE_ANTHROPIC_CACHED_MICROCOMPACT', '1')
    signalMicroCompactForPromptCache('s1')
    expect(consumeMicroCompactMessageCacheForkShiftOnce('s1')).toBe(true)
    expect(consumeMicroCompactMessageCacheForkShiftOnce('s1')).toBe(false)
  })

  it('does not latch for non-main agent ALS chains (§16.5)', () => {
    vi.stubEnv('POLE_ANTHROPIC_CACHED_MICROCOMPACT', '1')
    vi.spyOn(agentContext, 'getAgentContext').mockReturnValue({
      agentId: 'sub-agent-1',
    } as AgentContext)
    signalMicroCompactForPromptCache('s-sub')
    expect(consumeMicroCompactMessageCacheForkShiftOnce('s-sub')).toBe(false)
    vi.restoreAllMocks()
  })

  it('registers cache-editing latch when latch env + beta env set', () => {
    vi.stubEnv('POLE_ANTHROPIC_CACHED_MICROCOMPACT', '1')
    vi.stubEnv('POLE_ANTHROPIC_BETA_HEADER_LATCH', '1')
    vi.stubEnv('POLE_ANTHROPIC_LATCHED_CACHE_EDITING_BETA', 'test-cache-beta')
    signalMicroCompactForPromptCache('s2')
    const h = buildAnthropicStreamBetaHeaders({ conversationId: 's2', requestBetaTokens: [] })
    expect(h['anthropic-beta']).toBe('test-cache-beta')
  })
})
