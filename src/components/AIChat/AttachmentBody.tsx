import React, { useEffect, useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { REHYPE_PLUGINS } from './chatMessage/markdown'
import { AlertTriangle, FileText, FileSpreadsheet, FileImage, File as FileIcon, ScanLine, Info } from 'lucide-react'
import type { Attachment } from '../../types/tool'

/**
 * Shared body renderer + icon/subtitle helpers for attachment-like previews.
 * Used both by the chat-input `AttachmentPreview` modal and the workspace
 * `FilePreview` tab in the editor area.
 *
 * All rules here exactly mirror what the serializer sends to the model — the
 * user can trust the preview = what the AI sees.
 */

// These two helpers are co-located with the component they document —
// `AttachmentBody` needs to stay in sync with what the serializer sends
// and the renderer chooses. Splitting them to a sibling file would force
// every touch to cross a module boundary; HMR impact only.
// eslint-disable-next-line react-refresh/only-export-components
export function pickAttachmentIcon(att: Attachment) {
  if (att.type === 'image') return FileImage
  if (att.type === 'file' && att.pageImages?.length) return ScanLine
  if (
    att.type === 'file' &&
    (att.kind === 'xlsx' || att.kind === 'xls' || att.kind === 'csv' || att.kind === 'tsv')
  ) {
    return FileSpreadsheet
  }
  if (att.type === 'file' && att.text) return FileText
  return FileIcon
}

// eslint-disable-next-line react-refresh/only-export-components
export function renderAttachmentSubtitle(att: Attachment): string | null {
  if (att.type === 'image') return `图片 · ${att.mediaType}`
  if (att.type === 'file') {
    const parts: string[] = []
    if (att.kind) parts.push(att.kind)
    if (att.pdf?.pageCount) parts.push(`${att.pdf.pageCount} 页`)
    if (att.pdf?.oversized) parts.push('直接磁盘预览')
    if (att.pageImages?.length) parts.push(`已渲染 ${att.pageImages.length} 页`)
    if (att.sheets?.length) parts.push(`${att.sheets.length} 个工作表`)
    if (att.inlineImages?.length) parts.push(`${att.inlineImages.length} 张内嵌图`)
    if (att.text?.truncated) parts.push('已截断')
    return parts.join(' · ') || null
  }
  return null
}

/**
 * Turn base64 into a Blob URL so we can feed it to an `<iframe>` without
 * paying the 33% data:-URL encoding tax and hitting browser data:-length
 * limits. The URL is revoked when the component unmounts.
 */
function useBase64BlobUrl(base64: string | undefined, mime: string): string | null {
  return useMemo(() => {
    if (!base64) return null
    try {
      const bin = atob(base64)
      const len = bin.length
      const bytes = new Uint8Array(len)
      for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i)
      const blob = new Blob([bytes], { type: mime })
      return URL.createObjectURL(blob)
    } catch {
      return null
    }
  }, [base64, mime])
}

/**
 * For oversized PDFs (no inline base64) we fall back to the raw file path via
 * the `file://` protocol. Electron's renderer allows this; browsers only do
 * so when CSP whitelists `file:` in `frame-src`, which we do in index.html.
 */
function buildDiskPdfUrl(filePath: string | undefined): string | null {
  if (!filePath) return null
  const cleaned = filePath.replace(/\\/g, '/')
  // Strip any existing scheme so we always re-emit a well-formed file:/// URL.
  const noScheme = cleaned.replace(/^file:\/\/+/, '')
  const encoded = noScheme.split('/').map(encodeURIComponent).join('/')
  // POSIX paths start with /, Windows paths start with drive letter.
  if (encoded.startsWith('/')) return `file://${encoded}`
  return `file:///${encoded}`
}

const PdfIframe: React.FC<{
  name: string
  base64?: string
  filePath?: string
  oversized?: boolean
}> = ({ name, base64, filePath, oversized }) => {
  const blobUrl = useBase64BlobUrl(base64, 'application/pdf')
  useEffect(() => {
    if (!blobUrl) return
    return () => URL.revokeObjectURL(blobUrl)
  }, [blobUrl])

  const src = blobUrl || (oversized ? buildDiskPdfUrl(filePath) : null)
  if (!src) {
    return (
      <div className="attachment-preview-error">
        <strong>无法预览 PDF</strong>
        <pre>未能为 {name} 构造渲染源(base64 解码失败或 file:// 路径缺失)。</pre>
      </div>
    )
  }

  return (
    <iframe
      className="attachment-preview-iframe"
      title={name}
      src={src}
    />
  )
}

const NotesList: React.FC<{ notes?: string[] }> = ({ notes }) => {
  if (!notes || notes.length === 0) return null
  return (
    <div className="attachment-preview-notes">
      {notes.map((n, i) => (
        <div key={i} className="attachment-preview-note-item">
          <Info size={12} />
          <span>{n}</span>
        </div>
      ))}
    </div>
  )
}

const SheetSummary: React.FC<{
  sheets: NonNullable<Extract<Attachment, { type: 'file' }>['sheets']>
}> = ({ sheets }) => {
  if (!sheets.length) return null
  const hasAnyFlag = sheets.some(
    (s) => s.truncatedRows || s.truncatedCols || s.hasFormulas || (s.mergeCount ?? 0) > 0,
  )
  if (!hasAnyFlag) return null
  return (
    <div className="attachment-preview-sheet-summary">
      {sheets.map((s) => {
        const bits: string[] = []
        // 2026-07 审计修复:实际截断上限是 XLSX_MAX_ROWS_PER_SHEET=2000 /
        // XLSX_MAX_COLS_PER_SHEET=200(electron/attachments/office.ts),
        // 此前误写成 CSV 的 500/40。
        if (s.truncatedRows) bits.push(`行 2000/${s.rowCount}`)
        if (s.truncatedCols) bits.push(`列 200/${s.colCount}`)
        if (s.hasFormulas) bits.push('含公式')
        if ((s.mergeCount ?? 0) > 0) bits.push(`${s.mergeCount} 处合并格`)
        if (bits.length === 0) return null
        return (
          <div key={s.name} className="attachment-preview-sheet-chip">
            <AlertTriangle size={11} />
            <span className="attachment-preview-sheet-name">{s.name}</span>
            <span className="attachment-preview-sheet-bits">{bits.join(' · ')}</span>
          </div>
        )
      })}
    </div>
  )
}

export const AttachmentBody: React.FC<{ attachment: Attachment }> = ({ attachment: att }) => {
  if (att.type === 'image') {
    return (
      <div className="attachment-preview-image-wrap">
        <img src={`data:${att.mediaType};base64,${att.base64}`} alt={att.name} />
      </div>
    )
  }

  if (att.status === 'processing') {
    return <div className="attachment-preview-note">正在解析…</div>
  }

  if (att.status === 'error') {
    return (
      <div className="attachment-preview-error">
        <strong>解析失败</strong>
        <pre>{att.error || '未知错误'}</pre>
      </div>
    )
  }

  /**
   * Rendering priority:
   *   1. Rendered page images (scanned PDFs) — always show since there is no
   *      usable text.
   *   2. Text content — docx/xlsx/ipynb/etc. Markdown-friendly kinds get the
   *      Markdown renderer with raw-HTML support (so xlsx `<br>` in multi-
   *      line cells survives). Everything else uses a `<pre>` code block.
   *   3. PDF iframe — either blob URL (inline base64) or file:// (oversized).
   *   4. "no preview" fallback.
   *
   * This ordering guarantees that: for scanned PDFs the user sees page
   * thumbnails (never a blank iframe); for xlsx/docx the Markdown body is
   * the primary surface (iframe never shadows it).
   */

  if (att.pageImages && att.pageImages.length > 0) {
    return (
      <>
        <NotesList notes={att.notes} />
        <div className="attachment-preview-pages">
          {att.pageImages.map((pi) => (
            <figure key={pi.page} className="attachment-preview-page">
              <img src={`data:${pi.mediaType};base64,${pi.base64}`} alt={`Page ${pi.page}`} />
              <figcaption>
                第 {pi.page} 页{pi.source ? ` · ${pi.source}` : ''}
              </figcaption>
            </figure>
          ))}
        </div>
      </>
    )
  }

  const textContent = att.text?.content || ''
  const inlineImages = att.inlineImages || []

  if (textContent.trim()) {
    const useMarkdown =
      att.kind === 'markdown' || att.kind === 'docx' || att.kind === 'xlsx' ||
      att.kind === 'csv'     || att.kind === 'tsv'  || att.kind === 'ipynb' ||
      att.kind === 'pptx'

    // Swap mammoth image placeholders with inline <img data:> so the preview
    // renders the images exactly where they appear in the original document.
    // Dropped-image sentinels (over cap / oversized / read-error) are rendered
    // as labelled placeholders so readers know an image was there.
    const rendered = useMarkdown
      ? textContent.replace(
          /!\[([^\]]*)\]\(astra:docx-image(?:-dropped)?:([^\s)]+)\)/g,
          (_m, alt, idx) => {
            if (/^\d+$/.test(idx)) {
              const i = Number(idx)
              const img = inlineImages[i]
              if (!img) return `*[missing image #${i + 1}]*`
              return `![${alt || `inline-image-${i + 1}`}](data:${img.mediaType};base64,${img.base64})`
            }
            // Dropped-image sentinel:
            //   - cap-N        → hit MAX_DOCX_IMAGES
            //   - oversized-N  → single image larger than per-image cap
            //   - empty        → mammoth returned 0-byte buffer
            //   - read-error   → mammoth image handler threw
            const [reason, meta] = idx.split('-')
            const reasonLabel =
              reason === 'cap' ? `已达图片数量上限(${meta || '?'})`
              : reason === 'oversized' ? `单张超过 4MB(${meta ? Math.round(Number(meta) / 1024 / 1024 * 10) / 10 + 'MB' : '?'})`
              : reason === 'empty' ? '原文档图片为 0 字节'
              : reason === 'read' ? '图片读取失败'
              : '未知原因'
            return `\n\n> 📷 _此处原有一张图片,已省略 — ${reasonLabel}_\n\n`
          },
        )
      : textContent

    return (
      <>
        <NotesList notes={att.notes} />
        {att.sheets && <SheetSummary sheets={att.sheets} />}
        <div className="attachment-preview-text">
          {useMarkdown ? (
            <div className="attachment-preview-markdown">
              {/* Shared sanitized pipeline — attachment text is untrusted
                  document content, same XSS surface as model output. */}
              <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={REHYPE_PLUGINS}>
                {rendered}
              </ReactMarkdown>
            </div>
          ) : (
            <pre className="attachment-preview-code">{rendered}</pre>
          )}
          {att.text?.truncated && (
            <div className="attachment-preview-trunc-note">
              预览已截断;发送给 AI 的内容采用相同截断策略。
            </div>
          )}
        </div>
      </>
    )
  }

  if (att.pdf) {
    return (
      <>
        <NotesList notes={att.notes} />
        <PdfIframe
          name={att.name}
          base64={att.pdf.base64}
          filePath={att.path}
          oversized={att.pdf.oversized}
        />
      </>
    )
  }

  return <div className="attachment-preview-note">(无可预览内容)</div>
}
