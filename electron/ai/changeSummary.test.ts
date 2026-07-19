import { describe, it, expect } from 'vitest'
import {
  buildSimpleDiff,
  formatHunksAsChangeSummary,
  summarizeContentChange,
  buildChangeSummaryTrailer,
  CHANGE_SUMMARY_MARKER_RE,
} from './changeSummary'
import { extractEditNextHint } from './toolResultBudget'

describe('changeSummary — summary rendering', () => {
  it('reports added/removed counts and hunk anchors', () => {
    const oldContent = 'a\nb\nc\nd\ne'
    const newContent = 'a\nB\nc\nd\ne\nf'
    const summary = summarizeContentChange(oldContent, newContent)
    // one line changed (b->B) plus one appended (f)
    expect(summary).toMatch(/^\+\d+\/-\d+ lines, \d+ hunk\(s\) @ L\d+/)
    expect(summary).toContain('+')
  })

  it('returns empty for a no-op change', () => {
    expect(summarizeContentChange('same\ncontent', 'same\ncontent')).toBe('')
    expect(buildChangeSummaryTrailer('x', 'x')).toBe('')
  })

  it('collapses many hunks into a "+N more" suffix', () => {
    const oldContent = Array.from({ length: 40 }, (_, i) => `line${i}`).join('\n')
    // change every 5th line to force several separated hunks
    const newContent = oldContent
      .split('\n')
      .map((l, i) => (i % 5 === 0 ? `${l}-changed` : l))
      .join('\n')
    const hunks = buildSimpleDiff(oldContent, newContent)
    const summary = formatHunksAsChangeSummary(hunks)
    expect(summary).toContain('hunk(s)')
    expect(summary).toMatch(/more|@ L/)
  })

  it('degrades to a cheap net-line delta for very large files (LCS guard)', () => {
    // Default cap is 2500 lines; go well past it.
    const big = Array.from({ length: 6000 }, (_, i) => `line${i}`).join('\n')
    const bigger = big + '\nextra1\nextra2\nextra3'
    const summary = summarizeContentChange(big, bigger)
    expect(summary).toContain('net lines')
    expect(summary).toContain('large file')
    // +3 lines appended.
    expect(summary).toContain('+3')
    // The fallback must not contain a ']' so it stays marker-safe.
    expect(summary.includes(']')).toBe(false)
  })

  it('builds a parseable [change-summary: …] trailer', () => {
    const trailer = buildChangeSummaryTrailer('a\nb', 'a\nB')
    expect(trailer.startsWith('\n[change-summary: ')).toBe(true)
    const m = trailer.match(CHANGE_SUMMARY_MARKER_RE)
    expect(m).not.toBeNull()
    expect(m![1]).toContain('lines')
  })
})

describe('changeSummary — survives truncation via extractEditNextHint', () => {
  it('preserves both the next-edit readId AND the change summary', () => {
    const editOutput =
      'Edited /w/a.ts (result 120 bytes on disk, UTF-8).' +
      '\nreadId for next edit: read-42 — REQUIRED: pass this as baseReadId on the next edit_file for this path; the previous readId is now invalid. No re-read needed before the next edit.' +
      '\n[change-summary: +8/-3 lines, 2 hunk(s) @ L120, L340]'
    const hint = extractEditNextHint(editOutput)
    expect(hint).toContain('readId for next edit: read-42')
    expect(hint).toContain('changed: +8/-3 lines, 2 hunk(s) @ L120, L340')
  })

  it('preserves the change summary even when there is no readId (write_file style)', () => {
    const writeOutput =
      'Wrote 512 characters to /w/b.ts\n[change-summary: +5/-0 lines, 1 hunk(s) @ L1]'
    const hint = extractEditNextHint(writeOutput)
    expect(hint).toBe('changed: +5/-0 lines, 1 hunk(s) @ L1')
  })

  it('preserves the must-re-read warning alongside the change summary', () => {
    const output =
      'Edited /w/c.ts (result 9 bytes on disk, UTF-8).' +
      '\nNEXT EDIT REQUIRES A FRESH read_file: the read receipt could not be refreshed.' +
      '\n[change-summary: +1/-1 lines, 1 hunk(s) @ L4]'
    const hint = extractEditNextHint(output)
    expect(hint).toContain('NEXT EDIT REQUIRES A FRESH read_file')
    expect(hint).toContain('changed: +1/-1 lines, 1 hunk(s) @ L4')
  })

  it('returns empty when neither a next-edit hint nor a change summary is present', () => {
    expect(extractEditNextHint('Read 200 lines of /w/d.ts')).toBe('')
  })
})
