/**
 * informativeTokens — shared CJK-aware overlap comparator (extracted
 * 2026-07 会话审计 A2) + the F2 cross-script comparability check.
 *
 * The comparator itself has legacy coverage via
 * `objectiveConflict.test.ts` (re-exports); this file adds direct
 * coverage for the extraction seam and `scriptsAreIncomparable`.
 */

import { describe, expect, it } from 'vitest'
import {
  MIN_INFORMATIVE_TOKENS,
  informativeTokens,
  looksLikeDirectionChange,
  scriptsAreIncomparable,
} from './informativeTokens'

describe('informativeTokens', () => {
  it('extracts ASCII words (≥3 chars) and CJK bigrams', () => {
    const tokens = informativeTokens('修复 checkout 的重试逻辑')
    expect(tokens.has('checkout')).toBe(true)
    expect(tokens.has('修复')).toBe(true)
    expect(tokens.has('重试')).toBe(true)
  })

  it('MIN_INFORMATIVE_TOKENS floor keeps short texts from ever triggering', () => {
    expect(looksLikeDirectionChange('继续', '完全不相关的另一个任务描述在此')).toBe(false)
    expect(MIN_INFORMATIVE_TOKENS).toBe(3)
  })
})

describe('scriptsAreIncomparable (F2)', () => {
  it('true for pure-CJK vs pure-Latin', () => {
    expect(
      scriptsAreIncomparable(
        '请优化仪表盘的加载性能，目标一秒以内',
        'User wants the dashboard to load in under one second',
      ),
    ).toBe(true)
  })

  it('false when either text mixes scripts (shared surface exists)', () => {
    expect(
      scriptsAreIncomparable(
        '请优化 dashboard 的加载性能',
        'User wants the dashboard to load fast',
      ),
    ).toBe(false)
  })

  it('false for same-script pairs (normal comparison proceeds)', () => {
    expect(
      scriptsAreIncomparable('重构退款逻辑', '修复登录白屏问题'),
    ).toBe(false)
    expect(
      scriptsAreIncomparable('fix the login bug', 'refactor refund flow'),
    ).toBe(false)
  })
})
