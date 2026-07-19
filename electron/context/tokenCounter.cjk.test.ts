import { describe, it, expect } from 'vitest'
import { estimateTextTokens } from './tokenCounter'

describe('estimateTextTokens — CJK-aware weighting', () => {
  it('keeps the legacy chars/4 estimate for pure ASCII', () => {
    expect(estimateTextTokens('x'.repeat(400))).toBe(100)
  })

  it('returns 0 for empty input', () => {
    expect(estimateTextTokens('')).toBe(0)
  })

  it('counts CJK far denser than ASCII (no longer ~chars/4)', () => {
    const cjk = '你好世界'.repeat(100) // 400 Han codepoints
    const ascii = 'x'.repeat(400)
    // ASCII stays at 100; CJK must be substantially higher (default 1.0/char
    // → ~400) so a Chinese conversation no longer under-counts ~4x.
    expect(estimateTextTokens(ascii)).toBe(100)
    expect(estimateTextTokens(cjk)).toBeGreaterThanOrEqual(400)
    expect(estimateTextTokens(cjk)).toBeGreaterThan(estimateTextTokens(ascii) * 3)
  })

  it('handles mixed CJK + ASCII without double-counting length', () => {
    // 10 Han chars (10 tokens) + 40 ascii chars (10 tokens) ≈ 20 tokens.
    const mixed = '中文字符测试一二三四' + 'a'.repeat(40)
    const t = estimateTextTokens(mixed)
    expect(t).toBeGreaterThanOrEqual(18)
    expect(t).toBeLessThanOrEqual(22)
  })

  it('counts surrogate-paired CJK Ext-B ideographs once, not twice', () => {
    // U+20000 (𠀀) is a surrogate pair: string length 2, one codepoint.
    const ext = '\u{20000}'.repeat(50)
    const t = estimateTextTokens(ext)
    // 50 codepoints at 1.0/char → 50, not 100 (which a naive length-based
    // split would yield by treating each surrogate half as a non-CJK char).
    expect(t).toBeLessThanOrEqual(55)
    expect(t).toBeGreaterThanOrEqual(50)
  })

  it('counts Japanese kana and Korean Hangul as CJK', () => {
    expect(estimateTextTokens('こんにちは'.repeat(80))).toBeGreaterThan(100)
    expect(estimateTextTokens('안녕하세요'.repeat(80))).toBeGreaterThan(100)
  })
})
