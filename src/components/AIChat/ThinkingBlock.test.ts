/**
 * Unit tests for the `parseReasoningSections` helper that powers the
 * long-reasoning navigation UI in `<ThinkingBlock>`.
 *
 * Scope: parser only. The component itself depends on `react-markdown`
 * (heavy DOM render in jsdom) and is exercised indirectly via the
 * existing `AgentBlock.test.ts` / `ChatMessage` end-to-end paths. This
 * file targets the small, pure piece that decides whether to switch
 * from flat to sectioned rendering and how the slices look.
 */

import { describe, expect, it } from 'vitest'

import { formatThinkingTokens, parseReasoningSections } from './ThinkingBlock'

// Helper: pad short bodies up to the threshold so the parser doesn't
// early-return on length. Production headings carry meaningful bodies;
// we keep the test fixtures readable by stuffing prose to size.
function pad(s: string, targetLen = 1700): string {
  if (s.length >= targetLen) return s
  const filler = '\nadditional context paragraph for length padding.'
  while (s.length < targetLen) s += filler
  return s
}

describe('parseReasoningSections', () => {
  it('returns null for content below the length threshold even with multiple headings', () => {
    const short = `## Step 1\nshort body\n## Step 2\nshort body`
    expect(parseReasoningSections(short)).toBeNull()
  })

  it('returns null when content is long but lacks H2/H3 structure', () => {
    const flat = pad('Just a long stream of thought with no headings whatsoever.\n')
    expect(parseReasoningSections(flat)).toBeNull()
  })

  it('returns null when only one heading is present (treat as still flat)', () => {
    const oneHeading = pad('## Plan\n' + 'body line\n'.repeat(50))
    expect(parseReasoningSections(oneHeading)).toBeNull()
  })

  it('splits on H2 + H3 once two or more headings clear the length bar', () => {
    const content =
      '## Plan\n' +
      'planning body sentence with enough length to count\n'.repeat(20) +
      '\n## Verification\n' +
      'verification body sentence with enough length to count\n'.repeat(20)
    const sections = parseReasoningSections(content)
    expect(sections).not.toBeNull()
    expect(sections).toHaveLength(2)
    expect(sections![0].heading).toBe('Plan')
    expect(sections![0].level).toBe(2)
    expect(sections![1].heading).toBe('Verification')
    expect(sections![1].level).toBe(2)
    expect(sections![0].body).toContain('planning body')
    expect(sections![1].body).toContain('verification body')
  })

  it('surfaces content before the first heading as a synthetic "前言" lead-in', () => {
    const content =
      'High-level intro that the model wrote before any heading.\n'.repeat(15) +
      '## Step 1\n' +
      'step one body sentence with sufficient text\n'.repeat(10) +
      '## Step 2\n' +
      'step two body sentence with sufficient text\n'.repeat(10)
    const sections = parseReasoningSections(content)
    expect(sections).not.toBeNull()
    // 前言 + Step 1 + Step 2
    expect(sections).toHaveLength(3)
    expect(sections![0].heading).toBe('前言')
    expect(sections![0].body).toContain('High-level intro')
    expect(sections![1].heading).toBe('Step 1')
    expect(sections![2].heading).toBe('Step 2')
  })

  it('does not split on `## comment` lines that live inside a fenced code block', () => {
    const content =
      '## Real Heading\n' +
      'before code paragraph with adequate prose length to be realistic\n'.repeat(15) +
      '```python\n' +
      '## not a heading — this is a code comment in python\n' +
      'def hello():\n    pass\n' +
      '```\n' +
      'after code paragraph with adequate prose length to be realistic\n'.repeat(15) +
      '## Second Real Heading\n' +
      'tail body paragraph with adequate prose length to be realistic\n'.repeat(15)
    const sections = parseReasoningSections(content)
    expect(sections).not.toBeNull()
    expect(sections!.map((s) => s.heading)).toEqual([
      'Real Heading',
      'Second Real Heading',
    ])
    // The code block (including the `## not a heading` line) lands in the
    // first section's body verbatim, not as a phantom split.
    expect(sections![0].body).toContain('## not a heading')
    expect(sections![0].body).toContain('def hello()')
  })

  it('treats H3 the same as H2 for splitting (both count as section breaks)', () => {
    const content =
      '### Detail A\n' +
      'a body sentence of typical reasoning length and detail\n'.repeat(20) +
      '### Detail B\n' +
      'b body sentence of typical reasoning length and detail\n'.repeat(20)
    const sections = parseReasoningSections(content)
    expect(sections).not.toBeNull()
    expect(sections).toHaveLength(2)
    expect(sections![0].level).toBe(3)
    expect(sections![1].level).toBe(3)
  })

  it('records a body line count so the summary can preview section size', () => {
    const content =
      '## A\n' +
      Array(50).fill('a line of reasoning prose with realistic length').join('\n') +
      '\n## B\n' +
      Array(60).fill('b line of reasoning prose with realistic length').join('\n')
    const sections = parseReasoningSections(content)
    expect(sections).not.toBeNull()
    // Line counts are approximate — derived from `body.split('\n').length`
    // after trimming, so we assert "in the right ballpark" rather than
    // exact, which would couple the test to incidental whitespace
    // handling.
    expect(sections![0].lineCount).toBeGreaterThanOrEqual(40)
    expect(sections![1].lineCount).toBeGreaterThanOrEqual(50)
  })

})

describe('formatThinkingTokens', () => {
  it('returns empty string for non-positive or non-finite inputs', () => {
    expect(formatThinkingTokens(undefined)).toBe('')
    expect(formatThinkingTokens(0)).toBe('')
    expect(formatThinkingTokens(-5)).toBe('')
    expect(formatThinkingTokens(NaN)).toBe('')
    expect(formatThinkingTokens(Infinity)).toBe('')
  })

  it('renders three-digit-or-less counts verbatim', () => {
    expect(formatThinkingTokens(1)).toBe('1')
    expect(formatThinkingTokens(42)).toBe('42')
    expect(formatThinkingTokens(999)).toBe('999')
  })

  it('renders 1000…9999 with one decimal `k`', () => {
    expect(formatThinkingTokens(1000)).toBe('1.0k')
    expect(formatThinkingTokens(1234)).toBe('1.2k')
    expect(formatThinkingTokens(9999)).toBe('10.0k')
  })

  it('renders ≥10000 with rounded `k` (no decimal)', () => {
    expect(formatThinkingTokens(10000)).toBe('10k')
    expect(formatThinkingTokens(12500)).toBe('13k')
    expect(formatThinkingTokens(123456)).toBe('123k')
  })
})

describe('parseReasoningSections (cont.)', () => {
  it('handles consecutive headings (empty body sections) without crashing', () => {
    const content =
      'lead-in body paragraph with realistic length and prose\n'.repeat(15) +
      '## Empty 1\n' +
      '## Empty 2\n' +
      'body of two paragraph with realistic length and prose\n'.repeat(20)
    const sections = parseReasoningSections(content)
    expect(sections).not.toBeNull()
    // 前言 + 2 headings (one with empty body, one with body)
    expect(sections!.length).toBe(3)
    expect(sections![1].heading).toBe('Empty 1')
    expect(sections![1].body).toBe('')
    expect(sections![1].lineCount).toBe(0)
    expect(sections![2].heading).toBe('Empty 2')
    expect(sections![2].body).toContain('body of two')
  })
})
