/**
 * Tests for the pure helpers behind the DiffTransaction audit panel (P4e).
 *
 * The component itself is covered in manual QA; these tests pin down the logic that
 * matters for correctness: filtering, sorting, and human-readable timestamps.
 */

import { describe, expect, it } from 'vitest'
import {
  EMPTY_FILTER,
  basename,
  filterAndSort,
  humanizeRelative,
  summarizeLineDelta,
} from './auditFilters'
import type { RendererDiffTransaction, RendererDtState } from '../../stores/useDiffTransactionStore'

function tx(overrides: Partial<RendererDiffTransaction> & Pick<RendererDiffTransaction, 'id' | 'filePath' | 'state' | 'updatedAt'>): RendererDiffTransaction {
  return {
    baseSnapshot: {
      content: overrides.baseSnapshot?.content ?? '',
      contentHash: 'h',
      mtimeMs: 0,
      fileExisted: true,
      readId: null,
    },
    proposed: overrides.proposed ?? {
      content: '',
      toolName: 'edit_file',
      toolUseId: 't',
    },
    permissionRequestId: null,
    appliedContentHash: null,
    appliedReadId: null,
    stateHistory: [],
    error: overrides.error ?? null,
    createdAt: overrides.createdAt ?? overrides.updatedAt,
    ...overrides,
  }
}

describe('basename', () => {
  it('handles POSIX + Windows separators', () => {
    expect(basename('/a/b/c.ts')).toBe('c.ts')
    expect(basename('C:\\a\\b\\c.ts')).toBe('c.ts')
  })

  it('returns the full path when no separator', () => {
    expect(basename('foo.ts')).toBe('foo.ts')
  })
})

describe('humanizeRelative', () => {
  const now = 1_700_000_000_000

  it('"just now" under 5s', () => {
    expect(humanizeRelative(now - 1000, now)).toBe('just now')
  })

  it('seconds', () => {
    expect(humanizeRelative(now - 30_000, now)).toBe('30s ago')
  })

  it('minutes', () => {
    expect(humanizeRelative(now - 5 * 60_000, now)).toBe('5m ago')
  })

  it('hours', () => {
    expect(humanizeRelative(now - 3 * 3_600_000, now)).toBe('3h ago')
  })

  it('days', () => {
    expect(humanizeRelative(now - 2 * 86_400_000, now)).toBe('2d ago')
  })
})

describe('summarizeLineDelta', () => {
  it('counts line delta when proposed grows', () => {
    const t = tx({
      id: '1',
      filePath: '/a',
      state: 'Pending',
      updatedAt: 1,
      baseSnapshot: { content: 'a\nb', contentHash: 'h', mtimeMs: 0, fileExisted: true, readId: null },
      proposed: { content: 'a\nb\nc\nd', toolName: 'edit_file', toolUseId: 't' },
    })
    const r = summarizeLineDelta(t)
    expect(r.added).toBe(2)
    expect(r.removed).toBe(0)
  })

  it('counts line delta when proposed shrinks', () => {
    const t = tx({
      id: '1',
      filePath: '/a',
      state: 'Pending',
      updatedAt: 1,
      baseSnapshot: { content: 'a\nb\nc', contentHash: 'h', mtimeMs: 0, fileExisted: true, readId: null },
      proposed: { content: 'a', toolName: 'edit_file', toolUseId: 't' },
    })
    const r = summarizeLineDelta(t)
    expect(r.removed).toBe(2)
  })

  it('empty content safely returns 0/0', () => {
    const t = tx({ id: '1', filePath: '/a', state: 'Pending', updatedAt: 1 })
    const r = summarizeLineDelta(t)
    expect(r).toEqual({ added: 0, removed: 0 })
  })
})

describe('filterAndSort', () => {
  const base: RendererDiffTransaction[] = [
    tx({ id: 'a', filePath: '/w/app.tsx', state: 'Pending', updatedAt: 3000 }),
    tx({ id: 'b', filePath: '/w/api.ts', state: 'Applied', updatedAt: 4000 }),
    tx({ id: 'c', filePath: '/w/util.ts', state: 'Failed', updatedAt: 2000, error: { code: 'HASH', message: 'mismatch', recoverable: true } }),
    tx({ id: 'd', filePath: '/w/other.ts', state: 'Rejected', updatedAt: 5000 }),
  ]

  it('sorts non-terminal first, newest first within each group', () => {
    const rows = filterAndSort(base, EMPTY_FILTER)
    const ids = rows.map((r) => r.id)
    // Non-terminal (Pending, Failed) in order: a(3000) > c(2000), then terminal (Applied, Rejected): d(5000) > b(4000)
    expect(ids).toEqual(['a', 'c', 'd', 'b'])
  })

  it('filters by text against file path', () => {
    const rows = filterAndSort(base, { ...EMPTY_FILTER, text: 'util' })
    expect(rows.map((r) => r.id)).toEqual(['c'])
  })

  it('filters by text against error message', () => {
    const rows = filterAndSort(base, { ...EMPTY_FILTER, text: 'mismatch' })
    expect(rows.map((r) => r.id)).toEqual(['c'])
  })

  it('filters by state set', () => {
    const rows = filterAndSort(base, { ...EMPTY_FILTER, states: new Set<RendererDtState>(['Failed']) })
    expect(rows.map((r) => r.id)).toEqual(['c'])
  })

  it('filters by sinceMs', () => {
    const rows = filterAndSort(base, { ...EMPTY_FILTER, sinceMs: 3500 })
    expect(rows.map((r) => r.id).sort()).toEqual(['b', 'd'])
  })

  it('combines filters (AND semantics)', () => {
    const rows = filterAndSort(base, {
      text: 'w/',
      states: new Set<RendererDtState>(['Pending']),
      sinceMs: 0,
    })
    expect(rows.map((r) => r.id)).toEqual(['a'])
  })

  it('empty source list yields empty output', () => {
    expect(filterAndSort([], EMPTY_FILTER)).toEqual([])
  })

  it('case-insensitive text filter', () => {
    const rows = filterAndSort(base, { ...EMPTY_FILTER, text: 'APP' })
    expect(rows.map((r) => r.id)).toEqual(['a'])
  })
})
