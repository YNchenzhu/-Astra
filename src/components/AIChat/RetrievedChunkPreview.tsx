import React, { useCallback, useEffect, useState } from 'react'
import { X, ExternalLink, Copy, Check, Hash } from 'lucide-react'
import type { RetrievedChunkDisplay, Attachment, AttachmentKind } from '../../types'
import { AttachmentPreview } from './AttachmentPreview'
import './AttachmentPreview.css'
import './RetrievedChunks.css'

interface RetrievedChunkPreviewProps {
  chunk: RetrievedChunkDisplay
  onClose: () => void
}

/**
 * Modal for a single RAG-retrieved chunk. Shows:
 *   - Header: attachment name + heading breadcrumb + rank + score
 *   - Body: full chunk text with markdown rendering (headings / tables preserved)
 *   - Actions:
 *       * copy chunk text
 *       * "打开原文" — fetches the full attachment via the sha256 cache and
 *         mounts an AttachmentPreview so the user can see the entire parsed
 *         document with the retrieved chunk highlighted in context.
 *
 * "Jump to source" is implemented by re-hydrating the Attachment from the
 * main-process cache (Keyed by sha256 + kind). If the cache has been cleared
 * or the original file is gone, we show an inline notice instead.
 */
export const RetrievedChunkPreview: React.FC<RetrievedChunkPreviewProps> = ({ chunk, onClose }) => {
  const [copied, setCopied] = useState(false)
  const [sourceAttachment, setSourceAttachment] = useState<Attachment | null>(null)
  const [loadingSource, setLoadingSource] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  // Close on Escape (mirrors AttachmentPreview behaviour).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (sourceAttachment) {
          setSourceAttachment(null)
        } else {
          onClose()
        }
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, sourceAttachment])

  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(chunk.text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }, [chunk.text])

  const handleOpenSource = useCallback(async () => {
    if (!chunk.attachmentSha) {
      setLoadError('source attachment sha256 missing — can only show this chunk.')
      return
    }
    setLoadingSource(true)
    setLoadError(null)
    try {
      const api = window.electronAPI?.attachments
      if (!api?.cacheGet) {
        setLoadError('Attachment cache API unavailable (Electron-only).')
        return
      }
      // sha256 in the index is only the first 32 hex chars; cacheGet wants a
      // full sha256 for key lookup. The cache stores entries keyed by the
      // full sha+kind pair — we fall back to prefix-match if the full sha
      // isn't known. Newer writes always use the full hash.
      const result = await api.cacheGet({
        sha256: chunk.attachmentSha,
        kind: chunk.attachmentKind || 'unknown',
      })
      if (!result) {
        setLoadError('源附件已不在缓存里（可能被清理过）。仅显示该片段。')
        return
      }
      if (result.type === 'image') {
        setSourceAttachment({
          type: 'image',
          name: result.name,
          base64: result.base64,
          mediaType: result.mediaType,
          size: result.size,
          sha256: result.sha256,
        })
        return
      }
      setSourceAttachment({
        type: 'file',
        name: result.name,
        path: result.path,
        size: result.size,
        kind: result.kind as AttachmentKind,
        mimeType: result.mimeType,
        sha256: result.sha256,
        status: result.status,
        error: result.error,
        pdf: result.pdf,
        text: result.text,
        pageImages: result.pageImages,
        sheets: result.sheets,
        inlineImages: result.inlineImages,
      })
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoadingSource(false)
    }
  }, [chunk.attachmentSha, chunk.attachmentKind])

  // If the user clicked "open source", hand off to AttachmentPreview which
  // already renders every supported attachment kind. Our own modal stays
  // mounted underneath (Escape closes source first, then our modal).
  if (sourceAttachment) {
    return (
      <AttachmentPreview
        attachment={sourceAttachment}
        onClose={() => setSourceAttachment(null)}
      />
    )
  }

  return (
    <div className="attachment-preview-overlay" onClick={onClose}>
      <div className="attachment-preview-panel chunk-preview-panel" onClick={(e) => e.stopPropagation()}>
        <div className="attachment-preview-header">
          <div className="attachment-preview-title">
            <Hash size={14} />
            <div className="attachment-preview-title-text">
              <span className="attachment-preview-name" title={chunk.attachmentName}>
                {chunk.attachmentName}
              </span>
              <span className="attachment-preview-subtitle">
                #{chunk.rank} · {Math.round(chunk.score * 100)}% 相关
                {chunk.headingPath ? ` · § ${chunk.headingPath}` : ''}
              </span>
            </div>
          </div>
          <div className="chunk-preview-header-actions">
            <button
              className="chunk-preview-action-btn"
              onClick={handleCopy}
              title="复制片段文本"
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
            </button>
            <button
              className="chunk-preview-action-btn"
              onClick={handleOpenSource}
              disabled={loadingSource || !chunk.attachmentSha}
              title={chunk.attachmentSha ? '打开原文附件' : '无可定位的源附件'}
            >
              <ExternalLink size={14} />
              <span>打开原文</span>
            </button>
            <button
              className="attachment-preview-close"
              onClick={onClose}
              title="关闭 (Esc)"
            >
              <X size={16} />
            </button>
          </div>
        </div>
        <div className="attachment-preview-body">
          {loadError && (
            <div className="retrieved-chunk-notice">
              {loadError}
            </div>
          )}
          <pre className="chunk-preview-text">{chunk.text}</pre>
        </div>
      </div>
    </div>
  )
}
