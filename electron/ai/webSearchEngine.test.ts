/**
 * Tests for the Web Search engine router + Baidu key shape + CJK detection.
 *
 * Keeps {@link pickWebSearchEngine}'s precedence rules locked down so a
 * future refactor can't silently change which provider handles which query
 * shape. The CJK bias heuristic is particularly easy to regress because
 * it's all about ratios.
 */

import { describe, it, expect } from 'vitest'
import {
  BAIDU_API_KEY_MIN_LENGTH,
  BAIDU_API_KEY_PREFIX,
  detectBaiduKeyShapeWarnings,
  pickWebSearchEngine,
} from './advancedTools'

describe('detectBaiduKeyShapeWarnings', () => {
  it('no warnings for a well-formed bce-v3/ALTAK-xxx key', () => {
    const good = BAIDU_API_KEY_PREFIX + 'abcdefgh' // >= 13 + 8 = 21 chars
    expect(detectBaiduKeyShapeWarnings(good)).toEqual([])
  })

  it('accepts `/`, `-`, `_`, `.` inside the body (official charset)', () => {
    expect(
      detectBaiduKeyShapeWarnings(BAIDU_API_KEY_PREFIX + 'abc/def-gh_ij.kl'),
    ).toEqual([])
  })

  it('flags too-short below the documented minimum', () => {
    expect(detectBaiduKeyShapeWarnings('bce-v3/ALTA')).toEqual([
      'too-short',
      'wrong-prefix',
    ])
  })

  it('flags wrong-prefix when missing bce-v3/ALTAK-', () => {
    // 21 chars → not too-short, but wrong prefix.
    const k = 'x'.repeat(BAIDU_API_KEY_MIN_LENGTH)
    expect(detectBaiduKeyShapeWarnings(k)).toEqual(['wrong-prefix'])
  })

  it('flags invalid-charset on whitespace / symbols', () => {
    const k = BAIDU_API_KEY_PREFIX + 'abc def 1234 ' // has spaces
    expect(detectBaiduKeyShapeWarnings(k)).toEqual(['invalid-charset'])
  })
})

describe('pickWebSearchEngine', () => {
  const ENGLISH = 'latest news about typescript 5.5'
  const CHINESE = '人工智能在 2025 年的最新进展'

  it('explicit brave → brave when key present, else ddg', () => {
    expect(
      pickWebSearchEngine({
        engine: 'brave',
        query: ENGLISH,
        braveKeyPresent: true,
        baiduKeyPresent: false,
      }),
    ).toBe('brave')
    expect(
      pickWebSearchEngine({
        engine: 'brave',
        query: ENGLISH,
        braveKeyPresent: false,
        baiduKeyPresent: true,
      }),
    ).toBe('ddg')
  })

  it('explicit baidu → baidu when key present, else ddg', () => {
    expect(
      pickWebSearchEngine({
        engine: 'baidu',
        query: ENGLISH,
        braveKeyPresent: true,
        baiduKeyPresent: true,
      }),
    ).toBe('baidu')
    expect(
      pickWebSearchEngine({
        engine: 'baidu',
        query: CHINESE,
        braveKeyPresent: true,
        baiduKeyPresent: false,
      }),
    ).toBe('ddg')
  })

  it('explicit ddg always returns ddg', () => {
    expect(
      pickWebSearchEngine({
        engine: 'ddg',
        query: ENGLISH,
        braveKeyPresent: true,
        baiduKeyPresent: true,
      }),
    ).toBe('ddg')
  })

  it('auto + Chinese query + Baidu key → Baidu (CJK bias)', () => {
    expect(
      pickWebSearchEngine({
        engine: 'auto',
        query: CHINESE,
        braveKeyPresent: true,
        baiduKeyPresent: true,
      }),
    ).toBe('baidu')
  })

  it('auto + English query + Brave key → Brave', () => {
    expect(
      pickWebSearchEngine({
        engine: 'auto',
        query: ENGLISH,
        braveKeyPresent: true,
        baiduKeyPresent: true,
      }),
    ).toBe('brave')
  })

  it('auto + Chinese query + ONLY Brave key → Brave (no Baidu to use)', () => {
    expect(
      pickWebSearchEngine({
        engine: 'auto',
        query: CHINESE,
        braveKeyPresent: true,
        baiduKeyPresent: false,
      }),
    ).toBe('brave')
  })

  it('auto + English query + ONLY Baidu key → Baidu', () => {
    expect(
      pickWebSearchEngine({
        engine: 'auto',
        query: ENGLISH,
        braveKeyPresent: false,
        baiduKeyPresent: true,
      }),
    ).toBe('baidu')
  })

  it('auto + no keys → ddg (free fallback)', () => {
    expect(
      pickWebSearchEngine({
        engine: 'auto',
        query: ENGLISH,
        braveKeyPresent: false,
        baiduKeyPresent: false,
      }),
    ).toBe('ddg')
  })

  it('auto + mixed query (30%+ CJK) → Baidu when available', () => {
    // "TypeScript 编译器优化" — ~40% CJK, should route to Baidu.
    expect(
      pickWebSearchEngine({
        engine: 'auto',
        query: 'TypeScript 编译器优化指南',
        braveKeyPresent: true,
        baiduKeyPresent: true,
      }),
    ).toBe('baidu')
  })

  it('auto + mostly-Latin query with 1-2 CJK chars → stays with Brave', () => {
    // Under the 30% CJK threshold — stays on Brave.
    expect(
      pickWebSearchEngine({
        engine: 'auto',
        query: 'open-source typescript linter comparison 对比',
        braveKeyPresent: true,
        baiduKeyPresent: true,
      }),
    ).toBe('brave')
  })

  it('missing engine is treated as auto', () => {
    expect(
      pickWebSearchEngine({
        engine: undefined,
        query: CHINESE,
        braveKeyPresent: true,
        baiduKeyPresent: true,
      }),
    ).toBe('baidu')
  })
})
