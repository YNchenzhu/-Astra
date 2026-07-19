import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { SkillDefinition } from '../skills/types'
import * as skillTool from '../skills/skillTool'
import { loadLspConfigs } from './config'

describe('loadLspConfigs skill merge vs workspace trust', () => {
  let skillDir: string
  let workspaceDir: string
  let getAllSkillsSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    process.env.ASTRA_LSP_TEST_SKIP_PATH_DEFAULTS = '1'
    skillDir = mkdtempSync(join(tmpdir(), 'lsp-skill-trust-'))
    workspaceDir = mkdtempSync(join(tmpdir(), 'lsp-ws-trust-'))
    const skillMd = join(skillDir, 'SKILL.md')
    writeFileSync(skillMd, '---\nname: trusttest\n---\n')
    writeFileSync(
      join(skillDir, '.lsp.json'),
      JSON.stringify({
        servers: {
          skillonly: {
            command: 'true',
            args: [],
            extensionToLanguage: { '.zz': 'plaintext' },
          },
        },
      }),
    )
    getAllSkillsSpy = vi.spyOn(skillTool, 'getAllSkills').mockReturnValue([
      {
        name: 'trusttest',
        resolvedPath: skillMd,
      } as SkillDefinition,
    ])
  })

  afterEach(() => {
    delete process.env.ASTRA_LSP_TEST_SKIP_PATH_DEFAULTS
    getAllSkillsSpy.mockRestore()
    rmSync(skillDir, { recursive: true, force: true })
    rmSync(workspaceDir, { recursive: true, force: true })
  })

  it('does not merge skill-scoped LSP when workspacePath is omitted', async () => {
    const cfg = await loadLspConfigs(undefined, undefined)
    expect(Object.keys(cfg).some((k) => k.startsWith('skill:'))).toBe(false)
  })

  it('merges skill-scoped LSP when a trusted workspace path is provided', async () => {
    const cfg = await loadLspConfigs(workspaceDir, undefined)
    expect(Object.keys(cfg).some((k) => k.startsWith('skill:trusttest:skillonly'))).toBe(
      true,
    )
  })
})
