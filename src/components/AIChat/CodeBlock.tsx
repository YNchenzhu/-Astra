import React, { useEffect, useState } from 'react'
import { Copy, Check, FileCode } from 'lucide-react'
import { getColorize, resolveMonacoLanguageId } from './monacoColorize'
import './CodeBlock.css'

interface CodeBlockProps {
  language: string
  code: string
  fileName?: string
}

/**
 * Beyond this many lines we skip `monaco.editor.colorize` and render plain
 * text, so a huge generated blob doesn't block the JS thread (same rationale
 * as `WriteEditProgressView`'s COLORIZE_LINE_CAP).
 */
const HIGHLIGHT_LINE_CAP = 800

/**
 * Colorize only after the code has been stable for this long. During
 * streaming the tail block's content changes every frame, which keeps
 * resetting the timer — so highlighting kicks in exactly once, when the
 * block stops growing (fence closed / segment frozen / stream ended).
 */
const HIGHLIGHT_DEBOUNCE_MS = 150

export const CodeBlock: React.FC<CodeBlockProps> = ({ language, code, fileName }) => {
  const [copied, setCopied] = useState(false)
  // Keyed by source text so a stale highlight (from a previous `code` value)
  // is never rendered — we fall back to plaintext until the fresh colorize
  // resolves.
  const [colorized, setColorized] = useState<{ code: string; html: string } | null>(null)

  const handleCopy = async () => {
    await navigator.clipboard.writeText(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const languageId = resolveMonacoLanguageId(language)

  useEffect(() => {
    if (languageId === 'plaintext' || !code) return
    // Cheap line count without allocating an array.
    let lines = 1
    for (let i = 0; i < code.length; i += 1) if (code[i] === '\n') lines += 1
    if (lines > HIGHLIGHT_LINE_CAP) return

    let cancelled = false
    const timer = window.setTimeout(() => {
      getColorize()
        .then((colorize) => colorize(code, languageId, { tabSize: 2 }))
        .then((html) => {
          if (!cancelled) setColorized({ code, html })
        })
        .catch(() => {
          /* colorize unavailable — plaintext branch keeps rendering */
        })
    }, HIGHLIGHT_DEBOUNCE_MS)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [code, languageId])

  const highlightedHtml = colorized && colorized.code === code ? colorized.html : null

  return (
    <div className="chat-code-block">
      <div className="chat-code-header">
        <span className="chat-code-lang">{language}</span>
        {fileName && (
          <span className="chat-code-filename">
            <FileCode size={12} />
            {fileName}
          </span>
        )}
        <button className="chat-code-copy" onClick={handleCopy} title="Copy code">
          {copied ? <Check size={14} /> : <Copy size={14} />}
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>
      {highlightedHtml !== null ? (
        // Safe sink: `monaco.editor.colorize` HTML-escapes the source text
        // and only emits `<span class="mtk*">` token wrappers.
        <pre
          className="chat-code-content"
          dangerouslySetInnerHTML={{ __html: highlightedHtml }}
        />
      ) : (
        <pre className="chat-code-content">
          <code>{code}</code>
        </pre>
      )}
    </div>
  )
}
