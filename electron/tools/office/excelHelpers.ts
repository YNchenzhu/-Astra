/**
 * Shared helpers for the Excel tool suite (electron/tools/office/excelTool.ts).
 *
 * Design notes
 * ------------
 * Each Excel tool runs a self-contained "load → mutate → save" cycle (the
 * decision recorded in the tool-registry plan). That keeps individual tool
 * calls atomic and makes the agent's life simpler: there is no implicit
 * "open workbook" handle to forget about. The cost is repeated IO for batch
 * mutations — model is expected to use `excel_write_range` / `excel_append_rows`
 * for hot loops instead of looping `excel_write_cell`.
 *
 * Path policy mirrors `read_file` / `write_file`:
 *   - workspace-relative OR absolute paths
 *   - `gateFileMutatePath` enforced on writes (same protection layer as
 *     write_file: ~/.claude internal-agent sandbox, .git denial, etc.)
 *
 * Sheet addressing accepts either a `sheetName` string OR omitted (= first
 * worksheet). When a workbook has zero worksheets `getSheet` returns an error
 * instead of silently creating one, so the agent gets an actionable failure.
 */

import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import ExcelJS from 'exceljs'
import { resolvePathForTool, getWorkspacePath } from '../workspaceState'
import { notifyWorkspaceFileMutation } from '../../fs/workspaceFileNotify'
import { buildToolFailure, type ToolFailureFields } from '../toolErrorFormat'
import { buildFuzzyNotFoundError } from '../fuzzyPathError'
import { withExclusiveFileLock } from '../fileLock'
import { canonicalFileLockKey } from '../canonicalPath'

// NB: We deliberately do NOT import `fileToolValidation` here. That module
// transitively pulls in agentContext → registry → registryBuiltinTools,
// which would create an import-time cycle the moment registryBuiltinTools
// spreads `excelTools` (the spread runs while the office/excelTool module
// is still initializing). The mutation gate is applied in excelTool.ts
// instead via `resolveExcelPathForWrite`.
//
// `fileLock` and `canonicalPath` ARE safe to import: both are dependency-free
// leaf modules (only `node:fs` / `node:path`), so they don't reach the
// registry chain.

// ============================================================
// Path resolution
// ============================================================

export interface ResolvedOfficePath {
  ok: true
  resolved: string
}
/**
 * Audit fix D1: extends {@link ToolFailureFields} so callers can spread
 * the rejection directly onto a `ToolResult` (`{ success: false, ...r }`)
 * and get the headline / "Next" recovery hints rendered as styled regions
 * instead of grep-ing the flat `error` string. The legacy `error: string`
 * field is preserved (inherited from `ToolFailureFields`), so any
 * caller that still reads `r.error` continues to work unchanged.
 */
export interface ResolvedOfficePathError extends ToolFailureFields {
  ok: false
}
export type ResolveOfficePathResult = ResolvedOfficePath | ResolvedOfficePathError

/**
 * Resolve a tool-supplied path. Set `mustExist` for read-side tools.
 * Mutation-gate (write protection) is intentionally NOT here — see the
 * `fileToolValidation` import comment above.
 */
export function resolveExcelPath(
  filePath: string,
  options: { toolName: string; mustExist?: boolean },
): ResolveOfficePathResult {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    return {
      ok: false,
      ...buildToolFailure(
        {
          what: `${options.toolName}: \`filePath\` is missing or empty.`,
          next: 'Pass an .xlsx path (absolute or workspace-relative).',
        },
        'validation',
      ),
    }
  }
  const r = resolvePathForTool(filePath)
  if (!r.ok) {
    return {
      ok: false,
      ...buildToolFailure({ what: r.reason }, 'filesystem'),
    }
  }

  // Guard against directory targets — exceljs would explode with a
  // confusing error if handed one.
  try {
    const st = fs.statSync(r.resolved)
    if (st.isDirectory()) {
      return {
        ok: false,
        ...buildToolFailure(
          {
            what: `${options.toolName}: \`filePath\` resolves to a directory: ${r.resolved}`,
            next: 'Pass a path to an .xlsx file, not a folder.',
          },
          'validation',
        ),
      }
    }
  } catch {
    // Doesn't exist yet — that's fine for create / write tools.
    if (options.mustExist) {
      return {
        ok: false,
        ...buildFuzzyNotFoundError({
          toolName: options.toolName,
          kind: 'file',
          inputPath: filePath,
          resolvedPath: r.resolved,
          workspace: getWorkspacePath() ?? undefined,
          extraNext: ['Use `excel_create_workbook` first if this is a new file.'],
        }),
      }
    }
  }

  return { ok: true, resolved: r.resolved }
}

// ============================================================
// Workbook IO
// ============================================================

export async function loadWorkbook(absPath: string): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(absPath)
  return wb
}

/**
 * Persist a workbook.
 *
 * Two protections over `wb.xlsx.writeFile()`:
 *   1. **Exclusive file lock** on the realpath-canonical key — serializes
 *      against every other writer on the same underlying file (concurrent
 *      Excel saves, text `write_file`/`edit_file`, `NotebookEdit`). If another
 *      agent currently holds the lock the save throws a clear "File is locked"
 *      error instead of racing to last-writer-wins corruption.
 *   2. **Atomic write** — exceljs serializes to a buffer, which is written to a
 *      sibling temp file (`wx`, fsync'd) and `rename`d into place. A crash mid-
 *      write leaves the original .xlsx intact rather than a truncated zip.
 *
 * Residual: this does NOT detect a read-modify-write lost update across
 * processes (no expected-hash gate — the binary workbook has no read-receipt
 * equivalent). Within one orchestrator `isConcurrencySafe: false` already
 * serializes these tools.
 */
export async function saveWorkbook(wb: ExcelJS.Workbook, absPath: string): Promise<void> {
  await withExclusiveFileLock(
    canonicalFileLockKey(absPath),
    undefined,
    'excel_save',
    async () => {
      fs.mkdirSync(path.dirname(absPath), { recursive: true })
      const buf = (await wb.xlsx.writeBuffer()) as unknown as Buffer
      const tempPath = path.join(
        path.dirname(absPath),
        `.${path.basename(absPath)}.tmp-${randomUUID()}`,
      )
      try {
        // `wx` never clobbers a stale temp from a prior crash.
        const fd = fs.openSync(tempPath, 'wx')
        try {
          fs.writeFileSync(fd, buf)
          fs.fsyncSync(fd)
        } finally {
          fs.closeSync(fd)
        }
        fs.renameSync(tempPath, absPath)
      } catch (e) {
        try {
          fs.unlinkSync(tempPath)
        } catch {
          /* ignore — temp may not exist */
        }
        throw e
      }
    },
  )
  // Notify UI so any open OfficeLivePreview / file-tree watchers refresh.
  // Best-effort: failing to notify must NOT fail the tool call.
  try {
    notifyWorkspaceFileMutation(absPath, 'change')
  } catch {
    /* swallow: UI notification is decorative */
  }
}

// ============================================================
// Sheet selection
// ============================================================

export interface SheetResult {
  ok: true
  sheet: ExcelJS.Worksheet
}
/** Audit fix D1: extends {@link ToolFailureFields} for structured-spread. */
export interface SheetResultError extends ToolFailureFields {
  ok: false
}

/** Get a sheet by name; if `sheetName` is omitted/empty returns the first sheet. */
export function getSheet(
  wb: ExcelJS.Workbook,
  sheetName: string | undefined,
  toolName: string,
): SheetResult | SheetResultError {
  const sheets = wb.worksheets
  if (sheets.length === 0) {
    return {
      ok: false,
      ...buildToolFailure(
        {
          what: `${toolName}: workbook has no worksheets.`,
          next: 'Use `excel_create_sheet` to add one.',
        },
        'validation',
      ),
    }
  }
  if (!sheetName || !sheetName.trim()) {
    return { ok: true, sheet: sheets[0] }
  }
  const target = wb.getWorksheet(sheetName.trim())
  if (!target) {
    return {
      ok: false,
      ...buildToolFailure(
        {
          what: `${toolName}: sheet "${sheetName}" not found.`,
          context: { available: sheets.map((s) => s.name).join(', ') },
          next: 'Use one of the listed sheet names, or omit `sheetName` for the first sheet.',
        },
        'not_found',
      ),
    }
  }
  return { ok: true, sheet: target }
}

// ============================================================
// A1 / range parsing
// ============================================================

/** Convert a column letter (A, Z, AA…) to a 1-based column index. */
export function colLettersToNumber(letters: string): number {
  const upper = letters.toUpperCase()
  let n = 0
  for (const ch of upper) {
    const code = ch.charCodeAt(0)
    if (code < 65 || code > 90) return Number.NaN
    n = n * 26 + (code - 64)
  }
  return n
}

/** Convert a 1-based column index to its letters (1=A, 26=Z, 27=AA). */
export function colNumberToLetters(n: number): string {
  if (!Number.isInteger(n) || n < 1) return ''
  let s = ''
  let x = n
  while (x > 0) {
    const r = (x - 1) % 26
    s = String.fromCharCode(65 + r) + s
    x = Math.floor((x - 1) / 26)
  }
  return s
}

export interface ParsedAddress {
  ok: true
  row: number
  col: number
}
export interface ParsedAddressError {
  ok: false
  error: string
}

/** Parse an A1-style address (e.g. "B7", "AB123"). 1-based row & col. */
export function parseA1Address(addr: string): ParsedAddress | ParsedAddressError {
  if (typeof addr !== 'string') {
    return { ok: false, error: 'cell address must be a string like "A1"' }
  }
  const m = /^\s*\$?([A-Za-z]+)\$?(\d+)\s*$/.exec(addr)
  if (!m) return { ok: false, error: `invalid A1 address: "${addr}"` }
  const col = colLettersToNumber(m[1])
  const row = parseInt(m[2], 10)
  if (!Number.isFinite(col) || col < 1 || !Number.isFinite(row) || row < 1) {
    return { ok: false, error: `out-of-range A1 address: "${addr}"` }
  }
  return { ok: true, row, col }
}

export interface ParsedRange {
  ok: true
  startRow: number
  startCol: number
  endRow: number
  endCol: number
}
export interface ParsedRangeError {
  ok: false
  error: string
}

/** Parse a range like "A1:D10". Single-cell ranges accepted ("A1" → 1×1). */
export function parseA1Range(range: string): ParsedRange | ParsedRangeError {
  if (typeof range !== 'string' || !range.trim()) {
    return { ok: false, error: 'range must be a non-empty string like "A1:D10"' }
  }
  const trimmed = range.trim()
  const parts = trimmed.split(':')
  if (parts.length === 1) {
    const a = parseA1Address(parts[0])
    if (!a.ok) return { ok: false, error: a.error }
    return { ok: true, startRow: a.row, startCol: a.col, endRow: a.row, endCol: a.col }
  }
  if (parts.length !== 2) {
    return { ok: false, error: `invalid range: "${range}" (expected "A1:D10")` }
  }
  const a = parseA1Address(parts[0])
  const b = parseA1Address(parts[1])
  if (!a.ok) return { ok: false, error: a.error }
  if (!b.ok) return { ok: false, error: b.error }
  // Normalize so start <= end on both axes (caller may pass reversed corners)
  return {
    ok: true,
    startRow: Math.min(a.row, b.row),
    startCol: Math.min(a.col, b.col),
    endRow: Math.max(a.row, b.row),
    endCol: Math.max(a.col, b.col),
  }
}

// ============================================================
// Cell value serialization
// ============================================================

export interface CellSnapshot {
  /** A1 address, e.g. "B7". */
  address: string
  /** Resolved value (number/string/boolean/Date/null). Formula cells return cached calculated value. */
  value: unknown
  /** The formula text without leading `=`, when this is a formula cell. */
  formula?: string
  /** ExcelJS-reported cell type as a stable string. */
  type:
    | 'null'
    | 'merge'
    | 'number'
    | 'string'
    | 'date'
    | 'hyperlink'
    | 'formula'
    | 'sharedString'
    | 'richText'
    | 'boolean'
    | 'error'
    | 'unknown'
}

/** Snapshot a cell into a JSON-friendly shape. */
export function cellToSnapshot(cell: ExcelJS.Cell): CellSnapshot {
  const type = cellTypeName(cell.type)
  let value: unknown = cell.value
  let formula: string | undefined
  // ExcelJS stores formulas as { formula: 'SUM(A1:A2)', result: 12 } for
  // basic and { sharedFormula, result } for shared, plus richText / hyperlink
  // wrappers. Normalize to "value = computed result, formula = source text".
  if (value && typeof value === 'object') {
    const v = value as ExcelJS.CellValue & {
      formula?: string
      sharedFormula?: string
      result?: unknown
      hyperlink?: string
      text?: string
      richText?: Array<{ text?: string }>
    }
    if (typeof v.formula === 'string') {
      formula = v.formula
      value = v.result ?? null
    } else if (typeof v.sharedFormula === 'string') {
      formula = v.sharedFormula
      value = v.result ?? null
    } else if (Array.isArray(v.richText)) {
      value = v.richText.map((r) => r?.text ?? '').join('')
    } else if (typeof v.hyperlink === 'string') {
      value = v.text ?? v.hyperlink
    }
  }
  return { address: cell.address, value: value ?? null, formula, type }
}

function cellTypeName(t: ExcelJS.ValueType): CellSnapshot['type'] {
  switch (t) {
    case ExcelJS.ValueType.Null: return 'null'
    case ExcelJS.ValueType.Merge: return 'merge'
    case ExcelJS.ValueType.Number: return 'number'
    case ExcelJS.ValueType.String: return 'string'
    case ExcelJS.ValueType.Date: return 'date'
    case ExcelJS.ValueType.Hyperlink: return 'hyperlink'
    case ExcelJS.ValueType.Formula: return 'formula'
    case ExcelJS.ValueType.SharedString: return 'sharedString'
    case ExcelJS.ValueType.RichText: return 'richText'
    case ExcelJS.ValueType.Boolean: return 'boolean'
    case ExcelJS.ValueType.Error: return 'error'
    default: return 'unknown'
  }
}

// ============================================================
// Coercion helpers for write tools
// ============================================================

/**
 * Coerce a JSON-friendly value into an ExcelJS-acceptable cell value.
 *  - strings beginning with `=` become formula objects (so the model can
 *    just write `"=SUM(A1:A2)"` like a human typing into Excel)
 *  - ISO-like date strings → Date object (YYYY-MM-DD or ISO 8601)
 *  - undefined / null → null (clears cell)
 *  - everything else passes through
 */
export function coerceWriteValue(v: unknown): ExcelJS.CellValue {
  if (v === undefined || v === null) return null
  if (typeof v === 'string') {
    if (v.startsWith('=')) {
      return { formula: v.slice(1), result: undefined } as ExcelJS.CellFormulaValue
    }
    // ISO date detection: 2026-01-15 or 2026-01-15T10:30:00Z. Restrictive on
    // purpose — we don't want "1.5" misread as a date.
    if (/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(v)) {
      const d = new Date(v)
      if (!Number.isNaN(d.getTime())) return d
    }
    return v
  }
  if (typeof v === 'number' || typeof v === 'boolean') return v
  if (v instanceof Date) return v
  // Object form: { formula: '...' }, { hyperlink, text }, etc. — let
  // exceljs validate the shape itself.
  return v as ExcelJS.CellValue
}

// ============================================================
// Output size guard
// ============================================================

/** Hard upper bound on rows*cols that a single read returns. */
export const EXCEL_READ_CELL_LIMIT = 50_000
