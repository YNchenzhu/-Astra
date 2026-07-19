/**
 * Word read-only tool suite — 5 tools for letting an AI agent ingest .docx
 * content at the right granularity.
 *
 *  1. word_read_text             — full plain text (size-capped)
 *  2. word_read_html             — full HTML (size-capped)
 *  3. word_read_structured       — outline + paragraphs[] (auto-degrades to outline-only on huge docs)
 *  4. word_read_paragraph_range  — paginate through a large doc by paragraph index
 *  5. word_search                — locate a query and return paragraph-anchored hits with context
 *
 * The suite is read-only by design (see conversation log).
 *
 * Paragraph index policy
 * ----------------------
 * All five tools agree on the same 1-based "top-level block" index. An agent
 * that calls `word_read_structured` to learn the outline can then ask for
 * specific slices via `word_read_paragraph_range(start, end)` — the index
 * space is identical.
 */

import type { Tool, ToolResult, ToolParameter } from '../types'
import { buildTool } from '../buildTool'
import { buildToolFailure } from '../toolErrorFormat'
import {
  resolveWordPath,
  loadDocxRawText,
  loadDocxHtml,
  extractTopLevelBlocks,
  byteSize,
  buildSizeLimitError,
  WORD_TEXT_SIZE_LIMIT_BYTES,
  WORD_PARAGRAPH_RANGE_MAX,
  WORD_STRUCTURED_PARAGRAPH_LIMIT,
  WORD_SEARCH_DEFAULT_MAX_RESULTS,
  type WordBlock,
} from './wordHelpers'
import {
  wordReadTextInputZod,
  wordReadHtmlInputZod,
  wordReadStructuredInputZod,
  wordReadParagraphRangeInputZod,
  wordSearchInputZod,
} from './wordInputZod'

// ============================================================
// Internal helpers (small + duplicated from excelTool to keep modules independent)
// ============================================================

function getStringField(input: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const v = input[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return ''
}

/**
 * Read a numeric field from `input`, supporting multiple key aliases.
 *
 * P1-2 (audit): callers like `word_search` advertise both camelCase and
 * snake_case aliases in their Zod schema (e.g. `contextChars` /
 * `context_chars`). Previously this helper only checked a single key, so
 * snake_case inputs that Zod accepted silently fell through to the fallback,
 * giving the model a different result than its schema implied. Now the
 * signature mirrors `getBool` — pass any number of aliases; the last
 * parameter is the optional numeric fallback.
 *
 * Usage:
 *   getNumber(input, 'contextChars', 'context_chars', 80)
 *   getNumber(input, 'limit', 50)
 *   getNumber(input, 'offset')
 */
function getNumber(
  input: Record<string, unknown>,
  ...keysAndFallback: Array<string | number | undefined>
): number | undefined {
  // Trailing argument is the fallback iff it's a number; everything else is a key.
  const last = keysAndFallback[keysAndFallback.length - 1]
  const fallback = typeof last === 'number' ? last : undefined
  const keys = (
    typeof last === 'number' ? keysAndFallback.slice(0, -1) : keysAndFallback
  ) as string[]
  for (const key of keys) {
    const v = input[key]
    if (typeof v === 'number' && Number.isFinite(v)) return v
    if (typeof v === 'string') {
      const n = Number(v)
      if (Number.isFinite(n)) return n
    }
  }
  return fallback
}

function getBool(input: Record<string, unknown>, ...keys: string[]): boolean | undefined {
  for (const k of keys) {
    const v = input[k]
    if (typeof v === 'boolean') return v
  }
  return undefined
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

const paramFilePath: ToolParameter = {
  name: 'filePath',
  type: 'string',
  description: 'Path to the .docx file. Absolute OR workspace-relative.',
  required: true,
}

// ============================================================
// 1. word_read_text
// ============================================================

const wordReadText = buildTool({
  name: 'word_read_text',
  description:
    'Read the full plain-text content of a .docx file (no formatting). Best for ' +
    'quick "what does this document say" questions. Hard byte cap (default 1 MB) ' +
    'with a structured error pointing to `word_read_paragraph_range` for huge files.',
  searchHint: 'read Word docx plain text content full document',
  inputSchema: [paramFilePath,
    { name: 'maxBytes', type: 'number', description: 'Override the 1 MB default cap. Use sparingly.' },
  ],
  zInputSchema: wordReadTextInputZod,
  isReadOnly: true,
  isConcurrencySafe: true,
  async call(input, _ctx) {
    const TOOL = 'word_read_text'
    const filePath = getStringField(input, 'filePath', 'file_path', 'path')
    if (!filePath) return err(TOOL, 'filePath is required')
    const maxBytes = getNumber(input, 'maxBytes', WORD_TEXT_SIZE_LIMIT_BYTES) ?? WORD_TEXT_SIZE_LIMIT_BYTES
    const r = resolveWordPath(filePath, TOOL)
    if (!r.ok) return { success: false, ...r }
    try {
      const result = await loadDocxRawText(r.resolved)
      const size = byteSize(result.value)
      if (size > maxBytes) {
        return { success: false, ...buildSizeLimitError(TOOL, size, maxBytes) }
      }
      return ok({
        path: r.resolved,
        bytes: size,
        text: result.value,
        warnings: result.messages.filter((m) => m.type === 'warning').map((m) => m.message),
      })
    } catch (e) {
      return err(TOOL, `failed to read docx: ${getErrorMessage(e)}`)
    }
  },
})

// ============================================================
// 2. word_read_html
// ============================================================

const wordReadHtml = buildTool({
  name: 'word_read_html',
  description:
    'Read a .docx as HTML (mammoth conversion). Preserves headings, bold/italic, ' +
    'links, lists, and tables — the most useful "AI-readable" view of a Word doc. ' +
    'Hard byte cap (default 1 MB); use `word_read_paragraph_range` for huge files.',
  searchHint: 'read Word docx HTML formatted markup headings bold links',
  inputSchema: [paramFilePath,
    { name: 'maxBytes', type: 'number', description: 'Override the 1 MB default cap.' },
  ],
  zInputSchema: wordReadHtmlInputZod,
  isReadOnly: true,
  isConcurrencySafe: true,
  async call(input, _ctx) {
    const TOOL = 'word_read_html'
    const filePath = getStringField(input, 'filePath', 'file_path', 'path')
    if (!filePath) return err(TOOL, 'filePath is required')
    const maxBytes = getNumber(input, 'maxBytes', WORD_TEXT_SIZE_LIMIT_BYTES) ?? WORD_TEXT_SIZE_LIMIT_BYTES
    const r = resolveWordPath(filePath, TOOL)
    if (!r.ok) return { success: false, ...r }
    try {
      const result = await loadDocxHtml(r.resolved)
      const size = byteSize(result.value)
      if (size > maxBytes) {
        return { success: false, ...buildSizeLimitError(TOOL, size, maxBytes) }
      }
      return ok({
        path: r.resolved,
        bytes: size,
        html: result.value,
        warnings: result.messages.filter((m) => m.type === 'warning').map((m) => m.message),
      })
    } catch (e) {
      return err(TOOL, `failed to convert docx to html: ${getErrorMessage(e)}`)
    }
  },
})

// ============================================================
// 3. word_read_structured
// ============================================================

interface OutlineEntry {
  index: number
  level: number
  text: string
}
interface ParagraphSummary {
  index: number
  type: WordBlock['type']
  level?: number
  ordered?: boolean
  text: string
}

const wordReadStructured = buildTool({
  name: 'word_read_structured',
  description:
    'Parse a .docx into a structured outline: { headings: [...], paragraphs: [...], ' +
    'totalBlocks }. Each paragraph carries a stable 1-based `index` you can feed ' +
    'to `word_read_paragraph_range`. For very large docs (>5000 blocks) the tool ' +
    'auto-forces `outlineOnly: true` and drops paragraph bodies — use the range ' +
    'tool to read content. Set `outlineOnly: true` explicitly for a cheap toc-only call.',
  searchHint: 'Word docx outline headings table of contents structure paragraphs',
  inputSchema: [paramFilePath,
    { name: 'outlineOnly', type: 'boolean', description: 'Return only headings + counts (skip paragraph bodies).' },
  ],
  zInputSchema: wordReadStructuredInputZod,
  isReadOnly: true,
  isConcurrencySafe: true,
  async call(input, _ctx) {
    const TOOL = 'word_read_structured'
    const filePath = getStringField(input, 'filePath', 'file_path', 'path')
    if (!filePath) return err(TOOL, 'filePath is required')
    const requestedOutlineOnly = getBool(input, 'outlineOnly', 'outline_only') ?? false

    const r = resolveWordPath(filePath, TOOL)
    if (!r.ok) return { success: false, ...r }
    try {
      const html = await loadDocxHtml(r.resolved)
      const blocks = extractTopLevelBlocks(html.value)
      const tooLarge = blocks.length > WORD_STRUCTURED_PARAGRAPH_LIMIT
      const outlineOnly = requestedOutlineOnly || tooLarge

      const headings: OutlineEntry[] = blocks
        .filter((b) => b.type === 'heading')
        .map((b) => ({ index: b.index, level: b.level ?? 1, text: b.text }))

      const counts = {
        total: blocks.length,
        headings: headings.length,
        paragraphs: blocks.filter((b) => b.type === 'paragraph').length,
        tables: blocks.filter((b) => b.type === 'table').length,
        lists: blocks.filter((b) => b.type === 'list').length,
      }

      const payload: Record<string, unknown> = {
        path: r.resolved,
        counts,
        headings,
        outlineOnly,
      }
      if (!outlineOnly) {
        const paragraphs: ParagraphSummary[] = blocks.map((b) => ({
          index: b.index,
          type: b.type,
          level: b.level,
          ordered: b.ordered,
          text: b.text,
        }))
        payload.paragraphs = paragraphs
      } else if (tooLarge && !requestedOutlineOnly) {
        payload.note =
          `Document has ${blocks.length} blocks (> ${WORD_STRUCTURED_PARAGRAPH_LIMIT}); ` +
          `bodies omitted. Use \`word_read_paragraph_range\` to page through.`
      }
      return ok(payload)
    } catch (e) {
      return err(TOOL, `failed: ${getErrorMessage(e)}`)
    }
  },
})

// ============================================================
// 4. word_read_paragraph_range
// ============================================================

const wordReadParagraphRange = buildTool({
  name: 'word_read_paragraph_range',
  description:
    'Read a slice of paragraphs by 1-based index, e.g. start=10, end=50. The ' +
    'paragraph index is the same one returned by `word_read_structured`. Hard cap ' +
    `of ${WORD_PARAGRAPH_RANGE_MAX} paragraphs per call. ` +
    'Output format: "text" (default), "html", or "structured" (per-paragraph snapshots).',
  searchHint: 'Word docx paginate paragraphs read range slice',
  inputSchema: [paramFilePath,
    { name: 'start', type: 'number', description: '1-based starting paragraph index (inclusive).', required: true },
    { name: 'end', type: 'number', description: 'Ending paragraph index (inclusive). Default = start + 100.' },
    { name: 'format', type: 'string', description: '"text" | "html" | "structured" (default "text").' },
  ],
  zInputSchema: wordReadParagraphRangeInputZod,
  isReadOnly: true,
  isConcurrencySafe: true,
  async call(input, _ctx) {
    const TOOL = 'word_read_paragraph_range'
    const filePath = getStringField(input, 'filePath', 'file_path', 'path')
    if (!filePath) return err(TOOL, 'filePath is required')
    const start = getNumber(input, 'start')
    if (start === undefined || !Number.isInteger(start) || start < 1) {
      return err(TOOL, 'start is required (positive integer, 1-based)')
    }
    const end = getNumber(input, 'end', start + 100) ?? start + 100
    if (end < start) return err(TOOL, '`end` must be ≥ `start`')
    if (end - start + 1 > WORD_PARAGRAPH_RANGE_MAX) {
      return err(TOOL, `range covers ${end - start + 1} paragraphs, exceeds limit of ${WORD_PARAGRAPH_RANGE_MAX}`)
    }
    const formatRaw = getStringField(input, 'format')
    const format: 'text' | 'html' | 'structured' =
      formatRaw === 'html' || formatRaw === 'structured' ? formatRaw : 'text'

    const r = resolveWordPath(filePath, TOOL)
    if (!r.ok) return { success: false, ...r }
    try {
      const html = await loadDocxHtml(r.resolved)
      const allBlocks = extractTopLevelBlocks(html.value)
      if (start > allBlocks.length) {
        return ok({
          path: r.resolved,
          totalBlocks: allBlocks.length,
          start, end,
          paragraphs: [],
          note: `start (${start}) is beyond the document's last block (${allBlocks.length}).`,
        })
      }
      const slice = allBlocks.filter((b) => b.index >= start && b.index <= end)
      let payload: Record<string, unknown>
      if (format === 'text') {
        payload = {
          path: r.resolved,
          totalBlocks: allBlocks.length,
          start, end: Math.min(end, allBlocks.length),
          returnedCount: slice.length,
          text: slice.map((b) => b.text).join('\n\n'),
        }
      } else if (format === 'html') {
        payload = {
          path: r.resolved,
          totalBlocks: allBlocks.length,
          start, end: Math.min(end, allBlocks.length),
          returnedCount: slice.length,
          html: slice.map((b) => `<${blockOuterTag(b)}>${b.innerHtml}</${blockOuterTag(b)}>`).join('\n'),
        }
      } else {
        payload = {
          path: r.resolved,
          totalBlocks: allBlocks.length,
          start, end: Math.min(end, allBlocks.length),
          returnedCount: slice.length,
          paragraphs: slice.map((b) => ({
            index: b.index,
            type: b.type,
            level: b.level,
            ordered: b.ordered,
            text: b.text,
          })),
        }
      }
      return ok(payload)
    } catch (e) {
      return err(TOOL, `failed: ${getErrorMessage(e)}`)
    }
  },
})

function blockOuterTag(b: WordBlock): string {
  if (b.type === 'heading') return `h${b.level ?? 1}`
  if (b.type === 'list') return b.ordered ? 'ol' : 'ul'
  if (b.type === 'table') return 'table'
  return 'p'
}

// ============================================================
// 5. word_search
// ============================================================

interface SearchHit {
  paragraphIndex: number
  paragraphType: WordBlock['type']
  /** Character offset INSIDE the paragraph text where the match starts. */
  offset: number
  /** The literal matched substring. */
  match: string
  /** `contextChars` around the match, prefixed/suffixed with `…` when truncated. */
  context: string
}

const wordSearch = buildTool({
  name: 'word_search',
  description:
    'Search for a query inside a .docx and return paragraph-anchored hits with ' +
    'surrounding context. Useful for "where does this document mention X" before ' +
    'fetching a slice with `word_read_paragraph_range`. Set `regex: true` for a ' +
    'JS RegExp pattern. Default cap of ' + WORD_SEARCH_DEFAULT_MAX_RESULTS + ' hits.',
  searchHint: 'Word docx search find text query contains',
  inputSchema: [paramFilePath,
    { name: 'query', type: 'string', description: 'Search pattern. Empty string is rejected.', required: true },
    { name: 'regex', type: 'boolean', description: 'Treat `query` as a regex.' },
    { name: 'caseSensitive', type: 'boolean', description: 'Default false (case-insensitive).' },
    { name: 'contextChars', type: 'number', description: 'Chars on each side of the match. Default 80.' },
    { name: 'maxResults', type: 'number', description: 'Hard cap on hits. Default 50.' },
  ],
  zInputSchema: wordSearchInputZod,
  isReadOnly: true,
  isConcurrencySafe: true,
  async call(input, _ctx) {
    const TOOL = 'word_search'
    const filePath = getStringField(input, 'filePath', 'file_path', 'path')
    if (!filePath) return err(TOOL, 'filePath is required')
    const query = typeof input.query === 'string' ? input.query : ''
    if (!query) return err(TOOL, 'query is required (non-empty)')
    const useRegex = getBool(input, 'regex') ?? false
    const caseSensitive = getBool(input, 'caseSensitive', 'case_sensitive') ?? false
    const contextChars = Math.max(0, Math.min(getNumber(input, 'contextChars', 'context_chars', 80) ?? 80, 500))
    const maxResults = Math.max(1, getNumber(input, 'maxResults', 'max_results', WORD_SEARCH_DEFAULT_MAX_RESULTS) ?? WORD_SEARCH_DEFAULT_MAX_RESULTS)

    let pattern: RegExp
    try {
      pattern = useRegex
        ? new RegExp(query, caseSensitive ? 'g' : 'gi')
        : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), caseSensitive ? 'g' : 'gi')
    } catch (e) {
      return err(TOOL, `invalid regex: ${getErrorMessage(e)}`)
    }

    const r = resolveWordPath(filePath, TOOL)
    if (!r.ok) return { success: false, ...r }
    try {
      const html = await loadDocxHtml(r.resolved)
      const blocks = extractTopLevelBlocks(html.value)
      const hits: SearchHit[] = []
      let truncated = false
      outer: for (const b of blocks) {
        // Reset regex `lastIndex` per block (global flag).
        pattern.lastIndex = 0
        let m: RegExpExecArray | null
        while ((m = pattern.exec(b.text)) !== null) {
          if (hits.length >= maxResults) {
            truncated = true
            break outer
          }
          const offset = m.index
          const start = Math.max(0, offset - contextChars)
          const end = Math.min(b.text.length, offset + m[0].length + contextChars)
          const slice = b.text.slice(start, end)
          const prefix = start > 0 ? '…' : ''
          const suffix = end < b.text.length ? '…' : ''
          hits.push({
            paragraphIndex: b.index,
            paragraphType: b.type,
            offset,
            match: m[0],
            context: prefix + slice + suffix,
          })
          // Avoid infinite loops on zero-length matches.
          if (m[0].length === 0) pattern.lastIndex++
        }
      }
      return ok({
        path: r.resolved,
        totalBlocks: blocks.length,
        query,
        regex: useRegex,
        caseSensitive,
        hitCount: hits.length,
        truncated,
        hits,
      })
    } catch (e) {
      return err(TOOL, `failed: ${getErrorMessage(e)}`)
    }
  },
})

// ============================================================
// Public registry export
// ============================================================

/**
 * Deferred loading — same rationale and recovery mechanisms as the Excel
 * family; see the `markDeferredOfficeTool` doc block in `./excelTool.ts`.
 * (ToolSearch discovery + direct-call educative guard + sub-agent
 * whitelist bypass.)
 */
const markDeferredOfficeTool = (t: Tool): Tool => ({ ...t, shouldDefer: true })

export const wordTools: Tool[] = [
  wordReadText,
  wordReadHtml,
  wordReadStructured,
  wordReadParagraphRange,
  wordSearch,
].map(markDeferredOfficeTool)
