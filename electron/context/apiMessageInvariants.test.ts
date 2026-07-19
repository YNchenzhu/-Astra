import { describe, it, expect } from 'vitest'
import {
  API_MAX_MEDIA_ITEMS_PER_REQUEST,
  applyAnthropicApiMessageInvariants,
  fixAssistantThinkingNotLastBlock,
  stripExcessImageBlocks,
} from './apiMessageInvariants'

describe('apiMessageInvariants', () => {
  it('fixAssistantThinkingNotLastBlock appends empty text after trailing thinking', () => {
    const messages = [
      {
        role: 'assistant' as const,
        content: [{ type: 'thinking', thinking: 'x' }],
      },
    ]
    const out = fixAssistantThinkingNotLastBlock(messages)
    const c = out[0].content as Array<{ type: string }>
    expect(c.map((b) => b.type)).toEqual(['thinking', 'text'])
  })

  it('stripExcessImageBlocks removes oldest images beyond cap', () => {
    const img = { type: 'image', source: { type: 'url', url: 'https://x' } }
    const messages = [
      { role: 'user' as const, content: [img, img, { type: 'text', text: 't' }] },
    ]
    const out = stripExcessImageBlocks(messages as unknown as Record<string, unknown>[], 1)
    const c = out[0].content as Array<{ type: string }>
    expect(c.filter((b) => b.type === 'image').length).toBe(1)
    expect((c.find((b) => b.type === 'text') as { text?: string })?.text).toBe('t')
  })

  it('applyAnthropicApiMessageInvariants runs strip then fix (default cap)', () => {
    const img = { type: 'image', source: { type: 'url', url: 'https://x' } }
    const many = Array.from({ length: API_MAX_MEDIA_ITEMS_PER_REQUEST + 2 }, () => ({ ...img }))
    const messages = [
      {
        role: 'assistant' as const,
        content: [...many, { type: 'thinking', thinking: 'z' }],
      },
    ]
    const out = applyAnthropicApiMessageInvariants(messages as unknown as Record<string, unknown>[])
    const c = out[0].content as Array<{ type: string }>
    expect(c.filter((b) => b.type === 'image').length).toBe(API_MAX_MEDIA_ITEMS_PER_REQUEST)
    expect(c[c.length - 1].type).toBe('text')
  })
})
