import React, { memo, useDeferredValue, useMemo } from 'react'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import rehypeKatex from 'rehype-katex'
import type { PluggableList } from 'unified'
import 'katex/dist/katex.min.css'
import { CodeBlock } from '../CodeBlock'
import { MermaidBlock } from '../MermaidBlock'
import { HtmlPreviewBlock } from '../HtmlPreviewBlock'
import { ImagePreview } from '../ImagePreview'

/**
 * Sanitize schema for AI-generated markdown. `rehype-raw` parses inline HTML
 * straight into the tree, so without this step any `<img onerror=…>` /
 * `<script>` the model echoes (e.g. quoting a malicious web page) lands in
 * the real DOM. Extensions over the GitHub default schema:
 *   - keep `language-*` classes on `code` (CodeBlock / Mermaid / HtmlPreview
 *     routing reads them) plus the remark-math marker classes, which
 *     `rehype-katex` (running AFTER sanitize) needs to find math nodes
 *   - allow `data:` / `file:` image sources — chat renders base64 blocks and
 *     local files through `ImagePreview`
 */
const SANITIZE_SCHEMA: typeof defaultSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [
      ...(defaultSchema.attributes?.code ?? []),
      ['className', /^language-/, 'math-inline', 'math-display'],
    ],
  },
  protocols: {
    ...defaultSchema.protocols,
    src: [...(defaultSchema.protocols?.src ?? []), 'data', 'file'],
  },
}

// Stable plugin arrays — inline arrays recreate identity every render,
// forcing ReactMarkdown to re-initialise its processor pipeline.
// `singleDollarTextMath: false`: single-`$` inline math false-positives on
// ordinary prose ("价格$5一个$8" would become math). Models are steered to
// `\(...\)` / `\[...\]` / `$$…$$`; `normalizeMathDelimiters` maps the first
// two onto the `$$` forms remark-math does parse.
const REMARK_PLUGINS: PluggableList = [remarkGfm, [remarkMath, { singleDollarTextMath: false }]]
// Order matters: raw HTML is parsed, then sanitized, then math is expanded —
// KaTeX output (spans with inline styles + MathML) must not pass through the
// sanitizer or it would be stripped down to bare text.
// Exported so other chat markdown surfaces (AttachmentBody, …) share the same
// sanitized pipeline instead of a bare `[rehypeRaw]`.
// eslint-disable-next-line react-refresh/only-export-components
export const REHYPE_PLUGINS: PluggableList = [rehypeRaw, [rehypeSanitize, SANITIZE_SCHEMA], rehypeKatex]

/**
 * Convert LaTeX-style math delimiters to the `$$` forms remark-math parses:
 *   - `\[ … \]` → display math (`$$` on its own lines)
 *   - `\( … \)` → inline math (`$$ … $$` inline — mathText accepts 2+ dollar
 *     delimiters, so this stays inline while single-`$` parsing stays off)
 *
 * Fenced code blocks and single-backtick inline code spans are left
 * untouched so literal `\(`/`\[` in code never get rewritten.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function normalizeMathDelimiters(text: string): string {
  if (!text.includes('\\(') && !text.includes('\\[')) return text

  // Split out fenced code blocks with the same fence rules as
  // segmentStreamingMarkdown (open fence swallows everything after it).
  const lines = text.split('\n')
  const parts: Array<{ code: boolean; text: string }> = []
  let fenceMarker: '`' | '~' | null = null
  let buf: string[] = []
  let bufIsCode = false
  const flush = (nextIsCode: boolean) => {
    if (buf.length > 0) parts.push({ code: bufIsCode, text: buf.join('\n') })
    buf = []
    bufIsCode = nextIsCode
  }
  for (const line of lines) {
    const fenceMatch = /^(```+|~~~+)/.exec(line)
    if (fenceMatch) {
      const marker = fenceMatch[1][0] as '`' | '~'
      if (fenceMarker === null) {
        flush(true)
        fenceMarker = marker
      } else if (fenceMarker === marker) {
        buf.push(line)
        fenceMarker = null
        flush(false)
        continue
      }
    }
    buf.push(line)
  }
  flush(false)

  const transformProse = (prose: string): string =>
    // Mask inline code spans (single- and double-backtick) so `\(…\)`
    // inside backticks survives verbatim.
    prose
      .split(/(``[^`]*``|`[^`\n]*`)/)
      .map((piece, i) => {
        if (i % 2 === 1) return piece
        return piece
          .replace(/\\\[([\s\S]+?)\\\]/g, (_m, body: string) => `\n$$\n${body}\n$$\n`)
          .replace(/\\\(([\s\S]+?)\\\)/g, (_m, body: string) => `$$${body}$$`)
      })
      .join('')

  return parts.map((p) => (p.code ? p.text : transformProse(p.text))).join('\n')
}

// Stable markdown component map — extracted so it is not recreated on
// every MarkdownContent render. The functions only close over module-level
// imports, so the reference is safe to share across renders.
const MARKDOWN_COMPONENTS = {
  code({ className, children, ...props }: { className?: string; children?: React.ReactNode }) {
    const match = /language-(\w+)/.exec(className || '')
    const lang = (match ? match[1] : '').toLowerCase()
    const codeStr = String(children).replace(/\n$/, '')

    if (/\n/.test(String(children))) {
      if (lang === 'mermaid') {
        return <MermaidBlock code={codeStr} />
      }
      if (lang === 'html') {
        return <HtmlPreviewBlock code={codeStr} />
      }
      if (lang === 'svg') {
        return <HtmlPreviewBlock code={codeStr} asSvg />
      }
      return <CodeBlock language={lang} code={String(children)} />
    }
    return <code className="chat-inline-code" {...props}>{children}</code>
  },
  a({ href, children }: { href?: string; children?: React.ReactNode }) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="chat-markdown-link"
        onClick={(e) => {
          if (href?.startsWith('#')) {
            e.preventDefault()
          }
        }}
      >
        {children}
      </a>
    )
  },
  img({ src, alt, title }: { src?: string; alt?: string; title?: string }) {
    const url = typeof src === 'string' ? src : ''
    return <ImagePreview src={url} alt={alt} title={title} />
  },
  pre({ children }: { children?: React.ReactNode }) {
    return <>{children}</>
  },
  table({ children }: { children?: React.ReactNode }) {
    return (
      <div className="chat-table-wrapper">
        <table>{children}</table>
      </div>
    )
  },
}

/**
 * Below this length we don't bother segmenting a streaming message — the
 * full-text re-parse is cheap enough and the two-instance split would only
 * add overhead and transient boundary artifacts.
 */
export const STREAM_SEGMENT_MIN_CHARS = 2000

/**
 * Segment streaming markdown into a list of already-complete "frozen" blocks
 * plus a "live" tail (the block currently being streamed). Split points are
 * EVERY blank-line paragraph boundary that sits OUTSIDE a fenced code block —
 * markdown blocks are independent across blank lines, so each completed
 * segment can be memo-frozen and parsed exactly ONCE, while only the small
 * tail re-parses each frame.
 *
 * Why segment (vs a single prefix): a single frozen prefix re-parses its
 * whole (growing) content every time a new boundary is crossed — O(n²) over
 * the life of a long message. Splitting into per-block segments makes each
 * block parse once → O(n) total. The segment list is append-only during
 * streaming (an already-crossed boundary never moves, and an unclosed fence
 * keeps all later text in the tail), so segment indices are stable React keys.
 *
 * Guarantees:
 *   - An open (unclosed) code fence keeps everything from the fence onward in
 *     `tail` (a boundary is never recorded while inside a fence), so no
 *     segment ever contains a half-parsed code block.
 *   - `segments.join('') + tail === text` (round-trips losslessly).
 *   - Short inputs, or inputs with no safe boundary, return `{ segments: [],
 *     tail: text }` — i.e. behave exactly like the un-segmented path.
 *
 * A fence is only closed by a line led with the SAME marker (`` ` `` or `~`);
 * CommonMark forbids closing a ``` block with ~~~ (or vice-versa).
 */
// eslint-disable-next-line react-refresh/only-export-components
export function segmentStreamingMarkdown(text: string): { segments: string[]; tail: string } {
  if (text.length < STREAM_SEGMENT_MIN_CHARS) return { segments: [], tail: text }

  const lines = text.split('\n')
  let fenceMarker: '`' | '~' | null = null
  let offset = 0
  // Char offsets (exclusive) of each qualifying blank-line boundary.
  const boundaries: number[] = []

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const fenceMatch = /^(```+|~~~+)/.exec(line)
    if (fenceMatch) {
      const marker = fenceMatch[1][0] as '`' | '~'
      if (fenceMarker === null) {
        fenceMarker = marker
      } else if (fenceMarker === marker) {
        fenceMarker = null
      }
      // Different marker while inside a fence → it's code content, ignore.
    } else if (fenceMarker === null && line.trim() === '' && i < lines.length - 1) {
      // Position just past this blank line's newline.
      boundaries.push(offset + line.length + 1)
    }
    // +1 for the '\n' that `split` removed (no trailing newline after the
    // last line, but we never read `offset` past the final iteration).
    offset += line.length + 1
  }

  if (boundaries.length === 0) return { segments: [], tail: text }

  const segments: string[] = []
  let start = 0
  for (const b of boundaries) {
    if (b > start && b < text.length) {
      segments.push(text.slice(start, b))
      start = b
    }
  }
  return { segments, tail: text.slice(start) }
}

/**
 * react-markdown's built-in URL transform strips everything that isn't
 * http(s)/mailto/… — including `data:` and `file:` image sources, which chat
 * legitimately renders (base64 blocks, generated local images) through
 * `ImagePreview`. Re-allow exactly those two for image `src`; everything
 * else (notably `javascript:` hrefs) keeps the default treatment, and
 * rehype-sanitize independently enforces its protocol allow-list on top.
 */
const urlTransform = (url: string, key: string): string => {
  if (key === 'src' && (url.startsWith('data:image/') || url.startsWith('file:'))) {
    return url
  }
  return defaultUrlTransform(url)
}

/** Bare ReactMarkdown body with the shared stable plugins / component map. */
const CoreMarkdown: React.FC<{ text: string }> = ({ text }) => {
  const normalized = useMemo(() => normalizeMathDelimiters(text), [text])
  return (
    <ReactMarkdown
      remarkPlugins={REMARK_PLUGINS}
      rehypePlugins={REHYPE_PLUGINS}
      urlTransform={urlTransform}
      components={MARKDOWN_COMPONENTS as Record<string, React.ComponentType<Record<string, unknown>>>}
    >
      {normalized}
    </ReactMarkdown>
  )
}

/**
 * Memoised markdown body. During streaming the prefix is passed here so the
 * (expensive) remark/rehype pipeline only re-runs when the prefix actually
 * grows — i.e. when a new paragraph boundary is crossed, not on every token.
 */
const FrozenMarkdown = memo(CoreMarkdown)

/** Markdown renderer used for both top-level content and inline text blocks */
export const MarkdownContent: React.FC<{ text: string; showCursor?: boolean }> = ({ text, showCursor }) => {
  const deferredText = useDeferredValue(text)
  // Cheap O(n) string scan; far below the cost of the markdown parse it saves.
  const seg = useMemo(() => segmentStreamingMarkdown(text), [text])

  // Non-streaming: single deferred parse of the whole block (unchanged).
  if (!showCursor) {
    if (!deferredText) return null
    return (
      <div className="chat-markdown-body">
        <CoreMarkdown text={deferredText} />
      </div>
    )
  }

  // Streaming: each completed segment is a memo-frozen block (parsed once;
  // its content is immutable) + the live tail (re-parsed each frame). Segment
  // indices are stable keys because the list is append-only during streaming.
  if (!text) {
    return <span className="chat-streaming-cursor" />
  }
  return (
    <div className="chat-markdown-body">
      {seg.segments.map((s, i) => (
        <FrozenMarkdown key={i} text={s} />
      ))}
      <CoreMarkdown text={seg.tail} />
      <span className="chat-streaming-cursor" />
    </div>
  )
}

/** Animated wrapper for block entry — Cherry Studio style slide-in */
export const AnimatedBlock: React.FC<{ children: React.ReactNode; blockKey: string }> = ({ children, blockKey }) => (
  <div key={blockKey} className="animated-block-wrapper">
    {children}
  </div>
)
