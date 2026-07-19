/**
 * Self-audit fix B3 (2026-05) — pins G12 + A1 policy:
 *  - empty / undefined requested path resolves to the trusted workspace
 *  - matching requested path is accepted
 *  - any other path is rejected with a clear reason (handler throws)
 *  - case-insensitive Windows resolutions still compare-equal AFTER
 *    `path.resolve` normalizes them (this catches the C3 known edge —
 *    if it ever regresses we want to know).
 */

import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { resolveSkillReloadTarget } from './handlers'

describe('resolveSkillReloadTarget — accept paths', () => {
  it('empty requested + trusted workspace → uses trusted', () => {
    const r = resolveSkillReloadTarget(undefined, '/home/user/repo')
    expect(r.accepted).toBe(true)
    if (r.accepted) {
      expect(r.effective).toBe('/home/user/repo')
    }
  })

  it('empty requested + no trusted → resolves to undefined (no-workspace mode)', () => {
    const r = resolveSkillReloadTarget('', '')
    expect(r.accepted).toBe(true)
    if (r.accepted) {
      expect(r.effective).toBeUndefined()
    }
  })

  it('requested === trusted → accepted', () => {
    const r = resolveSkillReloadTarget('/home/user/repo', '/home/user/repo')
    expect(r.accepted).toBe(true)
    if (r.accepted) {
      expect(r.effective).toBe('/home/user/repo')
    }
  })

  it('requested resolves to same canonical path as trusted (trailing slashes / "." segments)', () => {
    const trusted = path.resolve('/home/user/repo')
    const noisy = path.join(trusted, '.', '..', 'repo')
    const r = resolveSkillReloadTarget(noisy, trusted)
    expect(r.accepted).toBe(true)
  })
})

describe('resolveSkillReloadTarget — reject paths (G12)', () => {
  it('rejects an arbitrary requested path that differs from trusted', () => {
    const r = resolveSkillReloadTarget('/evil', '/home/user/repo')
    expect(r.accepted).toBe(false)
    if (!r.accepted) {
      expect(r.reason).toMatch(/denied/i)
      expect(r.reason).toContain('/evil')
    }
  })

  it('rejects a requested path when there is NO trusted workspace at all', () => {
    // Without a trusted baseline, the only acceptable input is empty.
    // A renderer that asks us to load `/somewhere` cannot be allowed.
    const r = resolveSkillReloadTarget('/somewhere', undefined)
    expect(r.accepted).toBe(false)
    if (!r.accepted) {
      expect(r.reason).toContain('/somewhere')
      expect(r.reason).toMatch(/trusted=<none>/)
    }
  })

  it('treats non-string requested as empty (ignored)', () => {
    // IPC payloads can carry anything; defensive against junk types.
    const r1 = resolveSkillReloadTarget(123, '/home/user/repo')
    expect(r1.accepted).toBe(true)
    const r2 = resolveSkillReloadTarget({ evil: 'object' }, '/home/user/repo')
    expect(r2.accepted).toBe(true)
    const r3 = resolveSkillReloadTarget(null, '/home/user/repo')
    expect(r3.accepted).toBe(true)
  })

  it('trims whitespace before comparing (renderer normalization tolerance)', () => {
    const r = resolveSkillReloadTarget(' /home/user/repo ', '/home/user/repo')
    expect(r.accepted).toBe(true)
  })
})

describe('resolveSkillReloadTarget — Windows case-insensitive comparison (C3)', () => {
  // These tests intentionally use Windows-shaped paths regardless of host
  // platform. On POSIX `path.resolve('C:\\Users\\foo')` is treated as a
  // single literal segment so the case match becomes a string identity
  // check — still valid. On Windows the normalization kicks in.
  const isWin = process.platform === 'win32'

  it('Windows: differing drive-letter case still matches (`c:\\` vs `C:\\`)', () => {
    if (!isWin) return
    const trusted = 'C:\\Users\\foo\\repo'
    const requested = 'c:\\Users\\foo\\repo'
    const r = resolveSkillReloadTarget(requested, trusted)
    expect(r.accepted).toBe(true)
    if (r.accepted) {
      // `effective` must surface the caller's original casing, NOT the
      // lowercased compare-form. Downstream `initSkills` / LSP should
      // see what the renderer actually requested.
      expect(r.effective).toBe(requested)
    }
  })

  it('Windows: differing folder-name case still matches', () => {
    if (!isWin) return
    const r = resolveSkillReloadTarget(
      'C:\\Users\\Foo\\Repo',
      'C:\\users\\foo\\repo',
    )
    expect(r.accepted).toBe(true)
  })

  it('POSIX: differing-case paths are STILL rejected (case-sensitive FS)', () => {
    if (isWin) return
    // `/home/User/repo` and `/home/user/repo` are real distinct dirs on
    // POSIX; the comparison must remain case-sensitive there.
    const r = resolveSkillReloadTarget('/home/User/repo', '/home/user/repo')
    expect(r.accepted).toBe(false)
  })
})
