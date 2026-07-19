/**
 * Row flattener for the virtualized ProblemsPanel.
 *
 * Converts the `[file, Diagnostic[]]` grouping plus the `expandedFiles`
 * state into a single flat `ProblemRow[]`. react-window is a 1D list
 * virtualizer, so everything the user sees has to be a single row.
 *
 * Row kinds (each has a fixed pixel height — see {@link PROBLEM_ROW_HEIGHTS}):
 *   - `file-header`  — always present for a file group; click to toggle expand.
 *   - `diagnostic`   — one per diagnostic inside an expanded file.
 *   - `related`      — one per related-information entry on a diagnostic.
 *
 * The height map is pure — exported so both the list component and tests
 * can use it without duplicating magic numbers.
 */

import type { Diagnostic, DiagnosticRelatedLocation } from '../../stores/useDiagnosticStore'

export type ProblemRow =
  | { kind: 'file-header'; file: string; diagCount: number }
  | {
      kind: 'diagnostic'
      file: string
      /** 0-based index of this diagnostic within its file's sorted list. */
      indexInFile: number
      diag: Diagnostic
    }
  | {
      kind: 'related'
      parentDiag: Diagnostic
      rel: DiagnosticRelatedLocation
      indexInDiag: number
    }

export const PROBLEM_ROW_HEIGHTS: Record<ProblemRow['kind'], number> = {
  'file-header': 28,
  diagnostic: 24,
  related: 22,
}

export interface FlattenOptions {
  expandedFiles: Set<string>
}

/**
 * Produces a flat row array from `[file, Diagnostic[]]` tuples.
 *
 * File iteration order is preserved (caller pre-sorts). Within each file,
 * diagnostic order is preserved as well. Related-information rows directly
 * follow their parent diagnostic.
 */
export function flattenProblemRows(
  fileEntries: ReadonlyArray<readonly [string, ReadonlyArray<Diagnostic>]>,
  options: FlattenOptions,
): ProblemRow[] {
  const rows: ProblemRow[] = []
  const expanded = options.expandedFiles

  for (const [file, diags] of fileEntries) {
    rows.push({ kind: 'file-header', file, diagCount: diags.length })
    if (!expanded.has(file)) continue

    for (let i = 0; i < diags.length; i++) {
      const diag = diags[i]
      rows.push({ kind: 'diagnostic', file, indexInFile: i, diag })
      if (!diag.relatedInformation) continue
      for (let j = 0; j < diag.relatedInformation.length; j++) {
        rows.push({
          kind: 'related',
          parentDiag: diag,
          rel: diag.relatedInformation[j],
          indexInDiag: j,
        })
      }
    }
  }

  return rows
}

/** Helper for react-window: lookup a row's fixed height by kind. */
export function rowHeightByIndex(
  rows: ReadonlyArray<ProblemRow>,
): (index: number) => number {
  return (index) => {
    const row = rows[index]
    if (!row) return PROBLEM_ROW_HEIGHTS.diagnostic
    return PROBLEM_ROW_HEIGHTS[row.kind]
  }
}
