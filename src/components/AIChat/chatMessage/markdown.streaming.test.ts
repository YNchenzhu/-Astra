/**
 * Tests for `segmentStreamingMarkdown` — the streaming-markdown segmentation
 * that freezes each completed block (parsed once) and live-parses only the
 * tail, avoiding the O(n^2) re-parse of a single growing prefix.
 *
 * The function is pure and string-only, so these tests don't need a DOM or
 * React. They pin the safety invariants the rest of the streaming render
 * path relies on:
 *   - never splits inside a fenced code block,
 *   - always round-trips (`segments.join('') + tail === text`),
 *   - leaves short / boundary-less inputs untouched.
 */
import { describe, it, expect } from 'vitest'
import {
  segmentStreamingMarkdown,
  normalizeMathDelimiters,
  STREAM_SEGMENT_MIN_CHARS,
} from './markdown'

const para = (ch: string, n = 700) => ch.repeat(n)

describe('segmentStreamingMarkdown', () => {
  it('leaves short text (below threshold) un-segmented', () => {
    const text = 'hello\n\nworld'
    expect(text.length).toBeLessThan(STREAM_SEGMENT_MIN_CHARS)
    expect(segmentStreamingMarkdown(text)).toEqual({ segments: [], tail: text })
  })

  it('splits at every blank-line boundary outside a fence', () => {
    const text = `${para('a')}\n\n${para('b')}\n\n${para('c')}\n\nTAIL_CONTENT`
    expect(text.length).toBeGreaterThanOrEqual(STREAM_SEGMENT_MIN_CHARS)
    const { segments, tail } = segmentStreamingMarkdown(text)
    expect(tail).toBe('TAIL_CONTENT')
    expect(segments).toHaveLength(3)
    expect(segments.join('') + tail).toBe(text)
    // Each completed segment ends at its blank-line boundary.
    expect(segments.every((s) => s.endsWith('\n\n'))).toBe(true)
  })

  it('round-trips losslessly for any split', () => {
    const text = `${para('x')}\n\nmid\n\n${para('y')}\n\nlast`
    const { segments, tail } = segmentStreamingMarkdown(text)
    expect(segments.join('') + tail).toBe(text)
  })

  it('does NOT treat blank lines inside a fenced code block as boundaries', () => {
    const innerBlankLines = Array(400).fill('code').join('\n\n')
    const text = '```js\n' + innerBlankLines + '\n```'
    expect(text.length).toBeGreaterThanOrEqual(STREAM_SEGMENT_MIN_CHARS)
    // All blank lines are inside the (closed) fence → no safe boundary.
    expect(segmentStreamingMarkdown(text)).toEqual({ segments: [], tail: text })
  })

  it('keeps an unclosed fence entirely in the tail', () => {
    const head = `${para('p', 1000)}\n\n${para('q', 1000)}\n\n`
    const openFence = '```js\nfn()\n\nstill streaming code'
    const text = head + openFence
    expect(text.length).toBeGreaterThanOrEqual(STREAM_SEGMENT_MIN_CHARS)
    const { segments, tail } = segmentStreamingMarkdown(text)
    // The blank line INSIDE the open fence must not be chosen as a boundary —
    // the whole fence stays in the tail.
    expect(tail).toBe(openFence)
    expect(segments.join('') + tail).toBe(text)
    expect(segments.join('')).toBe(head)
  })

  it('treats `~~~` fences the same as ``` fences (blank lines inside not split)', () => {
    const innerBlankLines = Array(400).fill('code').join('\n\n')
    const text = '~~~\n' + innerBlankLines + '\n~~~'
    expect(text.length).toBeGreaterThanOrEqual(STREAM_SEGMENT_MIN_CHARS)
    expect(segmentStreamingMarkdown(text)).toEqual({ segments: [], tail: text })
  })

  it('does not let a ~~~ line falsely close a ``` fence (mixed markers)', () => {
    const head = `${para('p', 2100)}\n\n`
    const fence = '```js\nconst a = 1\n~~~\n\nstill inside fence\n```'
    const text = head + fence
    const { segments, tail } = segmentStreamingMarkdown(text)
    expect(tail).toBe(fence)
    expect(segments.join('')).toBe(head)
    expect(segments.join('') + tail).toBe(text)
  })

  it('returns no split when a long text has no blank-line boundary', () => {
    const text = para('z', STREAM_SEGMENT_MIN_CHARS + 50)
    expect(segmentStreamingMarkdown(text)).toEqual({ segments: [], tail: text })
  })

  it('ignores a trailing blank line as a boundary (tail keeps the body)', () => {
    const text = `${para('a', 2100)}\n\nbody text here\n`
    const { segments, tail } = segmentStreamingMarkdown(text)
    expect(segments.join('') + tail).toBe(text)
    expect(tail.startsWith('body text here')).toBe(true)
  })
})

describe('normalizeMathDelimiters', () => {
  it('returns input unchanged when no LaTeX delimiters are present', () => {
    const text = 'plain prose with $5 and $$x$$ untouched'
    expect(normalizeMathDelimiters(text)).toBe(text)
  })

  it('converts \\( … \\) to inline $$ … $$', () => {
    expect(normalizeMathDelimiters('area \\(\\pi r^2\\) here')).toBe('area $$\\pi r^2$$ here')
  })

  it('converts \\[ … \\] to display math on its own lines', () => {
    const out = normalizeMathDelimiters('before\n\\[E = mc^2\\]\nafter')
    expect(out).toContain('\n$$\nE = mc^2\n$$\n')
  })

  it('converts multi-line \\[ … \\] blocks', () => {
    const out = normalizeMathDelimiters('\\[\na + b\n= c\n\\]')
    expect(out).toContain('$$')
    expect(out).toContain('a + b\n= c')
    expect(out).not.toContain('\\[')
  })

  it('leaves fenced code blocks untouched', () => {
    const text = 'prose \\(x\\)\n\n```tex\n\\(raw in code\\)\n\\[also raw\\]\n```\n\ntail \\(y\\)'
    const out = normalizeMathDelimiters(text)
    expect(out).toContain('$$x$$')
    expect(out).toContain('$$y$$')
    expect(out).toContain('\\(raw in code\\)')
    expect(out).toContain('\\[also raw\\]')
  })

  it('leaves inline code spans untouched', () => {
    const text = 'use `\\(escaped\\)` syntax and \\(real\\) math'
    const out = normalizeMathDelimiters(text)
    expect(out).toContain('`\\(escaped\\)`')
    expect(out).toContain('$$real$$')
  })

  it('leaves double-backtick code spans untouched', () => {
    const text = 'use ``\\(a `tick` b\\)`` and \\(real\\)'
    const out = normalizeMathDelimiters(text)
    expect(out).toContain('``\\(a `tick` b\\)``')
    expect(out).toContain('$$real$$')
  })

  it('leaves an unclosed \\( alone while it is still streaming', () => {
    const text = 'partial \\(a + b'
    expect(normalizeMathDelimiters(text)).toBe(text)
  })

  it('keeps everything after an unclosed fence verbatim', () => {
    const text = 'prose\n\n```js\nconst x = "\\(not math\\)"'
    expect(normalizeMathDelimiters(text)).toBe(text)
  })
})
