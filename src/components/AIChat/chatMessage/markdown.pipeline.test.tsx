/**
 * Pipeline-level integration tests for the chat markdown renderer —
 * `MarkdownContent` with the real remark/rehype plugin chain
 * (remark-gfm → remark-math → rehype-raw → rehype-sanitize → rehype-katex).
 *
 * These pin the security and feature contracts added in the rendering
 * audit round:
 *   - inline raw HTML is sanitized (no script / event handlers in the DOM)
 *   - data:/file: image sources survive sanitize (chat renders base64 +
 *     local images through ImagePreview)
 *   - `language-*` classes survive sanitize so CodeBlock / Mermaid /
 *     HtmlPreview fence routing keeps working
 *   - `\(...\)` / `\[...\]` / `$$…$$` all reach KaTeX output
 *
 * Rendered via `renderToStaticMarkup` — no DOM needed, and effects
 * (Mermaid init, lightbox listeners) don't run under static rendering.
 */
import { describe, it, expect } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MarkdownContent } from './markdown'

const render = (text: string) =>
  renderToStaticMarkup(React.createElement(MarkdownContent, { text }))

describe('chat markdown pipeline (sanitize + katex)', () => {
  it('strips <script> from inline raw HTML', () => {
    const html = render('before <script>alert(1)</script> after')
    expect(html).not.toContain('<script')
    expect(html).toContain('before')
    expect(html).toContain('after')
  })

  it('strips event-handler attributes from inline raw HTML', () => {
    const html = render('<img src="x" onerror="alert(1)">')
    expect(html).not.toContain('onerror')
    expect(html).not.toContain('alert(1)')
  })

  it('strips javascript: links', () => {
    const html = render('[click](javascript:alert(1))')
    expect(html).not.toContain('javascript:')
  })

  it('keeps data: image sources (base64 chat images)', () => {
    const html = render('![pic](data:image/png;base64,AAAA)')
    expect(html).toContain('data:image/png;base64,AAAA')
  })

  it('keeps file: image sources (local files in Electron)', () => {
    const html = render('![pic](file:///C:/tmp/x.png)')
    expect(html).toContain('file:///C:/tmp/x.png')
  })

  it('keeps benign inline HTML like <details>', () => {
    const html = render('<details><summary>title</summary>body</details>')
    expect(html).toContain('<details>')
    expect(html).toContain('<summary>')
  })

  it('routes fenced code to CodeBlock with the language label', () => {
    const html = render('```ts\nconst a: number = 1\n```')
    expect(html).toContain('chat-code-block')
    expect(html).toContain('chat-code-lang')
    expect(html).toContain('const a: number = 1')
  })

  it('renders \\(...\\) as inline KaTeX', () => {
    const html = render('area \\(\\pi r^2\\) here')
    expect(html).toContain('katex')
    expect(html).not.toContain('\\(')
  })

  it('renders \\[...\\] as display KaTeX', () => {
    const html = render('result:\n\\[E = mc^2\\]')
    expect(html).toContain('katex-display')
  })

  it('renders native $$ display math', () => {
    const html = render('$$\na^2 + b^2 = c^2\n$$')
    expect(html).toContain('katex-display')
  })

  it('does NOT treat single-dollar prose as math', () => {
    const html = render('价格是$5一个$8也行')
    expect(html).not.toContain('katex')
    expect(html).toContain('$5')
  })

  it('leaves math delimiters inside fenced code untouched', () => {
    const html = render('```tex\n\\(raw\\)\n```')
    expect(html).not.toContain('katex')
    expect(html).toContain('\\(raw\\)')
  })

  it('renders GFM task-list checkboxes', () => {
    const html = render('- [x] done\n- [ ] todo')
    expect(html).toContain('type="checkbox"')
  })

  it('renders GFM tables inside the scroll wrapper', () => {
    const html = render('| a | b |\n| - | - |\n| 1 | 2 |')
    expect(html).toContain('chat-table-wrapper')
    expect(html).toContain('<table>')
  })
})
