import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect } from 'vitest'

import { canonicalFileLockKey, resolveRealPathAllowingMissingLeaf } from './canonicalPath'

describe('canonicalFileLockKey', () => {
  it('collapses a symlink and its target to the same lock key', () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cpath-')))
    const target = path.join(dir, 'real.txt')
    fs.writeFileSync(target, 'x')
    const link = path.join(dir, 'link.txt')
    let symlinked = true
    try {
      fs.symlinkSync(target, link)
    } catch {
      // Symlink creation needs elevated perms on Windows (non-admin / no dev
      // mode). Skip rather than fail — the assertion is meaningless without it.
      symlinked = false
    }
    if (symlinked) {
      expect(canonicalFileLockKey(link)).toBe(canonicalFileLockKey(target))
    }
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('produces a stable key regardless of redundant path segments', () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cpath-')))
    const target = path.join(dir, 'a.txt')
    fs.writeFileSync(target, 'x')
    const viaDotDot = path.join(dir, 'a.txt', '..', 'a.txt')
    expect(canonicalFileLockKey(viaDotDot)).toBe(canonicalFileLockKey(target))
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('resolves a missing leaf via its nearest existing ancestor', () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cpath-')))
    const missing = path.join(dir, 'does-not-exist.txt')
    expect(resolveRealPathAllowingMissingLeaf(missing)).toBe(path.join(dir, 'does-not-exist.txt'))
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
