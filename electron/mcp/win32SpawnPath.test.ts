import fs from 'node:fs'
import { describe, it, expect } from 'vitest'
import { getPathFromEnv } from './envPath'
import { ensureSystem32OnPath, normalizeWin32ComSpec, win32ShortPathIfNeeded } from './win32SpawnPath'

describe('win32ShortPathIfNeeded', () => {
  it('returns input unchanged when path has no spaces', () => {
    expect(win32ShortPathIfNeeded('C:\\foo\\bar.exe')).toBe('C:\\foo\\bar.exe')
  })

  it('returns input on non-Windows (no cmd short-name resolution)', () => {
    if (process.platform === 'win32') return
    expect(win32ShortPathIfNeeded('/tmp/foo bar/baz')).toBe('/tmp/foo bar/baz')
  })
})

describe('ensureSystem32OnPath', () => {
  it('is a no-op off Windows', () => {
    if (process.platform === 'win32') return
    const env = { PATH: '/usr/bin' }
    ensureSystem32OnPath(env)
    expect(env.PATH).toBe('/usr/bin')
  })

  it('on Windows prepends System32 when PATH omits it', () => {
    if (process.platform !== 'win32') return
    const sys32 = 'C:\\Windows\\System32'
    if (!fs.existsSync(sys32)) return
    const env: Record<string, string> = {
      SystemRoot: 'C:\\Windows',
      PATH: 'C:\\only\\npm',
    }
    ensureSystem32OnPath(env)
    const pathVal = getPathFromEnv(env)
    expect(pathVal.toLowerCase().startsWith(sys32.toLowerCase())).toBe(true)
    expect(pathVal).toContain('C:\\only\\npm')
  })
})

describe('normalizeWin32ComSpec', () => {
  it('does not throw', () => {
    expect(() => normalizeWin32ComSpec()).not.toThrow()
  })
})
