/**
 * Regression: Grep / Glob `path` parameter must accept a single file, not
 * only a directory. Before this fix the AI frequently handed the tool a
 * file path (e.g. `src/ui/steps/foo.py`) and got "Directory not found"
 * because (a) we resolved relative paths against process.cwd() instead
 * of the workspace root, and (b) we refused anything that wasn't a dir.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as workspaceState from '../tools/workspaceState'
import { toolGrep, toolGlob } from './advancedTools'

describe('toolGrep — single-file path target', () => {
  let workspaceDir: string
  let wsSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), 'grep-filetarget-'))
    mkdirSync(join(workspaceDir, 'src', 'ui', 'steps'), { recursive: true })
    writeFileSync(
      join(workspaceDir, 'src', 'ui', 'steps', 'step_10.py'),
      [
        'import foo',
        '',
        'def start_reskin_single(self, chapter_index, batch_mode=False):',
        '    """docstring"""',
        '    if not self.project:',
        '        return',
      ].join('\n'),
      'utf8',
    )
    writeFileSync(
      join(workspaceDir, 'other.py'),
      'def unrelated(): pass\n',
      'utf8',
    )
    wsSpy = vi.spyOn(workspaceState, 'getWorkspacePath').mockReturnValue(workspaceDir)
    // Force JS fallback (avoid ripgrep shelling out in the test sandbox).
    process.env.DISABLE_RG_GREP = '1'
  })

  afterEach(() => {
    wsSpy.mockRestore()
    delete process.env.DISABLE_RG_GREP
    rmSync(workspaceDir, { recursive: true, force: true })
  })

  it('accepts a relative file path in `cwd` and searches only that file', async () => {
    const r = await toolGrep('def start_reskin', 'src/ui/steps/step_10.py', {
      outputMode: 'files_with_matches',
    })
    expect(r.success).toBe(true)
    expect(r.output).toContain('step_10.py')
    // Must NOT have returned "Directory not found"; must NOT have walked the tree.
    expect(r.output).not.toContain('other.py')
  })

  it('accepts an absolute file path in `cwd`', async () => {
    const abs = join(workspaceDir, 'src', 'ui', 'steps', 'step_10.py')
    const r = await toolGrep('start_reskin', abs, { outputMode: 'content' })
    expect(r.success).toBe(true)
    // content mode: must include the hit line
    expect(typeof r.output === 'string' && r.output.length > 0).toBe(true)
    expect(r.output).toContain('start_reskin_single')
  })

  it('returns "no match" for a file target with no hits (not an error)', async () => {
    const r = await toolGrep('absolutely_not_here', 'src/ui/steps/step_10.py', {
      outputMode: 'files_with_matches',
    })
    expect(r.success).toBe(true)
    expect(r.output).toContain('No matches')
  })

  it('emits an actionable error when path is neither file nor directory', async () => {
    const r = await toolGrep('x', 'does/not/exist.py')
    expect(r.success).toBe(false)
    expect(r.error).toContain('Path not found')
    expect(r.error).toContain('does/not/exist.py')
    // Must mention the workspace hint so the AI fixes path on the next try.
    expect(r.error).toContain(workspaceDir)
  })

  it('respects the count output mode on a single-file target', async () => {
    const r = await toolGrep('self', 'src/ui/steps/step_10.py', { outputMode: 'count' })
    expect(r.success).toBe(true)
    expect(r.output).toContain('step_10.py')
    expect(r.output).toMatch(/step_10\.py: \d+/)
  })
})

describe('toolGlob — single-file path target', () => {
  let workspaceDir: string
  let wsSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), 'glob-filetarget-'))
    writeFileSync(join(workspaceDir, 'foo.py'), '', 'utf8')
    wsSpy = vi.spyOn(workspaceState, 'getWorkspacePath').mockReturnValue(workspaceDir)
    process.env.DISABLE_RG_GREP = '1'
  })

  afterEach(() => {
    wsSpy.mockRestore()
    delete process.env.DISABLE_RG_GREP
    rmSync(workspaceDir, { recursive: true, force: true })
  })

  it('degenerates to a match test when the path is a single file', async () => {
    const r = await toolGlob('*.py', 'foo.py')
    expect(r.success).toBe(true)
    expect(r.output).toContain('foo.py')
    expect(r.numFiles).toBe(1)
  })

  it('reports "no match" when the single-file path does not match the pattern', async () => {
    const r = await toolGlob('*.ts', 'foo.py')
    expect(r.success).toBe(true)
    expect(r.output).toContain('(no match)')
    expect(r.numFiles).toBe(0)
  })
})
