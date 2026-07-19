import { describe, it, expect, afterEach } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'
import {
  applyAnthropicSingleMessagePromptCache,
  anthropicSystemWireUsesMessageLevelStyleCache,
  shouldUseAnthropicMessagePromptCacheTtl1h,
  stripMessageContentCacheControls,
} from './anthropicMessagePromptCache'

describe('anthropicMessagePromptCache (§9.1)', () => {
  afterEach(() => {
    delete process.env.POLE_ANTHROPIC_PROMPT_CACHE_TTL_1H
    delete process.env.ENABLE_PROMPT_CACHING_1H_BEDROCK
  })

  function countCacheControls(messages: Anthropic.MessageParam[]): number {
    let n = 0
    for (const m of messages) {
      const c = m.content
      if (!Array.isArray(c)) continue
      for (const b of c) {
        if (b && typeof b === 'object' && 'cache_control' in b && (b as { cache_control?: unknown }).cache_control)
          n++
      }
    }
    return n
  }

  it('places exactly one ephemeral cache_control on last message string content', () => {
    const m: Anthropic.MessageParam[] = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
    ]
    const out = applyAnthropicSingleMessagePromptCache(m, {})
    expect(countCacheControls(out)).toBe(1)
    const last = out[out.length - 1]!
    expect(Array.isArray(last.content)).toBe(true)
    const b0 = (last.content as { type: string; cache_control?: { type: string } }[])[0]!
    expect(b0.type).toBe('text')
    expect(b0.cache_control?.type).toBe('ephemeral')
  })

  it('uses second-to-last message when secondToLastBreakpoint and len>=2', () => {
    const m: Anthropic.MessageParam[] = [
      { role: 'user', content: 'old' },
      { role: 'assistant', content: 'mid' },
    ]
    const out = applyAnthropicSingleMessagePromptCache(m, { secondToLastBreakpoint: true })
    expect(countCacheControls(out)).toBe(1)
    const pen = out[out.length - 2]!
    expect(Array.isArray(pen.content)).toBe(true)
    const b0 = (pen.content as { cache_control?: { type: string } }[])[0]!
    expect(b0.cache_control?.type).toBe('ephemeral')
    const last = out[out.length - 1]!
    expect(countCacheControls([last])).toBe(0)
  })

  it('strips prior cache_control before adding one', () => {
    const m: Anthropic.MessageParam[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'x', cache_control: { type: 'ephemeral' } },
        ] as unknown as Anthropic.MessageParam['content'],
      },
      { role: 'assistant', content: 'y' },
    ]
    const out = applyAnthropicSingleMessagePromptCache(m, {})
    expect(countCacheControls(out)).toBe(1)
  })

  it('stripMessageContentCacheControls removes all markers', () => {
    const m: Anthropic.MessageParam[] = [
      {
        role: 'user',
        content: [{ type: 'text', text: 'x', cache_control: { type: 'ephemeral' } }] as unknown as Anthropic.MessageParam['content'],
      },
    ]
    stripMessageContentCacheControls(m)
    expect(countCacheControls(m)).toBe(0)
  })

  it('anthropicSystemWireUsesMessageLevelStyleCache detects layered system', () => {
    expect(anthropicSystemWireUsesMessageLevelStyleCache('plain')).toBe(false)
    expect(
      anthropicSystemWireUsesMessageLevelStyleCache([
        { type: 'text', text: 's', cache_control: { type: 'ephemeral' } },
      ]),
    ).toBe(true)
  })

  it('optional 1h ttl on cache_control when env set', () => {
    process.env.POLE_ANTHROPIC_PROMPT_CACHE_TTL_1H = '1'
    const out = applyAnthropicSingleMessagePromptCache([{ role: 'user', content: 'z' }], {})
    const b = (out[0]!.content as { cache_control?: { type: string; ttl?: string } }[])[0]!
    expect(b.cache_control?.ttl).toBe('1h')
  })

  it('§9.2 Bedrock alias ENABLE_PROMPT_CACHING_1H_BEDROCK with providerId bedrock', () => {
    process.env.ENABLE_PROMPT_CACHING_1H_BEDROCK = '1'
    expect(shouldUseAnthropicMessagePromptCacheTtl1h('bedrock')).toBe(true)
    expect(shouldUseAnthropicMessagePromptCacheTtl1h('anthropic')).toBe(false)
    const out = applyAnthropicSingleMessagePromptCache([{ role: 'user', content: 'z' }], {
      providerId: 'bedrock',
    })
    const b = (out[0]!.content as { cache_control?: { type: string; ttl?: string } }[])[0]!
    expect(b.cache_control?.ttl).toBe('1h')
  })

  it('Bedrock alias does not apply without providerId (non-Bedrock stream path)', () => {
    process.env.ENABLE_PROMPT_CACHING_1H_BEDROCK = '1'
    const out = applyAnthropicSingleMessagePromptCache([{ role: 'user', content: 'z' }], {})
    const b = (out[0]!.content as { cache_control?: { type: string; ttl?: string } }[])[0]!
    expect(b.cache_control?.ttl).toBeUndefined()
  })
})
