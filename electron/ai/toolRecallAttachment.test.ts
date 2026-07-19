import { describe, it, expect } from 'vitest'
import {
  buildRecallSuccessResult,
  executeRecallAttachment,
  type RecallCacheGetFn,
} from './toolRecallAttachment'
import type { IngestedAttachment } from '../attachments/types'

/**
 * Build a fake `cacheGet` that returns a fixed mapping. Tests use this
 * instead of touching the real on-disk cache (`electron/attachments/cache.ts`)
 * which depends on Electron's `app.getPath` and is unsuitable for unit tests.
 */
function fakeCacheGet(table: Record<string, IngestedAttachment>): RecallCacheGetFn {
  return async (sha, kind) => table[`${sha}:${kind}`] ?? null
}

describe('executeRecallAttachment', () => {
  it('rejects empty sha256 with a clear, actionable error', async () => {
    const result = await executeRecallAttachment(
      { sha256: '   ', kind: 'image' },
      fakeCacheGet({}),
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('sha256')
    expect(result.error).toContain('kind')
    expect(result.toolErrorClass).toBe('invalid_input')
  })

  it('rejects empty kind', async () => {
    const result = await executeRecallAttachment(
      { sha256: 'abc', kind: '' },
      fakeCacheGet({}),
    )
    expect(result.success).toBe(false)
    expect(result.toolErrorClass).toBe('invalid_input')
  })

  it('returns a clear cache-miss error when the entry is not present', async () => {
    const result = await executeRecallAttachment(
      { sha256: 'no-such-sha', kind: 'image' },
      fakeCacheGet({}),
    )
    expect(result.success).toBe(false)
    expect(result.toolErrorClass).toBe('cache_miss')
    // Error must hint at the operator action (re-attach), not encourage retries.
    expect(result.error).toMatch(/re-attach|re-paste|ask the user/i)
    // sha + kind echoed so the model can compare to the recall-pointer attrs.
    expect(result.error).toContain('no-such-sha')
    expect(result.error).toContain('image')
  })

  it('surfaces an underlying cacheGet exception as a structured tool error', async () => {
    const result = await executeRecallAttachment(
      { sha256: 'sha-1', kind: 'image' },
      async () => {
        throw new Error('disk borked')
      },
    )
    expect(result.success).toBe(false)
    expect(result.toolErrorClass).toBe('cache_read_error')
    expect(result.error).toContain('disk borked')
  })

  it('returns a single image content block on a clipboard-paste recall', async () => {
    const cached: IngestedAttachment = {
      type: 'image',
      name: 'old-screenshot.png',
      base64: 'PNG_BYTES_HERE',
      mediaType: 'image/png',
      size: 12_345,
      sha256: 'sha-img-1',
    }
    const result = await executeRecallAttachment(
      { sha256: 'sha-img-1', kind: 'image' },
      fakeCacheGet({ 'sha-img-1:image': cached }),
    )
    expect(result.success).toBe(true)
    expect(result.contentBlocks).toBeDefined()
    expect(result.contentBlocks).toHaveLength(1)
    const block = result.contentBlocks![0]
    expect(block.type).toBe('image')
    expect(block.base64).toBe('PNG_BYTES_HERE')
    expect(block.mediaType).toBe('image/png')
    expect(block.originalSize).toBe(12_345)
    expect(result.output).toContain('old-screenshot.png')
    expect(result.output).toContain('12345 bytes')
  })

  it('returns PDF + page-image blocks together for a PDF file recall', async () => {
    const cached: IngestedAttachment = {
      type: 'file',
      name: 'spec.pdf',
      path: '/tmp/spec.pdf',
      size: 50_000,
      kind: 'pdf',
      mimeType: 'application/pdf',
      sha256: 'sha-pdf',
      status: 'ready',
      pdf: { base64: 'PDF_BYTES', pageCount: 3, sizeBytes: 50_000, oversized: false },
      pageImages: [
        { page: 1, base64: 'P1', mediaType: 'image/jpeg', source: 'pdftoppm' },
        { page: 2, base64: 'P2', mediaType: 'image/jpeg', source: 'pdftoppm' },
      ],
    }
    const result = await executeRecallAttachment(
      { sha256: 'sha-pdf', kind: 'pdf' },
      fakeCacheGet({ 'sha-pdf:pdf': cached }),
    )
    expect(result.success).toBe(true)
    expect(result.contentBlocks).toBeDefined()
    expect(result.contentBlocks).toHaveLength(3) // 1 pdf + 2 page images
    expect(result.contentBlocks![0].type).toBe('pdf')
    expect(result.contentBlocks![1].type).toBe('image')
    expect(result.contentBlocks![2].type).toBe('image')
    expect(result.output).toContain('spec.pdf')
    expect(result.output).toContain('3 pages')
    expect(result.output).toContain('2 page image(s)')
  })

  it('returns inline images + truncated text for a docx recall', async () => {
    const longText = 'A'.repeat(8000) // > 4 KB → must be truncated in output
    const cached: IngestedAttachment = {
      type: 'file',
      name: 'report.docx',
      path: '/tmp/report.docx',
      size: 20_000,
      kind: 'docx',
      mimeType:
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      sha256: 'sha-docx',
      status: 'ready',
      text: { content: longText, truncated: false, originalChars: longText.length },
      inlineImages: [
        { base64: 'IMG_A', mediaType: 'image/png' },
        { base64: 'IMG_B', mediaType: 'image/jpeg', altText: 'fig 2' },
      ],
    }
    const result = await executeRecallAttachment(
      { sha256: 'sha-docx', kind: 'docx' },
      fakeCacheGet({ 'sha-docx:docx': cached }),
    )
    expect(result.success).toBe(true)
    expect(result.contentBlocks).toHaveLength(2)
    expect(result.contentBlocks![0].base64).toBe('IMG_A')
    expect(result.contentBlocks![1].base64).toBe('IMG_B')
    // Output text is bounded to 4 KB + truncation marker — recall must not
    // dump 80 KB of extracted text into the loop's reply budget.
    expect(result.output).toContain('truncated')
    expect(result.output).toContain('Text content: 8000 chars')
    // The actual truncation kicked in (we don't see the entire 8000 As).
    expect(result.output!.length).toBeLessThan(longText.length)
  })

  it('returns no content blocks for a text-only file recall (just summary)', async () => {
    const cached: IngestedAttachment = {
      type: 'file',
      name: 'notes.txt',
      path: '/tmp/notes.txt',
      size: 50,
      kind: 'text',
      mimeType: 'text/plain',
      sha256: 'sha-txt',
      status: 'ready',
      text: { content: 'plain notes', truncated: false, originalChars: 11 },
    }
    const result = await executeRecallAttachment(
      { sha256: 'sha-txt', kind: 'text' },
      fakeCacheGet({ 'sha-txt:text': cached }),
    )
    expect(result.success).toBe(true)
    // No binary → no content blocks (text rides through `output` only).
    expect(result.contentBlocks).toBeUndefined()
    expect(result.output).toContain('plain notes')
  })

  it('trims whitespace on inputs before the cache lookup', async () => {
    // Models occasionally echo back whitespace from the recall-pointer
    // attribute — defensive trim avoids a spurious cache miss for what
    // is otherwise the right key.
    const cached: IngestedAttachment = {
      type: 'image',
      name: 'a.png',
      base64: 'A',
      mediaType: 'image/png',
      size: 1,
      sha256: 'sha-trim',
    }
    const result = await executeRecallAttachment(
      { sha256: '  sha-trim  ', kind: '\timage' },
      fakeCacheGet({ 'sha-trim:image': cached }),
    )
    expect(result.success).toBe(true)
    expect(result.contentBlocks![0].base64).toBe('A')
  })
})

describe('buildRecallSuccessResult (direct shape assertions)', () => {
  it('preserves file name + kind in the output header', () => {
    const result = buildRecallSuccessResult({
      type: 'file',
      name: 'a.pdf',
      path: '/tmp/a.pdf',
      size: 100,
      kind: 'pdf',
      mimeType: 'application/pdf',
      sha256: 's',
      status: 'ready',
      pdf: { base64: 'B', pageCount: 1, sizeBytes: 100, oversized: false },
    })
    expect(result.output).toMatch(/^Recalled file attachment "a.pdf"/)
    expect(result.contentBlocks).toHaveLength(1)
    expect(result.contentBlocks![0].type).toBe('pdf')
  })
})
