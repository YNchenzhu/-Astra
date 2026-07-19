/**
 * ImageLivePreview —— 编辑器 tab 的图片查看器。
 *
 * 2026-07 富文件审计修复:此前图片没有任何查看器路由,点击 png/jpg 会
 * 经 `fs:read-file` 以 UTF-8 读成乱码塞进 Monaco,大图直接冻结渲染进程。
 * 与 PdfLivePreview 同构:`fs:read-file-binary` 取原始字节(带 sanitize +
 * path security)→ Blob → objectURL → <img>,外部改动自动重载。
 */

import React, { useCallback, useEffect, useState } from 'react'
import { Loader2, AlertTriangle, RefreshCw } from 'lucide-react'
import { readFileBinary, onWorkspaceFileChanged } from '../../services/fileSystem'
import './OfficeLivePreview.css'
import './ImageLivePreview.css'

const EXT_TO_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  tiff: 'image/tiff',
  tif: 'image/tiff',
  avif: 'image/avif',
}

export interface ImageLivePreviewProps {
  filePath: string
  fileName: string
}

type Phase = 'loading' | 'ready' | 'error'

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(2)} MB`
}

export const ImageLivePreview: React.FC<ImageLivePreviewProps> = ({ filePath, fileName }) => {
  const [phase, setPhase] = useState<Phase>('loading')
  const [error, setError] = useState<string | null>(null)
  const [blobUrl, setBlobUrl] = useState<string | null>(null)
  const [byteSize, setByteSize] = useState(0)
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null)
  const [reloadNonce, setReloadNonce] = useState(0)

  useEffect(() => {
    let cancelled = false
    // 同 PdfLivePreview:读盘前复位表面,effect 形态有意为之。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPhase('loading')
    setError(null)
    setDims(null)

    let createdUrl: string | null = null
    readFileBinary(filePath)
      .then((bytes) => {
        if (cancelled) return
        const ext = fileName.split('.').pop()?.toLowerCase() || ''
        const mime = EXT_TO_MIME[ext] || 'application/octet-stream'
        const blob = new Blob([bytes.slice()], { type: mime })
        createdUrl = URL.createObjectURL(blob)
        setByteSize(bytes.byteLength)
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
  }, [filePath, fileName, reloadNonce])

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
    <div className="image-live-preview">
      <div className="image-live-preview-canvas">
        <img
          src={blobUrl}
          alt={fileName}
          onLoad={(e) => {
            const img = e.currentTarget
            setDims({ w: img.naturalWidth, h: img.naturalHeight })
          }}
        />
      </div>
      <div className="image-live-preview-meta">
        <span>{fileName}</span>
        {dims && <span>{dims.w} × {dims.h}</span>}
        <span>{formatBytes(byteSize)}</span>
      </div>
    </div>
  )
}
