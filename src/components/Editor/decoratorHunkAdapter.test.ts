/**
 * Tests for the P4a → decorator adapter.
 *
 * Goal: catch range-conversion mistakes (1-based inclusive ↔ 0-based exclusive-end)
 * and type classification (add / delete / modify). These are the only things the
 * adapter is responsible for; the diff engine itself has its own 24-test suite.
 */

import { describe, expect, it } from 'vitest'
import {
  computeHunks,
  hunkStats,
  p4aHunksToDecoratorHunks,
} from './decoratorHunkAdapter'

describe('p4aHunksToDecoratorHunks — range conversion', () => {
  it('single-line modify: modify type, correct 0-based exclusive ends', () => {
    const diff = computeHunks('a\nb\nc\n', 'a\nB\nc\n')
    const hunks = p4aHunksToDecoratorHunks(diff)
    expect(hunks).toHaveLength(1)
    const h = hunks[0]!
    expect(h.type).toBe('modify')
    expect(h.originalLines).toEqual(['b'])
    expect(h.modifiedLines).toEqual(['B'])
    // Line 2 (1-based) → origStart=1 (0-based), origEnd=2 (exclusive).
    expect(h.origStartLine).toBe(1)
    expect(h.origEndLine).toBe(2)
    expect(h.modStartLine).toBe(1)
    expect(h.modEndLine).toBe(2)
  })

  it('pure insertion: add type, zero-length orig range at anchor', () => {
    const diff = computeHunks('a\nb\n', 'a\nINS\nb\n')
    const hunks = p4aHunksToDecoratorHunks(diff)
    expect(hunks).toHaveLength(1)
    const h = hunks[0]!
    expect(h.type).toBe('add')
    expect(h.originalLines).toEqual([])
    expect(h.modifiedLines).toEqual(['INS'])
    // Anchor before line 2 (1-based) → origStart=origEnd=1.
    expect(h.origStartLine).toBe(h.origEndLine)
  })

  it('pure deletion: delete type, zero-length modified range at anchor', () => {
    const diff = computeHunks('a\nX\nb\n', 'a\nb\n')
    const hunks = p4aHunksToDecoratorHunks(diff)
    expect(hunks).toHaveLength(1)
    const h = hunks[0]!
    expect(h.type).toBe('delete')
    expect(h.originalLines).toEqual(['X'])
    expect(h.modifiedLines).toEqual([])
    expect(h.modStartLine).toBe(h.modEndLine)
  })

  it('multi-line replace block: correct inclusive→exclusive conversion', () => {
    const base = 'a\nb\nc\nd\ne\n'
    const mod = 'a\nB\nC\nD\ne\n'
    const diff = computeHunks(base, mod)
    const hunks = p4aHunksToDecoratorHunks(diff)
    expect(hunks).toHaveLength(1)
    const h = hunks[0]!
    expect(h.originalLines).toEqual(['b', 'c', 'd'])
    expect(h.modifiedLines).toEqual(['B', 'C', 'D'])
    // Lines 2..4 (1-based inclusive) → origStart=1, origEnd=4.
    expect(h.origStartLine).toBe(1)
    expect(h.origEndLine).toBe(4)
  })

  it('stable ids across re-applies (hunk-0, hunk-1, ...)', () => {
    const base = '1\n2\n3\n4\n5\n'
    const mod = '1\nX\n3\nY\n5\n'
    const diff = computeHunks(base, mod)
    const hunks = p4aHunksToDecoratorHunks(diff)
    expect(hunks.map((h) => h.id)).toEqual(['hunk-0', 'hunk-1'])
    // Re-apply on a completely different input still uses the same id pattern.
    const diff2 = computeHunks('x\ny\n', 'x\nY\n')
    const hunks2 = p4aHunksToDecoratorHunks(diff2)
    expect(hunks2[0]!.id).toBe('hunk-0')
  })

  it('preserves exact line content (no newline leaks into lines)', () => {
    const diff = computeHunks('line 1\nline 2\n', 'line 1\nLINE 2 CHANGED\n')
    const hunks = p4aHunksToDecoratorHunks(diff)
    expect(hunks[0]!.originalLines).toEqual(['line 2'])
    expect(hunks[0]!.modifiedLines).toEqual(['LINE 2 CHANGED'])
  })
})

describe('hunkStats — summary counts', () => {
  it('empty diff yields zeroes', () => {
    const s = hunkStats(computeHunks('a\n', 'a\n'))
    expect(s).toEqual({ added: 0, removed: 0, hunks: 0 })
  })

  it('counts per hunk, not collapsed across', () => {
    const base = 'a\nb\nc\nd\n'
    const mod = 'a\nB\nc\nD\n'
    const diff = computeHunks(base, mod)
    const s = hunkStats(diff)
    expect(s.hunks).toBe(2)
    expect(s.added).toBe(2)
    expect(s.removed).toBe(2)
  })

  it('pure insertion: removed=0', () => {
    const diff = computeHunks('a\nb\n', 'a\nINS\nb\n')
    const s = hunkStats(diff)
    expect(s.added).toBe(1)
    expect(s.removed).toBe(0)
    expect(s.hunks).toBe(1)
  })
})
