/**
 * Tests for the Unicode-aware "identical strings" diagnostic added to
 * `validateEditTool.ts`. Pinned to the real-world failure mode of an
 * agent trying to convert ASCII `"` to curly `"`/`"` and accidentally
 * sending two byte-identical sides because JSON only carries the
 * literal bytes the model typed.
 */

import { describe, it, expect } from 'vitest'
import {
  describeIdenticalEditPayload,
  validateEditToolPayload,
  validateMultiEditToolPayload,
} from './validateEditTool'

describe('describeIdenticalEditPayload', () => {
  it('returns empty string for an empty input (the both-empty case has its own message)', () => {
    expect(describeIdenticalEditPayload('')).toBe('')
  })

  it('lists codepoints so the agent can see exactly what bytes it sent', () => {
    const out = describeIdenticalEditPayload('"')
    expect(out).toMatch(/U\+0022/)
    expect(out).toMatch(/codepoints/i)
  })

  it('mentions the JSON look-alike pitfall when input is pure ASCII (e.g. straight quote)', () => {
    const out = describeIdenticalEditPayload('"')
    expect(out).toMatch(/U\+201C|U\+201D|curly/i)
    expect(out).toMatch(/JSON/)
  })

  it("covers ASCII single-quote -> curly single-quote confusable", () => {
    const out = describeIdenticalEditPayload("'")
    expect(out).toMatch(/U\+2018|U\+2019|curly/i)
  })

  it('covers ASCII hyphen vs en/em-dash confusable', () => {
    const out = describeIdenticalEditPayload('-')
    expect(out).toMatch(/U\+2013|U\+2014|dash/i)
  })

  it('mentions the literal \\uXXXX anti-pattern when both sides contain a Unicode escape literal', () => {
    const out = describeIdenticalEditPayload('\\u201d')
    expect(out).toMatch(/literal/i)
    expect(out).toMatch(/\\u/)
    expect(out).toMatch(/does not decode|do not|NOT/i)
  })

  it('also matches the brace-form \\u{XXXX} literal', () => {
    const out = describeIdenticalEditPayload('\\u{201d}')
    expect(out).toMatch(/literal/i)
    expect(out).toMatch(/\\u/)
  })

  it('truncates very long payloads in the preview', () => {
    const long = 'a'.repeat(200)
    const out = describeIdenticalEditPayload(long)
    expect(out).toContain('…')
  })
})

describe('validateEditToolPayload — identical strings produces enriched diagnostic', () => {
  it('upgrades the legacy "identical" error with codepoints and the curly-quote hint', () => {
    const r = validateEditToolPayload({
      filePath: '/tmp/foo.md',
      oldString: '"',
      newString: '"',
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.message).toContain('No changes to make: oldString and newString are identical.')
    expect(r.message).toMatch(/U\+0022/)
    expect(r.message).toMatch(/curly|U\+201[CD]/i)
  })

  it('handles the literal \\uXXXX-on-both-sides trap', () => {
    const r = validateEditToolPayload({
      filePath: '/tmp/foo.md',
      oldString: '\\u201d',
      newString: '\\u201d',
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.message).toMatch(/literal/i)
    expect(r.message).toMatch(/JSON parser/i)
  })

  it('still emits the legacy phrasing for backwards compatibility with downstream parsers', () => {
    const r = validateEditToolPayload({
      filePath: '/tmp/foo.md',
      oldString: 'a',
      newString: 'a',
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.message.startsWith('No changes to make: oldString and newString are identical.')).toBe(true)
  })
})

describe('validateMultiEditToolPayload — identical strings produces enriched diagnostic per-entry', () => {
  it('attaches the diagnostic to the offending edits[i] entry', () => {
    const r = validateMultiEditToolPayload({
      filePath: '/tmp/foo.md',
      edits: [
        { oldString: 'good', newString: 'better' },
        { oldString: '"', newString: '"' },
      ],
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.message).toMatch(/edits\[1\]/)
    expect(r.message).toMatch(/U\+0022/)
    expect(r.message).toMatch(/curly|look-alike/i)
  })
})
