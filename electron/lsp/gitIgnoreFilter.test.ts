import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, afterEach } from 'vitest'
import { createLocationGitignoreFilter } from './gitIgnoreFilter'

describe('createLocationGitignoreFilter', () => {
  let tmp: string | undefined
  afterEach(() => {
    if (tmp && fs.existsSync(tmp)) {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
    tmp = undefined
  })

  it('filters node_modules by path segment', () => {
    const f = createLocationGitignoreFilter('/repo')
    expect(f(path.join('/repo', 'node_modules', 'x', 'y.ts'))).toBe(true)
    expect(f(path.join('/repo', 'src', 'a.ts'))).toBe(false)
  })

  it('reads .gitignore patterns', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-gitig-'))
    fs.writeFileSync(path.join(tmp, '.gitignore'), 'dist/\n*.log\n', 'utf-8')
    const f = createLocationGitignoreFilter(tmp)
    expect(f(path.join(tmp, 'dist', 'out.js'))).toBe(true)
    expect(f(path.join(tmp, 'a.log'))).toBe(true)
    expect(f(path.join(tmp, 'src', 'a.ts'))).toBe(false)
  })
})
