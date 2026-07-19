/**
 * PDF ingestion.
 *
 * Produces up to three artefacts:
 *  1. raw base64 (for vendors with native document-block support: Claude, Gemini)
 *  2. extracted plain text via pdfjs-dist (for OpenAI / OCR fallback)
 *  3. per-page image renders (only for scanned/image-only PDFs). Tries
 *     `pdftoppm` (poppler) first — it's ~4x faster and produces tighter
 *     JPEGs — then falls back to rendering each page to canvas via
 *     `pdfjs-dist` + `@napi-rs/canvas` / `canvas` so Windows users (no
 *     poppler by default) still get OCR-compatible output.
 *
 * Each representation is attached to the Attachment payload so the serializer
 * picks the right block type based on current provider capabilities.
 */

import { readFile, mkdir, rm, readdir } from 'fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { LIMITS } from './types'

const execFileAsync = promisify(execFile)

/**
 * Structural view of the subset of `pdfjs-dist` we actually call.
 * Declared as an index signature over `unknown` so accidental property
 * access surfaces a type error instead of silently returning `any`.
 */
interface PdfPageTextItem {
  str?: string
}
interface PdfPageTextContent {
  items: PdfPageTextItem[]
}
interface PdfPageViewport {
  width: number
  height: number
}
interface PdfPage {
  getTextContent(): Promise<PdfPageTextContent>
  getViewport(opts: { scale: number }): PdfPageViewport
  render(opts: { canvasContext: unknown; viewport: PdfPageViewport }): { promise: Promise<void> }
  cleanup?(): void
}
interface PdfDocument {
  numPages: number
  getPage(i: number): Promise<PdfPage>
  destroy?(): void
}
interface PdfJsApi {
  getDocument(opts: {
    data: Uint8Array
    disableWorker?: boolean
    isEvalSupported?: boolean
    useSystemFonts?: boolean
  }): { promise: Promise<PdfDocument> }
}

async function loadPdfJs(): Promise<PdfJsApi | null> {
  try {
    return (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as PdfJsApi
  } catch {
    try {
      return (await import('pdfjs-dist')) as unknown as PdfJsApi
    } catch {
      return null
    }
  }
}

/** Extract plain text from a PDF using pdfjs-dist (legacy CJS build for Node). */
export async function extractPdfText(filePath: string): Promise<{
  text: string
  pageCount: number
}> {
  const pdfjs = await loadPdfJs()
  if (!pdfjs) {
    return { text: '[PDF text extraction unavailable: pdfjs-dist not loadable]', pageCount: 0 }
  }

  const buf = await readFile(filePath)
  const data = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)

  try {
    const loadingTask = pdfjs.getDocument({
      data,
      disableWorker: true,
      isEvalSupported: false,
      useSystemFonts: true,
    })
    const doc = await loadingTask.promise
    const pageCount = doc.numPages
    const MAX_PAGES = 200
    const pagesToRead = Math.min(pageCount, MAX_PAGES)
    const parts: string[] = []
    // 2026-07 审计修复:字符级截断。此前只限页数(200 页),密集 PDF
    // 可产出数百万字符直接炸掉上下文预算;现在与文本附件共用
    // LIMITS.MAX_TEXT_CHARS(80K),达到上限即停止读页并显式标注。
    let totalChars = 0
    let charCapHitAtPage = 0
    for (let i = 1; i <= pagesToRead; i++) {
      try {
        const page = await doc.getPage(i)
        const content = await page.getTextContent()
        const pageText = content.items
          .map((it) => (typeof it.str === 'string' ? it.str : ''))
          .join(' ')
          .replace(/\s+\n/g, '\n')
          .replace(/[ \t]+/g, ' ')
          .trim()
        if (pageText) {
          parts.push(`--- Page ${i} ---\n${pageText}`)
          totalChars += pageText.length
        }
      } catch {
        // skip broken page
      }
      if (totalChars >= LIMITS.MAX_TEXT_CHARS) {
        charCapHitAtPage = i
        break
      }
    }
    if (charCapHitAtPage > 0 && charCapHitAtPage < pageCount) {
      parts.push(
        `\n[Truncated: text budget (${LIMITS.MAX_TEXT_CHARS.toLocaleString()} chars) reached at page ${charCapHitAtPage} of ${pageCount}; remaining pages omitted]`,
      )
    } else if (pagesToRead < pageCount) {
      parts.push(`\n[Truncated: showed first ${pagesToRead} of ${pageCount} pages]`)
    }
    try { doc.destroy?.() } catch { /* noop */ }
    return { text: parts.join('\n\n') || '[No extractable text — PDF may be scanned/encrypted]', pageCount }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { text: `[PDF parse failed: ${msg}]`, pageCount: 0 }
  }
}

/**
 * Return the PDF bytes as base64 **only if** the file is small enough to be
 * inlined as a document block. Returns null otherwise (caller falls back to
 * rendering via `file://` URL in the renderer — the visual preview is still
 * lossless, only the "ship-to-AI-as-document-block" representation is
 * skipped).
 */
export async function loadPdfBase64(filePath: string, sizeBytes: number): Promise<string | null> {
  if (sizeBytes > LIMITS.MAX_PDF_BYTES) return null
  const buf = await readFile(filePath)
  return buf.toString('base64')
}

/**
 * Heuristic: a text extraction is considered "empty" when pdfjs returned no
 * meaningful characters across all pages — typical of scanned PDFs where each
 * page is a raster image.
 */
export function looksLikeScannedText(extractedText: string): boolean {
  if (!extractedText) return true
  // 2026-07 审计修复(P0):旧正则 `\[(Truncated|PDF[^\]]*)\]` 匹配不到
  // extractPdfText 无文本时返回的占位符 `[No extractable text — PDF may
  // be scanned/encrypted]`(以 "No extractable" 开头),也匹配不到带冒号
  // 的 `[Truncated: ...]` —— 于是"典型扫描件"被判定为"有文本",页面渲染
  // fallback 永远不触发,模型只收到一句占位符却显示解析成功。
  // 现在统一剥离所有 host 生成的方括号标记后再做长度判定。
  const cleaned = extractedText
    .replace(/--- Page \d+ ---/g, '')
    .replace(/\[(?:Truncated|PDF|No extractable)[^\]]*\]/gi, '')
    .replace(/\s+/g, '')
  return cleaned.length < 20
}

export interface RenderedPdfPage {
  page: number
  base64: string
  mediaType: 'image/jpeg' | 'image/png'
  source: 'pdftoppm' | 'pdfjs-canvas'
}

export interface RenderPdfOutcome {
  images: RenderedPdfPage[]
  /** Non-fatal reasons a render path was skipped; surfaced to the UI. */
  notes: string[]
}

/**
 * Render the first N pages of a PDF. Prefers `pdftoppm` (poppler) when
 * available, then falls back to pdfjs + canvas. Returns an outcome object so
 * the caller can surface "no renderer available" to the user instead of
 * silently showing a blank preview.
 */
export async function renderPdfPagesAsImages(
  filePath: string,
  maxPages: number,
): Promise<RenderPdfOutcome> {
  const notes: string[] = []
  const clampedPages = Math.max(1, Math.min(maxPages, 20))

  const popplerImages = await tryPdftoppm(filePath, clampedPages)
  if (popplerImages) {
    return { images: popplerImages, notes }
  }

  notes.push('未检测到 poppler (pdftoppm),正在使用 pdfjs canvas 渲染扫描 PDF(速度稍慢)')
  const pdfjsImages = await tryPdfjsCanvas(filePath, clampedPages)
  if (pdfjsImages.length > 0) {
    return { images: pdfjsImages, notes }
  }

  notes.push('pdfjs canvas 渲染也未成功(可能缺少 `canvas` / `@napi-rs/canvas` 依赖)。扫描 PDF 无法渲染为图片。')
  return { images: [], notes }
}

async function tryPdftoppm(filePath: string, maxPages: number): Promise<RenderedPdfPage[] | null> {
  const outputDir = path.join(tmpdir(), `pdf-render-${randomUUID()}`)
  try {
    await mkdir(outputDir, { recursive: true })
    await execFileAsync(
      'pdftoppm',
      [
        '-jpeg',
        '-r', '120',
        '-f', '1',
        '-l', String(maxPages),
        filePath,
        path.join(outputDir, 'page'),
      ],
      { timeout: 60_000 },
    )
    const files = (await readdir(outputDir)).filter((f) => f.endsWith('.jpg')).sort()
    const results: RenderedPdfPage[] = []
    for (let i = 0; i < files.length; i++) {
      const buf = await readFile(path.join(outputDir, files[i]))
      results.push({
        page: i + 1,
        base64: buf.toString('base64'),
        mediaType: 'image/jpeg',
        source: 'pdftoppm',
      })
    }
    return results.length > 0 ? results : null
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && (err as { code?: string }).code === 'ENOENT') {
      return null
    }
    // Different failure (e.g. corrupt PDF) — let caller try pdfjs fallback.
    return null
  } finally {
    try { await rm(outputDir, { recursive: true, force: true }) } catch { /* noop */ }
  }
}

/** Structural view of the `@napi-rs/canvas` / `canvas` module we use. */
interface CanvasApiModule {
  createCanvas?: (w: number, h: number) => {
    getContext(kind: '2d'): unknown
    toBuffer(mime: 'image/jpeg' | 'image/png', opts?: { quality?: number }): Buffer
  }
  default?: CanvasApiModule
}

async function tryPdfjsCanvas(filePath: string, maxPages: number): Promise<RenderedPdfPage[]> {
  const pdfjs = await loadPdfJs()
  if (!pdfjs) return []

  let canvasApi: CanvasApiModule | null = null
  try {
    canvasApi = (await import('@napi-rs/canvas')) as unknown as CanvasApiModule
  } catch {
    try {
      // `canvas` is an optional native dep — declared via `await import`.
      // The next line silences the missing-types error so we degrade
      // gracefully when the package (and therefore its typings) isn't
      // installed; using `ts-expect-error` rather than the broader
      // `ts-ignore` keeps the suppression tight against future fixes.
      // @ts-expect-error — optional runtime dep, no bundled typings
      canvasApi = (await import('canvas')) as unknown as CanvasApiModule
    } catch {
      return []
    }
  }
  const createCanvas = canvasApi?.createCanvas || canvasApi?.default?.createCanvas
  if (typeof createCanvas !== 'function') return []

  try {
    const buf = await readFile(filePath)
    const data = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
    const loadingTask = pdfjs.getDocument({
      data,
      disableWorker: true,
      isEvalSupported: false,
      useSystemFonts: true,
    })
    const doc = await loadingTask.promise
    const pagesToRender = Math.min(doc.numPages, maxPages)
    const results: RenderedPdfPage[] = []
    for (let i = 1; i <= pagesToRender; i++) {
      try {
        const page = await doc.getPage(i)
        // Scale ≈ 1.5 at a base of 96 DPI → ~144 DPI; matches pdftoppm output
        // closely for downstream vision models without ballooning base64.
        const viewport = page.getViewport({ scale: 1.5 })
        const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
        const ctx = canvas.getContext('2d')
        await page.render({ canvasContext: ctx, viewport }).promise
        const pngBuf: Buffer = canvas.toBuffer('image/png')
        results.push({
          page: i,
          base64: pngBuf.toString('base64'),
          mediaType: 'image/png',
          source: 'pdfjs-canvas',
        })
      } catch {
        // Skip bad page; keep rendering the rest.
      }
    }
    try { doc.destroy?.() } catch { /* noop */ }
    return results
  } catch {
    return []
  }
}
