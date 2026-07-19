/**
 * PdfLivePreview —— 编辑器 tab 的 PDF 原生预览。
 *
 * 与 `FilePreview`(走 attachment ingest 管道,产出"AI 视角"的文本/页图,
 * 为 chat 消费服务)不同,这个组件是给**用户**看的:直接把磁盘字节喂给
 * Chromium 内置 PDF 查看器(PDFium),获得与浏览器打开 PDF 完全一致的
 * 体验 —— 翻页、缩放、搜索、打印,扫描件和文本版一视同仁,不依赖
 * pdfjs/poppler/canvas 等解析链,自然也不会有"扫描件报错 / 文本版被
 * 转成纯文字"的问题。
 *
 * 实现:
 *   - 走 `fs:read-file-binary` IPC 取原始字节(与 OfficeLivePreview 同一
 *     通道,带 sanitize + path security)。
 *   - 字节 → Blob(application/pdf) → `URL.createObjectURL` → <iframe>。
 *     用 blob: 而不是 file://,dev(http://localhost)与打包(file://)
 *     两种 origin 下都能加载;CSP 的 frame-src 已放行 blob:。
 *   - 文件被外部修改(AI 写入/外部编辑器)时自动重载。
 */

import React, { useCallback, useEffect, useState } from 'react'
import { Loader2, AlertTriangle, RefreshCw } from 'lucide-react'
import { readFileBinary, onWorkspaceFileChanged } from '../../services/fileSystem'
import './OfficeLivePreview.css'
import './PdfLivePreview.css'

export interface PdfLivePreviewProps {
  filePath: string
  fileName: string
}

type Phase = 'loading' | 'ready' | 'error'

export const PdfLivePreview: React.FC<PdfLivePreviewProps> = ({ filePath, fileName }) => {
  const [phase, setPhase] = useState<Phase>('loading')
  const [error, setError] = useState<string | null>(null)
  const [blobUrl, setBlobUrl] = useState<string | null>(null)
  const [reloadNonce, setReloadNonce] = useState(0)

  useEffect(() => {
    let cancelled = false
    // 读盘前先复位 loading/error 表面;在 render 阶段表达这个复位需要
    // lastPath ref 之类的反模式,effect 形态是有意为之(同 OfficeLivePreview)。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPhase('loading')
    setError(null)

    let createdUrl: string | null = null
    readFileBinary(filePath)
      .then((bytes) => {
        if (cancelled) return
        // slice() 拷贝出独立的 ArrayBuffer,避免持有 IPC 传输缓冲的引用。
        const blob = new Blob([bytes.slice()], { type: 'application/pdf' })
        createdUrl = URL.createObjectURL(blob)
        setBlobUrl(createdUrl)
        setPhase('ready')
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
        setPhase('error')
      })

    return () => {
      cancelled = true
      if (createdUrl) URL.revokeObjectURL(createdUrl)
    }
  }, [filePath, reloadNonce])

  // 文件外部改动 → 自动重载
  useEffect(() => {
    const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')
    const key = norm(filePath)
    const unsub = onWorkspaceFileChanged((evt) => {
      if (!evt?.filePath) return
      if (norm(evt.filePath) !== key) return
      if (evt.changeType === 'add' || evt.changeType === 'change') {
        setReloadNonce((n) => n + 1)
      }
    })
    return () => {
      unsub?.()
    }
  }, [filePath])

  const handleReload = useCallback(() => setReloadNonce((n) => n + 1), [])

  if (phase === 'loading') {
    return (
      <div className="office-preview-status">
        <Loader2 size={18} className="is-spinning" />
        <span>正在加载 {fileName}…</span>
      </div>
    )
  }
  if (phase === 'error' || !blobUrl) {
    return (
      <div className="office-preview-status is-error">
        <AlertTriangle size={18} />
        <div className="office-preview-error-body">
          <div>打开失败:{error ?? '未知错误'}</div>
          <button type="button" className="office-preview-retry" onClick={handleReload}>
            <RefreshCw size={11} /> 重试
          </button>
        </div>
      </div>
    )
  }

  return (
    <iframe
      className="pdf-live-preview-frame"
      title={fileName}
      src={blobUrl}
    />
  )
}
