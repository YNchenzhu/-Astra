import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { mergeOpenClaudeStylePermissionRules } from './permissionRuleSources'
import { resolveToolPermissionMode } from './permissionRuleMatch'
import { setWorkspacePath } from '../tools/workspaceState'

describe('mergeOpenClaudeStylePermissionRules (report §5.2)', () => {
  const keys = [
    'ASTRA_POLICY_PERMISSION_RULES_JSON',
    'ASTRA_FLAG_PERMISSION_RULES_JSON',
    'ASTRA_USER_PERMISSION_RULES_JSON',
    'ASTRA_USER_PERMISSION_RULES_PATH',
    'ASTRA_PROJECT_PERMISSION_RULES_JSON',
    'ASTRA_PROJECT_PERMISSION_RULES_PATH',
    'ASTRA_LOCAL_PERMISSION_RULES_JSON',
    'ASTRA_CLI_PERMISSION_RULES_JSON',
    'ASTRA_COMMAND_PERMISSION_RULES_JSON',
    'ASTRA_EXPERIMENT_PERMISSION_RULES_JSON',
  ] as const

  afterEach(() => {
    for (const k of keys) {
      delete process.env[k]
    }
    delete process.env.POLE_SCRATCHPAD_ALLOW_RULES
    delete process.env.ASTRA_SCRATCHPAD_DIR
    setWorkspacePath(null)
  })

  it('orders policy before session so policy deny wins (first match)', () => {
    process.env.ASTRA_POLICY_PERMISSION_RULES_JSON = JSON.stringify([
      { id: 'p', pattern: 'read_file', mode: 'deny' },
    ])
    const merged = mergeOpenClaudeStylePermissionRules([
      { id: 's', pattern: 'read_file', mode: 'allow' },
    ])
    expect(merged[0]?.id).toBe('p')
    expect(merged[1]?.id).toBe('s')
    expect(resolveToolPermissionMode('read_file', 'ask', merged)).toEqual({
      effectiveMode: 'deny',
      matchedRule: true,
    })
  })

  it('orders flag between policy and user json', () => {
    process.env.ASTRA_POLICY_PERMISSION_RULES_JSON = JSON.stringify([
      { id: 'pol', pattern: 'glob_file_search', mode: 'deny' },
    ])
    process.env.ASTRA_FLAG_PERMISSION_RULES_JSON = JSON.stringify([
      { id: 'flg', pattern: 'grep', mode: 'deny' },
    ])
    process.env.ASTRA_USER_PERMISSION_RULES_JSON = JSON.stringify([
      { id: 'usr', pattern: 'read_file', mode: 'allow' },
    ])
    const merged = mergeOpenClaudeStylePermissionRules([])
    expect(merged.map((r) => r.id)).toEqual(['pol', 'flg', 'usr'])
  })

  it('loads user rules from ASTRA_USER_PERMISSION_RULES_PATH', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pole-perm-'))
    const fp = path.join(dir, 'rules.json')
    fs.writeFileSync(
      fp,
      JSON.stringify([{ id: 'fromfile', pattern: 'bash', mode: 'deny' }]),
      'utf-8',
    )
    process.env.ASTRA_USER_PERMISSION_RULES_PATH = fp
    const merged = mergeOpenClaudeStylePermissionRules([])
    expect(merged.some((r) => r.id === 'fromfile')).toBe(true)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  /**
   * AC-5.3 / 报告 §5.2 — policy highest; session lowest; experiment before session.
   * Order: policy → flag → userFile → userJson → projectFile → projectJson → local → cli → command → experiment → session
   */
  it('orders all §5.2 sources (full stack)', () => {
    const udir = fs.mkdtempSync(path.join(os.tmpdir(), 'pole-perm-user-'))
    const ufp = path.join(udir, 'u.json')
    fs.writeFileSync(ufp, JSON.stringify([{ id: 'ufile', pattern: 'read_file', mode: 'deny' }]), 'utf-8')
    const pdir = fs.mkdtempSync(path.join(os.tmpdir(), 'pole-perm-proj-'))
    const pfp = path.join(pdir, 'p.json')
    fs.writeFileSync(pfp, JSON.stringify([{ id: 'pfile', pattern: 'read_file', mode: 'deny' }]), 'utf-8')

    process.env.ASTRA_USER_PERMISSION_RULES_PATH = ufp
    process.env.ASTRA_PROJECT_PERMISSION_RULES_PATH = pfp
    process.env.ASTRA_POLICY_PERMISSION_RULES_JSON = JSON.stringify([
      { id: 'pol', pattern: 'read_file', mode: 'deny' },
    ])
    process.env.ASTRA_FLAG_PERMISSION_RULES_JSON = JSON.stringify([
      { id: 'flg', pattern: 'read_file', mode: 'deny' },
    ])
    process.env.ASTRA_USER_PERMISSION_RULES_JSON = JSON.stringify([
      { id: 'uj', pattern: 'read_file', mode: 'deny' },
    ])
    process.env.ASTRA_PROJECT_PERMISSION_RULES_JSON = JSON.stringify([
      { id: 'pj', pattern: 'read_file', mode: 'deny' },
    ])
    process.env.ASTRA_LOCAL_PERMISSION_RULES_JSON = JSON.stringify([
      { id: 'loc', pattern: 'read_file', mode: 'deny' },
    ])
    process.env.ASTRA_CLI_PERMISSION_RULES_JSON = JSON.stringify([
      { id: 'cli', pattern: 'read_file', mode: 'deny' },
    ])
    process.env.ASTRA_COMMAND_PERMISSION_RULES_JSON = JSON.stringify([
      { id: 'cmd', pattern: 'read_file', mode: 'deny' },
    ])
    process.env.ASTRA_EXPERIMENT_PERMISSION_RULES_JSON = JSON.stringify([
      { id: 'exp', pattern: 'read_file', mode: 'deny' },
    ])

    const merged = mergeOpenClaudeStylePermissionRules([
      { id: 'sess', pattern: 'read_file', mode: 'allow' },
    ])
    expect(merged.map((r) => r.id)).toEqual([
      'pol',
      'flg',
      'ufile',
      'uj',
      'pfile',
      'pj',
      'loc',
      'cli',
      'cmd',
      'exp',
      'sess',
    ])
    expect(resolveToolPermissionMode('read_file', 'ask', merged).effectiveMode).toBe('deny')

    fs.rmSync(udir, { recursive: true, force: true })
    fs.rmSync(pdir, { recursive: true, force: true })
  })

  it('prepends scratchpad auto-allow rules above policy when a workspace is active', () => {
    // The scratchpad is meant to be a no-prompt durable surface for
    // cross-sub-agent collaboration. To keep that promise it must sit
    // ABOVE every other layer in the first-match-wins evaluation order —
    // including a user/session deny.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pole-scratch-merge-'))
    setWorkspacePath(tmp)
    try {
      process.env.ASTRA_USER_PERMISSION_RULES_JSON = JSON.stringify([
        { id: 'usr-deny-edit', pattern: 'Edit', mode: 'deny' },
      ])
      const merged = mergeOpenClaudeStylePermissionRules([])

      // The very first rules must be the scratchpad allow set.
      const firstScratchpadRule = merged.find((r) =>
        r.id.startsWith('scratchpad-allow-'),
      )
      expect(firstScratchpadRule?.id).toBe(merged[0]?.id)
      // Workspace-relative — matcher normalises file paths the same way.
      expect(firstScratchpadRule?.pathPattern).toBe('.astra/scratch/**')

      // A user deny on `Edit` must NOT shadow scratchpad edits.
      const editInScratchpad = path.join(tmp, '.astra', 'scratch', 'notes.md')
      const result = resolveToolPermissionMode('Edit', 'ask', merged, {
        filePath: editInScratchpad,
      })
      expect(result.effectiveMode).toBe('allow')
      expect(result.matchedRule).toBe(true)

      // An `Edit` OUTSIDE the scratchpad still gets the user deny.
      const editOutside = path.join(tmp, 'src', 'app.ts')
      const outside = resolveToolPermissionMode('Edit', 'ask', merged, {
        filePath: editOutside,
      })
      expect(outside.effectiveMode).toBe('deny')
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('omits scratchpad rules entirely when POLE_SCRATCHPAD_ALLOW_RULES=0', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pole-scratch-merge-off-'))
    setWorkspacePath(tmp)
    process.env.POLE_SCRATCHPAD_ALLOW_RULES = '0'
    try {
      const merged = mergeOpenClaudeStylePermissionRules([])
      expect(
        merged.some((r) => r.id.startsWith('scratchpad-allow-')),
      ).toBe(false)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})
