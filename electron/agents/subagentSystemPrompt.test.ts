import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  getShellSyntaxGuideForSubagent,
  enhanceSubagentSystemPrompt,
} from './subagentSystemPrompt'
import { setDiskSettingsLoader } from '../settings/settingsAccess'

describe('subagentSystemPrompt', () => {
  const platform = process.platform

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: platform })
    setDiskSettingsLoader(() => ({}))
  })

  describe('getShellSyntaxGuideForSubagent', () => {
    it('labels Settings shell and includes PowerShell hints on win32', () => {
      Object.defineProperty(process, 'platform', { value: 'win32' })
      const g = getShellSyntaxGuideForSubagent('powershell')
      expect(g).toContain('Default terminal (Settings → 默认终端): powershell')
      expect(g).toContain('Get-Content')
      expect(g).toContain('Measure-Object')
    })

    it('labels cmd and forbids PowerShell on win32', () => {
      Object.defineProperty(process, 'platform', { value: 'win32' })
      const g = getShellSyntaxGuideForSubagent('cmd')
      expect(g).toContain('cmd.exe')
      expect(g).toContain('findstr')
      expect(g).toContain('Do not use:')
    })
  })

  describe('enhanceSubagentSystemPrompt', () => {
    beforeEach(() => {
      setDiskSettingsLoader(() => ({ defaultShell: 'powershell' }))
    })

    it('injects host runtime contract + tool conventions BEFORE the base prompt, then appends Notes and env', () => {
      // Stage 5 audit fix — typed sub-agents now receive the host runtime
      // contract (system-reminder semantics, recall ladder, historical
      // attachment rules) ahead of their own persona, matching the main
      // custom-system path. The base prompt no longer sits at index 0.
      Object.defineProperty(process, 'platform', { value: 'win32' })
      const out = enhanceSubagentSystemPrompt('BASE', 'claude-sonnet-4-20250514', {
        cwd: 'C:/proj',
      })
      const contractIdx = out.indexOf('How to recall what already happened')
      const toolConvIdx = out.indexOf('# Tool-use conventions')
      const baseIdx = out.indexOf('BASE')
      const envIdx = out.indexOf('<env>')
      expect(contractIdx).toBeGreaterThan(-1)
      expect(toolConvIdx).toBeGreaterThan(contractIdx)
      expect(baseIdx).toBeGreaterThan(toolConvIdx)
      expect(envIdx).toBeGreaterThan(baseIdx)
      expect(out).toContain('Settings → 默认终端')
      expect(out).toContain('Working directory: C:/proj')
      expect(out).toContain('Is directory a git repo:')
    })

    it('compactEnv omits git repo line (Explore/Plan omitClaudeMd)', () => {
      Object.defineProperty(process, 'platform', { value: 'win32' })
      const out = enhanceSubagentSystemPrompt('BASE', 'claude-sonnet-4-20250514', {
        cwd: 'C:/proj',
        compactEnv: true,
      })
      expect(out).not.toContain('Is directory a git repo:')
      expect(out).toContain('Working directory: C:/proj')
    })

    it('omits EDIT_FILE_CONTRACT_BLOCK when includeEditFileContract is false/undefined', () => {
      Object.defineProperty(process, 'platform', { value: 'win32' })
      const out = enhanceSubagentSystemPrompt('BASE', 'claude-sonnet-4-20250514', {
        cwd: 'C:/proj',
      })
      // Heading was extended to cover multi_edit_file too — match the
      // common prefix only so the test is stable across future contract
      // additions.
      expect(out).not.toContain('contract (MANDATORY')
    })

    it('injects EDIT_FILE_CONTRACT_BLOCK when includeEditFileContract is true', () => {
      Object.defineProperty(process, 'platform', { value: 'win32' })
      const out = enhanceSubagentSystemPrompt('BASE', 'claude-sonnet-4-20250514', {
        cwd: 'C:/proj',
        includeEditFileContract: true,
      })
      // The block now covers both edit_file and multi_edit_file. Assert the
      // common header keyword + both tool names so the test stays robust
      // to wording tweaks while still catching accidental block removal.
      expect(out).toContain('contract (MANDATORY')
      expect(out).toContain('edit_file')
      expect(out).toContain('multi_edit_file')
      // Contract text includes the canonical rule strings.
      expect(out).toContain('Exact `old_string`')
      expect(out).toContain('read_file before edit')
      // Standard structure preserved post-Stage-5: contract → tool
      // conventions → BASE → Notes → edit-file → env.
      expect(out).toContain('BASE')
      expect(out).toContain('Working directory: C:/proj')
    })

    it('is idempotent: does not re-inject when basePrompt already carries the contract', () => {
      Object.defineProperty(process, 'platform', { value: 'win32' })
      const base = [
        'Main-chat inherited prompt body.',
        '# edit_file / multi_edit_file contract (MANDATORY — host will reject bad calls)',
        'You have **edit_file** and/or **multi_edit_file**. Treat the following as non-negotiable...',
      ].join('\n\n')
      const out = enhanceSubagentSystemPrompt(base, 'claude-sonnet-4-20250514', {
        cwd: 'C:/proj',
        includeEditFileContract: true,
      })
      // Exactly one occurrence of the contract marker (the heading suffix),
      // not two. The dedup substring lives in EDIT_FILE_CONTRACT_MARKER and
      // appears once when the base already carries the contract — re-
      // injection would push it to two.
      const occurrences = out.split('contract (MANDATORY — host will reject bad calls)').length - 1
      expect(occurrences).toBe(1)
    })

    it('is idempotent against legacy (edit_file-only) marker text', () => {
      // Sub-agents whose parent prompt was serialised BEFORE this change
      // still carry the legacy heading `# edit_file contract (MANDATORY …)`.
      // The new marker anchors on the shared `contract (MANDATORY …)` tail
      // so dedup still detects the legacy heading and skips re-injection.
      Object.defineProperty(process, 'platform', { value: 'win32' })
      const legacyBase = [
        'Legacy fork prompt.',
        '# edit_file contract (MANDATORY — host will reject bad calls)',
        'You have **edit_file**. Treat the following as non-negotiable...',
      ].join('\n\n')
      const out = enhanceSubagentSystemPrompt(legacyBase, 'claude-sonnet-4-20250514', {
        cwd: 'C:/proj',
        includeEditFileContract: true,
      })
      const occurrences = out.split('contract (MANDATORY — host will reject bad calls)').length - 1
      expect(occurrences).toBe(1)
    })

    // Regression: typed sub-agents (Explore / Plan / Debug / Verification /
    // bundle-defined custom agents) build their prompt from
    // `agentDef.getSystemPrompt()` which does NOT include the default
    // 星构Astra prompt — the anti-action-hallucination guardrail must be
    // injected here so it survives the sub-agent path. Without this, a
    // user who delegates a task to a sub-agent (especially via a custom
    // workpack agent) loses the guardrail at exactly the moment the
    // sub-agent is making mutating tool calls.
    it('injects anti-action-hallucination guardrail on every typed sub-agent', () => {
      Object.defineProperty(process, 'platform', { value: 'win32' })
      const out = enhanceSubagentSystemPrompt('BASE', 'claude-sonnet-4-20250514', {
        cwd: 'C:/proj',
      })
      expect(out).toContain('## No action hallucination')
      // Spot-check both language families so a future refactor doesn't
      // accidentally drop the Chinese examples (the highest-leverage
      // examples for our user base).
      expect(out).toMatch(/我已经修改了|我创建了|我运行了/u)
      expect(out).toMatch(/I edited X|I created X|I ran X/u)
    })

    it('anti-action-hallucination guardrail is idempotent for fork sub-agents inheriting the parent prompt', () => {
      Object.defineProperty(process, 'platform', { value: 'win32' })
      const parentInherited = [
        'Main-chat inherited prompt body with everything.',
        '## No action hallucination',
        'Past-tense claims about mutating actions … (existing).',
      ].join('\n\n')
      const out = enhanceSubagentSystemPrompt(parentInherited, 'claude-sonnet-4-20250514', {
        cwd: 'C:/proj',
      })
      const occurrences = out.split('## No action hallucination').length - 1
      expect(occurrences).toBe(1)
    })

    // Stage 5 audit fix — typed sub-agents (Explore / Plan / Debug /
    // Verification / bundle-defined custom agents) build their prompt
    // from `agentDef.getSystemPrompt()` which does NOT include the
    // default 星构Astra prompt. Without this injection, sub-agents miss
    // the host runtime contract: they read `<system-reminder>` /
    // `<historical-snapshot>` / `<recall-pointer>` tags as fresh content
    // and skip the recall ladder, leading to redo-after-summary work.
    it('injects host runtime contract + tool conventions on every typed sub-agent', () => {
      Object.defineProperty(process, 'platform', { value: 'win32' })
      const out = enhanceSubagentSystemPrompt('BASE', 'claude-sonnet-4-20250514', {
        cwd: 'C:/proj',
      })
      // Host runtime contract (System block + recall ladder).
      expect(out).toContain('# System')
      expect(out).toContain('How to recall what already happened')
      expect(out).toContain('<system-reminder>')
      expect(out).toContain('<historical-snapshot')
      expect(out).toContain('<recall-pointer')
      // Tool-use conventions (read_file → edit_file workflow).
      expect(out).toContain('# Tool-use conventions')
      expect(out).toContain('read_file → edit_file workflow')
    })

    it('host contract injection is idempotent for fork sub-agents already inheriting it', () => {
      Object.defineProperty(process, 'platform', { value: 'win32' })
      // Simulate a fork sub-agent whose `basePrompt` is the parent's full
      // system prompt — already contains the host contract markers.
      const parentInherited = [
        'Main-chat inherited body.',
        '# System',
        'inherited system rules…',
        '## How to recall what already happened in this session',
        'inherited recall ladder…',
        '# Tool-use conventions',
        'inherited tool conventions…',
      ].join('\n\n')
      const out = enhanceSubagentSystemPrompt(parentInherited, 'claude-sonnet-4-20250514', {
        cwd: 'C:/proj',
      })
      // Exactly one of each marker — no double injection.
      expect(out.split('# System').length - 1).toBe(1)
      expect(out.split('How to recall what already happened').length - 1).toBe(1)
      expect(out.split('# Tool-use conventions').length - 1).toBe(1)
    })
  })
})
