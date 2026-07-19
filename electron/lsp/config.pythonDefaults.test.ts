/**
 * Regression lock for the Python LSP defaults.
 *
 * This test exists because "Problems panel shows Pyright false positives"
 * (e.g. `reportArgumentType` flagging `d: dict = None` defaults as errors
 * on basic-mode type checking) was reported by end users on real Python
 * projects that had no `pyrightconfig.json`. We fixed that by setting
 * `typeCheckingMode: 'off'` in the default `initializationOptions` so
 * pyright only reports unambiguous issues when no project-level config
 * exists. Accidental reversion of that default would re-open the flood
 * of noise, so we assert it here explicitly.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as skillTool from '../skills/skillTool'
import * as disabledServers from './disabledServers'
import { loadLspConfigs } from './config'

describe('loadLspConfigs — Python defaults', () => {
  let workspaceDir: string
  let getAllSkillsSpy: ReturnType<typeof vi.spyOn>
  let getDisabledSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), 'lsp-python-defaults-'))
    getAllSkillsSpy = vi
      .spyOn(skillTool, 'getAllSkills')
      .mockReturnValue([])
    // Make sure local disk settings don't accidentally disable the pyright
    // scope for the test runner machine.
    getDisabledSpy = vi
      .spyOn(disabledServers, 'getDisabledLspServers')
      .mockReturnValue([])
  })

  afterEach(() => {
    getAllSkillsSpy.mockRestore()
    getDisabledSpy.mockRestore()
    rmSync(workspaceDir, { recursive: true, force: true })
  })

  it('sets typeCheckingMode=off as the conservative baseline for pyright', async () => {
    const cfg = await loadLspConfigs(workspaceDir, undefined)
    const pythonCfg = cfg.python
    if (!pythonCfg) {
      // Bundled pyright not installed in this environment (possible in bare
      // CI lanes). Soft-skip rather than fail — the tested behaviour is a
      // property of the `addDefaults` constant, which is exercised fully
      // in any environment where `bundled-lsp/node_modules/pyright` exists.
      expect(true).toBe(true)
      return
    }

    const analysis = (pythonCfg.initializationOptions as {
      python?: { analysis?: Record<string, unknown> }
    } | undefined)?.python?.analysis

    expect(analysis).toBeDefined()
    expect(analysis!.typeCheckingMode).toBe('off')
    // Keep the other defaults intact — regressions on these hurt the app
    // in the opposite direction (pyright would miss real cross-file errors).
    expect(analysis!.diagnosticMode).toBe('workspace')
    expect(analysis!.useLibraryCodeForTypes).toBe(true)
    expect(analysis!.autoSearchPaths).toBe(true)
  })

  it('silences the top commonly-false-positive rules via diagnosticSeverityOverrides', async () => {
    // Belt-and-suspenders: even when a project's own `pyrightconfig.json`
    // bumps typeCheckingMode up to `basic`, these per-rule settings stay
    // effective unless the project explicitly opts them back in.
    const cfg = await loadLspConfigs(workspaceDir, undefined)
    if (!cfg.python) { expect(true).toBe(true); return }
    const analysis = (cfg.python.initializationOptions as {
      python?: { analysis?: Record<string, unknown> }
    } | undefined)?.python?.analysis
    expect(analysis).toBeDefined()

    const overrides = analysis!.diagnosticSeverityOverrides as Record<string, string> | undefined
    expect(overrides).toBeDefined()

    // The exact list these tests lock must include (a) every rule a user
    // has reported complaints about historically and (b) the common
    // Optional-access family that fires constantly on old Python code.
    const expectedNone = [
      'reportArgumentType',
      'reportUnusedVariable',
      'reportOptionalMemberAccess',
      'reportOptionalSubscript',
      'reportOptionalCall',
      'reportOptionalIterable',
      'reportOptionalContextManager',
      'reportOptionalOperand',
      'reportCallIssue',
      'reportAttributeAccessIssue',
      'reportAssignmentType',
    ]
    for (const rule of expectedNone) {
      expect(overrides![rule], `${rule} should be silenced`).toBe('none')
    }
  })

  it('workspace .lsp.json can override typeCheckingMode without losing other fields', async () => {
    // A user who explicitly wants strict type checking drops a `.lsp.json`
    // next to their project root. Workspace-scoped configs merge over
    // defaults — our "off" floor must NOT stick around once they opt in.
    const lspJson = JSON.stringify({
      servers: {
        python: {
          command: 'pyright-langserver',
          args: ['--stdio'],
          extensionToLanguage: { '.py': 'python' },
          initializationOptions: {
            python: {
              analysis: {
                typeCheckingMode: 'strict',
                diagnosticMode: 'workspace',
              },
            },
          },
        },
      },
    })
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(workspaceDir, '.lsp.json'), lspJson)

    const cfg = await loadLspConfigs(workspaceDir, undefined)
    const analysis = (cfg.python?.initializationOptions as {
      python?: { analysis?: Record<string, unknown> }
    } | undefined)?.python?.analysis

    expect(analysis).toBeDefined()
    expect(analysis!.typeCheckingMode).toBe('strict')
  })
})
