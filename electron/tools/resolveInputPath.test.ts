import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as workspaceState from './workspaceState'
import { resolveInputPath } from './resolveInputPath'

describe('resolveInputPath', () => {
  let workspaceDir: string
  let wsSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), 'resolve-input-path-'))
    mkdirSync(join(workspaceDir, 'src', 'lib'), { recursive: true })
    writeFileSync(join(workspaceDir, 'src', 'lib', 'a.ts'), 'export const a = 1\n', 'utf8')
    wsSpy = vi.spyOn(workspaceState, 'getWorkspacePath').mockReturnValue(workspaceDir)
  })

  afterEach(() => {
    wsSpy.mockRestore()
    rmSync(workspaceDir, { recursive: true, force: true })
  })

  it('resolves a relative path against the workspace root', () => {
    const r = resolveInputPath('src/lib/a.ts')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.resolved.replace(/\\/g, '/')).toBe(
        join(workspaceDir, 'src', 'lib', 'a.ts').replace(/\\/g, '/'),
      )
      expect(r.kind).toBe('file')
    }
  })

  it('accepts an absolute path verbatim', () => {
    const abs = join(workspaceDir, 'src', 'lib', 'a.ts')
    const r = resolveInputPath(abs)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.resolved).toBe(abs)
      expect(r.kind).toBe('file')
    }
  })

  it('returns kind=directory when the path points at a dir', () => {
    const r = resolveInputPath('src/lib')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.kind).toBe('directory')
  })

  it('rejects a directory when `expect: "file"` and suggests the configured alternate tool', () => {
    const r = resolveInputPath('src/lib', {
      expect: 'file',
      altForDirectory: 'list_files',
      toolName: 'read_file',
      argName: 'filePath',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toContain('`filePath` is a directory')
      expect(r.error).toContain('`list_files`')
    }
  })

  it('rejects a file when `expect: "directory"` and points at the alternate tool', () => {
    const r = resolveInputPath('src/lib/a.ts', {
      expect: 'directory',
      altForFile: 'read_file',
      toolName: 'list_files',
      argName: 'dirPath',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toContain('`dirPath` is a file')
      expect(r.error).toContain('`read_file`')
    }
  })

  it('emits a Tried / Context / Next-populated error when nothing exists', () => {
    const r = resolveInputPath('does/not/exist.ts', {
      toolName: 'read_file',
      argName: 'filePath',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toContain('`filePath` not found')
      expect(r.error).toContain('Tried:')
      expect(r.error).toContain(workspaceDir)
      expect(r.error).toContain('Next:')
    }
  })

  it('returns a clean missing-argument error when rawPath is blank', () => {
    const r = resolveInputPath('   ', { toolName: 'read_file', argName: 'filePath' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('missing or empty')
  })

  it('dedupes duplicate candidates when workspace === process.cwd()', () => {
    // Mock process.cwd() to equal the workspace root so both candidates
    // collapse to one — the "Tried:" line should NOT list the same path twice.
    const origCwd = process.cwd
    process.cwd = () => workspaceDir
    try {
      const r = resolveInputPath('ghost.ts', { toolName: 'read_file' })
      expect(r.ok).toBe(false)
      if (!r.ok) {
        const triedCount = (r.error.match(/ghost\.ts/g) ?? []).length
        // The headline mentions it, and the Tried section lists it exactly once.
        expect(triedCount).toBe(2)
      }
    } finally {
      process.cwd = origCwd
    }
  })
})
