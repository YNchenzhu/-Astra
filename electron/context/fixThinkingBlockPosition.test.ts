import { describe, expect, it } from 'vitest'
import { fixThinkingBlockPosition } from './fixThinkingBlockPosition'

describe('fixThinkingBlockPosition', () => {
  it('appends trailing text when assistant ends with thinking', () => {
    const messages: Array<Record<string, unknown>> = [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'plan' },
        ],
      },
    ]
    const out = fixThinkingBlockPosition(messages)
    const blocks = out[0].content as Record<string, unknown>[]
    expect(blocks).toHaveLength(2)
    expect(blocks[1].type).toBe('text')
  })

  it('does not modify when last block is text', () => {
    const messages: Array<Record<string, unknown>> = [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'x' },
          { type: 'text', text: 'hi' },
        ],
      },
    ]
    const out = fixThinkingBlockPosition(messages)
    expect((out[0].content as unknown[]).length).toBe(2)
  })

  it('handles redacted_thinking', () => {
    const messages: Array<Record<string, unknown>> = [
      { role: 'assistant', content: [{ type: 'redacted_thinking', data: 'abc' }] },
    ]
    const out = fixThinkingBlockPosition(messages)
    const blocks = out[0].content as Record<string, unknown>[]
    expect(blocks[blocks.length - 1].type).toBe('text')
  })
})
