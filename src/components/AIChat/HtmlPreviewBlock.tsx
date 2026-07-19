import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Copy, Check, Code2, Eye, Maximize2, X, RefreshCw } from 'lucide-react'
import './HtmlPreviewBlock.css'

interface HtmlPreviewBlockProps {
  code: string
  /**
   * When true the block is also rendered for `svg` language.
   * SVG is wrapped into a minimal HTML document before being piped into the
   * sandboxed iframe.
   */
  asSvg?: boolean
}

/**
 * Debounce `value` by `delayMs`. During rapid updates (e.g. assistant streaming
 * HTML token-by-token) the committed output only changes after the stream has
 * been quiet for `delayMs`. This prevents the iframe from reloading on every
 * token, which otherwise causes a visible white-flash flicker.
 *
 * Once the parent stops pushing new values the final value is guaranteed to be
 * committed after `delayMs`, so the end-of-stream frame still shows the full
 * document.
 */
function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(value), delayMs)
    return () => window.clearTimeout(id)
  }, [value, delayMs])
  return debounced
}

function wrapSvgAsHtml(svgSource: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:12px;background:transparent;display:flex;align-items:center;justify-content:center;min-height:100vh;}
    svg{max-width:100%;height:auto;}
  </style></head><body>${svgSource}</body></html>`
}

function looksLikeFullHtmlDoc(source: string): boolean {
  return /<!doctype|<html[\s>]/i.test(source)
}

function wrapHtmlFragment(source: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:12px;background:transparent;color:#cdd6f4;font-family:system-ui,-apple-system,sans-serif;}
  </style></head><body>${source}</body></html>`
}

/**
 * Render HTML (or SVG) snippets produced by the assistant in a sandboxed
 * iframe. The sandbox uses `allow-scripts` only — no `allow-same-origin`,
 * `allow-top-navigation`, or `allow-forms`, which means:
 *   - the iframe can run its own JS but cannot read cookies / localStorage
 *     from the parent document;
 *   - scripts cannot navigate the top window (so a malicious snippet can't
 *     redirect the user);
 *   - form submissions are blocked.
 *
 * The iframe auto-sizes based on its document height. Users can switch to the
 * source view, copy, reload, or open a full-screen zoom.
 */
export const HtmlPreviewBlock: React.FC<HtmlPreviewBlockProps> = ({ code, asSvg }) => {
  const [mode, setMode] = useState<'preview' | 'source'>('preview')
  const [copied, setCopied] = useState(false)
  const [zoom, setZoom] = useState(false)
  const [height, setHeight] = useState<number>(120)
  const [reloadTick, setReloadTick] = useState(0)
  const iframeRef = useRef<HTMLIFrameElement | null>(null)

  // Debounce the source fed to the iframe. While the assistant is streaming
  // the snippet, `code` mutates on every token — binding that directly to
  // `srcDoc` would cause the iframe to reload (white flash + re-measure) on
  // every token, producing the flicker reported by users. A 300ms quiet
  // window is short enough to feel responsive yet long enough to coalesce
  // typical LLM token bursts; once the stream ends, the final value is
  // committed after one more timer tick so the full result is always shown.
  const debouncedCode = useDebouncedValue(code, 300)

  const srcDoc = useMemo(
    () =>
      asSvg
        ? wrapSvgAsHtml(debouncedCode)
        : looksLikeFullHtmlDoc(debouncedCode)
          ? debouncedCode
          : wrapHtmlFragment(debouncedCode),
    [debouncedCode, asSvg],
  )

  useEffect(() => {
    const el = iframeRef.current
    if (!el) return
    const onLoad = () => {
      try {
        const doc = el.contentDocument
        if (!doc) return
        const measured = Math.min(
          Math.max(doc.documentElement.scrollHeight, doc.body?.scrollHeight ?? 0, 80),
          800,
        )
        const next = measured + 8
        // Skip trivial height oscillations (sub-pixel / scrollbar jitter) so the
        // iframe does not visibly resize on every small content tweak.
        setHeight((prev) => (Math.abs(prev - next) < 4 ? prev : next))
      } catch {
        /* cross-origin (shouldn't happen for srcDoc) */
      }
    }
    el.addEventListener('load', onLoad)
    return () => el.removeEventListener('load', onLoad)
  }, [srcDoc, reloadTick])

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      /* ignore clipboard errors */
    }
  }

  const iframe = (
    <iframe
      key={reloadTick}
      ref={iframeRef}
      className="chat-html-iframe"
      title={asSvg ? 'SVG 预览' : 'HTML 预览'}
      sandbox="allow-scripts"
      srcDoc={srcDoc}
      style={{ height }}
    />
  )

  return (
    <div className="chat-html-block">
      <div className="chat-html-header">
        <span className="chat-html-lang">{asSvg ? 'svg' : 'html'}</span>
        <div className="chat-html-actions">
          <button
            className={`chat-html-tab ${mode === 'preview' ? 'active' : ''}`}
            onClick={() => setMode('preview')}
            title="预览"
          >
            <Eye size={12} />
            预览
          </button>
          <button
            className={`chat-html-tab ${mode === 'source' ? 'active' : ''}`}
            onClick={() => setMode('source')}
            title="源码"
          >
            <Code2 size={12} />
            源码
          </button>
          {mode === 'preview' && (
            <>
              <button
                className="chat-html-iconbtn"
                onClick={() => setReloadTick((t) => t + 1)}
                title="重新加载"
              >
                <RefreshCw size={12} />
              </button>
              <button
                className="chat-html-iconbtn"
                onClick={() => setZoom(true)}
                title="放大查看"
              >
                <Maximize2 size={12} />
              </button>
            </>
          )}
          <button className="chat-html-iconbtn" onClick={handleCopy} title="复制源码">
            {copied ? <Check size={12} /> : <Copy size={12} />}
          </button>
        </div>
      </div>

      {mode === 'preview' ? (
        <div className="chat-html-preview">{iframe}</div>
      ) : (
        <pre className="chat-html-source">{code}</pre>
      )}

      {zoom && (
        <div className="chat-html-zoom-overlay" onClick={() => setZoom(false)}>
          <button
            className="chat-html-zoom-close"
            onClick={(e) => {
              e.stopPropagation()
              setZoom(false)
            }}
            title="关闭 (Esc)"
          >
            <X size={18} />
          </button>
          <div className="chat-html-zoom-content" onClick={(e) => e.stopPropagation()}>
            <iframe
              className="chat-html-zoom-iframe"
              title={asSvg ? 'SVG 预览 (全屏)' : 'HTML 预览 (全屏)'}
              sandbox="allow-scripts"
              srcDoc={srcDoc}
            />
          </div>
        </div>
      )}
    </div>
  )
}
