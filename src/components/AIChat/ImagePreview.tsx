import React, { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { X, Download, ZoomIn, ZoomOut } from 'lucide-react'
import './ImagePreview.css'

interface ImagePreviewProps {
  src: string
  alt?: string
  title?: string
}

/**
 * Inline image with click-to-zoom lightbox. Used as the `img` renderer for
 * markdown images so that any `![]()` in an assistant reply becomes a nice
 * clickable preview. Handles data URIs, remote URLs, and file:// URLs that
 * Electron's webview allows.
 */
export const ImagePreview: React.FC<ImagePreviewProps> = ({ src, alt, title }) => {
  const [zoom, setZoom] = useState(false)
  const [scale, setScale] = useState(1)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!zoom) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setZoom(false)
      else if (e.key === '+' || e.key === '=') setScale((s) => Math.min(s + 0.25, 4))
      else if (e.key === '-') setScale((s) => Math.max(s - 0.25, 0.25))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [zoom])

  if (!src) return null

  if (failed) {
    return (
      <span className="chat-image-broken" title={src}>
        [图片加载失败: {alt || src.slice(0, 40)}]
      </span>
    )
  }

  const handleDownload = async () => {
    try {
      const resp = await fetch(src)
      const blob = await resp.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = (alt || 'image').replace(/[^a-zA-Z0-9._-]/g, '_') || 'image'
      a.click()
      URL.revokeObjectURL(url)
    } catch {
      window.open(src, '_blank')
    }
  }

  return (
    <>
      <img
        src={src}
        alt={alt || ''}
        title={title || alt}
        className="chat-inline-image"
        loading="lazy"
        onError={() => setFailed(true)}
        onClick={() => {
          setScale(1)
          setZoom(true)
        }}
      />
      {zoom && createPortal(
        <div className="chat-image-zoom-overlay" onClick={() => setZoom(false)}>
          <div className="chat-image-zoom-toolbar" onClick={(e) => e.stopPropagation()}>
            <button
              className="chat-image-zoom-btn"
              onClick={() => setScale((s) => Math.max(s - 0.25, 0.25))}
              title="缩小"
            >
              <ZoomOut size={16} />
            </button>
            <span className="chat-image-zoom-scale">{Math.round(scale * 100)}%</span>
            <button
              className="chat-image-zoom-btn"
              onClick={() => setScale((s) => Math.min(s + 0.25, 4))}
              title="放大"
            >
              <ZoomIn size={16} />
            </button>
            <button className="chat-image-zoom-btn" onClick={handleDownload} title="下载">
              <Download size={16} />
            </button>
            <button
              className="chat-image-zoom-btn"
              onClick={() => setZoom(false)}
              title="关闭 (Esc)"
            >
              <X size={16} />
            </button>
          </div>
          <img
            src={src}
            alt={alt || ''}
            className="chat-image-zoom-img"
            style={{ transform: `scale(${scale})` }}
            onClick={(e) => e.stopPropagation()}
          />
        </div>,
        document.body,
      )}
    </>
  )
}
