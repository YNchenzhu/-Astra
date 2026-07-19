/**
 * Tests for `findLiteralUnicodeEscapeHint` — the "you wrote \uXXXX as a
 * literal 6-char sequence" diagnostic that fires from the "not found"
 * path inside `fileEditSemantics.ts`.
 *
 * Anchored to the real-world trace where an agent tried to replace a
 * curly right-quote `"` (U+201D) by sending `old_string: "\u201d"` as
 * a literal 6-char ASCII string, expected the tool to reverse-decode
 * it, then misdiagnosed the failure as "JSON double-escaped my input".
 */

import { describe, it, expect } from 'vitest'
import {
  computeFileEditResult,
  findLiteralUnicodeEscapeHint,
} from './fileEditSemantics'

describe('findLiteralUnicodeEscapeHint', () => {
  it('returns empty when old_string contains no Unicode escape literal', () => {
    const content = 'just some text'
    expect(findLiteralUnicodeEscapeHint(content, 'some text')).toBe('')
  })

  it('returns empty when the escape literal decodes but the decoded form is NOT in the file', () => {
    const content = 'hello world'
    expect(findLiteralUnicodeEscapeHint(content, '\\u201d')).toBe('')
  })

  it('fires when old_string is `\\u201d` and the file has the real "" (U+201D) character', () => {
    const content = 'curly quote here: \u201d done'
    const hint = findLiteralUnicodeEscapeHint(content, '\\u201d')
    expect(hint).toMatch(/literal/i)
    expect(hint).toMatch(/\\u201d/)
    expect(hint).toMatch(/U\+201D|U\+201d/i)
    expect(hint).toMatch(/does NOT decode|raw byte comparator/i)
  })

  it('fires for the brace-form \\u{XXXX}', () => {
    const content = 'curly quote: \u201d'
    const hint = findLiteralUnicodeEscapeHint(content, '\\u{201d}')
    expect(hint).toMatch(/literal/i)
    expect(hint).toMatch(/\\u\{201d\}/i)
  })

  it('fires when old_string contains the escape MIXED with normal text and the decoded form exists in the file', () => {
    const content = 'before "curly" \u201d after'
    const hint = findLiteralUnicodeEscapeHint(content, 'curly" \\u201d after')
    expect(hint).toMatch(/literal/i)
  })

  it('returns empty for an out-of-range \\u{...} codepoint (graceful, no throw)', () => {
    const content = 'whatever'
    expect(findLiteralUnicodeEscapeHint(content, '\\u{110000}')).toBe('')
  })
})

describe('computeFileEditResult — literal \\uXXXX auto-decode retry', () => {
  it('auto-decodes old_string AND new_string when the decoded old form matches the file', () => {
    const fileContent = 'line one\nLeft curly here: \u201cstart\u201d done\n'
    const r = computeFileEditResult(fileContent, '\\u201d', '\\u2019')
    expect(r.success).toBe(true)
    if (!r.success) return
    expect(r.newContent).toBe('line one\nLeft curly here: \u201cstart\u2019 done\n')
    // The literal 6-char escape text must never be inserted into the file.
    expect(r.newContent).not.toContain('\\u2019')
  })

  it('does NOT decode when the literal escape text genuinely exists in the file (source code)', () => {
    const fileContent = "const q = '\\u201d'\nconst other = 1\n"
    const r = computeFileEditResult(fileContent, "const q = '\\u201d'", "const q = '\\u2019'")
    expect(r.success).toBe(true)
    if (!r.success) return
    // Raw byte match wins — escape text preserved as code, not decoded to glyphs.
    expect(r.newContent).toBe("const q = '\\u2019'\nconst other = 1\n")
  })

  it('surfaces an actionable error when the decoded form matches multiple locations', () => {
    const fileContent = 'a \u201d b\nc \u201d d\n'
    const r = computeFileEditResult(fileContent, '\\u201d', 'X')
    expect(r.success).toBe(false)
    if (r.success) return
    expect(r.error).toMatch(/auto-decoded/i)
    expect(r.error).toMatch(/multiple times/i)
  })

  it('supports replaceAll on the decoded form', () => {
    const fileContent = 'a \u201d b\nc \u201d d\n'
    const r = computeFileEditResult(fileContent, '\\u201d', 'X', { replaceAll: true })
    expect(r.success).toBe(true)
    if (!r.success) return
    expect(r.newContent).toBe('a X b\nc X d\n')
  })

  it('falls back to the plain not-found error when the JSON-decoded form is not found either', () => {
    const fileContent = 'line one\nno curly quotes here\n'
    const r = computeFileEditResult(fileContent, '\\u201d', '\\u201c')
    expect(r.success).toBe(false)
    if (r.success) return
    expect(r.error).toContain('The old_string was not found in the file.')
    expect(r.error).not.toMatch(/raw byte comparator/i)
  })
})

describe('findLiteralUnicodeEscapeHint — corrected-value preview', () => {
  it('includes a copy-paste-ready decoded old_string with real glyphs', () => {
    const content = 'curly quote here: \u201d done'
    const hint = findLiteralUnicodeEscapeHint(content, '\\u201d')
    expect(hint).toContain('"old_string": "\u201d"')
  })

  it('never recommends writing the escape inside the JSON string (the double-escape trap)', () => {
    const content = 'curly quote here: \u201d done'
    const hint = findLiteralUnicodeEscapeHint(content, '\\u201d')
    expect(hint).not.toMatch(/INSIDE the JSON string/i)
  })
})

describe('computeFileEditResult — redundant JSON-string escape recovery', () => {
  it('recovers literal backslashes before quotes from a structured tool field', () => {
    const fileContent = '| 世界 | "不在天道之内"的真正含义 | 3 | 28 |\n'
    const oldString = '| 世界 | \\"不在天道之内\\"的真正含义 | 3 | 28 |'
    const newString = '| 世界 | \\"不在天道之外\\"的真正含义 | 3 | 28 |'

    const result = computeFileEditResult(fileContent, oldString, newString)
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.newContent).toBe('| 世界 | "不在天道之外"的真正含义 | 3 | 28 |\n')
    expect(result.newContent).not.toContain('\\"')
    expect(result.warnings?.some((warning) => warning.includes('JSON string escapes'))).toBe(true)
  })

  it('recovers literal newline escapes when the raw old_string is absent', () => {
    const result = computeFileEditResult('alpha\nbeta\n', 'alpha\\nbeta', 'alpha\\nBETA')
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.newContent).toBe('alpha\nBETA\n')
  })

  it('decodes only JSON escape kinds proven by old_string', () => {
    const result = computeFileEditResult(
      'title: "old"\n',
      'title: \\"old\\"',
      'title: \\"new\\" and literal \\n',
    )
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.newContent).toBe('title: "new" and literal \\n\n')
  })

  it('keeps literal escape text when the raw form genuinely exists in source', () => {
    const fileContent = 'const encoded = \\"value\\"\n'
    const result = computeFileEditResult(
      fileContent,
      'const encoded = \\"value\\"',
      'const encoded = \\"next\\"',
    )
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.newContent).toBe('const encoded = \\"next\\"\n')
  })

  it('surfaces decoded-form ambiguity instead of applying an unsafe match', () => {
    const result = computeFileEditResult('"x"\n"x"\n', '\\"x\\"', 'Y')
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error).toMatch(/auto-decoded/i)
    expect(result.error).toMatch(/multiple times/i)
  })

})
