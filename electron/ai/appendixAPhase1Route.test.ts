import { describe, expect, it } from 'vitest'
import { classifyAppendixAPhase1Route } from './appendixAPhase1Route'

describe('appendixAPhase1Route', () => {
  it('classifies slash-like last user turn', () => {
    expect(
      classifyAppendixAPhase1Route([
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
        { role: 'user', content: '/skills foo' },
      ]),
    ).toBe('slash_like')
  })

  it('classifies text prompt', () => {
    expect(
      classifyAppendixAPhase1Route([{ role: 'user', content: 'plain question' }]),
    ).toBe('text_prompt')
  })

  it('reads text from block array', () => {
    expect(
      classifyAppendixAPhase1Route([
        {
          role: 'user',
          content: [{ type: 'text', text: '/compact' }],
        },
      ]),
    ).toBe('slash_like')
  })
})
