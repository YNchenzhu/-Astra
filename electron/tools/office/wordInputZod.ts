/**
 * Zod input schemas for the Word read-only tool suite.
 *
 * Same conventions as electron/tools/toolInputZod.ts:
 *   - `.passthrough()` — unknown keys ignored, not rejected
 *   - snake_case + camelCase aliases on common fields (`filePath` / `file_path` / `path`)
 */

import { z } from 'zod'

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

// ---------- 1. word_read_text ----------

export const wordReadTextInputZod = filePathField
  .extend({
    /** Override the default 1MB output limit (use with care). */
    maxBytes: z.number().optional(),
  })
  .superRefine((data, ctx) => {
    if (!requireFilePath(data)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'filePath is required', path: ['filePath'] })
    }
  })

// ---------- 2. word_read_html ----------

export const wordReadHtmlInputZod = filePathField
  .extend({
    maxBytes: z.number().optional(),
  })
  .superRefine((data, ctx) => {
    if (!requireFilePath(data)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'filePath is required', path: ['filePath'] })
    }
  })

// ---------- 3. word_read_structured ----------

export const wordReadStructuredInputZod = filePathField
  .extend({
    /**
     * When true, return only headings + paragraph counts (no body text).
     * Auto-forced to true when the document exceeds WORD_STRUCTURED_PARAGRAPH_LIMIT.
     */
    outlineOnly: z.boolean().optional(),
    outline_only: z.boolean().optional(),
  })
  .superRefine((data, ctx) => {
    if (!requireFilePath(data)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'filePath is required', path: ['filePath'] })
    }
  })

// ---------- 4. word_read_paragraph_range ----------

export const wordReadParagraphRangeInputZod = filePathField
  .extend({
    /** 1-based inclusive starting paragraph index. */
    start: z.number(),
    /** 1-based inclusive ending paragraph index. Defaults to start + 100 when omitted. */
    end: z.number().optional(),
    /** Output format: 'text' (default) | 'html' | 'structured'. */
    format: z.enum(['text', 'html', 'structured']).optional(),
  })
  .superRefine((data, ctx) => {
    if (!requireFilePath(data)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'filePath is required', path: ['filePath'] })
    }
    if (typeof data.start !== 'number' || !Number.isInteger(data.start) || data.start < 1) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'start must be a positive integer (1-based)', path: ['start'] })
    }
    if (data.end !== undefined && (!Number.isInteger(data.end) || data.end < 1)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'end must be a positive integer when supplied', path: ['end'] })
    }
  })

// ---------- 5. word_search ----------

export const wordSearchInputZod = filePathField
  .extend({
    /** Pattern to look for. Treated as a literal substring unless `regex: true`. */
    query: z.string(),
    regex: z.boolean().optional(),
    caseSensitive: z.boolean().optional(),
    case_sensitive: z.boolean().optional(),
    /** Surrounding text in chars; default 80 each side. */
    contextChars: z.number().optional(),
    context_chars: z.number().optional(),
    /** Hard cap on hits returned (default 50). */
    maxResults: z.number().optional(),
    max_results: z.number().optional(),
  })
  .superRefine((data, ctx) => {
    if (!requireFilePath(data)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'filePath is required', path: ['filePath'] })
    }
    if (typeof data.query !== 'string' || data.query.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'query is required (non-empty string)', path: ['query'] })
    }
  })
