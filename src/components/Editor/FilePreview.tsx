import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, Paperclip, Check, RefreshCw } from 'lucide-react'
import type { Attachment, AttachmentKind } from '../../types/tool'
import {
  AttachmentBody,
  pickAttachmentIcon,
  renderAttachmentSubtitle,
} from '../AIChat/AttachmentBody'
import { useChatStore } from '../../stores/useChatStore'
import { indexAttachmentAsync } from '../../services/rag'
import { onWorkspaceFileChanged } from '../../services/fileSystem'
import { DOC_PREVIEW_EXTS } from '../../services/openBehavior'
import '../AIChat/AttachmentPreview.css'
import './FilePreview.css'

interface FilePreviewProps {
  filePath: string
  fileName: string
}

/**
 * Editor-area fallback for file types Monaco cannot render directly:
 *   PDF, docx / xlsx / pptx / legacy doc-xls-ppt (auto-converted via
 *   LibreOffice when available), ipynb, rtf.
 *
 * Uses the main-process ingest pipeline
 * (`window.electronAPI.attachments.ingest`) which is sha256-cached, so
 * repeat opens are near-instant. Shares the body renderer with the
 * chat-input `AttachmentPreview` so previews and what-the-AI-sees stay
 * perfectly in sync.
 *
 * Production concerns addressed here (see parent `EditorArea`):
 *   1. Ingest requests honour a 90s soft timeout so a runaway parse never
 *      pins the UI on an eternal spinner.
 *   2. Unmounting aborts the in-flight promise — rapid tab switching no
 *      longer double-fires expensive pdfjs/mammoth parses.
 *   3. Renderer-side memo cache keyed by file path avoids even the IPC
 *      round-trip when a user flips between tabs.
 *   4. A workspace file-change watcher invalidates the cache + re-ingests
 *      when the file is edited out-of-band (AI write, external editor).
 *   5. Errors render with a retry affordance instead of requiring the user
 *      to close/reopen the tab.
 *   6. The "attach to chat" button is disabled when the attachment is in
 *      `error` / `processing` state so we never ship a broken payload.
 */

const RENDER_TIMEOUT_MS = 90_000

const attachmentMemo = new Map<string, Attachment>()

function normalize(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '')
}

/**
 * Invalidate the renderer memo cache when a file changes on disk. Triggered
 * either by the workspace file watcher or by an explicit retry click.
 */
function invalidateMemo(filePath: string): void {
  attachmentMemo.delete(normalize(filePath))
}

type Phase = 'idle' | 'reading' | 'ready' | 'error'

export const FilePreview: React.FC<FilePreviewProps> = ({ filePath, fileName }) => {
  const [attachment, setAttachment] = useState<Attachment | null>(() => attachmentMemo.get(normalize(filePath)) || null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [phase, setPhase] = useState<Phase>(() => (attachmentMemo.has(normalize(filePath)) ? 'ready' : 'idle'))
  const [attached, setAttached] = useState(false)
  const [reloadNonce, setReloadNonce] = useState(0)
  const addAttachment = useChatStore((s) => s.addAttachment)
  const pendingAttachments = useChatStore((s) => s.pendingAttachments)

  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const alreadyInChat =
    !!attachment &&
    attachment.type === 'file' &&
    pendingAttachments.some(
      (a) => a.type === 'file' && !!attachment.sha256 && a.sha256 === attachment.sha256,
    )

  const canAttach =
    !!attachment &&
    (attachment.type === 'image' ||
      (attachment.type === 'file' && attachment.status !== 'error' && attachment.status !== 'processing'))

  const handleAttachToChat = () => {
    if (!attachment || !canAttach) return
    if (!alreadyInChat) addAttachment(attachment)
    if (attachment.type === 'file' && attachment.status === 'ready') {
      void indexAttachmentAsync(attachment).catch((err) => {
        console.warn('[FilePreview] attachment RAG indexing failed:', err)
      })
    }
    setAttached(true)
    setTimeout(() => setAttached(false), 1600)
  }

  const handleRetry = useCallback(() => {
    invalidateMemo(filePath)
    setAttachment(null)
    setLoadError(null)
    setPhase('idle')
    setReloadNonce((n) => n + 1)
  }, [filePath])

  useEffect(() => {
    const key = normalize(filePath)
    let cancelled = false
    let finished = false

    // Fast path: renderer memo hit — no IPC.
    const cached = attachmentMemo.get(key)
    if (cached && reloadNonce === 0) {
      // Synchronous cache hit: commit the cached view immediately so
      // the preview doesn't flash empty before the async IPC resolves.
      // Attempting to derive this in render would require a separate
      // "cache bound" state; the effect shape is deliberate here.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setAttachment(cached)
       
      setPhase('ready')
      return () => { cancelled = true }
    }

    setAttachment(null)
    setLoadError(null)
    setPhase('reading')

    const api = window.electronAPI?.attachments
    if (!api?.ingest) {
      setLoadError('附件解析 API 不可用(仅在 Electron 环境下支持 PDF / Office 预览)。')
      setPhase('error')
      return () => { cancelled = true }
    }

    timeoutRef.current = setTimeout(() => {
      if (finished || cancelled) return
      finished = true
      setLoadError(
        `解析 ${fileName} 超过 ${Math.round(RENDER_TIMEOUT_MS / 1000)} 秒仍未完成 — 主进程可能在处理超大文件或已挂起。点击"重试"可再次尝试。`,
      )
      setPhase('error')
    }, RENDER_TIMEOUT_MS)

    void (async () => {
      try {
        const result = await api.ingest({ path: filePath, name: fileName })
        if (cancelled || finished) return
        finished = true
        if (timeoutRef.current) {
          clearTimeout(timeoutRef.current)
          timeoutRef.current = null
        }
        if (!result) {
          setLoadError('主进程未返回任何解析结果。')
          setPhase('error')
          return
        }
        // `attachment:ingest` returns `unknown` in preload.ts because the
        // payload is built by main-process parsers whose shape varies by
        // `type`. Main process always produces an Attachment-shaped
        // record, so assert once through `unknown` rather than scattering
        // `as any` across every property.
        const r = result as Attachment
        let next: Attachment
        if (r.type === 'image') {
          next = {
            type: 'image',
            name: r.name,
            base64: r.base64,
            mediaType: r.mediaType,
            size: r.size,
            sha256: r.sha256,
          }
        } else {
          next = {
            type: 'file',
            name: r.name,
            path: r.path,
            size: r.size,
            kind: r.kind as AttachmentKind,
            mimeType: r.mimeType,
            sha256: r.sha256,
            status: r.status,
            error: r.error,
            pdf: r.pdf,
            text: r.text,
            pageImages: r.pageImages,
            sheets: r.sheets,
            inlineImages: r.inlineImages,
            notes: r.notes,
          }
        }
        attachmentMemo.set(key, next)
        setAttachment(next)
        setPhase('ready')
      } catch (err) {
        if (cancelled || finished) return
        finished = true
        if (timeoutRef.current) {
          clearTimeout(timeoutRef.current)
          timeoutRef.current = null
        }
        setLoadError(err instanceof Error ? err.message : String(err))
        setPhase('error')
      }
    })()

    return () => {
      cancelled = true
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
        timeoutRef.current = null
      }
    }
  }, [filePath, fileName, reloadNonce])

  // Watch the workspace for external file changes and invalidate the memo so
  // the next render pulls fresh bytes. Scoped to the currently displayed
  // path — we don't burn cache entries for unrelated files.
  useEffect(() => {
    const key = normalize(filePath)
    const unsub = onWorkspaceFileChanged((payload) => {
      if (normalize(payload.filePath) !== key) return
      if (payload.changeType === 'add' || payload.changeType === 'change') {
        invalidateMemo(filePath)
        setReloadNonce((n) => n + 1)
      }
    })
    return () => unsub()
  }, [filePath])

  if (phase === 'error' && loadError) {
    return (
      <div className="file-preview-wrap">
        <div className="file-preview-header">
          <div className="file-preview-title-text">
            <span className="file-preview-name" title={filePath}>{fileName}</span>
            <span className="file-preview-subtitle">解析失败</span>
          </div>
          <button className="file-preview-retry-btn" onClick={handleRetry} title="重新解析">
            <RefreshCw size={14} />
            <span>重试</span>
          </button>
        </div>
        <div className="file-preview-body">
          <div className="attachment-preview-error">
            <strong>无法预览</strong>
            <pre>{loadError}</pre>
          </div>
        </div>
      </div>
    )
  }

  if (phase !== 'ready' || !attachment) {
    return (
      <div className="file-preview-wrap file-preview-loading">
        <Loader2 size={20} className="spinning" />
        <span>正在解析 {fileName}…</span>
      </div>
    )
  }

  const Icon = pickAttachmentIcon(attachment)
  const subtitle = renderAttachmentSubtitle(attachment)
  const attachDisabled = !canAttach

  return (
    <div className="file-preview-wrap">
      <div className="file-preview-header">
        {/* `Icon` is a stable lookup from `pickAttachmentIcon`. See the
            sister comment in AttachmentPreview for why the rule fires
            a false positive on this pattern. */}
        {/* eslint-disable-next-line react-hooks/static-components */}
        <Icon size={16} />
        <div className="file-preview-title-text">
          <span className="file-preview-name" title={filePath}>{fileName}</span>
          {subtitle && <span className="file-preview-subtitle">{subtitle}</span>}
        </div>
        <button
          className="file-preview-retry-btn"
          onClick={handleRetry}
          title="重新解析(忽略缓存)"
        >
          <RefreshCw size={14} />
        </button>
        <button
          className="file-preview-attach-btn"
          onClick={handleAttachToChat}
          title={
            attachDisabled
              ? '附件当前不可用(解析失败或正在处理)'
              : alreadyInChat
                ? '已在对话附件中(再次点击仍可添加)'
                : '把此文件添加到对话附件(AI 将能读取)'
          }
          disabled={attachDisabled}
        >
          {attached ? <Check size={14} /> : <Paperclip size={14} />}
          <span>{attached ? '已添加' : '引用到对话'}</span>
        </button>
      </div>
      <div className="file-preview-body">
        <AttachmentBody attachment={attachment} />
      </div>
    </div>
  )
}

/**
 * Extensions Monaco cannot reasonably render — route these to FilePreview.
 * Markdown/JSON/CSV/TSV etc. still go through Monaco so the user can edit
 * plain-text representations; those preview nicely in the chat side anyway.
 *
 * `rtf` is included because Monaco would show it as control-word noise,
 * while the ingest pipeline strips the markup and presents readable text.
 * `ipynb` is included because Monaco has no cell-aware renderer and the
 * attachment pipeline produces a readable Markdown summary of cells.
 */
// 2026-07 审计修复 —— 扩展名清单收敛到 openBehavior.ts 单一来源,
// 此前 Sidebar 的 PREVIEW_ONLY 与这里各维护一份且不同步(缺 ipynb)。
// eslint-disable-next-line react-refresh/only-export-components
export function shouldPreviewInsteadOfEdit(fileName: string): boolean {
  const ext = fileName.split('.').pop()?.toLowerCase() || ''
  return DOC_PREVIEW_EXTS.has(ext)
}
