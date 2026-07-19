import { describe, it, expect } from 'vitest'
import { estimateContentBlockTokens, estimateMessageTokens } from './tokenCounter'

describe('tokenCounter content blocks §3.2', () => {
  it('counts tool_use name in addition to input JSON', () => {
    const withName = estimateContentBlockTokens({
      type: 'tool_use',
      name: 'Read',
      input: { path: 'x' },
    })
    const emptyName = estimateContentBlockTokens({
      type: 'tool_use',
      name: '',
      input: { path: 'x' },
    })
    expect(withName).toBeGreaterThan(emptyName)
  })

  it('estimates redacted_thinking data length', () => {
    const data = 'b'.repeat(400)
    const t = estimateContentBlockTokens({
      type: 'redacted_thinking',
      data,
    })
    expect(t).toBeGreaterThan(0)
  })

  it('assistant message aggregates redacted_thinking block', () => {
    const tok = estimateMessageTokens({
      role: 'assistant',
      content: [{ type: 'redacted_thinking', data: 'c'.repeat(100) }],
    })
    expect(tok).toBeGreaterThan(0)
  })
})
