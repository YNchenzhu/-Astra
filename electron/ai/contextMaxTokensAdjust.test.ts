import { describe, it, expect } from 'vitest'
import { suggestReducedMaxTokensForContextError } from './contextMaxTokensAdjust'

describe('suggestReducedMaxTokensForContextError', () => {
  it('returns null when current max_tokens is at floor', () => {
    expect(suggestReducedMaxTokensForContextError(new Error('max_tokens too large'), 3000)).toBeNull()
  })

  it('returns null when message lacks context hints', () => {
    expect(suggestReducedMaxTokensForContextError(new Error('unknown failure'), 8192)).toBeNull()
  })

  it('halves max_tokens on generic context overload message', () => {
    expect(
      suggestReducedMaxTokensForContextError(
        new Error('Request exceeds the context window limit'),
        8192,
      ),
    ).toBe(4096)
  })

  it('matches §12.6 input length + max_tokens exceed context limit phrasing', () => {
    const err = new Error(
      'input length and max_tokens exceed context limit: reduce max_tokens or input size',
    )
    expect(suggestReducedMaxTokensForContextError(err, 8192)).toBe(4096)
  })

  it('uses parsed limit and input when present', () => {
    const msg =
      'input tokens is 90000 and limit is 100000 please reduce max_tokens or shorten prompt'
    // Room after input + safety is 8976; need currentMaxTokens above that so min() actually drops.
    const reduced = suggestReducedMaxTokensForContextError(new Error(msg), 16_384)
    expect(reduced).toBe(9000)
  })
})
