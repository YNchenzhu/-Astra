/**
 * End-to-end tests for the Word read-only tool suite.
 *
 * Strategy: we generate fresh .docx fixtures at test time using the `docx`
 * writer package (already installed for symmetry with the Excel suite), then
 * exercise each tool via its public `execute`. The full pipeline runs
 * through mammoth + the in-house top-level block parser, so any mismatch
 * between the parser's expectations and mammoth's actual output surfaces here.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Document, Packer, Paragraph, HeadingLevel, TextRun } from 'docx'
import { setWorkspacePath } from '../workspaceState'
import { wordTools } from './wordTool'
import type { Tool, ToolResult } from '../types'

function tool(name: string): Tool {
  const t = wordTools.find((x) => x.name === name)
  if (!t) throw new Error(`tool not registered: ${name}`)
  return t
}

async function run(name: string, input: Record<string, unknown>): Promise<ToolResult> {
  return tool(name).execute(input)
}

function parseOutput<T = unknown>(res: ToolResult): T {
  expect(res.success, `tool failed: ${res.error}`).toBe(true)
  return JSON.parse(res.output ?? '{}') as T
}

// ------------------------------------------------------------
// Fixture builders
// ------------------------------------------------------------

/**
 * 6 top-level blocks in this order:
 *   1. heading lvl 1 — "Report Title"
 *   2. heading lvl 2 — "Section 1"
 *   3. paragraph     — "First body paragraph mentioning the keyword foo."
 *   4. paragraph     — "Second paragraph with bold and italic words."
 *   5. heading lvl 2 — "Section 2"
 *   6. paragraph     — "Third body paragraph mentioning foo again, and also bar."
 */
async function buildSmallDocx(filePath: string): Promise<void> {
  const doc = new Document({
    sections: [{
      children: [
        new Paragraph({ text: 'Report Title', heading: HeadingLevel.HEADING_1 }),
        new Paragraph({ text: 'Section 1', heading: HeadingLevel.HEADING_2 }),
        new Paragraph('First body paragraph mentioning the keyword foo.'),
        new Paragraph({ children: [
          new TextRun('Second paragraph with '),
          new TextRun({ text: 'bold', bold: true }),
          new TextRun(' and '),
          new TextRun({ text: 'italic', italics: true }),
          new TextRun(' words.'),
        ] }),
        new Paragraph({ text: 'Section 2', heading: HeadingLevel.HEADING_2 }),
        new Paragraph('Third body paragraph mentioning foo again, and also bar.'),
      ],
    }],
  })
  writeFileSync(filePath, await Packer.toBuffer(doc))
}

/** Single huge paragraph that trips the 1 MB byte-limit guard. */
async function buildBigDocx(filePath: string): Promise<void> {
  const huge = 'lorem ipsum dolor sit amet '.repeat(60_000)  // ~1.6 MB raw text
  const doc = new Document({
    sections: [{ children: [new Paragraph(huge)] }],
  })
  writeFileSync(filePath, await Packer.toBuffer(doc))
}

let workspace: string
let smallPath: string
let bigPath: string

beforeEach(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'word-tool-test-'))
  setWorkspacePath(workspace)
  smallPath = join(workspace, 'small.docx')
  bigPath = join(workspace, 'big.docx')
  await buildSmallDocx(smallPath)
})

afterEach(() => {
  setWorkspacePath(null)
  rmSync(workspace, { recursive: true, force: true })
})

// ------------------------------------------------------------
// word_read_text
// ------------------------------------------------------------

describe('word_read_text', () => {
  it('returns plain text containing every paragraph', async () => {
    const out = parseOutput<{ text: string; bytes: number }>(
      await run('word_read_text', { filePath: 'small.docx' }),
    )
    expect(out.text).toContain('Report Title')
    expect(out.text).toContain('Section 1')
    expect(out.text).toContain('keyword foo')
    expect(out.text).toContain('bold')
    expect(out.text).toContain('and also bar')
    expect(out.bytes).toBeGreaterThan(0)
  })

  it('returns a structured size-limit error for huge docs', async () => {
    await buildBigDocx(bigPath)
    const res = await run('word_read_text', { filePath: 'big.docx' })
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/exceeds limit/i)
    expect(res.error).toMatch(/word_read_paragraph_range/) // the next-step hint
  })

  it('honors caller-supplied maxBytes override', async () => {
    const res = await run('word_read_text', { filePath: 'small.docx', maxBytes: 10 })
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/exceeds limit of 10/)
  })
})

// ------------------------------------------------------------
// word_read_html
// ------------------------------------------------------------

describe('word_read_html', () => {
  it('returns HTML preserving headings + bold + italic', async () => {
    const out = parseOutput<{ html: string }>(
      await run('word_read_html', { filePath: 'small.docx' }),
    )
    expect(out.html).toMatch(/<h1[^>]*>Report Title<\/h1>/)
    expect(out.html).toMatch(/<h2[^>]*>Section 1<\/h2>/)
    expect(out.html).toContain('<strong>bold</strong>')
    expect(out.html).toContain('<em>italic</em>')
  })
})

// ------------------------------------------------------------
// word_read_structured
// ------------------------------------------------------------

describe('word_read_structured', () => {
  it('emits an outline of 3 headings and 6 total blocks', async () => {
    const out = parseOutput<{
      counts: { total: number; headings: number; paragraphs: number }
      headings: Array<{ index: number; level: number; text: string }>
      paragraphs: Array<{ index: number; type: string; text: string }>
      outlineOnly: boolean
    }>(await run('word_read_structured', { filePath: 'small.docx' }))

    expect(out.counts.total).toBe(6)
    expect(out.counts.headings).toBe(3)
    expect(out.counts.paragraphs).toBe(3)
    expect(out.outlineOnly).toBe(false)

    expect(out.headings.map((h) => h.text)).toEqual(['Report Title', 'Section 1', 'Section 2'])
    expect(out.headings[0].level).toBe(1)
    expect(out.headings[1].level).toBe(2)

    // Paragraph index must be stable & 1-based.
    expect(out.paragraphs[0].index).toBe(1)
    expect(out.paragraphs[5].index).toBe(6)
    expect(out.paragraphs[2].text).toContain('keyword foo')
  })

  it('respects outlineOnly = true (omits paragraph bodies)', async () => {
    const out = parseOutput<{ headings: unknown[]; paragraphs?: unknown[]; outlineOnly: boolean }>(
      await run('word_read_structured', { filePath: 'small.docx', outlineOnly: true }),
    )
    expect(out.outlineOnly).toBe(true)
    expect(out.headings.length).toBe(3)
    expect(out.paragraphs).toBeUndefined()
  })
})

// ------------------------------------------------------------
// word_read_paragraph_range
// ------------------------------------------------------------

describe('word_read_paragraph_range', () => {
  it('returns a text slice covering [start, end] inclusive', async () => {
    const out = parseOutput<{ text: string; returnedCount: number; totalBlocks: number }>(
      await run('word_read_paragraph_range', { filePath: 'small.docx', start: 2, end: 3 }),
    )
    expect(out.totalBlocks).toBe(6)
    expect(out.returnedCount).toBe(2)
    expect(out.text).toContain('Section 1')
    expect(out.text).toContain('keyword foo')
    expect(out.text).not.toContain('Section 2')
  })

  it('returns html format when requested', async () => {
    const out = parseOutput<{ html: string }>(
      await run('word_read_paragraph_range', { filePath: 'small.docx', start: 1, end: 1, format: 'html' }),
    )
    expect(out.html).toMatch(/<h1>.*Report Title.*<\/h1>/)
  })

  it('returns structured format with index + type per paragraph', async () => {
    const out = parseOutput<{ paragraphs: Array<{ index: number; type: string; level?: number }> }>(
      await run('word_read_paragraph_range', { filePath: 'small.docx', start: 1, end: 2, format: 'structured' }),
    )
    expect(out.paragraphs).toHaveLength(2)
    expect(out.paragraphs[0]).toMatchObject({ index: 1, type: 'heading', level: 1 })
    expect(out.paragraphs[1]).toMatchObject({ index: 2, type: 'heading', level: 2 })
  })

  it('returns empty paragraphs when start is past the end of the doc', async () => {
    const out = parseOutput<{ paragraphs?: unknown[]; note?: string }>(
      await run('word_read_paragraph_range', { filePath: 'small.docx', start: 999, end: 1000, format: 'structured' }),
    )
    expect(out.paragraphs).toEqual([])
    expect(out.note).toMatch(/beyond/i)
  })

  it('rejects ranges that exceed the per-call paragraph cap', async () => {
    const res = await run('word_read_paragraph_range', { filePath: 'small.docx', start: 1, end: 1000 })
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/exceeds limit/i)
  })

  it('rejects start < 1', async () => {
    const res = await run('word_read_paragraph_range', { filePath: 'small.docx', start: 0 })
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/start.*positive integer/i)
  })
})

// ------------------------------------------------------------
// word_search
// ------------------------------------------------------------

describe('word_search', () => {
  it('locates literal hits with paragraph index and context', async () => {
    const out = parseOutput<{
      hitCount: number
      truncated: boolean
      hits: Array<{ paragraphIndex: number; match: string; context: string }>
    }>(await run('word_search', { filePath: 'small.docx', query: 'foo' }))

    expect(out.hitCount).toBe(2)
    expect(out.truncated).toBe(false)
    // Body paragraphs at index 3 and 6.
    expect(out.hits.map((h) => h.paragraphIndex).sort()).toEqual([3, 6])
    expect(out.hits[0].context.toLowerCase()).toContain('foo')
  })

  it('respects caseSensitive=true', async () => {
    const out = parseOutput<{ hitCount: number }>(
      await run('word_search', { filePath: 'small.docx', query: 'FOO', caseSensitive: true }),
    )
    expect(out.hitCount).toBe(0)
  })

  it('honors regex=true', async () => {
    const out = parseOutput<{ hitCount: number; hits: Array<{ match: string }> }>(
      await run('word_search', { filePath: 'small.docx', query: 'foo|bar', regex: true }),
    )
    // 2 × foo + 1 × bar = 3 hits.
    expect(out.hitCount).toBe(3)
  })

  it('truncates at maxResults and reports truncated=true', async () => {
    const out = parseOutput<{ hitCount: number; truncated: boolean }>(
      await run('word_search', { filePath: 'small.docx', query: 'foo', maxResults: 1 }),
    )
    expect(out.hitCount).toBe(1)
    expect(out.truncated).toBe(true)
  })

  it('surfaces an actionable error for invalid regex', async () => {
    const res = await run('word_search', { filePath: 'small.docx', query: '(unclosed', regex: true })
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/invalid regex/i)
  })
})

// ------------------------------------------------------------
// Error paths
// ------------------------------------------------------------

describe('error handling', () => {
  it('reports a missing file with a structured error', async () => {
    const res = await run('word_read_text', { filePath: 'does-not-exist.docx' })
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/not found/i)
  })

  it('rejects an empty filePath', async () => {
    const res = await run('word_read_text', { filePath: '' })
    expect(res.success).toBe(false)
  })
})
