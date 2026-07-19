/**
 * Unit tests for the scratchpad shared-directory resolver + permission rules.
 *
 * Coverage:
 *   1. `getScratchpadDir` falls back to `<workspace>/.astra/scratch`
 *      when the env override is unset.
 *   2. `ASTRA_SCRATCHPAD_DIR` wins when set.
 *   3. `ensureScratchpadDir` mkdir's the directory.
 *   4. `buildScratchpadPermissionRules` emits one allow rule per supported
 *      file-targeting tool, all pointing at the same path subtree.
 *   5. `POLE_SCRATCHPAD_ALLOW_RULES=0` disables the rule emission.
 *   6. Windows-style paths round-trip through gitignore normalisation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { silenceExpectedConsoleWarn } from '../testHelpers/silenceExpectedConsole'

// The "scratchpad outside workspace" branch deliberately emits a console.warn
// from production; we test the no-rules-emitted outcome, not the warn itself.
silenceExpectedConsoleWarn()
import {
  DEFAULT_SCRATCHPAD_RELATIVE,
  SCRATCHPAD_ENV_KEY,
  buildScratchpadPermissionRules,
  ensureScratchpadDir,
  getScratchpadDir,
  isScratchpadPermissionAutoAllowEnabled,
} from './scratchpadDir'
import { resolveToolPermissionMode } from '../ai/permissionRuleMatch'
import { setWorkspacePath } from '../tools/workspaceState'

let tempWorkspace: string

beforeEach(() => {
  tempWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'pole-scratch-test-'))
  delete process.env[SCRATCHPAD_ENV_KEY]
  delete process.env.POLE_SCRATCHPAD_ALLOW_RULES
})

afterEach(() => {
  try {
    fs.rmSync(tempWorkspace, { recursive: true, force: true })
  } catch {
    /* best-effort cleanup */
  }
  delete process.env[SCRATCHPAD_ENV_KEY]
  delete process.env.POLE_SCRATCHPAD_ALLOW_RULES
})

describe('getScratchpadDir', () => {
  it('returns workspace-relative default when no env override', () => {
    const dir = getScratchpadDir(tempWorkspace)
    expect(dir).toBe(path.join(tempWorkspace, DEFAULT_SCRATCHPAD_RELATIVE))
  })

  it('returns the env override verbatim when set', () => {
    process.env[SCRATCHPAD_ENV_KEY] = '/custom/scratch/loc'
    const dir = getScratchpadDir(tempWorkspace)
    expect(dir).toBe('/custom/scratch/loc')
  })

  it('returns undefined when workspace is missing and no env override', () => {
    expect(getScratchpadDir(undefined)).toBeUndefined()
    expect(getScratchpadDir('')).toBeUndefined()
    expect(getScratchpadDir('   ')).toBeUndefined()
  })

  it('treats empty / whitespace env override as unset', () => {
    process.env[SCRATCHPAD_ENV_KEY] = '   '
    expect(getScratchpadDir(tempWorkspace)).toBe(
      path.join(tempWorkspace, DEFAULT_SCRATCHPAD_RELATIVE),
    )
  })
})

describe('ensureScratchpadDir', () => {
  it('creates the directory if missing and returns the absolute path', () => {
    const dir = ensureScratchpadDir(tempWorkspace)
    expect(dir).toBe(path.join(tempWorkspace, DEFAULT_SCRATCHPAD_RELATIVE))
    expect(fs.statSync(dir!).isDirectory()).toBe(true)
  })

  it('is idempotent (no error on second call)', () => {
    ensureScratchpadDir(tempWorkspace)
    const dir = ensureScratchpadDir(tempWorkspace)
    expect(dir).toBeDefined()
    expect(fs.statSync(dir!).isDirectory()).toBe(true)
  })

  it('returns undefined when no workspace + no env override', () => {
    expect(ensureScratchpadDir(undefined)).toBeUndefined()
  })
})

describe('buildScratchpadPermissionRules', () => {
  it('emits one allow rule per supported file-targeting tool', () => {
    const rules = buildScratchpadPermissionRules(tempWorkspace)
    expect(rules.length).toBeGreaterThan(0)
    const tools = new Set(rules.map((r) => r.pattern))
    // Spot-check the canonical names — exact list may evolve.
    expect(tools.has('Read')).toBe(true)
    expect(tools.has('Edit')).toBe(true)
    expect(tools.has('Write')).toBe(true)
    expect(tools.has('Glob')).toBe(true)
    expect(tools.has('Grep')).toBe(true)
    // Every rule must be `allow` and carry a pathPattern scoped to the
    // scratchpad subtree.
    for (const r of rules) {
      expect(r.mode).toBe('allow')
      expect(r.pathPattern).toBeTruthy()
      expect(r.pathPattern!.endsWith('/**')).toBe(true)
    }
  })

  it('emits a workspace-relative pathPattern when the scratchpad lives inside the workspace', () => {
    const rules = buildScratchpadPermissionRules(tempWorkspace)
    expect(rules.length).toBeGreaterThan(0)
    // matcher normalises file paths to workspace-relative POSIX before
    // testing; the gitignore line must therefore be workspace-relative too.
    for (const r of rules) {
      expect(r.pathPattern).toBe('.astra/scratch/**')
    }
  })

  it('returns an empty rule set when the scratchpad is outside the workspace (env override)', () => {
    // The matcher in permissionRuleMatch.ts normalises file paths to
    // workspace-relative POSIX via `path.relative(ws, filePath)`. An
    // absolute gitignore line `/elsewhere/scratch/**` cannot match the
    // resulting `../../elsewhere/scratch/...` relative path. Rather than
    // ship rules that silently never fire, we degrade to "no auto-allow".
    process.env[SCRATCHPAD_ENV_KEY] = '/elsewhere/scratch'
    expect(buildScratchpadPermissionRules(tempWorkspace)).toEqual([])
  })

  it('returns an empty rule set when env override points at a Windows path outside the workspace', () => {
    process.env[SCRATCHPAD_ENV_KEY] = String.raw`C:\foo\bar\scratch`
    expect(buildScratchpadPermissionRules(tempWorkspace)).toEqual([])
  })

  it('emits a workspace-relative pattern when env override puts the scratchpad inside the workspace', () => {
    // env override that happens to nest inside the workspace — still
    // resolvable to a relative pattern, so the rules fire.
    process.env[SCRATCHPAD_ENV_KEY] = path.join(tempWorkspace, 'tmp', 'shared')
    const rules = buildScratchpadPermissionRules(tempWorkspace)
    expect(rules.length).toBeGreaterThan(0)
    for (const r of rules) {
      expect(r.pathPattern).toBe('tmp/shared/**')
    }
  })

  it('returns empty array when workspace and env are both missing', () => {
    expect(buildScratchpadPermissionRules(undefined)).toEqual([])
  })

  it('returns empty array when env override is set but no workspace is known', () => {
    // We refuse to anchor a relative gitignore line without a workspace.
    process.env[SCRATCHPAD_ENV_KEY] = '/abs/path/scratch'
    expect(buildScratchpadPermissionRules(undefined)).toEqual([])
  })

  it('returns empty array when POLE_SCRATCHPAD_ALLOW_RULES=0', () => {
    process.env.POLE_SCRATCHPAD_ALLOW_RULES = '0'
    expect(buildScratchpadPermissionRules(tempWorkspace)).toEqual([])
  })

  it('returns empty array when POLE_SCRATCHPAD_ALLOW_RULES=false', () => {
    process.env.POLE_SCRATCHPAD_ALLOW_RULES = 'false'
    expect(buildScratchpadPermissionRules(tempWorkspace)).toEqual([])
  })

  it('uses unique rule ids so dedup logic doesn\'t collapse them', () => {
    const rules = buildScratchpadPermissionRules(tempWorkspace)
    const ids = new Set(rules.map((r) => r.id))
    expect(ids.size).toBe(rules.length)
  })
})

describe('end-to-end matcher integration', () => {
  // Guards Finding 7 (audit): we previously shipped a `pathPattern` shape
  // (absolute `/abs/scratch/**`) the matcher silently refused to honour
  // when the scratchpad lived outside the workspace, because
  // `pathMatchesPathPattern` normalises the file path via
  // `path.relative(ws, filePath)` first. These tests exercise the real
  // matcher so future regressions of that contract are caught here, not
  // in production.
  let previousWorkspace: string | null = null

  beforeEach(() => {
    previousWorkspace = null
    // Snapshot existing workspace so this suite doesn't bleed into others
    // that share the workspaceState singleton. We can't read it back in a
    // race-safe way (no getter for the previous value), so we just clear
    // at the end of each case.
  })

  afterEach(() => {
    setWorkspacePath(previousWorkspace)
  })

  it('matches a file inside the scratchpad subtree via the real matcher', () => {
    setWorkspacePath(tempWorkspace)
    const rules = buildScratchpadPermissionRules(tempWorkspace)
    expect(rules.length).toBeGreaterThan(0)
    const fileInside = path.join(
      tempWorkspace,
      DEFAULT_SCRATCHPAD_RELATIVE,
      'auth-findings.md',
    )
    const result = resolveToolPermissionMode('Read', 'ask', rules, {
      filePath: fileInside,
    })
    expect(result.effectiveMode).toBe('allow')
    expect(result.matchedRule).toBe(true)
  })

  it('matches a nested file deep under the scratchpad via the real matcher', () => {
    setWorkspacePath(tempWorkspace)
    const rules = buildScratchpadPermissionRules(tempWorkspace)
    const deep = path.join(
      tempWorkspace,
      DEFAULT_SCRATCHPAD_RELATIVE,
      'team-a',
      'phase-1',
      'notes.json',
    )
    const result = resolveToolPermissionMode('Edit', 'ask', rules, {
      filePath: deep,
    })
    expect(result.effectiveMode).toBe('allow')
  })

  it('does NOT match a sibling file outside the scratchpad subtree', () => {
    setWorkspacePath(tempWorkspace)
    const rules = buildScratchpadPermissionRules(tempWorkspace)
    const sibling = path.join(tempWorkspace, 'src', 'app.ts')
    const result = resolveToolPermissionMode('Read', 'ask', rules, {
      filePath: sibling,
    })
    // No scratchpad rule matches → falls back to defaultMode 'ask'.
    expect(result.effectiveMode).toBe('ask')
    expect(result.matchedRule).toBe(false)
  })

  it('out-of-workspace scratchpad: no rules emitted, so no spurious match against a same-named path', () => {
    process.env[SCRATCHPAD_ENV_KEY] = '/elsewhere/scratch'
    setWorkspacePath(tempWorkspace)
    const rules = buildScratchpadPermissionRules(tempWorkspace)
    expect(rules).toEqual([])
    // Sanity: feeding the file path directly through the matcher with an
    // empty rule set yields defaultMode and the audit's Finding 7
    // regression is gated structurally.
    const result = resolveToolPermissionMode(
      'Read',
      'ask',
      rules,
      { filePath: '/elsewhere/scratch/foo.md' },
    )
    expect(result.effectiveMode).toBe('ask')
  })
})

describe('isScratchpadPermissionAutoAllowEnabled', () => {
  it('defaults to enabled', () => {
    expect(isScratchpadPermissionAutoAllowEnabled()).toBe(true)
  })

  it.each([['0'], ['false'], ['no'], ['off'], ['FALSE'], ['Off']])(
    'returns false for %s',
    (raw: string) => {
      process.env.POLE_SCRATCHPAD_ALLOW_RULES = raw
      expect(isScratchpadPermissionAutoAllowEnabled()).toBe(false)
    },
  )

  it.each([['1'], ['true'], ['anything-else'], ['']])(
    'returns true for %s',
    (raw: string) => {
      process.env.POLE_SCRATCHPAD_ALLOW_RULES = raw
      expect(isScratchpadPermissionAutoAllowEnabled()).toBe(true)
    },
  )
})
