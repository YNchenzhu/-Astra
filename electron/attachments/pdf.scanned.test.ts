/**
 * 2026-07 富文件审计修复回归 —— 扫描 PDF 检测启发式。
 *
 * P0 bug:旧正则 `\[(Truncated|PDF[^\]]*)\]` 匹配不到 extractPdfText 的
 * 无文本占位符 `[No extractable text — PDF may be scanned/encrypted]`,
 * 导致典型扫描件被判定为"有文本",页面渲染 fallback 永远不触发。
 */

import { describe, it, expect } from 'vitest'
import { looksLikeScannedText } from './pdf'

describe('looksLikeScannedText', () => {
  it('空文本 → 扫描件', () => {
    expect(looksLikeScannedText('')).toBe(true)
  })

  it('P0 回归:无文本占位符 → 扫描件(旧实现返回 false)', () => {
    expect(
      looksLikeScannedText('[No extractable text — PDF may be scanned/encrypted]'),
    ).toBe(true)
  })

  it('解析失败占位符 → 扫描件(触发页面渲染兜底)', () => {
    expect(looksLikeScannedText('[PDF parse failed: bad xref]')).toBe(true)
  })

  it('仅页标记 + 少量噪声字符 → 扫描件', () => {
    expect(looksLikeScannedText('--- Page 1 ---\n \u00a0\n--- Page 2 ---\n.')).toBe(true)
  })

  it('带冒号的 Truncated 标记也会被剥离后判定', () => {
    expect(
      looksLikeScannedText('[Truncated: showed first 200 of 300 pages]'),
    ).toBe(true)
  })

  it('真实文本 → 非扫描件', () => {
    const text = '--- Page 1 ---\n本文档介绍了系统架构与部署方式,共分为五个章节。'
    expect(looksLikeScannedText(text)).toBe(false)
  })

  it('文本 + 截断标记混合 → 非扫描件', () => {
    const text =
      '--- Page 1 ---\nReal extracted paragraph with plenty of characters here.\n' +
      '[Truncated: text budget (80,000 chars) reached at page 3 of 500; remaining pages omitted]'
    expect(looksLikeScannedText(text)).toBe(false)
  })
})
