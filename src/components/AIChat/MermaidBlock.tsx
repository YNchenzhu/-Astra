import React, { useEffect, useId, useRef, useState } from 'react'
import mermaid from 'mermaid'
import { Copy, Check, Code2, Eye, Download, Maximize2, X } from 'lucide-react'
import './MermaidBlock.css'

/**
 * Detect known internal mermaid 9.x failures that surface as runtime errors
 * rather than parse failures — most commonly `flowDb.clear()` on undefined
 * webpack module imports under non-webpack bundlers (rolldown / vite native
 * ESM in Electron). When we hit one of these we can't recover the diagram,
 * so we degrade gracefully to a "查看源码" hint instead of dumping the raw
 * library stack trace into the chat surface.
 */
function isMermaidInternalLibraryError(message: string): boolean {
  if (!message) return false
  if (/Cannot read propert(?:y|ies) of undefined \(reading ['"]clear['"]\)/i.test(message)) {
    return true
  }
  if (/Cannot read propert(?:y|ies) of undefined \(reading ['"]parse['"]\)/i.test(message)) {
    return true
  }
  // The rolldown-bundled mermaid build occasionally throws a generic
  // "this.db is undefined" / "diagramApi.getDiagram is not a function" when
  // the diagram-type registry was not populated — same root cause, same
  // unrecoverable state. Treat them all the same way.
  if (/this\.db is undefined/i.test(message)) return true
  if (/getDiagram is not a function/i.test(message)) return true
  return false
}

/**
 * Debounce rapid `value` updates. Used here to coalesce streaming tokens so
 * we don't invoke `mermaid.parse` / `mermaid.render` on every intermediate
 * token — that caused the diagram to flicker (parse-fail → "渲染中…" →
 * successful render → parse-fail again …) during streaming.
 */
function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(value), delayMs)
    return () => window.clearTimeout(id)
  }, [value, delayMs])
  return debounced
}

let mermaidInitialized = false
let mermaidInitFailed = false
function ensureMermaidInitialized() {
  if (mermaidInitialized || mermaidInitFailed) return
  try {
    mermaid.initialize({
      startOnLoad: false,
      theme: 'dark',
      securityLevel: 'strict',
      fontFamily: 'inherit',
      themeVariables: {
        background: 'transparent',
        primaryColor: '#1e1e2e',
        primaryTextColor: '#cdd6f4',
        primaryBorderColor: '#45475a',
        lineColor: '#89b4fa',
        secondaryColor: '#313244',
        tertiaryColor: '#181825',
      },
    })
    mermaidInitialized = true
  } catch {
    mermaidInitFailed = true
  }
}

interface MermaidBlockProps {
  code: string
}

/**
 * Render a Mermaid diagram. Supports switching between rendered preview and
 * source code, copying the source, and opening a full-screen zoom view.
 *
 * Mermaid is loaded lazily and initialized once. Rendering is re-attempted
 * whenever the `code` prop changes (useful while the assistant is streaming
 * its response — we only render when parseable to avoid flashing errors).
 */
export const MermaidBlock: React.FC<MermaidBlockProps> = ({ code }) => {
  const domId = useId().replace(/[^a-zA-Z0-9]/g, '')
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [svg, setSvg] = useState<string>('')
  const [error, setError] = useState<string>('')
  /**
   * `unrecoverable` distinguishes "diagram source is mid-stream / has a typo"
   * (which is a soft `error`) from "the mermaid library itself blew up
   * internally" (which we can't fix from here). The renderer shows a
   * different, friendlier panel for the unrecoverable case so users don't
   * see "Cannot read properties of undefined (reading 'clear')".
   */
  const [unrecoverable, setUnrecoverable] = useState(false)
  const [mode, setMode] = useState<'preview' | 'source'>('preview')
  const [copied, setCopied] = useState(false)
  const [zoom, setZoom] = useState(false)
  // Mirror of the last-good SVG, read from the async parse/render effect
  // without pulling `svg` into the effect's dependency list (which would
  // cause it to re-run each time we successfully render a diagram).
  const lastSvgRef = useRef<string>('')
  useEffect(() => {
    lastSvgRef.current = svg
  }, [svg])
  /**
   * Per-render unique id suffix so each `mermaid.render()` gets a fresh DOM
   * id. mermaid 9.x reuses an internal cache keyed on the id; passing the
   * same id across re-renders (the user edits a team / coordination switches)
   * triggers stale-state asserts that look like `flowDb.clear()` on
   * undefined module slots. A monotonically increasing counter is the
   * cheapest fix that does not require upgrading mermaid.
   */
  const renderSeqRef = useRef(0)

  // Debounce the code fed into mermaid while streaming. Without this, every
  // assistant token triggers parse+render, most of which fail mid-stream and
  // momentarily swap the rendered SVG for the "渲染中…" / error state — the
  // flicker users were reporting. 250ms is short enough that, once the
  // stream ends, the final diagram appears almost immediately.
  const debouncedCode = useDebouncedValue(code, 250)

  useEffect(() => {
    ensureMermaidInitialized()
    let cancelled = false
    const trimmed = debouncedCode.trim()
    if (!trimmed) {
      // Clearing transient render state when the input goes empty. This
      // is a legitimate "reactive reset" — derived-render wouldn't help
      // because the blank-out has to be ordered against the async
      // mermaid parse below.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSvg('')
       
      setError('')
       
      setUnrecoverable(false)
      return
    }

    ;(async () => {
      try {
        const isValid = await mermaid.parse(trimmed, { suppressErrors: true })
        if (!isValid) {
          if (!cancelled) {
            // Keep the previously rendered SVG on screen while the new input
            // is still incomplete, so the preview does not blank out on each
            // failed parse during streaming. Only surface the "等待内容完成"
            // hint when we have nothing to show yet.
            if (!lastSvgRef.current) {
              setError('图表语法不完整，等待内容完成…')
              setUnrecoverable(false)
            }
          }
          return
        }
        const renderId = `mermaid-${domId}-${++renderSeqRef.current}`
        const { svg: renderedSvg } = await mermaid.render(renderId, trimmed)
        if (!cancelled) {
          setSvg(renderedSvg)
          setError('')
          setUnrecoverable(false)
        }
      } catch (err) {
        if (cancelled) return
        const message = err instanceof Error ? err.message : String(err)
        if (isMermaidInternalLibraryError(message)) {
          // Clear cached SVG too — it belongs to a different code revision
          // and will mislead the user about whether the current diagram
          // rendered. Switch to the unrecoverable panel which surfaces the
          // source verbatim and avoids leaking the raw library stack.
          lastSvgRef.current = ''
          setSvg('')
          setError('')
          setUnrecoverable(true)
          return
        }
        // Preserve the last good SVG instead of clearing it — otherwise the
        // preview flashes empty between each failed streaming re-render.
        // Only raise a hard error when we have nothing to show; otherwise
        // keep the last diagram on screen and wait for more input.
        if (!lastSvgRef.current) {
          setError(message)
          setUnrecoverable(false)
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [debouncedCode, domId])

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      /* ignore clipboard errors */
    }
  }

  const handleDownload = () => {
    if (!svg) return
    const blob = new Blob([svg], { type: 'image/svg+xml' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'diagram.svg'
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="chat-mermaid-block">
      <div className="chat-mermaid-header">
        <span className="chat-mermaid-lang">mermaid</span>
        <div className="chat-mermaid-actions">
          <button
            className={`chat-mermaid-tab ${mode === 'preview' ? 'active' : ''}`}
            onClick={() => setMode('preview')}
            title="预览"
          >
            <Eye size={12} />
            预览
          </button>
          <button
            className={`chat-mermaid-tab ${mode === 'source' ? 'active' : ''}`}
            onClick={() => setMode('source')}
            title="源码"
          >
            <Code2 size={12} />
            源码
          </button>
          {svg && mode === 'preview' && (
            <>
              <button
                className="chat-mermaid-iconbtn"
                onClick={() => setZoom(true)}
                title="放大查看"
              >
                <Maximize2 size={12} />
              </button>
              <button
                className="chat-mermaid-iconbtn"
                onClick={handleDownload}
                title="下载 SVG"
              >
                <Download size={12} />
              </button>
            </>
          )}
          <button
            className="chat-mermaid-iconbtn"
            onClick={handleCopy}
            title="复制源码"
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
          </button>
        </div>
      </div>

      {mode === 'preview' ? (
        unrecoverable ? (
          <div className="chat-mermaid-error">
            <div className="chat-mermaid-error-title">图表暂时无法渲染</div>
            <div className="chat-mermaid-error-msg">
              当前环境的 mermaid 渲染库未能加载完整的图表模块，已自动回退为源码视图。
            </div>
            <pre className="chat-mermaid-source">{code}</pre>
          </div>
        ) : error ? (
          <div className="chat-mermaid-error">
            <div className="chat-mermaid-error-title">无法渲染图表</div>
            <pre className="chat-mermaid-error-msg">{error}</pre>
            <details>
              <summary>查看源码</summary>
              <pre className="chat-mermaid-source">{code}</pre>
            </details>
          </div>
        ) : svg ? (
          <div
            ref={containerRef}
            className="chat-mermaid-preview"
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        ) : (
          <div className="chat-mermaid-loading">渲染中…</div>
        )
      ) : (
        <pre className="chat-mermaid-source">{code}</pre>
      )}

      {zoom && svg && (
        <div className="chat-mermaid-zoom-overlay" onClick={() => setZoom(false)}>
          <button
            className="chat-mermaid-zoom-close"
            onClick={(e) => {
              e.stopPropagation()
              setZoom(false)
            }}
            title="关闭 (Esc)"
          >
            <X size={18} />
          </button>
          <div
            className="chat-mermaid-zoom-content"
            onClick={(e) => e.stopPropagation()}
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        </div>
      )}
    </div>
  )
}
