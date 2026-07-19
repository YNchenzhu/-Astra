/**
 * Shared attachment ingestion types (main process).
 *
 * Keep in sync with `src/types/tool.ts#Attachment`. The shape emitted by
 * `ingestAttachment` is the renderer-facing `Attachment` (type='image' or
 * type='file' with extra payload fields).
 */

export type AttachmentKind =
  | 'image'
  | 'pdf'
  | 'docx' | 'doc' | 'rtf'
  | 'xlsx' | 'xls' | 'csv' | 'tsv'
  | 'pptx' | 'ppt'
  | 'text' | 'markdown' | 'code' | 'json' | 'yaml' | 'xml' | 'html'
  | 'ipynb'
  | 'unknown'

export interface IngestedImage {
  type: 'image'
  name: string
  base64: string
  mediaType: string
  size: number
  sha256: string
}

export interface IngestedFile {
  type: 'file'
  name: string
  path: string
  size: number
  kind: AttachmentKind
  mimeType: string
  sha256: string
  status: 'ready' | 'error'
  error?: string
  pdf?: {
    /**
     * Inline base64 bytes of the PDF, only emitted when the file is within the
     * provider-block cap (`LIMITS.MAX_PDF_BYTES`). For larger PDFs this is
     * `undefined` and the UI falls back to rendering the file path (`file://`)
     * directly in an iframe so we never lose the visual preview.
     */
    base64?: string
    pageCount?: number
    /** Raw file size — lets UI label "Preview inlined" vs. "Direct from disk". */
    sizeBytes?: number
    /** True when PDF bytes are too large to inline as a provider block. */
    oversized?: boolean
  }
  text?: {
    content: string
    truncated: boolean
    originalChars: number
  }
  pageImages?: Array<{
    page: number
    base64: string
    mediaType: 'image/jpeg' | 'image/png'
    /** How the page images were obtained — helps UI explain limits. */
    source?: 'pdftoppm' | 'pdfjs-canvas'
  }>
  sheets?: Array<{
    name: string
    rowCount: number
    colCount: number
    /** True if the rendered preview trimmed rows past `XLSX_MAX_ROWS_PER_SHEET`. */
    truncatedRows?: boolean
    /** True if the rendered preview trimmed columns past `XLSX_MAX_COLS_PER_SHEET`. */
    truncatedCols?: boolean
    /** True if any cell in the sheet has a formula (`ws[addr].f`). */
    hasFormulas?: boolean
    /** Number of merged ranges; non-zero is a signal about layout fidelity. */
    mergeCount?: number
  }>
  /** Docx inline images (see office.ts). Emitted as image blocks on send. */
  inlineImages?: Array<{ base64: string; mediaType: string; altText?: string }>
  /**
   * Non-fatal remarks produced by the ingest pipeline — missing poppler,
   * images dropped over cap, legacy-format auto-convert used, etc. The UI
   * surfaces these as informational notes below the preview body.
   */
  notes?: string[]
}

export type IngestedAttachment = IngestedImage | IngestedFile

/** Caps (tweakable). Keep conservative to avoid blowing up provider context. */
export const LIMITS = {
  /** Absolute max raw file size accepted by the ingest pipeline. */
  MAX_FILE_BYTES: 50 * 1024 * 1024,
  /** Hard cap for embedded PDF base64 (Claude document block limit ~32MB). */
  MAX_PDF_BYTES: 30 * 1024 * 1024,
  /** Max image raw bytes kept inline (we transcode larger ones via sharp if available). */
  MAX_IMAGE_BYTES: 20 * 1024 * 1024,
  /** Max characters of extracted text per file (truncated beyond). */
  MAX_TEXT_CHARS: 80_000,
}
