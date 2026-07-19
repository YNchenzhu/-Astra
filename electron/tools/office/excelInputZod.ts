/**
 * Zod input schemas for the Excel tool suite.
 *
 * Conventions (matching electron/tools/toolInputZod.ts):
 *   - `.passthrough()` —unknown keys ignored, not rejected (model self-correction)
 *   - snake_case + camelCase aliases on common fields (`filePath` / `file_path` / `path`)
 *   - One exported schema per tool; the registry pairs them via `zInputSchema`
 */

import { z } from 'zod'

// ---------- Reusable building blocks ----------

const filePathField = z
  .object({
    filePath: z.string().optional(),
    file_path: z.string().optional(),
    path: z.string().optional(),
  })
  .passthrough()

function requireFilePath(data: { filePath?: string; file_path?: string; path?: string }): string | null {
  return (data.filePath ?? data.file_path ?? data.path ?? '').trim() || null
}

const sheetNameOpt = z.string().optional()

const cellValueLoose = z.union([z.string(), z.number(), z.boolean(), z.null()]).optional()

// ---------- Workbook / sheet management ----------

export const excelReadWorkbookInputZod = filePathField.superRefine((data, ctx) => {
  if (!requireFilePath(data)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'filePath is required', path: ['filePath'] })
  }
})

export const excelCreateWorkbookInputZod = filePathField
  .extend({
    sheetName: sheetNameOpt,
    overwrite: z.boolean().optional(),
  })
  .superRefine((data, ctx) => {
    if (!requireFilePath(data)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'filePath is required', path: ['filePath'] })
    }
  })

export const excelCreateSheetInputZod = filePathField
  .extend({
    sheetName: z.string(),
    /** Insert position (0-based). Default = end of workbook. */
    index: z.number().optional(),
  })
  .superRefine((data, ctx) => {
    if (!requireFilePath(data)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'filePath is required', path: ['filePath'] })
    }
    if (!data.sheetName.trim()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'sheetName is required', path: ['sheetName'] })
    }
  })

export const excelDeleteSheetInputZod = filePathField
  .extend({
    sheetName: z.string(),
  })
  .superRefine((data, ctx) => {
    if (!requireFilePath(data)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'filePath is required', path: ['filePath'] })
    }
    if (!data.sheetName.trim()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'sheetName is required', path: ['sheetName'] })
    }
  })

export const excelRenameSheetInputZod = filePathField
  .extend({
    sheetName: z.string(),
    newName: z.string(),
  })
  .superRefine((data, ctx) => {
    if (!requireFilePath(data)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'filePath is required', path: ['filePath'] })
    }
    if (!data.sheetName.trim()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'sheetName is required', path: ['sheetName'] })
    }
    if (!data.newName.trim()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'newName is required', path: ['newName'] })
    }
  })

// ---------- Read ----------

export const excelReadSheetInputZod = filePathField
  .extend({
    sheetName: sheetNameOpt,
    /** Optional A1:D10 to limit; default = used range. */
    range: z.string().optional(),
    /** When true, returns formulas instead of values for formula cells. Default false. */
    includeFormulas: z.boolean().optional(),
  })
  .superRefine((data, ctx) => {
    if (!requireFilePath(data)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'filePath is required', path: ['filePath'] })
    }
  })

export const excelReadRangeInputZod = filePathField
  .extend({
    range: z.string(),
    sheetName: sheetNameOpt,
    includeFormulas: z.boolean().optional(),
  })
  .superRefine((data, ctx) => {
    if (!requireFilePath(data)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'filePath is required', path: ['filePath'] })
    }
    if (!data.range.trim()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'range is required (e.g. "A1:D10")', path: ['range'] })
    }
  })

export const excelReadCellInputZod = filePathField
  .extend({
    cell: z.string(),
    sheetName: sheetNameOpt,
  })
  .superRefine((data, ctx) => {
    if (!requireFilePath(data)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'filePath is required', path: ['filePath'] })
    }
    if (!data.cell.trim()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'cell is required (e.g. "B7")', path: ['cell'] })
    }
  })

export const excelGetUsedRangeInputZod = filePathField
  .extend({
    sheetName: sheetNameOpt,
  })
  .superRefine((data, ctx) => {
    if (!requireFilePath(data)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'filePath is required', path: ['filePath'] })
    }
  })

// ---------- Write ----------

export const excelWriteCellInputZod = filePathField
  .extend({
    cell: z.string(),
    value: cellValueLoose,
    sheetName: sheetNameOpt,
  })
  .superRefine((data, ctx) => {
    if (!requireFilePath(data)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'filePath is required', path: ['filePath'] })
    }
    if (!data.cell.trim()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'cell is required', path: ['cell'] })
    }
  })

export const excelWriteRangeInputZod = filePathField
  .extend({
    /** Anchor cell (top-left of the destination block), e.g. "A1". */
    startCell: z.string(),
    /** 2D array of rows; each row is an array of cell values (string/number/boolean/null/=formula). */
    values: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))),
    sheetName: sheetNameOpt,
  })
  .superRefine((data, ctx) => {
    if (!requireFilePath(data)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'filePath is required', path: ['filePath'] })
    }
    if (!data.startCell.trim()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'startCell is required', path: ['startCell'] })
    }
  })

export const excelSetFormulaInputZod = filePathField
  .extend({
    cell: z.string(),
    /** Formula text WITHOUT the leading `=` (e.g. "SUM(A1:A10)"). The leading `=` is also tolerated. */
    formula: z.string(),
    sheetName: sheetNameOpt,
  })
  .superRefine((data, ctx) => {
    if (!requireFilePath(data)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'filePath is required', path: ['filePath'] })
    }
    if (!data.cell.trim()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'cell is required', path: ['cell'] })
    }
    if (!data.formula.trim()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'formula is required', path: ['formula'] })
    }
  })

export const excelClearRangeInputZod = filePathField
  .extend({
    range: z.string(),
    sheetName: sheetNameOpt,
  })
  .superRefine((data, ctx) => {
    if (!requireFilePath(data)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'filePath is required', path: ['filePath'] })
    }
    if (!data.range.trim()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'range is required', path: ['range'] })
    }
  })

export const excelAppendRowsInputZod = filePathField
  .extend({
    /** 2D array; each row appended after the current last used row. */
    rows: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))),
    sheetName: sheetNameOpt,
  })
  .superRefine((data, ctx) => {
    if (!requireFilePath(data)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'filePath is required', path: ['filePath'] })
    }
  })

// ---------- Row / column ----------

export const excelInsertRowsInputZod = filePathField
  .extend({
    /** 1-based row index where the new rows start. */
    at: z.number(),
    /** How many rows to insert (default 1). */
    count: z.number().optional(),
    sheetName: sheetNameOpt,
  })
  .superRefine((data, ctx) => {
    if (!requireFilePath(data)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'filePath is required', path: ['filePath'] })
    }
  })

export const excelInsertColumnsInputZod = filePathField
  .extend({
    /** 1-based column index where the new columns start. */
    at: z.number(),
    count: z.number().optional(),
    sheetName: sheetNameOpt,
  })
  .superRefine((data, ctx) => {
    if (!requireFilePath(data)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'filePath is required', path: ['filePath'] })
    }
  })

export const excelDeleteRowsInputZod = filePathField
  .extend({
    at: z.number(),
    count: z.number().optional(),
    sheetName: sheetNameOpt,
  })
  .superRefine((data, ctx) => {
    if (!requireFilePath(data)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'filePath is required', path: ['filePath'] })
    }
  })

export const excelDeleteColumnsInputZod = filePathField
  .extend({
    at: z.number(),
    count: z.number().optional(),
    sheetName: sheetNameOpt,
  })
  .superRefine((data, ctx) => {
    if (!requireFilePath(data)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'filePath is required', path: ['filePath'] })
    }
  })

// ---------- Formatting ----------

const formatPropsSchema = z
  .object({
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    underline: z.boolean().optional(),
    fontSize: z.number().optional(),
    fontName: z.string().optional(),
    /** ARGB hex (with or without leading `#`), e.g. "FF0000" or "#FFFF0000". */
    fontColor: z.string().optional(),
    /** Background fill ARGB hex. */
    bgColor: z.string().optional(),
    /** "left" | "center" | "right" */
    horizontalAlignment: z.enum(['left', 'center', 'right']).optional(),
    /** "top" | "middle" | "bottom" */
    verticalAlignment: z.enum(['top', 'middle', 'bottom']).optional(),
    wrapText: z.boolean().optional(),
    /** Apply a thin border on all 4 sides. */
    border: z.boolean().optional(),
  })
  .passthrough()

export const excelFormatRangeInputZod = filePathField
  .extend({
    range: z.string(),
    sheetName: sheetNameOpt,
    format: formatPropsSchema,
  })
  .superRefine((data, ctx) => {
    if (!requireFilePath(data)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'filePath is required', path: ['filePath'] })
    }
    if (!data.range.trim()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'range is required', path: ['range'] })
    }
  })

export const excelSetColumnWidthInputZod = filePathField
  .extend({
    /** Column letter ("A") OR 1-based number. */
    column: z.union([z.string(), z.number()]),
    width: z.number(),
    sheetName: sheetNameOpt,
  })
  .superRefine((data, ctx) => {
    if (!requireFilePath(data)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'filePath is required', path: ['filePath'] })
    }
  })

export const excelSetRowHeightInputZod = filePathField
  .extend({
    row: z.number(),
    height: z.number(),
    sheetName: sheetNameOpt,
  })
  .superRefine((data, ctx) => {
    if (!requireFilePath(data)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'filePath is required', path: ['filePath'] })
    }
  })

export const excelSetNumberFormatInputZod = filePathField
  .extend({
    range: z.string(),
    /** Excel number format code, e.g. "0.00", "#,##0", "yyyy-mm-dd", "0.00%". */
    format: z.string(),
    sheetName: sheetNameOpt,
  })
  .superRefine((data, ctx) => {
    if (!requireFilePath(data)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'filePath is required', path: ['filePath'] })
    }
    if (!data.range.trim()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'range is required', path: ['range'] })
    }
    if (!data.format.trim()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'format is required', path: ['format'] })
    }
  })

// ---------- Advanced ----------

export const excelMergeCellsInputZod = filePathField
  .extend({
    range: z.string(),
    sheetName: sheetNameOpt,
  })
  .superRefine((data, ctx) => {
    if (!requireFilePath(data)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'filePath is required', path: ['filePath'] })
    }
    if (!data.range.trim()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'range is required', path: ['range'] })
    }
  })

export const excelUnmergeCellsInputZod = filePathField
  .extend({
    range: z.string(),
    sheetName: sheetNameOpt,
  })
  .superRefine((data, ctx) => {
    if (!requireFilePath(data)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'filePath is required', path: ['filePath'] })
    }
    if (!data.range.trim()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'range is required', path: ['range'] })
    }
  })

export const excelFindReplaceInputZod = filePathField
  .extend({
    find: z.string(),
    replace: z.string(),
    sheetName: sheetNameOpt,
    /** When omitted, search all sheets. */
    allSheets: z.boolean().optional(),
    /** Limit search to a range. */
    range: z.string().optional(),
    /** Treat `find` as a regex. Default false (literal match). */
    regex: z.boolean().optional(),
    caseSensitive: z.boolean().optional(),
  })
  .superRefine((data, ctx) => {
    if (!requireFilePath(data)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'filePath is required', path: ['filePath'] })
    }
    if (typeof data.find !== 'string' || data.find.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'find is required (non-empty string)', path: ['find'] })
    }
    if (typeof data.replace !== 'string') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'replace is required (string, may be empty)', path: ['replace'] })
    }
  })

export const excelSetNamedRangeInputZod = filePathField
  .extend({
    name: z.string(),
    /** Sheet-qualified range, e.g. "Sheet1!A1:D10". `sheetName` is used when omitted. */
    range: z.string(),
    sheetName: sheetNameOpt,
  })
  .superRefine((data, ctx) => {
    if (!requireFilePath(data)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'filePath is required', path: ['filePath'] })
    }
    if (!data.name.trim()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'name is required', path: ['name'] })
    }
    if (!data.range.trim()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'range is required', path: ['range'] })
    }
  })
