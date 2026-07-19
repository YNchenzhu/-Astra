/**
 * Advisory-warning channel on successful edits (2026-07):
 *
 *   1. replace_all substring-boundary collision — the `user` vs `username`
 *      trap (harness-write design D13). Warn with line numbers, never reject.
 *   2. new_string introducing a truncation-placeholder line — the lazy-edit
 *      variant of the data-loss pattern from hermes-agent #20849. Warn only;
 *      lines copied from the replaced region are never flagged.
 */

import { describe, it, expect } from 'vitest'
import {
  collectReplaceAllBoundaryCollisionWarning,
  computeFileEditResult,
  computeFileEditResultMulti,
  detectPlaceholderIntroducedByEdit,
} from './fileEditSemantics'

describe('collectReplaceAllBoundaryCollisionWarning', () => {
  it('flags an occurrence spliced inside a longer identifier, with the line number', () => {
    const content = 'const user = 1\nconst username = 2\n'
    const w = collectReplaceAllBoundaryCollisionWarning(content, 'user')
    expect(w).toBeTruthy()
    expect(w).toContain('line 2')
    expect(w).toMatch(/identifier/i)
  })

  it('returns null when every occurrence is word-bounded', () => {
    const content = 'const user = 1\nreturn user + 2\n'
    expect(collectReplaceAllBoundaryCollisionWarning(content, 'user')).toBeNull()
  })

  it('returns null when the needle itself has non-word boundaries (cannot splice)', () => {
    const content = 'a (user) b\nc (user)name d\n'
    expect(collectReplaceAllBoundaryCollisionWarning(content, '(user)')).toBeNull()
  })

  it('lists multiple collided lines', () => {
    const content = 'username\nuserId\nuser\n'
    const w = collectReplaceAllBoundaryCollisionWarning(content, 'user')
    expect(w).toContain('lines 1, 2')
  })
})

describe('detectPlaceholderIntroducedByEdit', () => {
  it('flags a comment-marker ellipsis line not present in the replaced region', () => {
    const w = detectPlaceholderIntroducedByEdit(
      'function f() {\n  doWork()\n  moreWork()\n}',
      'function f() {\n  // ... rest unchanged\n}',
    )
    expect(w).toBeTruthy()
    expect(w).toMatch(/placeholder/i)
    expect(w).toContain('rest unchanged')
  })

  it('flags an ellipsis + Chinese omission keyword without comment marker', () => {
    const w = detectPlaceholderIntroducedByEdit(
      '第一章 全文内容……',
      '第一章 新内容\n……其余内容保持不变\n',
    )
    expect(w).toBeTruthy()
  })

  it('does NOT flag a placeholder line the model faithfully copied from the replaced region', () => {
    const region = 'start\n// ... generated section ...\nend'
    const w = detectPlaceholderIntroducedByEdit(region, 'START\n// ... generated section ...\nend')
    expect(w).toBeNull()
  })

  it('does NOT flag a bare `...` line (Python Ellipsis / stub)', () => {
    expect(detectPlaceholderIntroducedByEdit('x = 1', 'class A:\n    ...\n')).toBeNull()
  })

  it('does NOT flag ordinary Chinese prose ellipses', () => {
    expect(
      detectPlaceholderIntroducedByEdit('他说："你好"', '他说："你好……再见……"\n心里想着别的。'),
    ).toBeNull()
  })

  it('does NOT flag spread/rest syntax', () => {
    expect(
      detectPlaceholderIntroducedByEdit('function f(a) {}', 'function f(...args) {\n  g(...args)\n}'),
    ).toBeNull()
  })
})

describe('computeFileEditResult — warnings channel', () => {
  it('replace_all success carries the boundary-collision warning', () => {
    const content = 'const user = 1\nconst username = 2\n'
    const r = computeFileEditResult(content, 'user', 'account', { replaceAll: true })
    expect(r.success).toBe(true)
    if (!r.success) return
    expect(r.newContent).toBe('const account = 1\nconst accountname = 2\n')
    expect(r.warnings?.some((w) => /identifier/i.test(w))).toBe(true)
  })

  it('clean replace_all success has no warnings field', () => {
    const content = 'const user = 1\nreturn user\n'
    const r = computeFileEditResult(content, 'user', 'account', { replaceAll: true })
    expect(r.success).toBe(true)
    if (!r.success) return
    expect(r.warnings).toBeUndefined()
  })

  it('single edit does NOT run the boundary check (uniqueness already reviewed)', () => {
    const content = 'const username = 2\n'
    const r = computeFileEditResult(content, 'const username = 2', 'const userLabel = 2')
    expect(r.success).toBe(true)
    if (!r.success) return
    expect(r.warnings).toBeUndefined()
  })

  it('single edit carries the placeholder-introduction warning', () => {
    const content = 'function f() {\n  doWork()\n  moreWork()\n}\n'
    const r = computeFileEditResult(
      content,
      'function f() {\n  doWork()\n  moreWork()\n}',
      'function f() {\n  // ... rest of the body unchanged\n}',
    )
    expect(r.success).toBe(true)
    if (!r.success) return
    expect(r.warnings?.some((w) => /placeholder/i.test(w))).toBe(true)
  })

  it('CRLF file: normalized-path edit still surfaces the placeholder warning', () => {
    const content = 'function f() {\r\n  doWork()\r\n}\r\n'
    const r = computeFileEditResult(
      content,
      'function f() {\n  doWork()\n}',
      'function f() {\n  # ... omitted ...\n}',
    )
    expect(r.success).toBe(true)
    if (!r.success) return
    expect(r.warnings?.some((w) => /placeholder/i.test(w))).toBe(true)
  })
})

describe('computeFileEditResultMulti — warnings propagate with edit index', () => {
  it('prefixes warnings with the originating edit number', () => {
    const content = 'const user = 1\nconst username = 2\nfooter\n'
    const r = computeFileEditResultMulti(content, [
      { oldString: 'footer', newString: 'FOOTER' },
      { oldString: 'user', newString: 'account', replaceAll: true },
    ])
    expect(r.success).toBe(true)
    if (!r.success) return
    expect(r.warnings?.length).toBeGreaterThan(0)
    expect(r.warnings![0]).toMatch(/^Edit #2:/)
  })

  it('clean batch has no warnings field', () => {
    const content = 'alpha\nbeta\n'
    const r = computeFileEditResultMulti(content, [
      { oldString: 'alpha', newString: 'ALPHA' },
      { oldString: 'beta', newString: 'BETA' },
    ])
    expect(r.success).toBe(true)
    if (!r.success) return
    expect(r.warnings).toBeUndefined()
  })
})
