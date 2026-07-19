/**
 * Tests for the per-hunk composition engine.
 *
 * We lean heavily on round-trip properties:
 *   • Accepting ALL hunks must reproduce the modified content byte-for-byte.
 *   • Accepting NO  hunks must reproduce the base content byte-for-byte.
 *   • For every subset we pick, the result is well-formed (expected lines, right LE).
 */

import { describe, it, expect } from 'vitest'
import { applyAcceptedHunks, computeHunks } from './hunkSelection'

describe('computeHunks — structural invariants', () => {
  it('returns no hunks when base === modified', () => {
    const diff = computeHunks('line 1\nline 2\n', 'line 1\nline 2\n')
    expect(diff.hunks).toHaveLength(0)
  })

  it('detects a single-line replacement', () => {
    const diff = computeHunks('a\nb\nc\n', 'a\nB\nc\n')
    expect(diff.hunks).toHaveLength(1)
    const h = diff.hunks[0]!
    expect(h.removedLines).toEqual(['b'])
    expect(h.addedLines).toEqual(['B'])
    expect(h.baseStartLine).toBe(2)
    expect(h.baseEndLine).toBe(2)
    expect(h.modifiedStartLine).toBe(2)
    expect(h.modifiedEndLine).toBe(2)
  })

  it('detects a pure insertion with zero-length base range', () => {
    const diff = computeHunks('a\nb\n', 'a\nINS\nb\n')
    expect(diff.hunks).toHaveLength(1)
    const h = diff.hunks[0]!
    expect(h.removedLines).toEqual([])
    expect(h.addedLines).toEqual(['INS'])
    expect(h.baseEndLine).toBeLessThan(h.baseStartLine) // empty base range
  })

  it('detects a pure deletion with zero-length modified range', () => {
    const diff = computeHunks('a\nX\nb\n', 'a\nb\n')
    expect(diff.hunks).toHaveLength(1)
    const h = diff.hunks[0]!
    expect(h.removedLines).toEqual(['X'])
    expect(h.addedLines).toEqual([])
  })

  it('emits multiple non-overlapping hunks sorted by baseStartLine', () => {
    const base = ['1', '2', '3', '4', '5', '6', '7', '8', '9'].join('\n') + '\n'
    const mod = ['1', 'X', '3', '4', '5', '6', 'Y', '8', '9'].join('\n') + '\n'
    const diff = computeHunks(base, mod)
    expect(diff.hunks.length).toBe(2)
    expect(diff.hunks[0]!.baseStartLine).toBeLessThan(diff.hunks[1]!.baseStartLine)
  })

  it('includes leading and trailing context lines', () => {
    const base = ['a', 'b', 'c', 'CHANGE', 'd', 'e', 'f'].join('\n') + '\n'
    const mod = ['a', 'b', 'c', 'CHANGED', 'd', 'e', 'f'].join('\n') + '\n'
    const diff = computeHunks(base, mod, { contextLines: 2 })
    expect(diff.hunks).toHaveLength(1)
    expect(diff.hunks[0]!.leadingContext).toEqual(['b', 'c'])
    expect(diff.hunks[0]!.trailingContext).toEqual(['d', 'e'])
  })

  it('detects CRLF as dominant line ending', () => {
    const diff = computeHunks('a\r\nb\r\n', 'a\r\nB\r\n')
    expect(diff.baseLineEnding).toBe('\r\n')
  })

  it('records hasTrailingNewline correctly for both styles', () => {
    expect(computeHunks('x\n', 'y\n').baseHasTrailingNewline).toBe(true)
    expect(computeHunks('x', 'y').baseHasTrailingNewline).toBe(false)
  })
})

describe('applyAcceptedHunks — round-trip properties', () => {
  it('accepting all hunks yields modified content', () => {
    const base = 'line 1\nline 2\nline 3\n'
    const mod = 'line 1\nMODIFIED 2\nline 3\nline 4\n'
    const diff = computeHunks(base, mod)
    const all = new Set(diff.hunks.map((h) => h.id))
    expect(applyAcceptedHunks(diff, all)).toBe(mod)
  })

  it('accepting zero hunks yields base content', () => {
    const base = 'line 1\nline 2\nline 3\n'
    const mod = 'line 1\nMODIFIED 2\nline 3\n'
    const diff = computeHunks(base, mod)
    expect(applyAcceptedHunks(diff, new Set())).toBe(base)
  })

  it('accepting a subset applies only those hunks', () => {
    const base = 'a\nb\nc\nd\n'
    const mod = 'a\nB\nc\nD\n'
    const diff = computeHunks(base, mod)
    expect(diff.hunks.length).toBe(2)
    const firstOnly = new Set([diff.hunks[0]!.id])
    expect(applyAcceptedHunks(diff, firstOnly)).toBe('a\nB\nc\nd\n')
    const secondOnly = new Set([diff.hunks[1]!.id])
    expect(applyAcceptedHunks(diff, secondOnly)).toBe('a\nb\nc\nD\n')
  })

  it('preserves CRLF line endings of the base when composing', () => {
    const base = 'a\r\nb\r\nc\r\n'
    const mod = 'a\r\nB\r\nc\r\n'
    const diff = computeHunks(base, mod)
    const all = new Set(diff.hunks.map((h) => h.id))
    expect(applyAcceptedHunks(diff, all)).toBe(mod)
  })

  it('does not add a stray trailing newline when base had none', () => {
    const base = 'a\nb'
    const mod = 'a\nB'
    const diff = computeHunks(base, mod)
    const all = new Set(diff.hunks.map((h) => h.id))
    expect(applyAcceptedHunks(diff, all)).toBe(mod)
  })

  it('handles pure insertion accepted vs rejected', () => {
    const base = 'a\nb\n'
    const mod = 'a\nINS\nb\n'
    const diff = computeHunks(base, mod)
    const all = new Set(diff.hunks.map((h) => h.id))
    expect(applyAcceptedHunks(diff, all)).toBe(mod)
    expect(applyAcceptedHunks(diff, new Set())).toBe(base)
  })

  it('handles pure deletion accepted vs rejected', () => {
    const base = 'a\nX\nb\n'
    const mod = 'a\nb\n'
    const diff = computeHunks(base, mod)
    const all = new Set(diff.hunks.map((h) => h.id))
    expect(applyAcceptedHunks(diff, all)).toBe(mod)
    expect(applyAcceptedHunks(diff, new Set())).toBe(base)
  })

  it('handles insertion at the very start (empty base)', () => {
    const base = ''
    const mod = 'x\ny\n'
    const diff = computeHunks(base, mod)
    const all = new Set(diff.hunks.map((h) => h.id))
    expect(applyAcceptedHunks(diff, all)).toBe(mod)
    expect(applyAcceptedHunks(diff, new Set())).toBe(base)
  })

  it('handles tail-appended lines as their own hunk', () => {
    const base = 'a\nb\n'
    const mod = 'a\nb\nAPPENDED\n'
    const diff = computeHunks(base, mod)
    const all = new Set(diff.hunks.map((h) => h.id))
    expect(applyAcceptedHunks(diff, all)).toBe(mod)
  })
})

describe('applyAcceptedHunks — cherry-pick properties over many inputs', () => {
  // A light-touch property test: for each generated case, accepting all hunks must
  // reproduce `modified` and accepting none must reproduce `base`, which is the core
  // invariant of the whole engine. If this breaks we've broken cherry-pick soundness.
  const cases: Array<{ base: string; mod: string }> = [
    { base: 'line 1\n', mod: 'line 1 edited\n' },
    { base: '', mod: 'brand new\n' },
    { base: 'keep this\n', mod: '' },
    { base: 'one\ntwo\nthree\n', mod: 'one\nTWO\nthree\nfour\n' },
    { base: 'function foo() {\n  return 1\n}\n', mod: 'function foo() {\n  return 2\n}\n' },
    // Idempotent
    { base: 'unchanged\n', mod: 'unchanged\n' },
    // Multi-hunk
    {
      base: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].join('\n') + '\n',
      mod: ['A', 'b', 'c', 'D', 'e', 'f', 'G', 'h'].join('\n') + '\n',
    },
  ]

  for (const { base, mod } of cases) {
    it(`round-trip: base(${JSON.stringify(base.slice(0, 30))}) ↔ mod(${JSON.stringify(mod.slice(0, 30))})`, () => {
      const diff = computeHunks(base, mod)
      const all = new Set(diff.hunks.map((h) => h.id))
      expect(applyAcceptedHunks(diff, all)).toBe(mod)
      expect(applyAcceptedHunks(diff, new Set())).toBe(base)
    })
  }
})
