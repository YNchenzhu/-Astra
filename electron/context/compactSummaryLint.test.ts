/**
 * Compact summary fact-lint (#11, 2026-07 deep-loop uplift) tests.
 */

import { afterEach, describe, expect, it } from 'vitest'
import {
  MAX_UNVERIFIED_PATHS_LISTED,
  SUMMARY_FACT_CHECK_OPEN_TAG,
  buildSummaryFactLintAnnotation,
  buildToolActivityCorpus,
} from './compactSummaryLint'

type Msg = Record<string, unknown>

const toolUseMsg = (name: string, input: Record<string, unknown>): Msg => ({
  role: 'assistant',
  content: [{ type: 'tool_use', id: `tu_${name}`, name, input }],
})

const toolResultMsg = (id: string, content: string): Msg => ({
  role: 'user',
  content: [{ type: 'tool_result', tool_use_id: id, content }],
})

afterEach(() => {
  delete process.env.POLE_COMPACT_SUMMARY_LINT
})

describe('buildToolActivityCorpus', () => {
  it('returns null for a window without tool_use (lint skipped)', () => {
    expect(
      buildToolActivityCorpus([
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: [{ type: 'text', text: 'hello src/a.ts' }] },
      ]),
    ).toBeNull()
  })

  it('collects tool inputs and result bodies, normalized', () => {
    const corpus = buildToolActivityCorpus([
      toolUseMsg('edit_file', { file_path: 'G:\\ws\\SRC\\App.tsx' }),
      toolResultMsg('tu_edit_file', 'Edited OK'),
    ])
    expect(corpus).not.toBeNull()
    expect(corpus!).toContain('g:/ws/src/app.tsx')
    expect(corpus!).toContain('edited ok')
  })
})

describe('buildSummaryFactLintAnnotation', () => {
  const window = [
    toolUseMsg('edit_file', { file_path: 'src/payments/checkout.ts' }),
    toolResultMsg('tu_edit_file', 'Edited src/payments/checkout.ts (+3/-1)'),
  ]

  it('annotates paths the summary claims but the window never touched', () => {
    const summary =
      '完成情况:修复了 src/payments/checkout.ts 的空指针;同时重构了 src/payments/refund.ts 并全部通过测试。'
    const out = buildSummaryFactLintAnnotation(summary, window)
    expect(out).toContain(SUMMARY_FACT_CHECK_OPEN_TAG)
    expect(out).toContain('src/payments/refund.ts')
    expect(out).not.toContain('checkout.ts')
    expect(out).toContain('UNVERIFIED')
  })

  it('returns empty when every claimed path is traceable', () => {
    const summary = 'Fixed the NPE in src/payments/checkout.ts.'
    expect(buildSummaryFactLintAnnotation(summary, window)).toBe('')
  })

  it('basename fallback absorbs absolute-vs-relative differences', () => {
    const absWindow = [
      toolUseMsg('edit_file', { file_path: 'G:\\repo\\deep\\nested\\checkout.ts' }),
    ]
    const summary = 'Edited src/payments/checkout.ts.'
    expect(buildSummaryFactLintAnnotation(summary, absWindow)).toBe('')
  })

  it('skips windows without any tool activity', () => {
    const summary = 'Discussed src/never-touched.ts at length.'
    expect(
      buildSummaryFactLintAnnotation(summary, [{ role: 'user', content: 'chat' }]),
    ).toBe('')
  })

  it('returns empty for summaries without path claims (prose sessions)', () => {
    expect(
      buildSummaryFactLintAnnotation('润色了第三章,统一了语气。', window),
    ).toBe('')
  })

  it('caps the listed paths', () => {
    const many = Array.from(
      { length: MAX_UNVERIFIED_PATHS_LISTED + 5 },
      (_, i) => `claimed edit of src/ghost/file${i}.ts`,
    ).join('; ')
    const out = buildSummaryFactLintAnnotation(many, window)
    const listed = out.split('\n').filter((l) => l.startsWith('- src/ghost/'))
    expect(listed.length).toBeLessThanOrEqual(MAX_UNVERIFIED_PATHS_LISTED)
    expect(out).toContain('more')
  })

  it('honours the POLE_COMPACT_SUMMARY_LINT=0 kill-switch', () => {
    process.env.POLE_COMPACT_SUMMARY_LINT = '0'
    const summary = 'Refactored src/payments/refund.ts.'
    expect(buildSummaryFactLintAnnotation(summary, window)).toBe('')
  })
})
