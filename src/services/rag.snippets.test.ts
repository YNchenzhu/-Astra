import { describe, expect, it } from 'vitest'
import { ragHitsToSnippets, type RagHit } from './rag'

function hit(over: Partial<RagHit> = {}): RagHit {
  return { text: 'chunk text', score: 0.5, namespace: 'att-x-abc', ...over }
}

describe('ragHitsToSnippets', () => {
  it('returns [] for no hits', () => {
    expect(ragHitsToSnippets([])).toEqual([])
  })

  it('maps text into lines and matchCount 1', () => {
    const [s] = ragHitsToSnippets([hit({ text: 'hello body' })])
    expect(s.lines).toBe('hello body')
    expect(s.matchCount).toBe(1)
  })

  it('uses attachmentName in the synthetic path', () => {
    const [s] = ragHitsToSnippets([hit({ meta: { attachmentName: 'spec.pdf' } })])
    expect(s.filePath).toBe('attachment://spec.pdf')
    expect(s.relativePath).toBe('spec.pdf')
  })

  it('appends a heading breadcrumb when present', () => {
    const [s] = ragHitsToSnippets([
      hit({ meta: { attachmentName: 'spec.pdf', headingPath: 'Intro > Goals' } }),
    ])
    expect(s.relativePath).toBe('spec.pdf § Intro > Goals')
    expect(s.filePath).toBe('attachment://spec.pdf § Intro > Goals')
  })

  it('falls back to "attachment" when name missing', () => {
    const [s] = ragHitsToSnippets([hit({ meta: {} })])
    expect(s.relativePath).toBe('attachment')
  })

  it('preserves order and count across multiple hits', () => {
    const out = ragHitsToSnippets([
      hit({ text: 'a', meta: { attachmentName: 'a.pdf' } }),
      hit({ text: 'b', meta: { attachmentName: 'b.pdf' } }),
    ])
    expect(out.map((s) => s.lines)).toEqual(['a', 'b'])
  })
})
