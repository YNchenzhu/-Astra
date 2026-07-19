import { describe, expect, it } from 'vitest'
import { extractSearchTerms } from './semanticContext'

describe('extractSearchTerms', () => {
  it('returns [] for empty or term-less input', () => {
    expect(extractSearchTerms('')).toEqual([])
    expect(extractSearchTerms('的 了 在 是')).toEqual([]) // all chinese stop words
  })

  it('extracts file basenames from paths', () => {
    const terms = extractSearchTerms('please open src/services/ChatInput.tsx')
    expect(terms).toContain('ChatInput.tsx')
  })

  it('extracts code identifiers but drops stop words and short tokens', () => {
    const terms = extractSearchTerms('the useChatStore function needs work')
    expect(terms).toContain('useChatStore')
    expect(terms).not.toContain('the')
    expect(terms).not.toContain('function')
  })

  it('extracts quoted strings', () => {
    const terms = extractSearchTerms('look at "buildContext" please')
    expect(terms).toContain('buildContext')
  })

  it('dedupes case-insensitively, keeping first-seen casing', () => {
    const terms = extractSearchTerms('FooBar foobar FOOBAR')
    const lowered = terms.map((t) => t.toLowerCase())
    expect(lowered.filter((t) => t === 'foobar')).toHaveLength(1)
    expect(terms).toContain('FooBar')
  })

  it('filters out windows path-segment noise', () => {
    const terms = extractSearchTerms('C:\\Users\\TestUser\\Desktop\\projects\\thingDoer')
    expect(terms).not.toContain('Users')
    expect(terms).not.toContain('Desktop')
    expect(terms).not.toContain('TestUser')
    expect(terms).toContain('thingDoer')
  })

  it('limits to at most 5 terms, prioritizing longer ones', () => {
    const terms = extractSearchTerms(
      'alphaIdentifier betaIdentifier gammaIdentifier deltaIdentifier epsilonIdentifier zetaIdentifier etaX',
    )
    expect(terms.length).toBeLessThanOrEqual(5)
    // The shortest token (etaX) should be dropped before the longer ones.
    expect(terms).not.toContain('etaX')
  })

  it('is sorted by descending length', () => {
    const terms = extractSearchTerms('shortWord aMuchLongerIdentifierHere midLengthOne')
    for (let i = 1; i < terms.length; i++) {
      expect(terms[i - 1].length).toBeGreaterThanOrEqual(terms[i].length)
    }
  })
})
