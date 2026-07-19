/**
 * Shared helpers for the Word read-only tool suite.
 *
 * Backed by `mammoth` (.docx → HTML / raw text). We deliberately do not
 * depend on `docx` (writer) here — the suite is read-only, see the
 * conversation log that locked this scope.
 *
 * Design notes
 * ------------
 * - mammoth converts a .docx into a small, predictable HTML subset:
 *     <p> <h1>…<h6> <table>…<tr><td> <ul>/<ol><li> <strong> <em> <a> <br> <img>
 *   Inline tags (<strong>, <em>, <a>) live INSIDE block elements; nested
 *   block-level constructs are limited to <li><p> / <td><p>. We extract
 *   only TOP-LEVEL blocks for a stable paragraph index; nested content
 *   becomes a single concatenated text+html chunk on its parent block.
 * - Paragraph index is 1-based and stable across all word_read_* tools, so
 *   the agent can drive `word_read_paragraph_range(start, end)` with
 *   indices it learned from `word_read_structured`.
 * - Path resolution mirrors Excel: we reuse `resolveExcelPath` (which is
 *   really a generic .office-style resolver despite its name). Renaming
 *   would touch the working Excel suite — out of scope here.
 */

import mammoth from 'mammoth'
import { resolveExcelPath } from './excelHelpers'
import type { ResolveOfficePathResult } from './excelHelpers'
import { buildToolFailure, type ToolFailureFields } from '../toolErrorFormat'

// ============================================================
// Limits (tunable)
// ============================================================

/** Max bytes returned by `word_read_text` / `word_read_html` in one call. */
export const WORD_TEXT_SIZE_LIMIT_BYTES = 1_000_000 // 1 MB ≈ ~250K tokens
/** Max paragraphs returned by `word_read_paragraph_range` in one call. */
export const WORD_PARAGRAPH_RANGE_MAX = 500
/**
 * `word_read_structured` returns full paragraph bodies up to this count.
 * Past it, the tool forces `outlineOnly: true` and tells the agent to
 * page through with `word_read_paragraph_range`.
 */
export const WORD_STRUCTURED_PARAGRAPH_LIMIT = 5000
/** `word_search` default cap. */
export const WORD_SEARCH_DEFAULT_MAX_RESULTS = 50

// ============================================================
// Path resolution (re-export the generic resolver; same path policy as Excel)
// ============================================================

export function resolveWordPath(
  filePath: string,
  toolName: string,
): ResolveOfficePathResult {
  // Word tools are READ-ONLY — no `forWrite` path is ever needed.
  return resolveExcelPath(filePath, { toolName, mustExist: true })
}

// ============================================================
// mammoth wrappers
// ============================================================

export interface MammothResult {
  value: string
  messages: Array<{ type: string; message: string }>
}

export async function loadDocxRawText(absPath: string): Promise<MammothResult> {
  const r = await mammoth.extractRawText({ path: absPath })
  return { value: r.value, messages: r.messages ?? [] }
}

export async function loadDocxHtml(absPath: string): Promise<MammothResult> {
  const r = await mammoth.convertToHtml({ path: absPath })
  return { value: r.value, messages: r.messages ?? [] }
}

// ============================================================
// HTML block parser
// ============================================================

export type WordBlockType = 'paragraph' | 'heading' | 'table' | 'list'

export interface WordBlock {
  /** 1-based stable index across the whole document. */
  index: number
  type: WordBlockType
  /** For headings only: 1-6. */
  level?: number
  /** For lists only: ordered (ol) or unordered (ul). */
  ordered?: boolean
  /** Inner HTML of the block (children only — outer tag stripped). */
  innerHtml: string
  /** Plain text of the block (HTML stripped, entities decoded). */
  text: string
}

const TOP_LEVEL_BLOCK_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'ul', 'ol'])
/** Tags we treat as void (no closing) for the depth tracker. */
const VOID_TAGS = new Set(['br', 'img', 'hr', 'meta', 'link', 'input'])

/**
 * Walk through the HTML once, tracking tag depth, and emit one
 * {@link WordBlock} per top-level block element.
 *
 * Why not a proper HTML parser? mammoth's output is well-formed and uses a
 * tiny tag set; a depth-counted regex sweep is ~30 lines and zero new
 * dependencies. If mammoth ever produces malformed HTML the sweep will
 * desync — tests guard the contract.
 */
export function extractTopLevelBlocks(html: string): WordBlock[] {
  const blocks: WordBlock[] = []
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g
  let depth = 0
  let openTag = ''
  let openContentStart = -1
  let openIndex = 0
  let m: RegExpExecArray | null
  while ((m = tagRe.exec(html)) !== null) {
    const isClose = m[1] === '/'
    const tag = m[2].toLowerCase()
    const attrs = m[3] || ''
    const isVoid = VOID_TAGS.has(tag) || /\/\s*$/.test(attrs)
    if (isVoid) continue
    if (!isClose) {
      if (depth === 0 && TOP_LEVEL_BLOCK_TAGS.has(tag)) {
        openTag = tag
        openContentStart = m.index + m[0].length
        openIndex = blocks.length + 1
      }
      depth++
    } else {
      depth--
      if (depth === 0 && tag === openTag) {
        const innerHtml = html.slice(openContentStart, m.index)
        const text = decodeEntities(stripTags(innerHtml)).trim()
        if (tag.startsWith('h')) {
          blocks.push({
            index: openIndex,
            type: 'heading',
            level: parseInt(tag[1], 10),
            innerHtml,
            text,
          })
        } else if (tag === 'p') {
          blocks.push({ index: openIndex, type: 'paragraph', innerHtml, text })
        } else if (tag === 'table') {
          blocks.push({ index: openIndex, type: 'table', innerHtml, text })
        } else if (tag === 'ul' || tag === 'ol') {
          blocks.push({
            index: openIndex,
            type: 'list',
            ordered: tag === 'ol',
            innerHtml,
            text,
          })
        }
        openTag = ''
      }
    }
  }
  return blocks
}

/** Strip all HTML tags from a fragment. Mammoth output is well-formed, so naive regex is safe. */
export function stripTags(html: string): string {
  // Replace block boundaries inside lists / table cells with newlines so the
  // text comes back readable. Specifically: </p>, </li>, </tr>, </td>, <br>
  return html
    .replace(/<\/(p|li|tr|h[1-6])>/gi, '\n')
    .replace(/<\/td>\s*/gi, '\t')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
}

/** Decode the small entity set mammoth emits. */
export function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
}

// ============================================================
// Output helpers
// ============================================================

/** Build a structured-error response when output would exceed the size limit. */
export function buildSizeLimitError(
  toolName: string,
  byteSize: number,
  limit: number,
): ToolFailureFields {
  return buildToolFailure(
    {
      what: `${toolName}: output is ${byteSize} bytes, exceeds limit of ${limit} bytes.`,
      next: 'Use `word_read_paragraph_range` to read the document in slices, or `word_read_structured` with `outlineOnly: true` to get just the heading outline.',
    },
    'validation',
  )
}

/** UTF-8 byte size of a string. */
export function byteSize(s: string): number {
  return Buffer.byteLength(s, 'utf8')
}
