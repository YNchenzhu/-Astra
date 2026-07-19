/**
 * `computeUnifiedDiff` correctness tests — the renderer's single-card
 * inline diff view depends on the structured output here matching the
 * expected `+/-/context` semantics that line up with `git diff -U2`.
 *
 * Tests cover the common LLM-edit patterns (one contiguous span
 * change) plus the empty / identical / pure-add / pure-remove edge
 * cases the streaming pipeline routinely produces (oldString empty
 * when the model is creating a new function, newString empty when
 * deleting a block, etc.).
 */
import { describe, expect, it } from 'vitest'
import { computeUnifiedDiff, indexOfLastAdded } from './unifiedDiff'

describe('computeUnifiedDiff', () => {
  it('returns empty diff for two empty strings', () => {
    expect(computeUnifiedDiff('', '')).toEqual([])
  })

  it('emits a context-only block when old and new are identical', () => {
    const out = computeUnifiedDiff('a\nb\nc', 'a\nb\nc')
    // All lines surface as context (subject to the context cap).
    expect(out.every((l) => l.kind === 'context')).toBe(true)
    expect(out.length).toBeGreaterThan(0)
    expect(out.length).toBeLessThanOrEqual(6)
  })

  it('emits pure-add when oldString is empty', () => {
    const out = computeUnifiedDiff('', 'one\ntwo')
    expect(out).toEqual([
      { kind: 'added', text: 'one', newIdx: 0 },
      { kind: 'added', text: 'two', newIdx: 1 },
    ])
  })

  it('emits pure-remove when newString is empty', () => {
    const out = computeUnifiedDiff('one\ntwo', '')
    expect(out).toEqual([
      { kind: 'removed', text: 'one', oldIdx: 0 },
      { kind: 'removed', text: 'two', oldIdx: 1 },
    ])
  })

  it('classic contiguous replacement: surrounding context + - + + pattern', () => {
    const oldText = ['line A', 'line B', 'OLD-1', 'OLD-2', 'line E', 'line F'].join('\n')
    const newText = ['line A', 'line B', 'NEW-1', 'NEW-2', 'NEW-3', 'line E', 'line F'].join('\n')
    const out = computeUnifiedDiff(oldText, newText, 2)
    // Expected sequence: 2 context (A,B), 2 removed, 3 added, 2 context (E,F).
    const kinds = out.map((l) => l.kind)
    expect(kinds).toEqual([
      'context',
      'context',
      'removed',
      'removed',
      'added',
      'added',
      'added',
      'context',
      'context',
    ])
    // Indices line up with original arrays.
    const removed = out.filter((l) => l.kind === 'removed') as Extract<
      ReturnType<typeof computeUnifiedDiff>[number],
      { kind: 'removed' }
    >[]
    expect(removed.map((l) => l.oldIdx)).toEqual([2, 3])
    const added = out.filter((l) => l.kind === 'added') as Extract<
      ReturnType<typeof computeUnifiedDiff>[number],
      { kind: 'added' }
    >[]
    expect(added.map((l) => l.newIdx)).toEqual([2, 3, 4])
  })

  it('truncates context above when fewer lines exist than the requested context', () => {
    // Only 1 line of pre-context exists; algorithm should not synthesise
    // extra lines or read past index 0.
    const out = computeUnifiedDiff('A\nOLD', 'A\nNEW', 3)
    expect(out).toEqual([
      { kind: 'context', text: 'A', oldIdx: 0, newIdx: 0 },
      { kind: 'removed', text: 'OLD', oldIdx: 1 },
      { kind: 'added', text: 'NEW', newIdx: 1 },
    ])
  })

  it('context-lines = 0 strips context entirely', () => {
    const out = computeUnifiedDiff('A\nB\nC', 'A\nX\nC', 0)
    expect(out).toEqual([
      { kind: 'removed', text: 'B', oldIdx: 1 },
      { kind: 'added', text: 'X', newIdx: 1 },
    ])
  })

  it('handles a streaming intermediate state (newText shorter than final)', () => {
    // While the model is still writing, newString has only the first
    // few lines of the eventual content. The diff should still parse
    // cleanly without throwing or producing negative indices.
    const out = computeUnifiedDiff('OLD', 'NEW-PART')
    expect(out).toEqual([
      { kind: 'removed', text: 'OLD', oldIdx: 0 },
      { kind: 'added', text: 'NEW-PART', newIdx: 0 },
    ])
  })
})

describe('indexOfLastAdded', () => {
  it('returns -1 when no added lines exist', () => {
    expect(indexOfLastAdded([])).toBe(-1)
    expect(
      indexOfLastAdded([
        { kind: 'removed', text: 'x', oldIdx: 0 },
        { kind: 'context', text: 'y', oldIdx: 1, newIdx: 0 },
      ]),
    ).toBe(-1)
  })

  it('returns the LAST added index when multiple added entries exist', () => {
    const diff: ReturnType<typeof computeUnifiedDiff> = [
      { kind: 'removed', text: 'a', oldIdx: 0 },
      { kind: 'added', text: 'b', newIdx: 0 },
      { kind: 'added', text: 'c', newIdx: 1 },
      { kind: 'context', text: 'd', oldIdx: 1, newIdx: 2 },
    ]
    expect(indexOfLastAdded(diff)).toBe(2)
  })
})
