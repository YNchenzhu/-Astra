import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { resolveRipgrepBin, __resetRipgrepBinCacheForTests } from './ripgrepBin'

describe('resolveRipgrepBin', () => {
  beforeEach(() => {
    __resetRipgrepBinCacheForTests()
  })

  it('prefers the bundled @vscode/ripgrep platform binary when installed', () => {
    const bin = resolveRipgrepBin()
    // The repo has @vscode/ripgrep as a dependency, so on any platform the
    // dev/CI install includes the matching platform package — we must get an
    // absolute, existing path (never the bare PATH fallback here).
    expect(path.isAbsolute(bin)).toBe(true)
    expect(fs.existsSync(bin)).toBe(true)
    expect(path.basename(bin)).toBe(process.platform === 'win32' ? 'rg.exe' : 'rg')
  })

  it('caches the resolution', () => {
    expect(resolveRipgrepBin()).toBe(resolveRipgrepBin())
  })
})
