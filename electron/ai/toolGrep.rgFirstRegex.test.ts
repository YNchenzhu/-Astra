/**
 * Ripgrep accepts Rust-regex syntax; JavaScript `RegExp` does not always match.
 * We must not pre-validate with `new RegExp()` before invoking rg — that caused
 * false "Invalid regex pattern" failures for valid ripgrep-only constructs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import * as workspaceState from '../tools/workspaceState'
import { toolGrep } from './advancedTools'

const rgOnPath =
  spawnSync(process.platform === 'win32' ? 'rg.exe' : 'rg', ['--version'], {
    encoding: 'utf8',
    windowsHide: true,
  }).status === 0

describe.skipIf(!rgOnPath)('toolGrep — ripgrep-first (no JS pre-validation)', () => {
  let workspaceDir: string
  let wsSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), 'grep-rgfirst-'))
    writeFileSync(join(workspaceDir, 'letters.txt'), 'abc123\n', 'utf8')
    wsSpy = vi.spyOn(workspaceState, 'getWorkspacePath').mockReturnValue(workspaceDir)
    delete process.env.DISABLE_RG_GREP
  })

  afterEach(() => {
    wsSpy.mockRestore()
    rmSync(workspaceDir, { recursive: true, force: true })
  })

  it('does not reject \\p{L}+ before ripgrep (Unicode class — invalid bare JS RegExp)', async () => {
    const r = await toolGrep(String.raw`\p{L}+`, undefined, { outputMode: 'files_with_matches' })
    expect(r.success).toBe(true)
    expect(String(r.output)).toContain('letters.txt')
  })
})
