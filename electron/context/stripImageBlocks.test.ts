import { describe, it, expect } from 'vitest'
import { stripImageBlocks } from './stripImageBlocks'

describe('stripImageBlocks', () => {
  it('returns same reference when nothing to strip', () => {
    const msgs = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    ]
    const result = stripImageBlocks(msgs)
    expect(result.strippedCount).toBe(0)
    expect(result.messages).toBe(msgs)
  })

  it('strips top-level Anthropic image blocks', () => {
    const msgs = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Look at this' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: '...' } },
        ],
      },
    ]
    const result = stripImageBlocks(msgs)
    expect(result.strippedCount).toBe(1)
    expect(result.messages).not.toBe(msgs)
    expect((result.messages[0].content as Array<Record<string, unknown>>).length).toBe(1)
    expect((result.messages[0].content as Array<Record<string, unknown>>)[0].type).toBe('text')
  })

  it('strips OpenAI image_url blocks', () => {
    const msgs = [
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: 'data:image/png;base64,...' } },
          { type: 'text', text: 'Caption?' },
        ],
      },
    ]
    const result = stripImageBlocks(msgs)
    expect(result.strippedCount).toBe(1)
    expect((result.messages[0].content as Array<Record<string, unknown>>).length).toBe(1)
  })

  it('strips images nested inside tool_result content arrays', () => {
    const msgs = [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_x',
            content: [
              { type: 'text', text: 'OK' },
              { type: 'image', source: { type: 'base64', data: '...' } },
            ],
          },
        ],
      },
    ]
    const result = stripImageBlocks(msgs)
    expect(result.strippedCount).toBe(1)
    const tr = (result.messages[0].content as Array<Record<string, unknown>>)[0]
    expect(Array.isArray((tr as { content: unknown }).content)).toBe(true)
    expect((tr as { content: Array<Record<string, unknown>> }).content.length).toBe(1)
  })

  it('replaces emptied messages with placeholder text', () => {
    const msgs = [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', data: '...' } },
        ],
      },
    ]
    const result = stripImageBlocks(msgs)
    expect(result.strippedCount).toBe(1)
    const blocks = result.messages[0].content as Array<Record<string, unknown>>
    expect(blocks.length).toBe(1)
    expect(blocks[0].type).toBe('text')
    expect((blocks[0] as { text: string }).text).toMatch(/image stripped/i)
  })

  it('replaces emptied tool_result content with placeholder', () => {
    const msgs = [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_x',
            content: [{ type: 'image', source: { type: 'base64', data: '...' } }],
          },
        ],
      },
    ]
    const result = stripImageBlocks(msgs)
    expect(result.strippedCount).toBe(1)
    const tr = (result.messages[0].content as Array<Record<string, unknown>>)[0] as {
      content: Array<Record<string, unknown>>
    }
    expect(tr.content.length).toBe(1)
    expect(tr.content[0].type).toBe('text')
  })

  it('counts every image stripped across multiple messages and providers', () => {
    const msgs = [
      {
        role: 'user',
        content: [
          { type: 'image', source: { data: '1' } },
          { type: 'text', text: 'a' },
        ],
      },
      {
        role: 'assistant',
        content: [
          { type: 'image_url', image_url: { url: 'b' } },
          { type: 'media', mime: 'audio/wav', data: 'c' },
          { type: 'text', text: 'd' },
        ],
      },
    ]
    const result = stripImageBlocks(msgs)
    expect(result.strippedCount).toBe(3)
  })

  it('does not modify input array (immutability)', () => {
    const msgs = [
      {
        role: 'user',
        content: [{ type: 'image', source: { data: 'x' } }],
      },
    ]
    const before = JSON.stringify(msgs)
    stripImageBlocks(msgs)
    expect(JSON.stringify(msgs)).toBe(before)
  })
})
