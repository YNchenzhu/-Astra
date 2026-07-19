import { describe, expect, it } from 'vitest'
import { chunkText } from './ragChunker'

const MAX = 2400
const OVERLAP = 180

describe('chunkText basics', () => {
  it('returns [] for empty/whitespace input', () => {
    expect(chunkText('')).toEqual([])
  })

  it('keeps short text as a single chunk', () => {
    const out = chunkText('hello world')
    expect(out).toHaveLength(1)
    expect(out[0].text).toBe('hello world')
    expect(out[0].index).toBe(0)
  })

  it('preserves index ordering', () => {
    const text = Array.from({ length: 20 }, (_, i) => `Paragraph number ${i} ` + 'x'.repeat(200)).join('\n\n')
    const out = chunkText(text)
    expect(out.map((c) => c.index)).toEqual(out.map((_, i) => i))
  })

  it('tracks markdown heading breadcrumb', () => {
    const text = `# Title\n\n## Section\n\n${'body '.repeat(400)}`
    const out = chunkText(text)
    const withCrumb = out.find((c) => c.meta.headingPath)
    expect(withCrumb?.meta.headingPath).toContain('Title')
  })
})

describe('chunkText size guarantee (documented: never exceeds MAX)', () => {
  // Regression guard for the overlap-tail + near-MAX-paragraph overflow:
  // flush() now hard-caps every emitted chunk at MAX by slicing an oversized
  // buffer (see ragChunker.ts). Previously these produced 2482 / 2431 chars.
  it('never emits a chunk longer than MAX, even with overlap on near-MAX paragraphs', () => {
    const para = 'a'.repeat(2300)
    const text = `${para}\n\n${para}`
    const out = chunkText(text)
    const over = out.map((c) => c.text.length).filter((l) => l > MAX)
    expect(over).toEqual([])
  })

  it('respects MAX across a long multi-paragraph document', () => {
    const text = Array.from({ length: 30 }, () => 'word '.repeat(450)).join('\n\n')
    const out = chunkText(text)
    for (const c of out) {
      expect(c.text.length).toBeLessThanOrEqual(MAX)
    }
  })

  it('preserves full content coverage when an oversized buffer is split', () => {
    // The two-paragraph near-MAX case splits the second buffer; ensure no
    // characters are DROPPED by the hard cap. Counts are >= source because the
    // overlap feature intentionally duplicates up to OVERLAP trailing chars
    // into the following chunk's seed.
    const text = `${'a'.repeat(2300)}\n\n${'b'.repeat(2300)}`
    const out = chunkText(text)
    const joined = out.map((c) => c.text).join('')
    expect(joined.match(/a/g)?.length ?? 0).toBeGreaterThanOrEqual(2300)
    expect(joined.match(/b/g)?.length ?? 0).toBeGreaterThanOrEqual(2300)
  })
})

describe('chunkText overlap', () => {
  it('overlaps consecutive chunks by ~OVERLAP chars when content is large', () => {
    const text = Array.from({ length: 10 }, (_, i) => `S${i} ` + 'x'.repeat(400)).join('\n\n')
    const out = chunkText(text)
    if (out.length >= 2) {
      // The tail of chunk[0] should appear at the head of chunk[1].
      const tail = out[0].text.slice(-OVERLAP)
      expect(out[1].text.startsWith(tail.slice(0, 50))).toBe(true)
    }
  })
})
