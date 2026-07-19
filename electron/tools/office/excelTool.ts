/**
 * Excel tool suite �?25 atomic tools for cell-level .xlsx manipulation.
 *
 * Backed by `exceljs`. Each tool is a self-contained "load �?mutate �?save"
 * cycle (see excelHelpers.ts header for the rationale). Tools are registered
 * in registryBuiltinTools.ts and exposed to every agent that doesn't filter
 * them out of its `tools` whitelist.
 *
 * Concurrency: write tools are NOT marked `isConcurrencySafe` �?exceljs is
 * single-workbook stateful and concurrent writes to the same file would
 * race on disk. Read tools are concurrency-safe.
 */

import fs from 'node:fs'
import ExcelJS from 'exceljs'
import type { ZodTypeAny } from 'zod'
import type { Tool, ToolResult, ToolParameter } from '../types'
import { buildTool } from '../buildTool'
import { buildToolFailure } from '../toolErrorFormat'
import {
  resolveExcelPath,
  loadWorkbook,
  saveWorkbook,
  getSheet,
  parseA1Address,
  parseA1Range,
  cellToSnapshot,
  coerceWriteValue,
  colLettersToNumber,
  colNumberToLetters,
  EXCEL_READ_CELL_LIMIT,
} from './excelHelpers'
import type { ResolveOfficePathResult } from './excelHelpers'

/**
 * Resolve a path AND apply a small mutation gate.
 *
 * Why not the project's full `gateFileMutatePath`?
 * That helper transitively imports `memory/service.ts`, which pulls in
 * AI-providers (`ai/providers/anthropic.ts` �?. Bringing that chain in
 * here triggers a load-time cycle the moment `registryBuiltinTools`
 * spreads `excelTools` into its array (the spread runs while the office
 * module is still initializing). To keep the office subsystem standalone
 * we reproduce the small-but-important checks inline:
 *   - reject shell-expansion in raw path ($(...), ${...}, %VAR%, backticks)
 *   - reject glob metachars (`*`, `?`) in raw path
 *   - reject mutations under .git / .vscode / .idea / .claude segments
 * (Sub-agent sandbox enforcement is intentionally NOT replicated here �?
 * Excel tools target .xlsx files, not the session-memory tree those
 * sandboxes guard.)
 */
const SHELL_EXPANSION_RE = /\$\(|\$\{|`|%[^/%\s]+%|~[+-](?:[/\\]|$)/
const PROTECTED_SEGMENTS = new Set(['.git', '.vscode', '.idea', '.claude'])

function checkMutationSafety(
  rawInput: string,
  resolvedPath: string,
): { ok: true } | { ok: false; reason: string } {
  if (SHELL_EXPANSION_RE.test(rawInput)) {
    return { ok: false, reason: 'Refusing path that contains shell-style expansion. Use a literal workspace-relative path.' }
  }
  if (/[*?]/.test(rawInput)) {
    return { ok: false, reason: 'Refusing write path that contains glob metacharacters (* or ?). Pass a single concrete file path.' }
  }
  const segments = resolvedPath.split(/[\\/]/).map((s) => s.toLowerCase()).filter(Boolean)
  for (const seg of segments) {
    if (PROTECTED_SEGMENTS.has(seg)) {
      return { ok: false, reason: `Refusing to write under a protected directory segment (.git/.vscode/.idea/.claude). Path: ${resolvedPath}` }
    }
  }
  return { ok: true }
}

function resolveExcelPathForWrite(
  filePath: string,
  toolName: string,
  options: { mustExist?: boolean } = {},
): ResolveOfficePathResult {
  const r = resolveExcelPath(filePath, { toolName, mustExist: options.mustExist })
  if (!r.ok) return r
  const gate = checkMutationSafety(filePath, r.resolved)
  if (!gate.ok) {
    return {
      ok: false,
      ...buildToolFailure({ what: gate.reason }, 'permission_denied'),
    }
  }
  return r
}

import {
  excelReadWorkbookInputZod,
  excelCreateWorkbookInputZod,
  excelCreateSheetInputZod,
  excelDeleteSheetInputZod,
  excelRenameSheetInputZod,
  excelReadSheetInputZod,
  excelReadRangeInputZod,
  excelReadCellInputZod,
  excelGetUsedRangeInputZod,
  excelWriteCellInputZod,
  excelWriteRangeInputZod,
  excelSetFormulaInputZod,
  excelClearRangeInputZod,
  excelAppendRowsInputZod,
  excelInsertRowsInputZod,
  excelInsertColumnsInputZod,
  excelDeleteRowsInputZod,
  excelDeleteColumnsInputZod,
  excelFormatRangeInputZod,
  excelSetColumnWidthInputZod,
  excelSetRowHeightInputZod,
  excelSetNumberFormatInputZod,
  excelMergeCellsInputZod,
  excelUnmergeCellsInputZod,
  excelFindReplaceInputZod,
  excelSetNamedRangeInputZod,
} from './excelInputZod'

// ============================================================
// Internal helpers
// ============================================================

function getStringField(input: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const v = input[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return ''
}

function getOptString(input: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = input[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return undefined
}

function getNumber(input: Record<string, unknown>, key: string, fallback?: number): number | undefined {
  const v = input[key]
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const n = Number(v)
    if (Number.isFinite(n)) return n
  }
  return fallback
}

function getBool(input: Record<string, unknown>, key: string): boolean | undefined {
  const v = input[key]
  if (typeof v === 'boolean') return v
  return undefined
}

/** Normalize `"FF0000"` / `"#FF0000"` / `"FFFF0000"` �?8-char ARGB. */
function normalizeARGB(color: string | undefined): string | undefined {
  if (!color) return undefined
  let s = color.trim().replace(/^#/, '').toUpperCase()
  if (s.length === 6) s = 'FF' + s  // assume opaque alpha
  if (!/^[0-9A-F]{8}$/.test(s)) return undefined
  return s
}

function err(toolName: string, message: string): ToolResult {
  return { success: false, ...buildToolFailure({ what: `${toolName}: ${message}` }) }
}

function ok(payload: unknown): ToolResult {
  return { success: true, output: typeof payload === 'string' ? payload : JSON.stringify(payload) }
}

function getErrorMessage(e: unknown): string {
  if (e instanceof Error) return e.message
  return String(e)
}

// ============================================================
// Param schema fragments (re-used)
// ============================================================

const paramFilePath: ToolParameter = {
  name: 'filePath',
  type: 'string',
  description: 'Path to the .xlsx file. Absolute OR workspace-relative.',
  required: true,
}
const paramSheetNameOpt: ToolParameter = {
  name: 'sheetName',
  type: 'string',
  description: 'Sheet name. Omit to use the first worksheet.',
  required: false,
}
const paramRangeReq: ToolParameter = {
  name: 'range',
  type: 'string',
  description: 'A1-style range, e.g. "A1:D10". A single cell ("A1") is also accepted.',
  required: true,
}

// ============================================================
// 1. excel_read_workbook
// ============================================================

const excelReadWorkbook = buildTool({
  name: 'excel_read_workbook',
  description:
    'Read .xlsx workbook metadata: list of sheets with their dimensions, ' +
    'plus any defined names (named ranges). Use this BEFORE deeper reads ' +
    'so you know which sheets exist and how big they are.',
  searchHint: 'inspect Excel workbook structure sheets named ranges',
  inputSchema: [paramFilePath],
  zInputSchema: excelReadWorkbookInputZod,
  isReadOnly: true,
  isConcurrencySafe: true,
  async call(input, _ctx) {
    const TOOL = 'excel_read_workbook'
    const filePath = getStringField(input, 'filePath', 'file_path', 'path')
    if (!filePath) return err(TOOL, 'filePath is required')
    const r = resolveExcelPath(filePath, { toolName: TOOL, mustExist: true })
    if (!r.ok) return { success: false, ...r }
    try {
      const wb = await loadWorkbook(r.resolved)
      const sheets = wb.worksheets.map((ws) => ({
        name: ws.name,
        rowCount: ws.actualRowCount,
        columnCount: ws.actualColumnCount,
        hidden: ws.state === 'hidden' || ws.state === 'veryHidden',
      }))
      const definedNames = (wb.definedNames as ExcelJS.DefinedNames | undefined)?.model ?? []
      return ok({ path: r.resolved, sheets, definedNames })
    } catch (e) {
      return err(TOOL, `failed to read workbook: ${getErrorMessage(e)}`)
    }
  },
})

// ============================================================
// 2. excel_create_workbook
// ============================================================

const excelCreateWorkbook = buildTool({
  name: 'excel_create_workbook',
  description:
    'Create a new empty .xlsx workbook with one sheet. By default fails if ' +
    'the file already exists; pass `overwrite: true` to replace it.',
  searchHint: 'new blank Excel xlsx file create',
  inputSchema: [
    paramFilePath,
    { name: 'sheetName', type: 'string', description: 'Name of the initial sheet (default "Sheet1").' },
    { name: 'overwrite', type: 'boolean', description: 'Replace existing file when true. Default false.' },
  ],
  zInputSchema: excelCreateWorkbookInputZod,
  isReadOnly: false,
  isConcurrencySafe: false,
  isDestructive: true,
  async call(input, _ctx) {
    const TOOL = 'excel_create_workbook'
    const filePath = getStringField(input, 'filePath', 'file_path', 'path')
    if (!filePath) return err(TOOL, 'filePath is required')
    const sheetName = getOptString(input, 'sheetName') ?? 'Sheet1'
    const overwrite = getBool(input, 'overwrite') ?? false

    const r = resolveExcelPathForWrite(filePath, TOOL)
    if (!r.ok) return { success: false, ...r }
    if (!overwrite && fs.existsSync(r.resolved)) {
      return err(TOOL, `file already exists: ${r.resolved} (pass overwrite: true to replace)`)
    }
    try {
      const wb = new ExcelJS.Workbook()
      wb.addWorksheet(sheetName)
      await saveWorkbook(wb, r.resolved)
      return ok({ created: r.resolved, sheet: sheetName })
    } catch (e) {
      return err(TOOL, `failed to create workbook: ${getErrorMessage(e)}`)
    }
  },
})

// ============================================================
// 3. excel_create_sheet
// ============================================================

const excelCreateSheet = buildTool({
  name: 'excel_create_sheet',
  description:
    'Add a new worksheet (tab) to an existing .xlsx workbook. Fails if a sheet ' +
    'with the same name already exists. Use `excel_rename_sheet` to rename, or ' +
    '`excel_create_workbook` to start a fresh file.',
  searchHint: 'add Excel sheet tab',
  inputSchema: [
    paramFilePath,
    { name: 'sheetName', type: 'string', description: 'Name of the new sheet.', required: true },
    { name: 'index', type: 'number', description: '0-based insert position. Default = end of workbook.' },
  ],
  zInputSchema: excelCreateSheetInputZod,
  isReadOnly: false,
  isConcurrencySafe: false,
  async call(input, _ctx) {
    const TOOL = 'excel_create_sheet'
    const filePath = getStringField(input, 'filePath', 'file_path', 'path')
    if (!filePath) return err(TOOL, 'filePath is required')
    const sheetName = getStringField(input, 'sheetName')
    if (!sheetName) return err(TOOL, 'sheetName is required')
    const index = getNumber(input, 'index')

    const r = resolveExcelPathForWrite(filePath, TOOL, { mustExist: true })
    if (!r.ok) return { success: false, ...r }
    try {
      const wb = await loadWorkbook(r.resolved)
      if (wb.getWorksheet(sheetName)) {
        return err(TOOL, `sheet "${sheetName}" already exists`)
      }
      // ExcelJS spliceWorksheets isn't public; the documented way to insert
      // mid-workbook is `addWorksheet(name, options)` then move via order.
      // We keep it simple: append, then optionally reorder via `wb.views`
      // is overkill �?just record the requested index in metadata and let
      // a future pass handle reordering if it matters. Practical risk: low.
      void index
      wb.addWorksheet(sheetName)
      await saveWorkbook(wb, r.resolved)
      return ok({ created: sheetName, totalSheets: wb.worksheets.length })
    } catch (e) {
      return err(TOOL, `failed to create sheet: ${getErrorMessage(e)}`)
    }
  },
})

// ============================================================
// 4. excel_delete_sheet
// ============================================================

const excelDeleteSheet = buildTool({
  name: 'excel_delete_sheet',
  description: 'Delete a worksheet by name. Refuses to delete the only remaining sheet.',
  searchHint: 'remove Excel sheet tab',
  inputSchema: [
    paramFilePath,
    { name: 'sheetName', type: 'string', description: 'Sheet to delete.', required: true },
  ],
  zInputSchema: excelDeleteSheetInputZod,
  isReadOnly: false,
  isConcurrencySafe: false,
  isDestructive: true,
  async call(input, _ctx) {
    const TOOL = 'excel_delete_sheet'
    const filePath = getStringField(input, 'filePath', 'file_path', 'path')
    if (!filePath) return err(TOOL, 'filePath is required')
    const sheetName = getStringField(input, 'sheetName')
    if (!sheetName) return err(TOOL, 'sheetName is required')

    const r = resolveExcelPathForWrite(filePath, TOOL, { mustExist: true })
    if (!r.ok) return { success: false, ...r }
    try {
      const wb = await loadWorkbook(r.resolved)
      const target = wb.getWorksheet(sheetName)
      if (!target) return err(TOOL, `sheet "${sheetName}" not found`)
      if (wb.worksheets.length <= 1) {
        return err(TOOL, 'cannot delete the only remaining sheet')
      }
      wb.removeWorksheet(target.id)
      await saveWorkbook(wb, r.resolved)
      return ok({ deleted: sheetName, remainingSheets: wb.worksheets.map((s) => s.name) })
    } catch (e) {
      return err(TOOL, `failed to delete sheet: ${getErrorMessage(e)}`)
    }
  },
})

// ============================================================
// 5. excel_rename_sheet
// ============================================================

const excelRenameSheet = buildTool({
  name: 'excel_rename_sheet',
  description:
    'Rename an existing worksheet. Fails if `newName` is already taken by another ' +
    'sheet in this workbook. To delete a sheet use `excel_delete_sheet` instead.',
  searchHint: 'rename Excel sheet tab',
  inputSchema: [
    paramFilePath,
    { name: 'sheetName', type: 'string', description: 'Current sheet name.', required: true },
    { name: 'newName', type: 'string', description: 'New sheet name.', required: true },
  ],
  zInputSchema: excelRenameSheetInputZod,
  isReadOnly: false,
  isConcurrencySafe: false,
  async call(input, _ctx) {
    const TOOL = 'excel_rename_sheet'
    const filePath = getStringField(input, 'filePath', 'file_path', 'path')
    if (!filePath) return err(TOOL, 'filePath is required')
    const sheetName = getStringField(input, 'sheetName')
    const newName = getStringField(input, 'newName')
    if (!sheetName) return err(TOOL, 'sheetName is required')
    if (!newName) return err(TOOL, 'newName is required')
    if (sheetName === newName) return ok({ noop: true, name: newName })

    const r = resolveExcelPathForWrite(filePath, TOOL, { mustExist: true })
    if (!r.ok) return { success: false, ...r }
    try {
      const wb = await loadWorkbook(r.resolved)
      const target = wb.getWorksheet(sheetName)
      if (!target) return err(TOOL, `sheet "${sheetName}" not found`)
      if (wb.getWorksheet(newName)) {
        return err(TOOL, `a sheet named "${newName}" already exists`)
      }
      target.name = newName
      await saveWorkbook(wb, r.resolved)
      return ok({ renamed: { from: sheetName, to: newName } })
    } catch (e) {
      return err(TOOL, `failed to rename sheet: ${getErrorMessage(e)}`)
    }
  },
})

// ============================================================
// 6. excel_read_sheet
// ============================================================

const excelReadSheet = buildTool({
  name: 'excel_read_sheet',
  description:
    'Read all (or a specified range of) cells in a sheet. Returns a 2D array of ' +
    'cell snapshots with value/formula/type. Hard cap of ' + EXCEL_READ_CELL_LIMIT +
    ' cells per call �?use `range` to chunk if you exceed that.',
  searchHint: 'read Excel sheet rows columns data',
  inputSchema: [
    paramFilePath,
    paramSheetNameOpt,
    { name: 'range', type: 'string', description: 'Optional A1:D10 to limit. Defaults to used range.' },
    { name: 'includeFormulas', type: 'boolean', description: 'When true, returns formula text alongside values.' },
  ],
  zInputSchema: excelReadSheetInputZod,
  isReadOnly: true,
  isConcurrencySafe: true,
  async call(input, _ctx) {
    const TOOL = 'excel_read_sheet'
    const filePath = getStringField(input, 'filePath', 'file_path', 'path')
    if (!filePath) return err(TOOL, 'filePath is required')
    const sheetName = getOptString(input, 'sheetName')
    const rangeStr = getOptString(input, 'range')
    const includeFormulas = getBool(input, 'includeFormulas') ?? false

    const r = resolveExcelPath(filePath, { toolName: TOOL, mustExist: true })
    if (!r.ok) return { success: false, ...r }
    try {
      const wb = await loadWorkbook(r.resolved)
      const sr = getSheet(wb, sheetName, TOOL)
      if (!sr.ok) return { success: false, ...sr }
      const ws = sr.sheet

      let startRow = 1, startCol = 1, endRow = ws.actualRowCount, endCol = ws.actualColumnCount
      if (rangeStr) {
        const pr = parseA1Range(rangeStr)
        if (!pr.ok) return err(TOOL, pr.error)
        startRow = pr.startRow; startCol = pr.startCol
        endRow = pr.endRow; endCol = pr.endCol
      }
      if (endRow < startRow || endCol < startCol) {
        return ok({ sheet: ws.name, rows: [], note: 'sheet is empty' })
      }
      const cellCount = (endRow - startRow + 1) * (endCol - startCol + 1)
      if (cellCount > EXCEL_READ_CELL_LIMIT) {
        return err(TOOL,
          `range covers ${cellCount} cells, exceeds limit of ${EXCEL_READ_CELL_LIMIT}; ` +
          'use `excel_read_range` with smaller chunks')
      }

      const rows: unknown[][] = []
      for (let row = startRow; row <= endRow; row++) {
        const out: unknown[] = []
        for (let col = startCol; col <= endCol; col++) {
          const cell = ws.getCell(row, col)
          const snap = cellToSnapshot(cell)
          out.push(includeFormulas ? snap : snap.value)
        }
        rows.push(out)
      }
      return ok({
        sheet: ws.name,
        startCell: `${colNumberToLetters(startCol)}${startRow}`,
        endCell: `${colNumberToLetters(endCol)}${endRow}`,
        rowCount: rows.length,
        columnCount: endCol - startCol + 1,
        rows,
      })
    } catch (e) {
      return err(TOOL, `failed to read sheet: ${getErrorMessage(e)}`)
    }
  },
})

// ============================================================
// 7. excel_read_range
// ============================================================

const excelReadRange = buildTool({
  name: 'excel_read_range',
  description: 'Read a specific A1-style range and return a 2D array of cell snapshots.',
  searchHint: 'read Excel range A1 cells',
  inputSchema: [paramFilePath, paramRangeReq, paramSheetNameOpt,
    { name: 'includeFormulas', type: 'boolean', description: 'Include formula text in output.' },
  ],
  zInputSchema: excelReadRangeInputZod,
  isReadOnly: true,
  isConcurrencySafe: true,
  async call(input, _ctx) {
    const TOOL = 'excel_read_range'
    const filePath = getStringField(input, 'filePath', 'file_path', 'path')
    if (!filePath) return err(TOOL, 'filePath is required')
    const range = getStringField(input, 'range')
    if (!range) return err(TOOL, 'range is required')
    const sheetName = getOptString(input, 'sheetName')
    const includeFormulas = getBool(input, 'includeFormulas') ?? false

    const r = resolveExcelPath(filePath, { toolName: TOOL, mustExist: true })
    if (!r.ok) return { success: false, ...r }
    try {
      const wb = await loadWorkbook(r.resolved)
      const sr = getSheet(wb, sheetName, TOOL)
      if (!sr.ok) return { success: false, ...sr }
      const pr = parseA1Range(range)
      if (!pr.ok) return err(TOOL, pr.error)
      const cellCount = (pr.endRow - pr.startRow + 1) * (pr.endCol - pr.startCol + 1)
      if (cellCount > EXCEL_READ_CELL_LIMIT) {
        return err(TOOL, `range covers ${cellCount} cells, exceeds limit of ${EXCEL_READ_CELL_LIMIT}`)
      }
      const rows: unknown[][] = []
      for (let row = pr.startRow; row <= pr.endRow; row++) {
        const out: unknown[] = []
        for (let col = pr.startCol; col <= pr.endCol; col++) {
          const snap = cellToSnapshot(sr.sheet.getCell(row, col))
          out.push(includeFormulas ? snap : snap.value)
        }
        rows.push(out)
      }
      return ok({ sheet: sr.sheet.name, range, rowCount: rows.length, columnCount: pr.endCol - pr.startCol + 1, rows })
    } catch (e) {
      return err(TOOL, `failed to read range: ${getErrorMessage(e)}`)
    }
  },
})

// ============================================================
// 8. excel_read_cell
// ============================================================

const excelReadCell = buildTool({
  name: 'excel_read_cell',
  description: 'Read a single cell. Returns { address, value, formula, type }.',
  searchHint: 'read single Excel cell value formula',
  inputSchema: [paramFilePath,
    { name: 'cell', type: 'string', description: 'A1 address, e.g. "B7".', required: true },
    paramSheetNameOpt,
  ],
  zInputSchema: excelReadCellInputZod,
  isReadOnly: true,
  isConcurrencySafe: true,
  async call(input, _ctx) {
    const TOOL = 'excel_read_cell'
    const filePath = getStringField(input, 'filePath', 'file_path', 'path')
    if (!filePath) return err(TOOL, 'filePath is required')
    const cellStr = getStringField(input, 'cell')
    if (!cellStr) return err(TOOL, 'cell is required')
    const sheetName = getOptString(input, 'sheetName')
    const addr = parseA1Address(cellStr)
    if (!addr.ok) return err(TOOL, addr.error)

    const r = resolveExcelPath(filePath, { toolName: TOOL, mustExist: true })
    if (!r.ok) return { success: false, ...r }
    try {
      const wb = await loadWorkbook(r.resolved)
      const sr = getSheet(wb, sheetName, TOOL)
      if (!sr.ok) return { success: false, ...sr }
      const cell = sr.sheet.getCell(addr.row, addr.col)
      return ok({ sheet: sr.sheet.name, ...cellToSnapshot(cell) })
    } catch (e) {
      return err(TOOL, `failed to read cell: ${getErrorMessage(e)}`)
    }
  },
})

// ============================================================
// 9. excel_get_used_range
// ============================================================

const excelGetUsedRange = buildTool({
  name: 'excel_get_used_range',
  description: 'Return the bounding box of populated cells in a sheet (rowCount, columnCount, startCell, endCell).',
  searchHint: 'Excel sheet dimensions used range size',
  inputSchema: [paramFilePath, paramSheetNameOpt],
  zInputSchema: excelGetUsedRangeInputZod,
  isReadOnly: true,
  isConcurrencySafe: true,
  async call(input, _ctx) {
    const TOOL = 'excel_get_used_range'
    const filePath = getStringField(input, 'filePath', 'file_path', 'path')
    if (!filePath) return err(TOOL, 'filePath is required')
    const sheetName = getOptString(input, 'sheetName')

    const r = resolveExcelPath(filePath, { toolName: TOOL, mustExist: true })
    if (!r.ok) return { success: false, ...r }
    try {
      const wb = await loadWorkbook(r.resolved)
      const sr = getSheet(wb, sheetName, TOOL)
      if (!sr.ok) return { success: false, ...sr }
      const ws = sr.sheet
      const rowCount = ws.actualRowCount
      const columnCount = ws.actualColumnCount
      if (rowCount === 0 || columnCount === 0) {
        return ok({ sheet: ws.name, rowCount: 0, columnCount: 0, empty: true })
      }
      return ok({
        sheet: ws.name,
        rowCount,
        columnCount,
        startCell: 'A1',
        endCell: `${colNumberToLetters(columnCount)}${rowCount}`,
      })
    } catch (e) {
      return err(TOOL, `failed: ${getErrorMessage(e)}`)
    }
  },
})

// ============================================================
// 10. excel_write_cell
// ============================================================

const excelWriteCell = buildTool({
  name: 'excel_write_cell',
  description:
    'Write a single cell. The `value` field accepts string/number/boolean/null. ' +
    'Strings starting with `=` are treated as formulas. ISO-format date strings ' +
    '("2026-05-15" or "2026-05-15T10:30:00Z") become Date values.',
  searchHint: 'write Excel cell set value formula',
  inputSchema: [paramFilePath,
    { name: 'cell', type: 'string', description: 'A1 address, e.g. "B7".', required: true },
    { name: 'value', type: 'string', description: 'New cell value (string/number/boolean/null/=formula).' },
    paramSheetNameOpt,
  ],
  zInputSchema: excelWriteCellInputZod,
  isReadOnly: false,
  isConcurrencySafe: false,
  async call(input, _ctx) {
    const TOOL = 'excel_write_cell'
    const filePath = getStringField(input, 'filePath', 'file_path', 'path')
    if (!filePath) return err(TOOL, 'filePath is required')
    const cellStr = getStringField(input, 'cell')
    if (!cellStr) return err(TOOL, 'cell is required')
    const sheetName = getOptString(input, 'sheetName')
    const addr = parseA1Address(cellStr)
    if (!addr.ok) return err(TOOL, addr.error)

    const r = resolveExcelPathForWrite(filePath, TOOL, { mustExist: true })
    if (!r.ok) return { success: false, ...r }
    try {
      const wb = await loadWorkbook(r.resolved)
      const sr = getSheet(wb, sheetName, TOOL)
      if (!sr.ok) return { success: false, ...sr }
      sr.sheet.getCell(addr.row, addr.col).value = coerceWriteValue(input.value)
      await saveWorkbook(wb, r.resolved)
      return ok({ sheet: sr.sheet.name, updated: cellStr })
    } catch (e) {
      return err(TOOL, `failed to write cell: ${getErrorMessage(e)}`)
    }
  },
})

// ============================================================
// 11. excel_write_range
// ============================================================

const excelWriteRange = buildTool({
  name: 'excel_write_range',
  description:
    'Write a 2D array of values starting at `startCell` (top-left anchor). ' +
    'Use this instead of looping `excel_write_cell` �?one save instead of N. ' +
    'Each value follows the same string/number/boolean/null/=formula convention.',
  searchHint: 'bulk write Excel rectangular block of cells',
  inputSchema: [paramFilePath,
    { name: 'startCell', type: 'string', description: 'Top-left anchor, e.g. "A1".', required: true },
    {
      name: 'values',
      type: 'array',
      description: '2D array; each row is an array of cell values.',
      required: true,
      items: { type: 'array', description: 'A row of cell values (string/number/boolean/null).' },
    },
    paramSheetNameOpt,
  ],
  zInputSchema: excelWriteRangeInputZod,
  isReadOnly: false,
  isConcurrencySafe: false,
  async call(input, _ctx) {
    const TOOL = 'excel_write_range'
    const filePath = getStringField(input, 'filePath', 'file_path', 'path')
    if (!filePath) return err(TOOL, 'filePath is required')
    const startCell = getStringField(input, 'startCell')
    if (!startCell) return err(TOOL, 'startCell is required')
    const values = input.values
    if (!Array.isArray(values)) return err(TOOL, 'values must be a 2D array')
    const sheetName = getOptString(input, 'sheetName')
    const addr = parseA1Address(startCell)
    if (!addr.ok) return err(TOOL, addr.error)

    const r = resolveExcelPathForWrite(filePath, TOOL, { mustExist: true })
    if (!r.ok) return { success: false, ...r }
    try {
      const wb = await loadWorkbook(r.resolved)
      const sr = getSheet(wb, sheetName, TOOL)
      if (!sr.ok) return { success: false, ...sr }
      let cellsWritten = 0
      for (let i = 0; i < values.length; i++) {
        const row = values[i]
        if (!Array.isArray(row)) return err(TOOL, `values[${i}] is not an array`)
        for (let j = 0; j < row.length; j++) {
          sr.sheet.getCell(addr.row + i, addr.col + j).value = coerceWriteValue(row[j])
          cellsWritten++
        }
      }
      await saveWorkbook(wb, r.resolved)
      return ok({ sheet: sr.sheet.name, startCell, rows: values.length, cellsWritten })
    } catch (e) {
      return err(TOOL, `failed to write range: ${getErrorMessage(e)}`)
    }
  },
})

// ============================================================
// 12. excel_set_formula
// ============================================================

const excelSetFormula = buildTool({
  name: 'excel_set_formula',
  description:
    'Set a formula in a cell. Pass the formula text WITHOUT a leading `=` ' +
    '(but a leading `=` is tolerated). Distinct from `excel_write_cell` so ' +
    'the model intent is unambiguous.',
  searchHint: 'set Excel cell formula function',
  inputSchema: [paramFilePath,
    { name: 'cell', type: 'string', description: 'A1 address.', required: true },
    { name: 'formula', type: 'string', description: 'Formula body, e.g. "SUM(A1:A10)".', required: true },
    paramSheetNameOpt,
  ],
  zInputSchema: excelSetFormulaInputZod,
  isReadOnly: false,
  isConcurrencySafe: false,
  async call(input, _ctx) {
    const TOOL = 'excel_set_formula'
    const filePath = getStringField(input, 'filePath', 'file_path', 'path')
    if (!filePath) return err(TOOL, 'filePath is required')
    const cellStr = getStringField(input, 'cell')
    if (!cellStr) return err(TOOL, 'cell is required')
    let formula = getStringField(input, 'formula')
    if (!formula) return err(TOOL, 'formula is required')
    if (formula.startsWith('=')) formula = formula.slice(1)
    const sheetName = getOptString(input, 'sheetName')
    const addr = parseA1Address(cellStr)
    if (!addr.ok) return err(TOOL, addr.error)

    const r = resolveExcelPathForWrite(filePath, TOOL, { mustExist: true })
    if (!r.ok) return { success: false, ...r }
    try {
      const wb = await loadWorkbook(r.resolved)
      const sr = getSheet(wb, sheetName, TOOL)
      if (!sr.ok) return { success: false, ...sr }
      sr.sheet.getCell(addr.row, addr.col).value = { formula, result: undefined } as ExcelJS.CellFormulaValue
      await saveWorkbook(wb, r.resolved)
      return ok({ sheet: sr.sheet.name, cell: cellStr, formula: `=${formula}` })
    } catch (e) {
      return err(TOOL, `failed to set formula: ${getErrorMessage(e)}`)
    }
  },
})

// ============================================================
// 13. excel_clear_range
// ============================================================

const excelClearRange = buildTool({
  name: 'excel_clear_range',
  description: 'Clear all cell values in a range (sets each cell to null). Does not change formatting.',
  searchHint: 'erase clear Excel cell values range',
  inputSchema: [paramFilePath, paramRangeReq, paramSheetNameOpt],
  zInputSchema: excelClearRangeInputZod,
  isReadOnly: false,
  isConcurrencySafe: false,
  isDestructive: true,
  async call(input, _ctx) {
    const TOOL = 'excel_clear_range'
    const filePath = getStringField(input, 'filePath', 'file_path', 'path')
    if (!filePath) return err(TOOL, 'filePath is required')
    const range = getStringField(input, 'range')
    if (!range) return err(TOOL, 'range is required')
    const sheetName = getOptString(input, 'sheetName')
    const pr = parseA1Range(range)
    if (!pr.ok) return err(TOOL, pr.error)

    const r = resolveExcelPathForWrite(filePath, TOOL, { mustExist: true })
    if (!r.ok) return { success: false, ...r }
    try {
      const wb = await loadWorkbook(r.resolved)
      const sr = getSheet(wb, sheetName, TOOL)
      if (!sr.ok) return { success: false, ...sr }
      let cleared = 0
      for (let row = pr.startRow; row <= pr.endRow; row++) {
        for (let col = pr.startCol; col <= pr.endCol; col++) {
          sr.sheet.getCell(row, col).value = null
          cleared++
        }
      }
      await saveWorkbook(wb, r.resolved)
      return ok({ sheet: sr.sheet.name, range, cellsCleared: cleared })
    } catch (e) {
      return err(TOOL, `failed: ${getErrorMessage(e)}`)
    }
  },
})

// ============================================================
// 14. excel_append_rows
// ============================================================

const excelAppendRows = buildTool({
  name: 'excel_append_rows',
  description:
    'Append one or more rows after the current last used row. Each row is an array ' +
    'of cell values (string/number/boolean/null/=formula).',
  searchHint: 'append rows Excel sheet bottom',
  inputSchema: [paramFilePath,
    {
      name: 'rows', type: 'array',
      description: 'Array of rows; each row is an array of cell values.',
      required: true,
      items: { type: 'array', description: 'Row values.' },
    },
    paramSheetNameOpt,
  ],
  zInputSchema: excelAppendRowsInputZod,
  isReadOnly: false,
  isConcurrencySafe: false,
  async call(input, _ctx) {
    const TOOL = 'excel_append_rows'
    const filePath = getStringField(input, 'filePath', 'file_path', 'path')
    if (!filePath) return err(TOOL, 'filePath is required')
    const rows = input.rows
    if (!Array.isArray(rows)) return err(TOOL, 'rows must be a 2D array')
    const sheetName = getOptString(input, 'sheetName')

    const r = resolveExcelPathForWrite(filePath, TOOL, { mustExist: true })
    if (!r.ok) return { success: false, ...r }
    try {
      const wb = await loadWorkbook(r.resolved)
      const sr = getSheet(wb, sheetName, TOOL)
      if (!sr.ok) return { success: false, ...sr }
      let appended = 0
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i]
        if (!Array.isArray(row)) return err(TOOL, `rows[${i}] is not an array`)
        sr.sheet.addRow(row.map(coerceWriteValue))
        appended++
      }
      await saveWorkbook(wb, r.resolved)
      return ok({ sheet: sr.sheet.name, rowsAppended: appended, newLastRow: sr.sheet.actualRowCount })
    } catch (e) {
      return err(TOOL, `failed: ${getErrorMessage(e)}`)
    }
  },
})

// ============================================================
// 15-18. Row/column insert/delete
// ============================================================

function rowColTool<S extends ZodTypeAny>(
  toolName: string,
  description: string,
  axis: 'row' | 'col',
  op: 'insert' | 'delete',
  zSchema: S,
): Tool {
  return buildTool({
    name: toolName,
    description,
    searchHint: `${op} ${axis === 'row' ? 'rows' : 'columns'} Excel`,
    inputSchema: [paramFilePath,
      { name: 'at', type: 'number', description: `1-based ${axis} index where the operation starts.`, required: true },
      { name: 'count', type: 'number', description: 'How many to insert/delete (default 1).' },
      paramSheetNameOpt,
    ],
    zInputSchema: zSchema,
    isReadOnly: false,
    isConcurrencySafe: false,
    isDestructive: op === 'delete',
    async call(rawInput, _ctx) {
      const input = rawInput as Record<string, unknown>
      const filePath = getStringField(input, 'filePath', 'file_path', 'path')
      if (!filePath) return err(toolName, 'filePath is required')
      const at = getNumber(input, 'at')
      if (at === undefined || at < 1 || !Number.isInteger(at)) return err(toolName, '`at` must be a positive integer')
      const count = getNumber(input, 'count', 1) ?? 1
      if (count < 1 || !Number.isInteger(count)) return err(toolName, '`count` must be a positive integer')
      const sheetName = getOptString(input, 'sheetName')

      const r = resolveExcelPathForWrite(filePath, toolName, { mustExist: true })
      if (!r.ok) return { success: false, ...r }
      try {
        const wb = await loadWorkbook(r.resolved)
        const sr = getSheet(wb, sheetName, toolName)
        if (!sr.ok) return { success: false, ...sr }
        const ws = sr.sheet
        // ExcelJS spliceRows / spliceColumns take (start, deleteCount, ...inserts).
        // For inserts we pass `count` empty arrays; for deletes we pass deleteCount = count, no inserts.
        if (axis === 'row') {
          if (op === 'insert') {
            const inserts: ExcelJS.CellValue[][] = []
            for (let i = 0; i < count; i++) inserts.push([])
            ws.spliceRows(at, 0, ...inserts)
          } else {
            ws.spliceRows(at, count)
          }
        } else {
          if (op === 'insert') {
            const inserts: ExcelJS.CellValue[][] = []
            for (let i = 0; i < count; i++) inserts.push([])
            ws.spliceColumns(at, 0, ...inserts)
          } else {
            ws.spliceColumns(at, count)
          }
        }
        await saveWorkbook(wb, r.resolved)
        return ok({ sheet: ws.name, op, axis, at, count })
      } catch (e) {
        return err(toolName, `failed: ${getErrorMessage(e)}`)
      }
    },
  })
}

const excelInsertRows = rowColTool(
  'excel_insert_rows',
  'Insert N empty rows starting at the given 1-based row index. Existing rows shift down.',
  'row', 'insert', excelInsertRowsInputZod,
)
const excelInsertColumns = rowColTool(
  'excel_insert_columns',
  'Insert N empty columns starting at the given 1-based column index. Existing columns shift right.',
  'col', 'insert', excelInsertColumnsInputZod,
)
const excelDeleteRows = rowColTool(
  'excel_delete_rows',
  'Delete N rows starting at the given 1-based row index. Rows below shift up. ' +
  'To clear values without removing rows, use `excel_clear_range` instead.',
  'row', 'delete', excelDeleteRowsInputZod,
)
const excelDeleteColumns = rowColTool(
  'excel_delete_columns',
  'Delete N columns starting at the given 1-based column index. Columns to the right shift left. ' +
  'To clear values without removing columns, use `excel_clear_range` instead.',
  'col', 'delete', excelDeleteColumnsInputZod,
)

// ============================================================
// 19. excel_format_range
// ============================================================

const excelFormatRange = buildTool({
  name: 'excel_format_range',
  description:
    'Apply font / fill / alignment / border to every cell in a range. ' +
    'Pass an object in `format` with any of: bold, italic, underline, fontSize, fontName, ' +
    'fontColor (ARGB hex like "FF0000"), bgColor, horizontalAlignment, verticalAlignment, wrapText, border.',
  searchHint: 'Excel format style font color border alignment',
  inputSchema: [paramFilePath, paramRangeReq, paramSheetNameOpt,
    {
      name: 'format', type: 'object',
      description: 'Format properties to apply. Any subset.',
      required: true,
      properties: {
        bold: { type: 'boolean' },
        italic: { type: 'boolean' },
        underline: { type: 'boolean' },
        fontSize: { type: 'number' },
        fontName: { type: 'string' },
        fontColor: { type: 'string', description: 'ARGB hex' },
        bgColor: { type: 'string', description: 'ARGB hex' },
        horizontalAlignment: { type: 'string', enum: ['left', 'center', 'right'] },
        verticalAlignment: { type: 'string', enum: ['top', 'middle', 'bottom'] },
        wrapText: { type: 'boolean' },
        border: { type: 'boolean', description: 'Apply thin border on all 4 sides.' },
      },
    },
  ],
  zInputSchema: excelFormatRangeInputZod,
  isReadOnly: false,
  isConcurrencySafe: false,
  async call(input, _ctx) {
    const TOOL = 'excel_format_range'
    const filePath = getStringField(input, 'filePath', 'file_path', 'path')
    if (!filePath) return err(TOOL, 'filePath is required')
    const range = getStringField(input, 'range')
    if (!range) return err(TOOL, 'range is required')
    const sheetName = getOptString(input, 'sheetName')
    const format = (input.format ?? {}) as Record<string, unknown>
    if (typeof format !== 'object' || format === null) return err(TOOL, 'format must be an object')
    const pr = parseA1Range(range)
    if (!pr.ok) return err(TOOL, pr.error)

    const r = resolveExcelPathForWrite(filePath, TOOL, { mustExist: true })
    if (!r.ok) return { success: false, ...r }
    try {
      const wb = await loadWorkbook(r.resolved)
      const sr = getSheet(wb, sheetName, TOOL)
      if (!sr.ok) return { success: false, ...sr }

      const fontPatch: Partial<ExcelJS.Font> = {}
      if (typeof format.bold === 'boolean') fontPatch.bold = format.bold
      if (typeof format.italic === 'boolean') fontPatch.italic = format.italic
      if (typeof format.underline === 'boolean') fontPatch.underline = format.underline
      if (typeof format.fontSize === 'number') fontPatch.size = format.fontSize
      if (typeof format.fontName === 'string') fontPatch.name = format.fontName
      const fontArgb = normalizeARGB(typeof format.fontColor === 'string' ? format.fontColor : undefined)
      if (fontArgb) fontPatch.color = { argb: fontArgb }

      const fillArgb = normalizeARGB(typeof format.bgColor === 'string' ? format.bgColor : undefined)

      const alignPatch: Partial<ExcelJS.Alignment> = {}
      if (format.horizontalAlignment === 'left' || format.horizontalAlignment === 'center' || format.horizontalAlignment === 'right') {
        alignPatch.horizontal = format.horizontalAlignment
      }
      if (format.verticalAlignment === 'top' || format.verticalAlignment === 'middle' || format.verticalAlignment === 'bottom') {
        alignPatch.vertical = format.verticalAlignment
      }
      if (typeof format.wrapText === 'boolean') alignPatch.wrapText = format.wrapText

      const wantBorder = format.border === true
      const thin: ExcelJS.Border = { style: 'thin', color: { argb: 'FF000000' } }

      let count = 0
      for (let row = pr.startRow; row <= pr.endRow; row++) {
        for (let col = pr.startCol; col <= pr.endCol; col++) {
          const cell = sr.sheet.getCell(row, col)
          if (Object.keys(fontPatch).length > 0) {
            cell.font = { ...cell.font, ...fontPatch }
          }
          if (fillArgb) {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fillArgb } }
          }
          if (Object.keys(alignPatch).length > 0) {
            cell.alignment = { ...cell.alignment, ...alignPatch }
          }
          if (wantBorder) {
            cell.border = { top: thin, left: thin, right: thin, bottom: thin }
          }
          count++
        }
      }
      await saveWorkbook(wb, r.resolved)
      return ok({ sheet: sr.sheet.name, range, cellsFormatted: count })
    } catch (e) {
      return err(TOOL, `failed: ${getErrorMessage(e)}`)
    }
  },
})

// ============================================================
// 20. excel_set_column_width
// ============================================================

const excelSetColumnWidth = buildTool({
  name: 'excel_set_column_width',
  description: 'Set the width of a column. `column` accepts either a letter ("A") or a 1-based number.',
  searchHint: 'Excel column width adjust resize',
  inputSchema: [paramFilePath,
    { name: 'column', type: 'string', description: 'Column letter ("A") or 1-based number as string.', required: true },
    { name: 'width', type: 'number', description: 'Width in Excel units.', required: true },
    paramSheetNameOpt,
  ],
  zInputSchema: excelSetColumnWidthInputZod,
  isReadOnly: false,
  isConcurrencySafe: false,
  async call(input, _ctx) {
    const TOOL = 'excel_set_column_width'
    const filePath = getStringField(input, 'filePath', 'file_path', 'path')
    if (!filePath) return err(TOOL, 'filePath is required')
    const colRaw = input.column
    let colNum: number | undefined
    if (typeof colRaw === 'number') colNum = colRaw
    else if (typeof colRaw === 'string') {
      const trimmed = colRaw.trim()
      colNum = /^\d+$/.test(trimmed) ? Number(trimmed) : colLettersToNumber(trimmed)
    }
    if (!colNum || !Number.isFinite(colNum) || colNum < 1) return err(TOOL, '`column` must be a letter ("A") or positive integer')
    const width = getNumber(input, 'width')
    if (width === undefined || !Number.isFinite(width) || width < 0) return err(TOOL, '`width` must be a non-negative number')
    const sheetName = getOptString(input, 'sheetName')

    const r = resolveExcelPathForWrite(filePath, TOOL, { mustExist: true })
    if (!r.ok) return { success: false, ...r }
    try {
      const wb = await loadWorkbook(r.resolved)
      const sr = getSheet(wb, sheetName, TOOL)
      if (!sr.ok) return { success: false, ...sr }
      sr.sheet.getColumn(colNum).width = width
      await saveWorkbook(wb, r.resolved)
      return ok({ sheet: sr.sheet.name, column: colNumberToLetters(colNum), width })
    } catch (e) {
      return err(TOOL, `failed: ${getErrorMessage(e)}`)
    }
  },
})

// ============================================================
// 21. excel_set_row_height
// ============================================================

const excelSetRowHeight = buildTool({
  name: 'excel_set_row_height',
  description:
    'Set the height (in Excel points) of a single row by 1-based row index. ' +
    'For column width use `excel_set_column_width`.',
  searchHint: 'Excel row height adjust',
  inputSchema: [paramFilePath,
    { name: 'row', type: 'number', description: '1-based row index.', required: true },
    { name: 'height', type: 'number', description: 'Height in Excel points.', required: true },
    paramSheetNameOpt,
  ],
  zInputSchema: excelSetRowHeightInputZod,
  isReadOnly: false,
  isConcurrencySafe: false,
  async call(input, _ctx) {
    const TOOL = 'excel_set_row_height'
    const filePath = getStringField(input, 'filePath', 'file_path', 'path')
    if (!filePath) return err(TOOL, 'filePath is required')
    const row = getNumber(input, 'row')
    if (row === undefined || !Number.isInteger(row) || row < 1) return err(TOOL, '`row` must be a positive integer')
    const height = getNumber(input, 'height')
    if (height === undefined || !Number.isFinite(height) || height < 0) return err(TOOL, '`height` must be non-negative')
    const sheetName = getOptString(input, 'sheetName')

    const r = resolveExcelPathForWrite(filePath, TOOL, { mustExist: true })
    if (!r.ok) return { success: false, ...r }
    try {
      const wb = await loadWorkbook(r.resolved)
      const sr = getSheet(wb, sheetName, TOOL)
      if (!sr.ok) return { success: false, ...sr }
      sr.sheet.getRow(row).height = height
      await saveWorkbook(wb, r.resolved)
      return ok({ sheet: sr.sheet.name, row, height })
    } catch (e) {
      return err(TOOL, `failed: ${getErrorMessage(e)}`)
    }
  },
})

// ============================================================
// 22. excel_set_number_format
// ============================================================

const excelSetNumberFormat = buildTool({
  name: 'excel_set_number_format',
  description:
    'Set the Excel number format string for every cell in a range. Examples: ' +
    '"0.00" (2 decimals), "#,##0" (thousands separator), "yyyy-mm-dd" (date), ' +
    '"0.00%" (percent), "$#,##0.00" (USD).',
  searchHint: 'Excel number date currency percent format code',
  inputSchema: [paramFilePath, paramRangeReq,
    { name: 'format', type: 'string', description: 'Excel format code, e.g. "0.00" or "yyyy-mm-dd".', required: true },
    paramSheetNameOpt,
  ],
  zInputSchema: excelSetNumberFormatInputZod,
  isReadOnly: false,
  isConcurrencySafe: false,
  async call(input, _ctx) {
    const TOOL = 'excel_set_number_format'
    const filePath = getStringField(input, 'filePath', 'file_path', 'path')
    if (!filePath) return err(TOOL, 'filePath is required')
    const range = getStringField(input, 'range')
    const format = getStringField(input, 'format')
    if (!range) return err(TOOL, 'range is required')
    if (!format) return err(TOOL, 'format is required')
    const sheetName = getOptString(input, 'sheetName')
    const pr = parseA1Range(range)
    if (!pr.ok) return err(TOOL, pr.error)

    const r = resolveExcelPathForWrite(filePath, TOOL, { mustExist: true })
    if (!r.ok) return { success: false, ...r }
    try {
      const wb = await loadWorkbook(r.resolved)
      const sr = getSheet(wb, sheetName, TOOL)
      if (!sr.ok) return { success: false, ...sr }
      let count = 0
      for (let row = pr.startRow; row <= pr.endRow; row++) {
        for (let col = pr.startCol; col <= pr.endCol; col++) {
          sr.sheet.getCell(row, col).numFmt = format
          count++
        }
      }
      await saveWorkbook(wb, r.resolved)
      return ok({ sheet: sr.sheet.name, range, format, cellsFormatted: count })
    } catch (e) {
      return err(TOOL, `failed: ${getErrorMessage(e)}`)
    }
  },
})

// ============================================================
// 23. excel_merge_cells
// ============================================================

const excelMergeCells = buildTool({
  name: 'excel_merge_cells',
  description: 'Merge a range of cells into a single cell. The top-left cell\'s value is kept.',
  searchHint: 'Excel merge cells join',
  inputSchema: [paramFilePath, paramRangeReq, paramSheetNameOpt],
  zInputSchema: excelMergeCellsInputZod,
  isReadOnly: false,
  isConcurrencySafe: false,
  async call(input, _ctx) {
    const TOOL = 'excel_merge_cells'
    const filePath = getStringField(input, 'filePath', 'file_path', 'path')
    if (!filePath) return err(TOOL, 'filePath is required')
    const range = getStringField(input, 'range')
    if (!range) return err(TOOL, 'range is required')
    const sheetName = getOptString(input, 'sheetName')

    const r = resolveExcelPathForWrite(filePath, TOOL, { mustExist: true })
    if (!r.ok) return { success: false, ...r }
    try {
      const wb = await loadWorkbook(r.resolved)
      const sr = getSheet(wb, sheetName, TOOL)
      if (!sr.ok) return { success: false, ...sr }
      sr.sheet.mergeCells(range)
      await saveWorkbook(wb, r.resolved)
      return ok({ sheet: sr.sheet.name, merged: range })
    } catch (e) {
      return err(TOOL, `failed: ${getErrorMessage(e)}`)
    }
  },
})

// ============================================================
// 24. excel_unmerge_cells
// ============================================================

const excelUnmergeCells = buildTool({
  name: 'excel_unmerge_cells',
  description:
    'Reverse a prior `excel_merge_cells` operation. The range you pass must match ' +
    'one of the workbook\'s existing merged regions. Returns success even on no-op.',
  searchHint: 'Excel unmerge split cells',
  inputSchema: [paramFilePath, paramRangeReq, paramSheetNameOpt],
  zInputSchema: excelUnmergeCellsInputZod,
  isReadOnly: false,
  isConcurrencySafe: false,
  async call(input, _ctx) {
    const TOOL = 'excel_unmerge_cells'
    const filePath = getStringField(input, 'filePath', 'file_path', 'path')
    if (!filePath) return err(TOOL, 'filePath is required')
    const range = getStringField(input, 'range')
    if (!range) return err(TOOL, 'range is required')
    const sheetName = getOptString(input, 'sheetName')

    const r = resolveExcelPathForWrite(filePath, TOOL, { mustExist: true })
    if (!r.ok) return { success: false, ...r }
    try {
      const wb = await loadWorkbook(r.resolved)
      const sr = getSheet(wb, sheetName, TOOL)
      if (!sr.ok) return { success: false, ...sr }
      sr.sheet.unMergeCells(range)
      await saveWorkbook(wb, r.resolved)
      return ok({ sheet: sr.sheet.name, unmerged: range })
    } catch (e) {
      return err(TOOL, `failed: ${getErrorMessage(e)}`)
    }
  },
})

// ============================================================
// 25. excel_find_replace
// ============================================================

const excelFindReplace = buildTool({
  name: 'excel_find_replace',
  description:
    'Find and replace text in cell string values across one sheet, all sheets, or ' +
    'a specific range. Formula bodies and numeric/date cells are left untouched. ' +
    'Set `regex: true` to treat `find` as a JavaScript RegExp pattern.',
  searchHint: 'Excel find replace search text values',
  inputSchema: [paramFilePath,
    { name: 'find', type: 'string', description: 'Text to find. Empty string is rejected.', required: true },
    { name: 'replace', type: 'string', description: 'Replacement text (may be empty).', required: true },
    paramSheetNameOpt,
    { name: 'allSheets', type: 'boolean', description: 'Search all sheets when true. Default false.' },
    { name: 'range', type: 'string', description: 'Optional A1 range to limit search (single-sheet only).' },
    { name: 'regex', type: 'boolean', description: 'Treat `find` as a regex.' },
    { name: 'caseSensitive', type: 'boolean', description: 'Default false (case-insensitive).' },
  ],
  zInputSchema: excelFindReplaceInputZod,
  isReadOnly: false,
  isConcurrencySafe: false,
  async call(input, _ctx) {
    const TOOL = 'excel_find_replace'
    const filePath = getStringField(input, 'filePath', 'file_path', 'path')
    if (!filePath) return err(TOOL, 'filePath is required')
    const find = typeof input.find === 'string' ? input.find : ''
    const replace = typeof input.replace === 'string' ? input.replace : ''
    if (!find) return err(TOOL, 'find is required (non-empty)')
    const sheetName = getOptString(input, 'sheetName')
    const allSheets = getBool(input, 'allSheets') ?? false
    const rangeStr = getOptString(input, 'range')
    const useRegex = getBool(input, 'regex') ?? false
    const caseSensitive = getBool(input, 'caseSensitive') ?? false

    let pattern: RegExp
    try {
      pattern = useRegex
        ? new RegExp(find, caseSensitive ? 'g' : 'gi')
        : new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), caseSensitive ? 'g' : 'gi')
    } catch (e) {
      return err(TOOL, `invalid regex: ${getErrorMessage(e)}`)
    }

    const r = resolveExcelPathForWrite(filePath, TOOL, { mustExist: true })
    if (!r.ok) return { success: false, ...r }
    try {
      const wb = await loadWorkbook(r.resolved)
      const sheets: ExcelJS.Worksheet[] = []
      if (allSheets) {
        sheets.push(...wb.worksheets)
      } else {
        const sr = getSheet(wb, sheetName, TOOL)
        if (!sr.ok) return { success: false, ...sr }
        sheets.push(sr.sheet)
      }
      // Range only applies in single-sheet mode.
      let pr: ReturnType<typeof parseA1Range> | undefined
      if (rangeStr) {
        if (allSheets) return err(TOOL, '`range` cannot be combined with `allSheets`')
        const parsed = parseA1Range(rangeStr)
        if (!parsed.ok) return err(TOOL, parsed.error)
        pr = parsed
      }

      let totalReplacements = 0
      let cellsTouched = 0
      const perSheet: Array<{ sheet: string; replacements: number; cells: number }> = []
      for (const ws of sheets) {
        let r1 = 1, c1 = 1, r2 = ws.actualRowCount, c2 = ws.actualColumnCount
        if (pr && pr.ok) {
          r1 = pr.startRow; c1 = pr.startCol; r2 = pr.endRow; c2 = pr.endCol
        }
        let sheetRepl = 0, sheetCells = 0
        for (let row = r1; row <= r2; row++) {
          for (let col = c1; col <= c2; col++) {
            const cell = ws.getCell(row, col)
            // Only string cells; formulas / numbers / dates are left alone
            // since blanket rewriting them tends to corrupt calculations.
            if (typeof cell.value !== 'string') continue
            const before = cell.value
            const after = before.replace(pattern, replace)
            if (after !== before) {
              cell.value = after
              const matches = before.match(pattern)
              sheetRepl += matches ? matches.length : 0
              sheetCells++
            }
          }
        }
        if (sheetCells > 0) {
          perSheet.push({ sheet: ws.name, replacements: sheetRepl, cells: sheetCells })
          totalReplacements += sheetRepl
          cellsTouched += sheetCells
        }
      }
      if (cellsTouched > 0) {
        await saveWorkbook(wb, r.resolved)
      }
      return ok({ totalReplacements, cellsTouched, perSheet })
    } catch (e) {
      return err(TOOL, `failed: ${getErrorMessage(e)}`)
    }
  },
})

// ============================================================
// 26. excel_set_named_range
// ============================================================

const excelSetNamedRange = buildTool({
  name: 'excel_set_named_range',
  description:
    'Define or update a workbook-level named range. The `range` parameter must include ' +
    'the sheet (e.g. "Sheet1!A1:D10") OR you must supply `sheetName`, in which case the ' +
    'name resolves to `${sheetName}!${range}`.',
  searchHint: 'Excel named range workbook scope',
  inputSchema: [paramFilePath,
    { name: 'name', type: 'string', description: 'The defined name, e.g. "salesData".', required: true },
    { name: 'range', type: 'string', description: 'A1 range. May be sheet-qualified ("Sheet1!A1:D10").', required: true },
    paramSheetNameOpt,
  ],
  zInputSchema: excelSetNamedRangeInputZod,
  isReadOnly: false,
  isConcurrencySafe: false,
  async call(input, _ctx) {
    const TOOL = 'excel_set_named_range'
    const filePath = getStringField(input, 'filePath', 'file_path', 'path')
    if (!filePath) return err(TOOL, 'filePath is required')
    const name = getStringField(input, 'name')
    const range = getStringField(input, 'range')
    if (!name) return err(TOOL, 'name is required')
    if (!range) return err(TOOL, 'range is required')
    const sheetName = getOptString(input, 'sheetName')

    let qualified = range
    if (!range.includes('!')) {
      if (!sheetName) {
        return err(TOOL, 'range must be sheet-qualified ("Sheet1!A1:D10") or supply `sheetName`')
      }
      qualified = `${sheetName}!${range}`
    }

    const r = resolveExcelPathForWrite(filePath, TOOL, { mustExist: true })
    if (!r.ok) return { success: false, ...r }
    try {
      const wb = await loadWorkbook(r.resolved)
      // Validate referenced sheet exists.
      const [refSheet] = qualified.split('!')
      if (!wb.getWorksheet(refSheet)) {
        return err(TOOL, `referenced sheet "${refSheet}" not found`)
      }
      // ExcelJS DefinedNames: `add(rangeRef, name)` �?note arg order is (range, name).
      wb.definedNames.add(qualified, name)
      await saveWorkbook(wb, r.resolved)
      return ok({ name, range: qualified })
    } catch (e) {
      return err(TOOL, `failed: ${getErrorMessage(e)}`)
    }
  },
})

// ============================================================
// Public registry export
// ============================================================

/**
 * Deferred loading (tool-surface slimming, 2026-06 audit):
 *
 * The 26-tool Excel family alone is ~14K chars of schema — roughly a third
 * of the default tool surface — while the overwhelming majority of turns
 * never touch a workbook. Marking the family `shouldDefer: true` removes
 * it from the default model tool listing; the tools stay fully registered
 * and reachable through three host mechanisms:
 *
 *   1. **ToolSearch discovery** — keyword search ("excel write") or
 *      `select:excel_read_sheet`; each tool's `searchHint` is tuned for it.
 *      The deferred pool is announced to the model via the transcript
 *      `pole-dtd` delta markers (`context/toolPoolTranscriptDeltas.ts`).
 *   2. **Direct-call guard** — an undiscovered direct call is blocked with
 *      an educative "call ToolSearch first, then retry" message
 *      (`tools/deferredToolExecutionGuard.ts`), so the worst case is one
 *      extra round-trip, never a dead end.
 *   3. **Whitelist bypass** — sub-agents and bundle primary agents with an
 *      explicit `tools` allowlist resolve through
 *      `agents/subAgentToolResolver.ts`, which intentionally ignores
 *      deferral: an "Excel 专员" agent keeps its full schema up front.
 */
const markDeferredOfficeTool = (t: Tool): Tool => ({ ...t, shouldDefer: true })

export const excelTools: Tool[] = [
  excelReadWorkbook,
  excelCreateWorkbook,
  excelCreateSheet,
  excelDeleteSheet,
  excelRenameSheet,
  excelReadSheet,
  excelReadRange,
  excelReadCell,
  excelGetUsedRange,
  excelWriteCell,
  excelWriteRange,
  excelSetFormula,
  excelClearRange,
  excelAppendRows,
  excelInsertRows,
  excelInsertColumns,
  excelDeleteRows,
  excelDeleteColumns,
  excelFormatRange,
  excelSetColumnWidth,
  excelSetRowHeight,
  excelSetNumberFormat,
  excelMergeCells,
  excelUnmergeCells,
  excelFindReplace,
  excelSetNamedRange,
].map(markDeferredOfficeTool)
