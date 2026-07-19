import { describe, it, expect } from 'vitest'
import {
  POLE_CONTEXT_USAGE_MESSAGE_KEY,
  POLE_QUERY_TRACKING_KEY,
  contextUsagePercentOfWindow,
  finalContextTokensFromLastResponse,
  findLastMessageUsageAnchor,
  getTokenCountFromUsage,
  messageTokenCountFromLastApiResponse,
  stripPoleContextUsageFromApiMessages,
  tokenCountWithEstimationFromMessageAnchors,
} from './tokenUsageAccounting'
import { ContextManager, DEFAULT_THRESHOLDS } from './manager'

describe('tokenUsageAccounting §3.4', () => {
  it('getTokenCountFromUsage sums input and cache fields', () => {
    expect(
      getTokenCountFromUsage({
        input_tokens: 1000,
        cache_creation_input_tokens: 100,
        cache_read_input_tokens: 9000,
      }),
    ).toBe(10_100)
  })

  it('finalContextTokensFromLastResponse ignores cache fields', () => {
    expect(
      finalContextTokensFromLastResponse({
        input_tokens: 5000,
        output_tokens: 200,
        cache_read_input_tokens: 99999,
      }),
    ).toBe(5200)
  })

  it('messageTokenCountFromLastApiResponse is output only', () => {
    expect(
      messageTokenCountFromLastApiResponse({
        input_tokens: 100,
        output_tokens: 42,
      }),
    ).toBe(42)
  })

  it('contextUsagePercentOfWindow caps at 100', () => {
    expect(contextUsagePercentOfWindow(150_000, 100_000)).toBe(100)
    expect(contextUsagePercentOfWindow(50_000, 200_000)).toBe(25)
  })
})

describe('stripPoleContextUsageFromApiMessages', () => {
  it('removes internal key without mutating originals when absent', () => {
    const a = { role: 'user', content: 'x' }
    const out = stripPoleContextUsageFromApiMessages([a])
    expect(out![0]).toBe(a)
  })

  it('strips _poleContextUsage from a shallow copy', () => {
    const messages: Array<Record<string, unknown>> = [
      {
        role: 'assistant',
        content: 'hi',
        [POLE_CONTEXT_USAGE_MESSAGE_KEY]: { input_tokens: 1, output_tokens: 0 },
      },
    ]
    const out = stripPoleContextUsageFromApiMessages(messages)!
    expect(out[0][POLE_CONTEXT_USAGE_MESSAGE_KEY]).toBeUndefined()
    expect(messages[0][POLE_CONTEXT_USAGE_MESSAGE_KEY]).toBeDefined()
  })

  it('strips _poleQueryTracking from a shallow copy', () => {
    const messages: Array<Record<string, unknown>> = [
      {
        role: 'user',
        content: 'hi',
        [POLE_QUERY_TRACKING_KEY]: { chainId: 'c', requestId: 'r', source: 'repl_main_thread' },
      },
    ]
    const out = stripPoleContextUsageFromApiMessages(messages)!
    expect(out[0][POLE_QUERY_TRACKING_KEY]).toBeUndefined()
    expect(messages[0][POLE_QUERY_TRACKING_KEY]).toBeDefined()
  })
})

describe('tokenUsageAccounting §3.3 message anchor', () => {
  it('findLastMessageUsageAnchor accepts cache-only usage (input_tokens may be 0)', () => {
    const messages: Array<Record<string, unknown>> = [
      {
        role: 'assistant',
        content: 'x',
        [POLE_CONTEXT_USAGE_MESSAGE_KEY]: {
          input_tokens: 0,
          cache_read_input_tokens: 5000,
          output_tokens: 1,
        },
      },
    ]
    const a = findLastMessageUsageAnchor(messages)
    expect(a).not.toBeNull()
    expect(getTokenCountFromUsage(a!.usage)).toBe(5000)
  })

  it('findLastMessageUsageAnchor picks the last marked message', () => {
    const messages: Array<Record<string, unknown>> = [
      { role: 'user', content: 'a', [POLE_CONTEXT_USAGE_MESSAGE_KEY]: { input_tokens: 1 } },
      { role: 'assistant', content: 'b', [POLE_CONTEXT_USAGE_MESSAGE_KEY]: { input_tokens: 500 } },
    ]
    const a = findLastMessageUsageAnchor(messages)
    expect(a?.index).toBe(1)
    expect(getTokenCountFromUsage(a!.usage)).toBe(500)
  })

  it('findLastMessageUsageAnchor skips stale assistant usage when same id continues later', () => {
    const messages: Array<Record<string, unknown>> = [
      {
        role: 'assistant',
        id: 'turn-1',
        content: 'part-a',
        [POLE_CONTEXT_USAGE_MESSAGE_KEY]: { input_tokens: 100, output_tokens: 1 },
      },
      {
        role: 'assistant',
        id: 'turn-1',
        content: 'part-b',
        [POLE_CONTEXT_USAGE_MESSAGE_KEY]: { input_tokens: 900, output_tokens: 1 },
      },
    ]
    const a = findLastMessageUsageAnchor(messages)
    expect(a?.index).toBe(1)
    expect(getTokenCountFromUsage(a!.usage)).toBe(900)
  })

  it('tokenCountWithEstimationFromMessageAnchors adds rough tail', () => {
    const big = 'z'.repeat(400)
    const messages: Array<Record<string, unknown>> = [
      {
        role: 'assistant',
        content: 'old',
        [POLE_CONTEXT_USAGE_MESSAGE_KEY]: {
          input_tokens: 2000,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
      { role: 'user', content: big },
    ]
    const t = tokenCountWithEstimationFromMessageAnchors(messages, 0)
    expect(t).not.toBeNull()
    expect(t!).toBeGreaterThan(2000)
  })

  it('ContextManager prefers _poleContextUsage over full rough estimate', () => {
    const charPerTier = DEFAULT_THRESHOLDS.warningTokens * 4
    const huge = 'h'.repeat(charPerTier)
    const messages: Array<Record<string, unknown>> = [
      { role: 'user', content: huge },
      {
        role: 'assistant',
        content: 'x',
        [POLE_CONTEXT_USAGE_MESSAGE_KEY]: { input_tokens: 1000 },
      },
      { role: 'user', content: 'tail' },
    ]
    const mgr = new ContextManager()
    const r = mgr.evaluate(messages, 'sys', 0)
    expect(r.level).toBe('ok')
  })
})
