/**
 * Tests for the P4a-backed `computeDiff` (+ `applyAcceptedHunks`) in services/diff.
 *
 * These exist specifically to pin down the public shape (`DiffResult` — `diffLines`,
 * `hunks`, `stats`) so the internal engine swap from LCS to P4a did not change anything
 * that the app's renderer code observes.
 *
 * What we cover:
 *   • Basic diff cases: single-line modify, pure insertion, pure deletion, empty files.
 *   • Tail-newline parity — the trickiest compatibility dimension. The old LCS treated
 *     `"a\n".split('\n')` as `['a', '']` and thus emitted a trailing `equal ''`; our
 *     synthesis must match for ComposerPanel's line-by-line renderer to look the same.
 *   • Stats sums added/removed line counts across all hunks.
 *   • Hunk ids are stable and sequential (the pre-swap version used Date.now() → a new
 *     id every call; the new version yields `hunk-0`, `hunk-1`, which is a strict
 *     upgrade but we assert the shape).
 *   • `applyAcceptedHunks` round-trips: full-accept → modified, empty-accept → original.
 *   • MAX_DIFF_COMBINED_LINES budget still kicks in.
 */

import { describe, expect, it } from 'vitest'
import {
  MAX_DIFF_COMBINED_LINES,
  applyAcceptedHunks,
  computeDiff,
} from './DiffComputationService'

describe('computeDiff — structural shape', () => {
  it('returns three top-level fields: diffLines / hunks / stats', () => {
    const r = computeDiff('a\n', 'a\n')
    expect(r.diffLines).toBeInstanceOf(Array)
    expect(r.hunks).toBeInstanceOf(Array)
    expect(r.stats).toMatchObject({ added: expect.any(Number), removed: expect.any(Number), hunks: expect.any(Number) })
  })

  it('no diff → zero hunks, stats all zero, diffLines is all equal lines', () => {
    const r = computeDiff('a\nb\nc\n', 'a\nb\nc\n')
    expect(r.hunks).toEqual([])
    expect(r.stats).toEqual({ added: 0, removed: 0, hunks: 0 })
    for (const dl of r.diffLines) expect(dl.op).toBe('equal')
  })
})

describe('computeDiff — hunk shapes', () => {
  it('single-line modify yields one modify hunk with correct ranges', () => {
    const r = computeDiff('a\nb\nc\n', 'a\nB\nc\n')
    expect(r.hunks).toHaveLength(1)
    const h = r.hunks[0]!
    expect(h.type).toBe('modify')
    expect(h.originalLines).toEqual(['b'])
    expect(h.modifiedLines).toEqual(['B'])
    // 0-based inclusive start, 0-based exclusive end.
    expect(h.origStartLine).toBe(1)
    expect(h.origEndLine).toBe(2)
    expect(h.modStartLine).toBe(1)
    expect(h.modEndLine).toBe(2)
  })

  it('pure insertion yields an "add" hunk with zero-length orig range', () => {
    const r = computeDiff('a\nb\n', 'a\nINS\nb\n')
    expect(r.hunks).toHaveLength(1)
    const h = r.hunks[0]!
    expect(h.type).toBe('add')
    expect(h.originalLines).toEqual([])
    expect(h.modifiedLines).toEqual(['INS'])
    expect(h.origStartLine).toBe(h.origEndLine)
  })

  it('pure deletion yields a "delete" hunk with zero-length modified range', () => {
    const r = computeDiff('a\nX\nb\n', 'a\nb\n')
    expect(r.hunks).toHaveLength(1)
    const h = r.hunks[0]!
    expect(h.type).toBe('delete')
    expect(h.originalLines).toEqual(['X'])
    expect(h.modifiedLines).toEqual([])
    expect(h.modStartLine).toBe(h.modEndLine)
  })

  it('multiple non-adjacent hunks come out in order by origStartLine', () => {
    const base = ['a', 'b', 'c', 'd', 'e', 'f'].join('\n') + '\n'
    const mod = ['A', 'b', 'c', 'd', 'e', 'F'].join('\n') + '\n'
    const r = computeDiff(base, mod)
    expect(r.hunks).toHaveLength(2)
    expect(r.hunks[0]!.origStartLine).toBeLessThan(r.hunks[1]!.origStartLine)
  })

  it('hunk ids are stable and sequential (hunk-0, hunk-1, ...)', () => {
    const r = computeDiff('a\nb\nc\n', 'A\nb\nC\n')
    expect(r.hunks.map((h) => h.id)).toEqual(['hunk-0', 'hunk-1'])
  })
})

describe('computeDiff — diffLines synthesis', () => {
  it('simple modify produces [eq, del, add, eq, eq] order matching LCS output', () => {
    const r = computeDiff('a\nb\nc\n', 'a\nB\nc\n')
    // Expected ops-in-order: equal(a), delete(b), add(B), equal(c), equal('')
    const ops = r.diffLines.map((d) => d.op)
    expect(ops).toEqual(['equal', 'delete', 'add', 'equal', 'equal'])
    expect(r.diffLines[0]!.text).toBe('a')
    expect(r.diffLines[1]!.text).toBe('b')
    expect(r.diffLines[2]!.text).toBe('B')
    expect(r.diffLines[3]!.text).toBe('c')
    expect(r.diffLines[4]!.text).toBe('') // tail-newline parity
  })

  it('pure insertion: [eq, add, eq, eq]', () => {
    const r = computeDiff('a\nb\n', 'a\nINS\nb\n')
    const ops = r.diffLines.map((d) => d.op)
    expect(ops).toEqual(['equal', 'add', 'equal', 'equal'])
    expect(r.diffLines[1]!.text).toBe('INS')
  })

  it('pure deletion: [eq, del, eq, eq]', () => {
    const r = computeDiff('a\nX\nb\n', 'a\nb\n')
    const ops = r.diffLines.map((d) => d.op)
    expect(ops).toEqual(['equal', 'delete', 'equal', 'equal'])
    expect(r.diffLines[1]!.text).toBe('X')
  })

  it('tail-appended insertion: [eq, eq, add, eq]', () => {
    const r = computeDiff('a\nb\n', 'a\nb\nAPP\n')
    const ops = r.diffLines.map((d) => d.op)
    expect(ops).toEqual(['equal', 'equal', 'add', 'equal'])
  })

  it('tail-newline parity: both sides end in \\n → synthesises trailing equal ""', () => {
    const r = computeDiff('a\n', 'a\n')
    const lastOp = r.diffLines.at(-1)
    expect(lastOp).toEqual({ op: 'equal', text: '' })
  })

  it('no tail newline on either side → no synthesised trailing empty line', () => {
    const r = computeDiff('a', 'a')
    for (const dl of r.diffLines) {
      expect(dl.text).not.toBe('')
    }
  })

  it('inserting at position 0 (empty base, non-empty mod)', () => {
    const r = computeDiff('', 'x\ny\n')
    const ops = r.diffLines.map((d) => d.op)
    expect(ops.every((o) => o === 'add' || o === 'equal')).toBe(true)
    const addedTexts = r.diffLines.filter((d) => d.op === 'add').map((d) => d.text)
    expect(addedTexts).toContain('x')
    expect(addedTexts).toContain('y')
  })
})

describe('computeDiff — stats', () => {
  it('stats sum added/removed line counts across hunks', () => {
    const base = 'a\nb\nc\nd\n'
    const mod = 'a\nB\nc\nD\nE\n'
    const r = computeDiff(base, mod)
    // b→B and d→D (2 modifies: 2 added, 2 removed) + tail E append (1 added, 0 removed).
    expect(r.stats.added).toBe(3)
    expect(r.stats.removed).toBe(2)
    expect(r.stats.hunks).toBe(r.hunks.length)
  })

  it('identical inputs → all zero stats', () => {
    const r = computeDiff('same\ncontent\n', 'same\ncontent\n')
    expect(r.stats).toEqual({ added: 0, removed: 0, hunks: 0 })
  })
})

describe('computeDiff — budget guard', () => {
  it('rejects inputs over MAX_DIFF_COMBINED_LINES combined', () => {
    // Build two files whose combined line count crosses the budget.
    const big = 'x\n'.repeat(MAX_DIFF_COMBINED_LINES + 1)
    const r = computeDiff(big, big.slice(0, -2))
    expect(r.hunks).toEqual([])
    expect(r.diffLines).toEqual([])
    expect(r.stats).toEqual({ added: 0, removed: 0, hunks: 0 })
  })
})

describe('applyAcceptedHunks — round trip', () => {
  it('empty accepted set → original content', () => {
    const base = 'a\nb\nc\n'
    const mod = 'a\nB\nC\n'
    const result = applyAcceptedHunks(base, mod, new Set())
    expect(result).toBe(base)
  })

  it('all hunks accepted → modified content', () => {
    const base = 'a\nb\nc\n'
    const mod = 'a\nB\nC\n'
    const { hunks } = computeDiff(base, mod)
    const ids = new Set(hunks.map((h) => h.id))
    expect(applyAcceptedHunks(base, mod, ids)).toBe(mod)
  })

  it('selective subset: accepting only the first hunk leaves the second as original', () => {
    const base = 'a\nb\nc\nd\n'
    const mod = 'a\nB\nc\nD\n'
    const { hunks } = computeDiff(base, mod)
    expect(hunks).toHaveLength(2)
    const firstOnly = new Set([hunks[0]!.id])
    const result = applyAcceptedHunks(base, mod, firstOnly)
    expect(result).toBe('a\nB\nc\nd\n')
  })

  it('preserves CRLF line endings of the base', () => {
    const base = 'a\r\nb\r\nc\r\n'
    const mod = 'a\r\nB\r\nc\r\n'
    const { hunks } = computeDiff(base, mod)
    const ids = new Set(hunks.map((h) => h.id))
    expect(applyAcceptedHunks(base, mod, ids)).toBe(mod)
  })
})
