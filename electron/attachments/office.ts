/**
 * Industrial-grade Office extraction.
 *
 *  - docx → Markdown via `mammoth.convertToMarkdown`. Preserves headings,
 *    lists, tables, hyperlinks, footnotes (via style map). Inline images are
 *    collected in reading order; the preview layer reinjects them via data:
 *    URIs so layout fidelity is close to the source. Falls back to the raw
 *    ZIP-XML text extractor if mammoth throws.
 *  - xlsx → per-sheet Markdown tables via SheetJS (`xlsx`). Preserves merged
 *    cells (col/row-spans collapse gracefully in Markdown, fidelity markers
 *    are surfaced via `sheetsMeta`), formulas (shown inline as
 *    `value  ⟨=FORMULA⟩`), ISO dates (locale-independent), and multi-line
 *    cells (kept as `<br>` so the Markdown renderer preserves line breaks).
 *    Each sheet tracks row/column truncation in structured metadata so the UI
 *    can render precise banners instead of hiding the fact.
 *  - pptx → legacy ZIP-XML path (slide titles + bullets).
 *  - Legacy doc/xls/ppt: try `soffice --headless --convert-to` if LibreOffice
 *    is available; otherwise return a structured error with remediation.
 */

import { readFile } from 'fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const execFileAsync = promisify(execFile)

export interface OfficeExtractResult {
  ok: true
  text: string
  truncated: boolean
  originalChars: number
  /**
   * For xlsx: per-sheet metadata so the UI can render precise "previewing X of
   * Y rows" banners and indicate layout-fidelity trade-offs.
   */
  sheets?: Array<{
    name: string
    rowCount: number
    colCount: number
    truncatedRows?: boolean
    truncatedCols?: boolean
    hasFormulas?: boolean
    mergeCount?: number
  }>
  /**
   * For docx: in-order base64 copies of inline images extracted from the
   * document. The markdown text references them as `![](astra:docx-image:N)`
   * and we relay the binary as vision blocks when serializing.
   */
  inlineImages?: Array<{ base64: string; mediaType: string; altText?: string }>
  /** Non-fatal remarks surfaced in the preview UI as informational notes. */
  notes?: string[]
}

export interface OfficeExtractError {
  ok: false
  error: string
  /** Some errors are accompanied by a best-effort remediation hint. */
  hint?: string
}

// Tuned for typical enterprise Word documents (~300K chars after markdown
// conversion). 350K leaves headroom for tables/footnotes while staying
// under the 200K-per-message tool-result cap plus preamble overhead.
const MAX_TOTAL_CHARS = 350_000
const XLSX_MAX_ROWS_PER_SHEET = 2_000
const XLSX_MAX_COLS_PER_SHEET = 200
const MAX_DOCX_IMAGES = 40
const MAX_DOCX_IMAGE_BYTES = 4 * 1024 * 1024

export async function extractOffice(
  filePath: string,
  ext: string,
): Promise<OfficeExtractResult | OfficeExtractError> {
  const extLower = ext.toLowerCase()

  if (extLower === 'doc' || extLower === 'xls' || extLower === 'ppt') {
    return extractLegacyViaSoffice(filePath, extLower as 'doc' | 'xls' | 'ppt')
  }

  if (extLower === 'docx') return extractDocx(filePath)
  if (extLower === 'xlsx') return extractXlsx(filePath)
  if (extLower === 'pptx') return extractPptx(filePath)

  return { ok: false, error: `Unsupported Office extension: .${extLower}` }
}

// ---------------------------------------------------------------------------
// DOCX
// ---------------------------------------------------------------------------

/**
 * Minimal structural view of the `mammoth` module surface we actually
 * call. Avoids `any` while still tolerating drift in the real typings.
 */
interface MammothImageElement {
  read(): Promise<Buffer>
  contentType?: string
  altText?: string
}
interface MammothConvertResult {
  value?: string
  messages?: Array<{ type?: string; message?: string }>
}
interface MammothConvertOptions {
  convertImage?: (el: MammothImageElement) => Promise<Record<string, string>>
  styleMap?: string[]
  includeDefaultStyleMap?: boolean
}
interface MammothModule {
  convertToHtml(input: { buffer: Buffer }, options?: MammothConvertOptions): Promise<MammothConvertResult>
  convertToMarkdown(input: { buffer: Buffer }, options?: MammothConvertOptions): Promise<MammothConvertResult>
  extractRawText(input: { buffer: Buffer }): Promise<MammothConvertResult>
  images: {
    imgElement(
      handler: (el: MammothImageElement) => Promise<Record<string, string>>,
    ): (el: MammothImageElement) => Promise<Record<string, string>>
  }
}

async function extractDocx(filePath: string): Promise<OfficeExtractResult | OfficeExtractError> {
  try {
    const modRaw = (await import('mammoth')) as unknown
    const mod = (modRaw && typeof modRaw === 'object' && 'default' in modRaw
      ? (modRaw as { default: MammothModule }).default
      : (modRaw as MammothModule))
    const mammoth = mod
    const buf = await readFile(filePath)

    const collected: NonNullable<OfficeExtractResult['inlineImages']> = []
    const notes: string[] = []
    let imagesDropped = 0

    const imageHandler = mammoth.images.imgElement(async (el: {
      read(): Promise<Buffer>
      contentType?: string
      altText?: string
    }) => {
      try {
        if (collected.length >= MAX_DOCX_IMAGES) {
          imagesDropped++
          return { src: `astra:docx-image-dropped:cap-${MAX_DOCX_IMAGES}` }
        }
        const bin = await el.read()
        if (!bin || bin.length === 0) {
          return { src: 'astra:docx-image-dropped:empty' }
        }
        if (bin.length > MAX_DOCX_IMAGE_BYTES) {
          imagesDropped++
          return { src: `astra:docx-image-dropped:oversized-${bin.length}` }
        }
        const mt = el.contentType || 'image/png'
        collected.push({
          base64: bin.toString('base64'),
          mediaType: mt,
          altText: el.altText,
        })
        return { src: `astra:docx-image:${collected.length - 1}` }
      } catch {
        imagesDropped++
        return { src: 'astra:docx-image-dropped:read-error' }
      }
    })

    /**
     * Style-map: preserve Word-native "hidden" structure (footnotes,
     * endnotes, comments, header/footer text) so the AI and the user see the
     * complete document, not just the main body. Only the styles mammoth
     * knows about get emitted; unknown styles fall through to its default
     * mapping so we never "lose" content.
     */
    const styleMap = [
      "p[style-name='Title'] => h1:fresh",
      "p[style-name='Subtitle'] => h2:fresh",
      "p[style-name='Quote'] => blockquote:fresh",
      "p[style-name='Intense Quote'] => blockquote.intense:fresh",
      "p[style-name='footnote text'] => p.footnote:fresh",
      "p[style-name='endnote text'] => p.endnote:fresh",
      "r[style-name='Strong'] => strong",
      "r[style-name='Emphasis'] => em",
      "r[style-name='Code'] => code",
      "r[style-name='Hyperlink'] => a",
      // Keep footnote/endnote reference markers inline so the body
      // reads "... claim [1]" instead of losing the citation entirely.
      "r[style-name='footnote reference'] => sup",
      "r[style-name='endnote reference'] => sup",
      "comment-reference => sup.comment-ref",
    ]

    const r = await mammoth.convertToMarkdown(
      { buffer: buf },
      { convertImage: imageHandler, styleMap, includeDefaultStyleMap: true },
    )

    const md: string = typeof r?.value === 'string' ? r.value : ''

    // Mammoth emits warnings for unsupported structures (e.g. SmartArt).
    // Collect the distinct messages so the UI can proactively mention them.
    if (Array.isArray(r?.messages)) {
      const seen = new Set<string>()
      for (const m of r.messages as Array<{ type?: string; message?: string }>) {
        if (!m?.message || m.type === 'info') continue
        const key = m.message.replace(/\s+/g, ' ').trim().slice(0, 160)
        if (seen.has(key)) continue
        seen.add(key)
        if (seen.size <= 3) notes.push(`mammoth: ${key}`)
      }
      if (seen.size > 3) notes.push(`mammoth: …和其它 ${seen.size - 3} 条转换提示被隐藏`)
    }

    if (imagesDropped > 0) {
      notes.push(`已忽略 ${imagesDropped} 张超限或读取失败的图片（上限 ${MAX_DOCX_IMAGES} 张 / 单张 ${MAX_DOCX_IMAGE_BYTES / 1024 / 1024}MB）`)
    }

    const originalChars = md.length
    const sectionResult = truncateBySections(md, MAX_TOTAL_CHARS)
    return {
      ok: true,
      text: sectionResult.content,
      truncated: sectionResult.truncated,
      originalChars,
      inlineImages: collected.length > 0 ? collected : undefined,
      notes: notes.length > 0 ? notes : undefined,
    }
  } catch (err) {
    // Fallback: use existing low-level ZIP-XML extractor so docx at least
    // produces *some* text.
    try {
      const legacy = await import('../utils/office')
      const r = await legacy.readOfficeFile(filePath)
      if (r.success && typeof r.output === 'string') {
        const text = stripLegacyHeader(r.output)
        const original = text.length
        const { content, truncated } = truncate(text, MAX_TOTAL_CHARS)
        return {
          ok: true,
          text: content,
          truncated,
          originalChars: original,
          notes: ['mammoth 解析失败,已回退到 ZIP-XML 纯文本提取(表格/图片丢失)'],
        }
      }
    } catch { /* swallow */ }
    return {
      ok: false,
      error: `docx parse failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

// ---------------------------------------------------------------------------
// XLSX
// ---------------------------------------------------------------------------

interface SheetMeta {
  name: string
  rowCount: number
  colCount: number
  truncatedRows?: boolean
  truncatedCols?: boolean
  hasFormulas?: boolean
  mergeCount?: number
}

/** Convert an Excel serial date value into a stable ISO-ish string. */
function formatCellValue(cell: unknown): string {
  if (cell == null) return ''
  if (cell instanceof Date) {
    // All-zero time → date-only representation to match Excel display defaults.
    const hasTime =
      cell.getUTCHours() !== 0 ||
      cell.getUTCMinutes() !== 0 ||
      cell.getUTCSeconds() !== 0
    const iso = cell.toISOString()
    return hasTime ? iso.replace('T', ' ').replace(/\.\d+Z$/, '') : iso.slice(0, 10)
  }
  if (typeof cell === 'number') {
    // Guard against NaN / Infinity showing up in Markdown tables.
    return Number.isFinite(cell) ? String(cell) : ''
  }
  if (typeof cell === 'boolean') return cell ? 'TRUE' : 'FALSE'
  return String(cell)
}

interface XlsxCell {
  f?: string
  v?: unknown
  w?: string
  t?: string
}
interface XlsxMerge {
  s: { r: number; c: number }
  e: { r: number; c: number }
}
interface XlsxSheet {
  [address: string]: XlsxCell | XlsxMerge[] | unknown
  '!merges'?: XlsxMerge[]
}
interface XlsxWorkbook {
  SheetNames: string[]
  Sheets: Record<string, XlsxSheet>
}
interface XlsxUtils {
  sheet_to_json(
    ws: XlsxSheet,
    opts: { header: 1; blankrows?: boolean; defval?: unknown; raw?: boolean },
  ): unknown[][]
  encode_cell(addr: { r: number; c: number }): string
}
interface XlsxModule {
  read(buf: Buffer, opts: { type: string; cellDates?: boolean; cellFormula?: boolean; cellHTML?: boolean }): XlsxWorkbook
  utils: XlsxUtils
}

async function extractXlsx(filePath: string): Promise<OfficeExtractResult | OfficeExtractError> {
  try {
    const modRaw = (await import('xlsx')) as unknown
    const XLSX: XlsxModule =
      modRaw && typeof modRaw === 'object' && 'default' in modRaw
        ? (modRaw as { default: XlsxModule }).default
        : (modRaw as XlsxModule)
    const buf = await readFile(filePath)
    /**
     * `cellFormula:true`  — keep formulas so we can annotate `=SUM(A1:A3)` in
     *   the preview. Critical for structure fidelity; without it any
     *   computed-value table reads as "magic numbers".
     * `cellDates:true`    — parse serial dates into JS Date; we then
     *   re-format with a locale-independent ISO string.
     * `cellHTML:false`    — skip HTML generation; we render Markdown.
     */
    const wb = XLSX.read(buf, {
      type: 'buffer',
      cellDates: true,
      cellFormula: true,
      cellHTML: false,
    })
    const sheetNames: string[] = wb.SheetNames || []
    const parts: string[] = []
    const sheetsMeta: SheetMeta[] = []

    for (const name of sheetNames) {
      const ws = wb.Sheets[name]
      if (!ws) continue

      // Keep raw values (not pre-formatted) so we can apply our own ISO
      // normalisation and multi-line-preserving escape.
      const aoa = XLSX.utils.sheet_to_json(ws, {
        header: 1,
        blankrows: false,
        defval: '',
        raw: true,
      }) as unknown[][]

      const rowCount = aoa.length
      const colCount = aoa.reduce((m: number, r: unknown[]) => Math.max(m, r.length), 0)

      // Detect formulas + merges by walking the sheet's address space.
      let hasFormulas = false
      const formulaMap = new Map<string, string>()
      for (const addr of Object.keys(ws)) {
        if (addr.startsWith('!')) continue
        const cell = ws[addr] as XlsxCell | undefined
        if (cell && typeof cell === 'object' && typeof cell.f === 'string') {
          hasFormulas = true
          formulaMap.set(addr, cell.f)
        }
      }
      const merges: XlsxMerge[] = ws['!merges'] ?? []
      const mergeCount = merges.length

      const meta: SheetMeta = {
        name,
        rowCount,
        colCount,
        hasFormulas,
        mergeCount,
      }
      sheetsMeta.push(meta)

      if (rowCount === 0) {
        parts.push(`## Sheet: ${name}\n\n_(empty)_`)
        continue
      }

      meta.truncatedRows = rowCount > XLSX_MAX_ROWS_PER_SHEET
      meta.truncatedCols = colCount > XLSX_MAX_COLS_PER_SHEET

      const limited = aoa
        .slice(0, XLSX_MAX_ROWS_PER_SHEET)
        .map((r) => r.slice(0, XLSX_MAX_COLS_PER_SHEET))

      const headerRaw: unknown[] = limited[0] || []
      const headerHasText = headerRaw.some((v) => String(v ?? '').trim() !== '')
      const effectiveHeader = headerHasText
        ? headerRaw.map((v) => formatCellValue(v))
        : Array.from({ length: Math.max(colCount, 1) }, (_, i) => colLetter(i))
      const bodyStart = headerHasText ? 1 : 0
      const body = limited.slice(bodyStart)

      /**
       * Markdown cell escape.
       *  - `|` becomes `\|`
       *  - Line breaks become `<br>` so multi-line cells stay multi-line in
       *    the preview (react-markdown with remark-gfm honours raw HTML).
       *  - Collapsing to plain space is avoided — it is the #1 complaint
       *    about spreadsheet "structure fidelity".
       */
      const esc = (s: string) =>
        s.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>').trim()

      const lines: string[] = []
      lines.push(`## Sheet: ${name}`)
      lines.push('')
      lines.push(`| ${effectiveHeader.map(esc).join(' | ')} |`)
      lines.push(`| ${effectiveHeader.map(() => '---').join(' | ')} |`)

      for (let rowIdx = 0; rowIdx < body.length; rowIdx++) {
        const row = body[rowIdx]
        const cells: string[] = []
        for (let i = 0; i < effectiveHeader.length; i++) {
          const rawVal = row[i]
          const display = esc(formatCellValue(rawVal))
          // Annotate formulas next to the displayed value.
          const addr = XLSX.utils.encode_cell({
            r: bodyStart + rowIdx,
            c: i,
          })
          const formula = formulaMap.get(addr)
          cells.push(formula ? `${display} ⟨=${esc(formula)}⟩` : display)
        }
        lines.push(`| ${cells.join(' | ')} |`)
      }

      // Meta footer — scoped to the sheet so truncation is always localised.
      const footerBits: string[] = []
      if (meta.truncatedRows) footerBits.push(`行 ${XLSX_MAX_ROWS_PER_SHEET}/${rowCount}`)
      if (meta.truncatedCols) footerBits.push(`列 ${XLSX_MAX_COLS_PER_SHEET}/${colCount}`)
      if (hasFormulas) footerBits.push(`含公式 ${formulaMap.size} 处`)
      if (mergeCount > 0) footerBits.push(`合并单元格 ${mergeCount} 处(Markdown 无跨格,已平铺)`)
      if (footerBits.length > 0) {
        lines.push('')
        lines.push(`_${footerBits.join(' · ')}_`)
      }
      parts.push(lines.join('\n'))
    }

    const joined = parts.join('\n\n')
    const original = joined.length
    const { content, truncated } = truncate(joined, MAX_TOTAL_CHARS)
    const notes: string[] = []
    const anyRowTrunc = sheetsMeta.some((m) => m.truncatedRows)
    const anyColTrunc = sheetsMeta.some((m) => m.truncatedCols)
    if (anyRowTrunc || anyColTrunc) {
      notes.push(
        `部分工作表超过预览上限(${XLSX_MAX_ROWS_PER_SHEET} 行 / ${XLSX_MAX_COLS_PER_SHEET} 列),` +
          '已按 sheet 单独截断并在下方标注。',
      )
    }
    return {
      ok: true,
      text: content || '_(empty workbook)_',
      truncated,
      originalChars: original,
      sheets: sheetsMeta,
      notes: notes.length > 0 ? notes : undefined,
    }
  } catch (err) {
    return {
      ok: false,
      error: `xlsx parse failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

// ---------------------------------------------------------------------------
// PPTX
// ---------------------------------------------------------------------------

async function extractPptx(filePath: string): Promise<OfficeExtractResult | OfficeExtractError> {
  try {
    const legacy = await import('../utils/office')
    const r = await legacy.readOfficeFile(filePath)
    if (!r.success || typeof r.output !== 'string') {
      return { ok: false, error: r.error || 'pptx parse failed' }
    }
    const text = stripLegacyHeader(r.output)
    const original = text.length
    const { content, truncated } = truncate(text, MAX_TOTAL_CHARS)
    return { ok: true, text: content, truncated, originalChars: original }
  } catch (err) {
    return {
      ok: false,
      error: `pptx parse failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

// ---------------------------------------------------------------------------
// Legacy .doc / .xls / .ppt — best-effort via LibreOffice headless
// ---------------------------------------------------------------------------

async function extractLegacyViaSoffice(
  filePath: string,
  ext: 'doc' | 'xls' | 'ppt',
): Promise<OfficeExtractResult | OfficeExtractError> {
  const modern: Record<typeof ext, 'docx' | 'xlsx' | 'pptx'> = {
    doc: 'docx',
    xls: 'xlsx',
    ppt: 'pptx',
  }
  const targetExt = modern[ext]

  // Windows/macOS/Linux all commonly expose either `soffice` or `libreoffice`.
  const candidates = process.platform === 'win32'
    ? ['soffice.com', 'soffice', 'soffice.exe', 'libreoffice']
    : ['soffice', 'libreoffice']

  let sofficeBin: string | null = null
  for (const bin of candidates) {
    try {
      await execFileAsync(bin, ['--version'], { timeout: 10_000 })
      sofficeBin = bin
      break
    } catch { /* try next */ }
  }

  if (!sofficeBin) {
    return {
      ok: false,
      error: `Legacy Office format (.${ext}) detected and LibreOffice ('soffice') is not installed — cannot auto-convert to .${targetExt}.`,
      hint: `请安装 LibreOffice 或手动另存为 .${targetExt} 后重试。`,
    }
  }

  const workDir = await mkdtemp(path.join(tmpdir(), 'astra-soffice-'))
  try {
    await execFileAsync(
      sofficeBin,
      ['--headless', '--norestore', '--nolockcheck', '--convert-to', targetExt, '--outdir', workDir, filePath],
      { timeout: 120_000 },
    )
    const files = (await readdir(workDir)).filter((f) => f.toLowerCase().endsWith(`.${targetExt}`))
    if (files.length === 0) {
      return { ok: false, error: `soffice conversion produced no .${targetExt} output for ${path.basename(filePath)}` }
    }
    const converted = path.join(workDir, files[0])
    const inner = await extractOffice(converted, targetExt)
    if (!inner.ok) return inner
    const note = `旧版 .${ext} 已通过 LibreOffice 自动转换为 .${targetExt} 后解析(可能有细微版式差异)`
    return { ...inner, notes: [...(inner.notes || []), note] }
  } catch (err) {
    return {
      ok: false,
      error: `Legacy .${ext} conversion via LibreOffice failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  } finally {
    try { await rm(workDir, { recursive: true, force: true }) } catch { /* noop */ }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function colLetter(i: number): string {
  let s = ''
  let n = i
  while (true) {
    s = String.fromCharCode(65 + (n % 26)) + s
    n = Math.floor(n / 26) - 1
    if (n < 0) break
  }
  return s
}

function truncate(content: string, limit: number): { content: string; truncated: boolean } {
  if (content.length <= limit) return { content, truncated: false }
  const keepHead = Math.floor(limit * 0.8)
  const keepTail = Math.max(0, limit - keepHead - 64)
  const head = content.slice(0, keepHead)
  const tail = keepTail > 0 ? content.slice(-keepTail) : ''
  const omitted = content.length - keepHead - keepTail
  return {
    content: `${head}\n\n... [中间 ${omitted.toLocaleString()} 字符已截断,原始共 ${content.length.toLocaleString()} 字符,当前保留 ${(keepHead + keepTail).toLocaleString()} 字符.如需查看中间被省略的内容,请告知需要关注的章节或关键词] ...\n\n${tail}`,
    truncated: true,
  }
}

/**
 * Section-aware truncation for docx Markdown. Rather than a raw head/tail
 * cut that can slice through a table or paragraph, we try to keep whole
 * `##` sections until the budget runs out, then append a TOC of what was
 * dropped so readers know what else exists in the document.
 */
function truncateBySections(content: string, limit: number): { content: string; truncated: boolean } {
  if (content.length <= limit) return { content, truncated: false }

  // Greedy: walk heading-delimited sections (h1/h2) and keep taking them
  // until budget exhausted.
  const sectionRe = /(^|\n)(#{1,3} [^\n]+)/g
  const matches: Array<{ start: number; heading: string }> = []
  let m: RegExpExecArray | null
  while ((m = sectionRe.exec(content)) !== null) {
    matches.push({ start: m.index + (m[1] ? m[1].length : 0), heading: m[2] })
  }

  if (matches.length <= 1) {
    // Structure-less document → fall back to the simple head/tail cut.
    return truncate(content, limit)
  }

  const kept: string[] = []
  const dropped: string[] = []
  let used = 0
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].start
    const end = i + 1 < matches.length ? matches[i + 1].start : content.length
    const section = content.slice(start, end)
    if (used + section.length <= limit) {
      kept.push(section)
      used += section.length
    } else {
      dropped.push(matches[i].heading.replace(/^#+ /, ''))
    }
  }

  if (dropped.length === 0) {
    return truncate(content, limit)
  }

  const toc = dropped
    .slice(0, 30)
    .map((h) => `- ${h}`)
    .join('\n')
  const more = dropped.length > 30 ? `\n- ...以及其它 ${dropped.length - 30} 节` : ''
  const notice = `\n\n---\n\n⚠️ _预览已按章节截断,省略 ${dropped.length} 节(原始 ${content.length.toLocaleString()} 字符,预览 ${used.toLocaleString()} 字符).如需查看被省略的章节,请告知需要关注的章节标题._\n\n**未显示的章节:**\n\n${toc}${more}\n`

  return { content: kept.join('') + notice, truncated: true }
}

function stripLegacyHeader(s: string): string {
  return s.replace(/^\[Office document: [^\]]*\]\n{0,2}/, '')
}
