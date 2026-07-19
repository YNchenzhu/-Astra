import { describe, it, expect } from 'vitest'
import { isAnthropicApiCountTokensEnabled } from './conversationTokenMeter'

describe('conversationTokenMeter', () => {
  it('isAnthropicApiCountTokensEnabled reads POLE_ANTHROPIC_COUNT_TOKENS', () => {
    const prev = process.env.POLE_ANTHROPIC_COUNT_TOKENS
    delete process.env.POLE_ANTHROPIC_COUNT_TOKENS
    expect(isAnthropicApiCountTokensEnabled()).toBe(false)
    process.env.POLE_ANTHROPIC_COUNT_TOKENS = '1'
    expect(isAnthropicApiCountTokensEnabled()).toBe(true)
    if (prev === undefined) delete process.env.POLE_ANTHROPIC_COUNT_TOKENS
    else process.env.POLE_ANTHROPIC_COUNT_TOKENS = prev
  })
})
