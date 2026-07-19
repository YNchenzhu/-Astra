/**
 * Whitespace-tolerant fallback tier (2026-07 drift elimination).
 *
 * Covers the residual "old_string not found" class caused by the model
 * recomposing the target from memory with whitespace drift: tab↔space
 * swaps, whole-block indent shifts, lost trailing spaces, NBSP / fullwidth
 * spaces, and collapsed internal space runs. Also covers the safety
 * guarantees: unique-match requirement, replace_all exemption, and the
 * gate/applier agreement via editOldStringLocatable.
 */
import { describe, expect, it } from 'vitest'
import {
  computeFileEditResult,
  editOldStringLocatable,
  getEditAffectedLineBounds1Based,
} from './fileEditSemantics'

describe('whitespace-tolerant edit fallback', () => {
  it('applies when the model lost a trailing space present on disk', () => {
    const content = 'const a = 1; \nconst b = 2;\n'
    const r = computeFileEditResult(content, 'const a = 1;\nconst b = 2;', 'const a = 10;\nconst b = 2;')
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.newContent).toContain('const a = 10;')
      expect(r.warnings?.some((w) => w.includes('whitespace-normalized'))).toBe(true)
    }
  })

  it('applies when disk uses tabs and the model transcribed spaces (indent dictionary remap)', () => {
    const content = 'function f() {\n\tif (x) {\n\t\treturn 1\n\t}\n}\n'
    const r = computeFileEditResult(
      content,
      'function f() {\n    if (x) {\n        return 1\n    }\n}',
      'function f() {\n    if (x) {\n        return 2\n    }\n}',
    )
    expect(r.success).toBe(true)
    if (r.success) {
      // Inserted lines must adopt the file's REAL tab indentation.
      expect(r.newContent).toBe('function f() {\n\tif (x) {\n\t\treturn 2\n\t}\n}\n')
    }
  })

  it('applies when the model shifted the whole block by one indent level (uniform re-indent)', () => {
    const content = 'class A {\n    method() {\n        return 1\n    }\n}\n'
    // Model dropped 4 leading spaces on every line.
    const r = computeFileEditResult(
      content,
      'method() {\n    return 1\n}',
      'method() {\n    return 2\n}',
    )
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.newContent).toBe('class A {\n    method() {\n        return 2\n    }\n}\n')
    }
  })

  it('applies when disk contains NBSP but the model typed a regular space', () => {
    const content = 'title:\u00A0hello world\n'
    const r = computeFileEditResult(content, 'title: hello world', 'title: goodbye world')
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.newContent).toBe('title: goodbye world\n')
    }
  })

  it('applies when internal space runs were collapsed by the model', () => {
    const content = 'foo(a,   b)\nbar()\n'
    const r = computeFileEditResult(content, 'foo(a, b)\nbar()', 'foo(a, b, c)\nbar()')
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.newContent).toContain('foo(a, b, c)')
    }
  })

  it('rejects with an ambiguity error when the normalized form matches twice', () => {
    const content = 'if (x) {\n\treturn 1\n}\nif (x) {\n  return 1\n}\n'
    const r = computeFileEditResult(content, 'if (x) {\n    return 1\n}', 'if (x) {\n    return 9\n}')
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error).toContain('whitespace-normalized form matches 2 locations')
    }
  })

  it('never fuzzy-matches a whitespace-only old_string', () => {
    const content = 'a\n\n\nb\n'
    const r = computeFileEditResult(content, '  \t  ', 'X')
    expect(r.success).toBe(false)
  })

  it('does not apply the whitespace tier for replace_all', () => {
    const content = '\tvalue = 1\n\tvalue = 1\n'
    const r = computeFileEditResult(content, '  value = 1', '  value = 2', { replaceAll: true })
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error).toContain('was not found')
    }
  })

  it('exact matches still take precedence (no warning, byte-exact path)', () => {
    const content = 'const a = 1;\nconst a = 1; \n'
    // Exact match exists at line 1 — must NOT be routed through the ws tier
    // (which would see 2 normalized matches and reject as ambiguous).
    const r = computeFileEditResult(content, 'const a = 1;\n', 'const a = 2;\n')
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.newContent).toBe('const a = 2;\nconst a = 1; \n')
      expect(r.warnings ?? []).toEqual([])
    }
  })

  it('deletion (empty new_string) removes the matched line cleanly', () => {
    const content = 'keep1\n\tdrop me\nkeep2\n'
    const r = computeFileEditResult(content, '  drop me', '')
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.newContent).toBe('keep1\nkeep2\n')
    }
  })

  it('preserves CRLF line endings of the surrounding file', () => {
    const content = 'line1\r\n\tif (x) {\r\n\t\treturn 1\r\n\t}\r\nline5\r\n'
    const r = computeFileEditResult(
      content,
      'if (x) {\n    return 1\n}',
      'if (x) {\n    return 2\n}',
    )
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.newContent).toContain('line1\r\n')
      expect(r.newContent).toContain('return 2\r\n')
      expect(r.newContent).toContain('line5\r\n')
    }
  })
})

describe('editOldStringLocatable (gate/applier agreement)', () => {
  it('accepts exact, drift-canonical, and whitespace-tolerant payloads', () => {
    const content = '\tconst msg = \u201Chello\u201D;\n'
    expect(editOldStringLocatable(content, '\tconst msg = \u201Chello\u201D;')).toBe(true)
    // curly→straight quote drift
    expect(editOldStringLocatable(content, '\tconst msg = "hello";')).toBe(true)
    // tab→space indent drift
    expect(editOldStringLocatable(content, '    const msg = "hello";')).toBe(true)
  })

  it('rejects text that is genuinely absent', () => {
    expect(editOldStringLocatable('alpha\nbeta\n', 'gamma')).toBe(false)
  })

  it('accepts redundant JSON quote escapes when the decoded text is visible', () => {
    const content = '| 世界 | "不在天道之内"的真正含义 |\n'
    expect(editOldStringLocatable(content, '| 世界 | \\"不在天道之内\\"的真正含义 |')).toBe(true)
  })
})

describe('getEditAffectedLineBounds1Based whitespace branch', () => {
  it('requires a full read when the match is whitespace-tolerant only', () => {
    const content = '\tvalue = 1\nother\n'
    const b = getEditAffectedLineBounds1Based(content, '  value = 1', '  value = 2')
    expect(b.ok).toBe(true)
    if (b.ok) {
      expect(b.requiresFullRead).toBe(true)
    }
  })
})
