import { describe, it, expect } from 'vitest'
import {
  flattenProblemRows,
  rowHeightByIndex,
  PROBLEM_ROW_HEIGHTS,
  type ProblemRow,
} from './problemsPanelRows'
import type { Diagnostic } from '../../stores/useDiagnosticStore'

function mkDiag(
  file: string,
  line: number,
  message = `${file}:${line}`,
  related?: Diagnostic['relatedInformation'],
): Diagnostic {
  return {
    file,
    fileName: file.split(/[\\/]/).pop() ?? file,
    line,
    column: 1,
    endLine: line,
    endColumn: 2,
    severity: 'error',
    message,
    source: 'ts',
    providerKey: 'lsp:typescript',
    relatedInformation: related,
  }
}

describe('flattenProblemRows', () => {
  it('emits a file-header + collapsed body for each file', () => {
    const rows = flattenProblemRows(
      [
        ['a.ts', [mkDiag('a.ts', 1), mkDiag('a.ts', 2)]],
        ['b.ts', [mkDiag('b.ts', 5)]],
      ],
      { expandedFiles: new Set() },
    )
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.kind === 'file-header')).toBe(true)
    expect((rows[0] as { diagCount: number }).diagCount).toBe(2)
    expect((rows[1] as { diagCount: number }).diagCount).toBe(1)
  })

  it('expands diagnostics when a file is in expandedFiles', () => {
    const rows = flattenProblemRows(
      [
        ['a.ts', [mkDiag('a.ts', 1), mkDiag('a.ts', 2)]],
        ['b.ts', [mkDiag('b.ts', 5)]],
      ],
      { expandedFiles: new Set(['a.ts']) },
    )
    expect(rows.map((r) => r.kind)).toEqual([
      'file-header',
      'diagnostic',
      'diagnostic',
      'file-header',
    ])
  })

  it('inserts related rows immediately after their parent diagnostic', () => {
    const related = [
      { message: 'rel1', file: 'b.ts', line: 3, column: 1 },
      { message: 'rel2', file: 'c.ts', line: 4, column: 5 },
    ]
    const rows = flattenProblemRows(
      [['a.ts', [mkDiag('a.ts', 1, 'primary', related)]]],
      { expandedFiles: new Set(['a.ts']) },
    )
    expect(rows.map((r) => r.kind)).toEqual([
      'file-header',
      'diagnostic',
      'related',
      'related',
    ])
    const rel0 = rows[2] as Extract<ProblemRow, { kind: 'related' }>
    expect(rel0.rel.message).toBe('rel1')
    expect(rel0.indexInDiag).toBe(0)
    const rel1 = rows[3] as Extract<ProblemRow, { kind: 'related' }>
    expect(rel1.rel.message).toBe('rel2')
    expect(rel1.indexInDiag).toBe(1)
  })

  it('is monotonic: preserves file iteration order + diag order within file', () => {
    const rows = flattenProblemRows(
      [
        ['z.ts', [mkDiag('z.ts', 99), mkDiag('z.ts', 1)]],
        ['a.ts', [mkDiag('a.ts', 7)]],
      ],
      { expandedFiles: new Set(['z.ts', 'a.ts']) },
    )
    expect(
      rows
        .filter((r): r is Extract<ProblemRow, { kind: 'diagnostic' }> => r.kind === 'diagnostic')
        .map((r) => `${r.file}:${r.diag.line}`),
    ).toEqual(['z.ts:99', 'z.ts:1', 'a.ts:7'])
  })

  it('rowHeightByIndex returns the right height per row kind', () => {
    const rows: ProblemRow[] = [
      { kind: 'file-header', file: 'a', diagCount: 1 },
      { kind: 'diagnostic', file: 'a', indexInFile: 0, diag: mkDiag('a', 1) },
      { kind: 'related', parentDiag: mkDiag('a', 1), rel: { message: 'x', file: 'a', line: 1, column: 1 }, indexInDiag: 0 },
    ]
    const h = rowHeightByIndex(rows)
    expect(h(0)).toBe(PROBLEM_ROW_HEIGHTS['file-header'])
    expect(h(1)).toBe(PROBLEM_ROW_HEIGHTS.diagnostic)
    expect(h(2)).toBe(PROBLEM_ROW_HEIGHTS.related)
    // out-of-bounds → fall back to `diagnostic` height (defensive)
    expect(h(999)).toBe(PROBLEM_ROW_HEIGHTS.diagnostic)
  })

  it('scales: 10 files x 1000 diagnostics each flattens in <50ms', () => {
    const entries: Array<[string, Diagnostic[]]> = []
    const expandedFiles = new Set<string>()
    for (let f = 0; f < 10; f++) {
      const file = `file-${f}.ts`
      expandedFiles.add(file)
      const diags: Diagnostic[] = []
      for (let i = 0; i < 1000; i++) diags.push(mkDiag(file, i + 1))
      entries.push([file, diags])
    }
    const start = performance.now()
    const rows = flattenProblemRows(entries, { expandedFiles })
    const elapsed = performance.now() - start
    expect(rows.length).toBe(10 /* headers */ + 10 * 1000 /* diagnostics */)
    expect(elapsed).toBeLessThan(50)
  })
})
