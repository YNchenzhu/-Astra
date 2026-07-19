import { describe, it, expect } from 'vitest'
import { sanitizeUntrustedText, summarizeFindings } from './sanitizeUntrustedText'

describe('sanitizeUntrustedText', () => {
  it('passes clean ASCII through unchanged', () => {
    const r = sanitizeUntrustedText('Hello, world!')
    expect(r.cleaned).toBe('Hello, world!')
    expect(r.findings).toEqual([])
    expect(r.totalStripped).toBe(0)
  })

  it('passes clean CJK through unchanged', () => {
    const r = sanitizeUntrustedText('你好，世界！')
    expect(r.cleaned).toBe('你好，世界！')
    expect(r.totalStripped).toBe(0)
  })

  it('strips Tag characters (the canonical hidden-prompt vector)', () => {
    // U+E0041 ('A' tag) + U+E0042 ('B' tag) + U+E007F (cancel tag)
    const dirty = `Read me${String.fromCodePoint(0xE0041, 0xE0042, 0xE007F)}fine`
    const r = sanitizeUntrustedText(dirty)
    expect(r.cleaned).toBe('Read mefine')
    expect(r.totalStripped).toBe(3)
    const tag = r.findings.find((f) => f.category === 'tagChar')
    expect(tag?.count).toBe(3)
    expect(tag?.codepoints).toEqual(['U+E0041', 'U+E0042', 'U+E007F'])
  })

  it('strips Bidi control characters (Trojan-Source family)', () => {
    // LRO (U+202D) + payload + PDF (U+202C)
    const dirty = 'safe\u202Dhidden-reorder\u202Crest'
    const r = sanitizeUntrustedText(dirty)
    expect(r.cleaned).toBe('safehidden-reorderrest')
    const bidi = r.findings.find((f) => f.category === 'bidiControl')
    expect(bidi?.count).toBe(2)
  })

  it('strips zero-width characters (ZWSP / ZWNJ / ZWJ)', () => {
    const dirty = 'a\u200Bb\u200Cc\u200Dd'
    const r = sanitizeUntrustedText(dirty)
    expect(r.cleaned).toBe('abcd')
    const zw = r.findings.find((f) => f.category === 'zeroWidth')
    expect(zw?.count).toBe(3)
  })

  it('strips BOM / U+FEFF wherever it appears', () => {
    const dirty = '\uFEFFhello\uFEFFworld'
    const r = sanitizeUntrustedText(dirty)
    expect(r.cleaned).toBe('helloworld')
    const bom = r.findings.find((f) => f.category === 'bom')
    expect(bom?.count).toBe(2)
  })

  it('strips Mongolian Vowel Separator', () => {
    const dirty = 'a\u180Eb'
    const r = sanitizeUntrustedText(dirty)
    expect(r.cleaned).toBe('ab')
    expect(r.findings.find((f) => f.category === 'mongolianVowelSeparator')?.count).toBe(1)
  })

  it('does NOT strip emoji Variation Selectors (legitimate use)', () => {
    // ❤️ = U+2764 + U+FE0F (VS-16, emoji presentation)
    const text = '\u2764\uFE0F love'
    const r = sanitizeUntrustedText(text)
    expect(r.cleaned).toBe(text)
    expect(r.totalStripped).toBe(0)
  })

  it('does NOT strip Word Joiner U+2060 (legitimate line-break control)', () => {
    const text = 'no\u2060break'
    const r = sanitizeUntrustedText(text)
    expect(r.cleaned).toBe(text)
    expect(r.totalStripped).toBe(0)
  })

  it('does NOT strip Soft Hyphen U+00AD (legitimate typography)', () => {
    const text = 'long\u00ADword'
    const r = sanitizeUntrustedText(text)
    expect(r.cleaned).toBe(text)
    expect(r.totalStripped).toBe(0)
  })

  it('aggregates multiple categories in a single pass', () => {
    const dirty = `start${String.fromCodePoint(0xE0041)}\u202E\u200Bend\uFEFF`
    const r = sanitizeUntrustedText(dirty)
    expect(r.cleaned).toBe('startend')
    expect(r.totalStripped).toBe(4)
    expect(r.findings.length).toBe(4)
  })

  it('handles non-string defensively', () => {
    const r = sanitizeUntrustedText(null as unknown as string)
    expect(r.cleaned).toBe('')
    expect(r.findings).toEqual([])
  })

  it('caps reported codepoints at 4 with ellipsis hint in summary', () => {
    // 6 distinct tag-chars
    const dirty = String.fromCodePoint(0xE0041, 0xE0042, 0xE0043, 0xE0044, 0xE0045, 0xE0046)
    const r = sanitizeUntrustedText(dirty)
    const tag = r.findings.find((f) => f.category === 'tagChar')
    expect(tag?.count).toBe(6)
    expect(tag?.codepoints.length).toBe(4)
    const summary = summarizeFindings(r.findings)
    expect(summary).toMatch(/tagChar=6/)
    expect(summary).toContain(',…')
  })
})

describe('summarizeFindings', () => {
  it('returns empty string when no findings', () => {
    expect(summarizeFindings([])).toBe('')
  })

  it('joins multiple findings with `; `', () => {
    const r = sanitizeUntrustedText('a\u202Eb\u200Bc')
    const summary = summarizeFindings(r.findings)
    expect(summary).toContain('bidiControl=1')
    expect(summary).toContain('zeroWidth=1')
    expect(summary).toContain('; ')
  })
})
