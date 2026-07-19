import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  getSecurityWorkspaceRoots,
  resolvePathForWorkspaceAccess,
  setSecurityWorkspaceRoots,
} from './workspaceAccess'

describe('workspaceAccess', () => {
  let tmp: string

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-ws-'))
    setSecurityWorkspaceRoots([tmp])
  })

  afterEach(() => {
    setSecurityWorkspaceRoots([])
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('rejects when no roots', () => {
    setSecurityWorkspaceRoots([])
    const r = resolvePathForWorkspaceAccess(path.join(tmp, 'a.txt'))
    expect(r.ok).toBe(false)
  })

  it('allows file under root (relative)', () => {
    const r = resolvePathForWorkspaceAccess('src/foo.ts')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.resolved).toBe(path.resolve(tmp, 'src/foo.ts'))
    }
  })

  it('allows absolute path inside root', () => {
    const inner = path.join(tmp, 'inner', 'x.md')
    fs.mkdirSync(path.dirname(inner), { recursive: true })
    const r = resolvePathForWorkspaceAccess(inner)
    expect(r.ok).toBe(true)
  })

  it('rejects path outside root', () => {
    const outside = path.join(os.tmpdir(), 'outside-sec-ws', 'evil.txt')
    fs.mkdirSync(path.dirname(outside), { recursive: true })
    const r = resolvePathForWorkspaceAccess(outside)
    expect(r.ok).toBe(false)
  })

  it('getSecurityWorkspaceRoots returns copy', () => {
    const a = getSecurityWorkspaceRoots()
    a.push('x')
    expect(getSecurityWorkspaceRoots()).not.toContain('x')
  })
})
