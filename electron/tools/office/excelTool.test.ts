/**
 * End-to-end tests for the Excel tool suite.
 *
 * Strategy: spin up a temp workspace, drive each tool through its public
 * `execute` entry-point with realistic inputs, then read the file back to
 * assert on-disk effects. We deliberately exercise the full "load → mutate →
 * save" cycle rather than mocking exceljs, because the whole point of the
 * tool layer is that the agent gets a real .xlsx on disk.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import ExcelJS from 'exceljs'
import { setWorkspacePath } from '../workspaceState'
import { tryAcquireFileLock } from '../fileLock'
import { excelTools } from './excelTool'
import type { Tool, ToolResult } from '../types'

function tool(name: string): Tool {
  const t = excelTools.find((x) => x.name === name)
  if (!t) throw new Error(`tool not registered: ${name}`)
  return t
}

async function run(name: string, input: Record<string, unknown>): Promise<ToolResult> {
  return tool(name).execute(input)
}

function parseOutput<T = unknown>(res: ToolResult): T {
  expect(res.success, `tool failed: ${res.error}`).toBe(true)
  return JSON.parse(res.output ?? '{}') as T
}

let workspace: string
let xlsxPath: string

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'excel-tool-test-'))
  setWorkspacePath(workspace)
  xlsxPath = join(workspace, 'test.xlsx')
})

afterEach(() => {
  setWorkspacePath(null)
  if (existsSync(workspace)) rmSync(workspace, { recursive: true, force: true })
})

// ------------------------------------------------------------
// Workbook lifecycle
// ------------------------------------------------------------

describe('excel_create_workbook', () => {
  it('creates an empty workbook with the requested initial sheet', async () => {
    const res = await run('excel_create_workbook', {
      filePath: 'test.xlsx',
      sheetName: 'Data',
    })
    const out = parseOutput<{ created: string; sheet: string }>(res)
    expect(out.sheet).toBe('Data')
    expect(existsSync(xlsxPath)).toBe(true)
  })

  it('refuses to overwrite an existing file unless overwrite=true', async () => {
    await run('excel_create_workbook', { filePath: 'test.xlsx' })
    const fail = await run('excel_create_workbook', { filePath: 'test.xlsx' })
    expect(fail.success).toBe(false)
    expect(fail.error).toMatch(/already exists/i)

    const ok = await run('excel_create_workbook', { filePath: 'test.xlsx', overwrite: true })
    expect(ok.success).toBe(true)
  })
})

describe('excel_read_workbook', () => {
  it('reports sheets and their dimensions', async () => {
    await run('excel_create_workbook', { filePath: 'test.xlsx', sheetName: 'A' })
    await run('excel_create_sheet', { filePath: 'test.xlsx', sheetName: 'B' })
    const out = parseOutput<{ sheets: Array<{ name: string }> }>(
      await run('excel_read_workbook', { filePath: 'test.xlsx' }),
    )
    expect(out.sheets.map((s) => s.name)).toEqual(['A', 'B'])
  })
})

// ------------------------------------------------------------
// Cell-level read/write
// ------------------------------------------------------------

describe('excel_write_cell + excel_read_cell', () => {
  beforeEach(async () => {
    await run('excel_create_workbook', { filePath: 'test.xlsx' })
  })

  it('round-trips a string value', async () => {
    await run('excel_write_cell', { filePath: 'test.xlsx', cell: 'A1', value: 'hello' })
    const out = parseOutput<{ value: unknown; type: string }>(
      await run('excel_read_cell', { filePath: 'test.xlsx', cell: 'A1' }),
    )
    expect(out.value).toBe('hello')
    expect(out.type).toBe('string')
  })

  it('round-trips a number', async () => {
    await run('excel_write_cell', { filePath: 'test.xlsx', cell: 'B2', value: 42 })
    const out = parseOutput<{ value: unknown; type: string }>(
      await run('excel_read_cell', { filePath: 'test.xlsx', cell: 'B2' }),
    )
    expect(out.value).toBe(42)
    expect(out.type).toBe('number')
  })

  it('treats string values starting with "=" as formulas', async () => {
    await run('excel_write_cell', { filePath: 'test.xlsx', cell: 'A1', value: 5 })
    await run('excel_write_cell', { filePath: 'test.xlsx', cell: 'A2', value: 7 })
    await run('excel_write_cell', { filePath: 'test.xlsx', cell: 'A3', value: '=SUM(A1:A2)' })
    const out = parseOutput<{ formula?: string; type: string }>(
      await run('excel_read_cell', { filePath: 'test.xlsx', cell: 'A3' }),
    )
    expect(out.type).toBe('formula')
    expect(out.formula).toBe('SUM(A1:A2)')
  })

  it('rejects a malformed A1 address', async () => {
    const res = await run('excel_write_cell', { filePath: 'test.xlsx', cell: 'not-a-cell', value: 1 })
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/invalid A1 address/i)
  })
})

describe('excel_write_range + excel_read_range', () => {
  beforeEach(async () => {
    await run('excel_create_workbook', { filePath: 'test.xlsx' })
  })

  it('writes and reads back a 2D block', async () => {
    await run('excel_write_range', {
      filePath: 'test.xlsx',
      startCell: 'A1',
      values: [
        ['Name', 'Age'],
        ['Alice', 30],
        ['Bob', 25],
      ],
    })
    const out = parseOutput<{ rows: unknown[][] }>(
      await run('excel_read_range', { filePath: 'test.xlsx', range: 'A1:B3' }),
    )
    expect(out.rows).toEqual([
      ['Name', 'Age'],
      ['Alice', 30],
      ['Bob', 25],
    ])
  })
})

// ------------------------------------------------------------
// Formula tool
// ------------------------------------------------------------

describe('excel_set_formula', () => {
  it('writes a formula cell that ExcelJS round-trips with `=` prefix', async () => {
    await run('excel_create_workbook', { filePath: 'test.xlsx' })
    await run('excel_write_range', {
      filePath: 'test.xlsx',
      startCell: 'A1',
      values: [[10], [20]],
    })
    await run('excel_set_formula', { filePath: 'test.xlsx', cell: 'A3', formula: 'SUM(A1:A2)' })

    const wb = new ExcelJS.Workbook()
    await wb.xlsx.readFile(xlsxPath)
    const cell = wb.worksheets[0].getCell('A3')
    // CellFormulaValue shape from exceljs
    const v = cell.value as { formula?: string }
    expect(v?.formula).toBe('SUM(A1:A2)')
  })
})

// ------------------------------------------------------------
// Append + insert/delete rows
// ------------------------------------------------------------

describe('excel_append_rows', () => {
  it('appends rows after the existing last row', async () => {
    await run('excel_create_workbook', { filePath: 'test.xlsx' })
    await run('excel_write_range', {
      filePath: 'test.xlsx',
      startCell: 'A1',
      values: [['a'], ['b']],
    })
    await run('excel_append_rows', {
      filePath: 'test.xlsx',
      rows: [['c'], ['d']],
    })
    const out = parseOutput<{ rows: unknown[][] }>(
      await run('excel_read_range', { filePath: 'test.xlsx', range: 'A1:A4' }),
    )
    expect(out.rows.flat()).toEqual(['a', 'b', 'c', 'd'])
  })
})

describe('excel_insert_rows + excel_delete_rows', () => {
  it('shifts existing data down on insert and back up on delete', async () => {
    await run('excel_create_workbook', { filePath: 'test.xlsx' })
    await run('excel_write_range', {
      filePath: 'test.xlsx',
      startCell: 'A1',
      values: [['row1'], ['row2'], ['row3']],
    })
    await run('excel_insert_rows', { filePath: 'test.xlsx', at: 2, count: 1 })
    let out = parseOutput<{ rows: unknown[][] }>(
      await run('excel_read_range', { filePath: 'test.xlsx', range: 'A1:A4' }),
    )
    expect(out.rows.flat()).toEqual(['row1', null, 'row2', 'row3'])

    await run('excel_delete_rows', { filePath: 'test.xlsx', at: 2, count: 1 })
    out = parseOutput<{ rows: unknown[][] }>(
      await run('excel_read_range', { filePath: 'test.xlsx', range: 'A1:A3' }),
    )
    expect(out.rows.flat()).toEqual(['row1', 'row2', 'row3'])
  })
})

// ------------------------------------------------------------
// Formatting
// ------------------------------------------------------------

describe('excel_format_range', () => {
  it('applies font and fill properties that survive round-trip', async () => {
    await run('excel_create_workbook', { filePath: 'test.xlsx' })
    await run('excel_write_cell', { filePath: 'test.xlsx', cell: 'A1', value: 'Header' })
    const res = await run('excel_format_range', {
      filePath: 'test.xlsx',
      range: 'A1',
      format: { bold: true, fontColor: 'FF0000', bgColor: 'FFFF00' },
    })
    expect(res.success).toBe(true)

    const wb = new ExcelJS.Workbook()
    await wb.xlsx.readFile(xlsxPath)
    const cell = wb.worksheets[0].getCell('A1')
    expect(cell.font?.bold).toBe(true)
    expect(cell.font?.color?.argb).toBe('FFFF0000')
    const fill = cell.fill as ExcelJS.FillPattern
    expect(fill?.fgColor?.argb).toBe('FFFFFF00')
  })
})

describe('excel_set_number_format', () => {
  it('sets numFmt on every cell in the range', async () => {
    await run('excel_create_workbook', { filePath: 'test.xlsx' })
    await run('excel_write_range', {
      filePath: 'test.xlsx',
      startCell: 'A1',
      values: [[1.234], [5.678]],
    })
    await run('excel_set_number_format', {
      filePath: 'test.xlsx',
      range: 'A1:A2',
      format: '0.00',
    })

    const wb = new ExcelJS.Workbook()
    await wb.xlsx.readFile(xlsxPath)
    expect(wb.worksheets[0].getCell('A1').numFmt).toBe('0.00')
    expect(wb.worksheets[0].getCell('A2').numFmt).toBe('0.00')
  })
})

// ------------------------------------------------------------
// Find/replace
// ------------------------------------------------------------

describe('excel_find_replace', () => {
  beforeEach(async () => {
    await run('excel_create_workbook', { filePath: 'test.xlsx' })
    await run('excel_write_range', {
      filePath: 'test.xlsx',
      startCell: 'A1',
      values: [
        ['Hello World', 1],
        ['hello there', 2],
        ['nothing', 3],
      ],
    })
  })

  it('case-insensitive literal replace', async () => {
    const out = parseOutput<{ totalReplacements: number; cellsTouched: number }>(
      await run('excel_find_replace', {
        filePath: 'test.xlsx',
        find: 'hello',
        replace: 'GOODBYE',
      }),
    )
    expect(out.totalReplacements).toBe(2)
    expect(out.cellsTouched).toBe(2)

    const data = parseOutput<{ rows: unknown[][] }>(
      await run('excel_read_range', { filePath: 'test.xlsx', range: 'A1:A3' }),
    )
    expect(data.rows.flat()).toEqual(['GOODBYE World', 'GOODBYE there', 'nothing'])
  })

  it('respects caseSensitive=true', async () => {
    const out = parseOutput<{ totalReplacements: number }>(
      await run('excel_find_replace', {
        filePath: 'test.xlsx',
        find: 'Hello',
        replace: 'X',
        caseSensitive: true,
      }),
    )
    expect(out.totalReplacements).toBe(1)
  })

  it('leaves numbers untouched even if their decimal text matches', async () => {
    const out = parseOutput<{ cellsTouched: number }>(
      await run('excel_find_replace', {
        filePath: 'test.xlsx',
        find: '1',
        replace: '999',
      }),
    )
    // The "1" in cell B1 is a NUMBER cell — we never rewrite numeric cells.
    expect(out.cellsTouched).toBe(0)
  })
})

// ------------------------------------------------------------
// Error paths
// ------------------------------------------------------------

describe('error handling', () => {
  it('reads from a missing file produce an actionable error', async () => {
    const res = await run('excel_read_workbook', { filePath: 'does-not-exist.xlsx' })
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/not found/i)
  })

  it('rejects an unknown sheet name with the available list', async () => {
    await run('excel_create_workbook', { filePath: 'test.xlsx', sheetName: 'Real' })
    const res = await run('excel_read_sheet', { filePath: 'test.xlsx', sheetName: 'NotReal' })
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/not found/i)
    expect(res.error).toMatch(/Real/) // available sheets in context
  })

  it('refuses to delete the only remaining sheet', async () => {
    await run('excel_create_workbook', { filePath: 'test.xlsx', sheetName: 'OnlyOne' })
    const res = await run('excel_delete_sheet', { filePath: 'test.xlsx', sheetName: 'OnlyOne' })
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/only remaining sheet/i)
  })
})

// ------------------------------------------------------------
// Concurrency: saves take the shared per-file lock
// ------------------------------------------------------------

describe('excel write concurrency', () => {
  it('fails the save while another writer holds the file lock, then succeeds after release', async () => {
    await run('excel_create_workbook', { filePath: 'test.xlsx', sheetName: 'Data' })

    // Hold the same per-file lock another tool/agent would take.
    const held = tryAcquireFileLock(xlsxPath)
    expect('release' in held).toBe(true)
    try {
      const blocked = await run('excel_write_cell', {
        filePath: 'test.xlsx',
        cell: 'A1',
        value: 'x',
      })
      expect(blocked.success).toBe(false)
      expect(blocked.error).toMatch(/locked/i)
    } finally {
      if ('release' in held) held.release()
    }

    const after = await run('excel_write_cell', { filePath: 'test.xlsx', cell: 'A1', value: 'x' })
    expect(after.success).toBe(true)
  })
})
