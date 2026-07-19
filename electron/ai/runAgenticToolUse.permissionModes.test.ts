import { describe, it, expect, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runAgenticToolUse } from './runAgenticToolUse'
import { setPermissionMode } from './interactionState'
import * as interactionState from './interactionState'
import { setWorkspacePath } from '../tools/workspaceState'
import { toolRegistry } from '../tools/registry'
import * as agentContext from '../agents/agentContext'
import {
  clearAllReadFileState,
  findReadReceiptByReadId,
  recordSuccessfulRead,
} from '../tools/readFileState'

describe('runAgenticToolUse permission modes', () => {
  afterEach(() => {
    setPermissionMode('default')
    clearAllReadFileState()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('dontAsk denies write_file without calling requestPermission', async () => {
    setPermissionMode('dontAsk')
    const reqSpy = vi.spyOn(interactionState, 'requestPermission')

    const out = await runAgenticToolUse({
      toolUse: {
        id: 'tu-dontask',
        name: 'write_file',
        input: { filePath: 'x.txt', content: 'a' },
      },
      signal: new AbortController().signal,
      callbacks: { onToolStart: () => {}, onToolResult: () => {} },
      diffPermissionMode: 'default',
      permissionDefaultMode: 'ask',
      permissionRules: undefined,
      discoveryExclude: new Set(),
      getInlineSkillSession: () => null,
      setInlineSkillSession: () => {},
    })

    expect(reqSpy).not.toHaveBeenCalled()
    expect(String((out as { content?: string }).content)).toMatch(/dontAsk/i)
  })

  it('permission approval preserves a current edit baseReadId through execution', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pole-approval-readid-'))
    const fp = path.join(tmp, 'target.txt')
    fs.writeFileSync(fp, 'alpha\nbeta\n', 'utf8')
    setWorkspacePath(tmp)
    setPermissionMode('default')
    const receipt = recordSuccessfulRead(fp, {
      mtimeMs: fs.statSync(fp).mtimeMs,
      isPartialView: false,
      fullFileContent: 'alpha\nbeta\n',
      viewedContent: 'alpha\nbeta\n',
    })
    const reqSpy = vi.spyOn(interactionState, 'requestPermission').mockResolvedValue({
      behavior: 'allow',
    })
    const execSpy = vi.spyOn(toolRegistry, 'execute').mockResolvedValue({
      success: true,
      output: 'ok',
    })

    try {
      await runAgenticToolUse({
        toolUse: {
          id: 'tu-approval-readid',
          name: 'edit_file',
          input: {
            filePath: fp,
            oldString: 'alpha',
            newString: 'ALPHA',
            baseReadId: receipt.readId,
          },
        },
        signal: new AbortController().signal,
        callbacks: { onToolStart: () => {}, onToolResult: () => {} },
        diffPermissionMode: 'default',
        permissionDefaultMode: 'ask',
        permissionRules: undefined,
        discoveryExclude: new Set(),
        getInlineSkillSession: () => null,
        setInlineSkillSession: () => {},
      })

      expect(reqSpy).toHaveBeenCalled()
      expect(execSpy).toHaveBeenCalled()
      const executedInput = execSpy.mock.calls[0]?.[1] as Record<string, unknown>
      expect(executedInput.baseReadId).toBe(receipt.readId)
      expect(findReadReceiptByReadId(receipt.readId)).toBeDefined()
    } finally {
      setWorkspacePath(null)
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('permission approval does not launder a file change that happened after the diff preview', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pole-approval-race-'))
    const fp = path.join(tmp, 'target.txt')
    fs.writeFileSync(fp, 'alpha\nbeta\n', 'utf8')
    setWorkspacePath(tmp)
    setPermissionMode('default')
    const receipt = recordSuccessfulRead(fp, {
      mtimeMs: fs.statSync(fp).mtimeMs,
      isPartialView: false,
      fullFileContent: 'alpha\nbeta\n',
      viewedContent: 'alpha\nbeta\n',
    })
    const reqSpy = vi.spyOn(interactionState, 'requestPermission').mockImplementation(async () => {
      fs.writeFileSync(fp, 'externally changed\nbeta\n', 'utf8')
      return { behavior: 'allow' }
    })

    try {
      const result = await runAgenticToolUse({
        toolUse: {
          id: 'tu-approval-race',
          name: 'edit_file',
          input: {
            filePath: fp,
            oldString: 'alpha',
            newString: 'ALPHA',
            baseReadId: receipt.readId,
          },
        },
        signal: new AbortController().signal,
        callbacks: { onToolStart: () => {}, onToolResult: () => {} },
        diffPermissionMode: 'default',
        permissionDefaultMode: 'ask',
        permissionRules: undefined,
        discoveryExclude: new Set(),
        getInlineSkillSession: () => null,
        setInlineSkillSession: () => {},
      })

      expect(reqSpy).toHaveBeenCalled()
      expect(String((result as { content?: string }).content)).toMatch(/content hash mismatch/i)
      expect(fs.readFileSync(fp, 'utf8')).toBe('externally changed\nbeta\n')
    } finally {
      setWorkspacePath(null)
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('acceptEdits skips permission UI for write_file (no requestPermission)', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pole-ace-'))
    const fp = path.join(tmp, 't.txt')
    setWorkspacePath(tmp)
    setPermissionMode('acceptEdits')
    const reqSpy = vi.spyOn(interactionState, 'requestPermission')

    try {
    await runAgenticToolUse({
      toolUse: {
        id: 'tu-ace',
        name: 'write_file',
        input: { filePath: fp, content: 'x' },
      },
      signal: new AbortController().signal,
      callbacks: { onToolStart: () => {}, onToolResult: () => {} },
      diffPermissionMode: 'default',
      permissionDefaultMode: 'ask',
      permissionRules: undefined,
      discoveryExclude: new Set(),
      getInlineSkillSession: () => null,
      setInlineSkillSession: () => {},
    })

    expect(reqSpy).not.toHaveBeenCalled()
    } finally {
      setWorkspacePath(null)
      try {
        fs.rmSync(tmp, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
  })

  it('plan mode prompts for bash mkdir unless acceptEdits (filesystem allowlist)', async () => {
    setPermissionMode('plan')
    const reqSpy = vi.spyOn(interactionState, 'requestPermission').mockResolvedValue({
      behavior: 'allow',
    })
    const execSpy = vi.spyOn(toolRegistry, 'execute').mockResolvedValue({ success: true, output: 'ok' })

    await runAgenticToolUse({
      toolUse: {
        id: 'tu-plan-mkdir',
        name: 'bash',
        input: { command: 'mkdir -p sub' },
      },
      signal: new AbortController().signal,
      callbacks: { onToolStart: () => {}, onToolResult: () => {} },
      diffPermissionMode: 'default',
      permissionDefaultMode: 'ask',
      permissionRules: undefined,
      discoveryExclude: new Set(),
      getInlineSkillSession: () => null,
      setInlineSkillSession: () => {},
    })

    expect(reqSpy).toHaveBeenCalled()
    expect(execSpy).toHaveBeenCalled()
  })

  it('acceptEdits clears restricted-tier permission ask for filesystem bash (OpenClaude §5.1)', async () => {
    setPermissionMode('acceptEdits')
    vi.spyOn(agentContext, 'getAgentContext').mockReturnValue({
      policyTier: 'restricted',
      config: { id: 'anthropic', name: 'x', apiKey: '' },
      model: 'm',
      systemPrompt: '',
      messages: [],
      signal: new AbortController().signal,
      agentId: 'test-restricted',
    })
    const reqSpy = vi.spyOn(interactionState, 'requestPermission')
    const execSpy = vi.spyOn(toolRegistry, 'execute').mockResolvedValue({ success: true, output: 'ok' })

    await runAgenticToolUse({
      toolUse: {
        id: 'tu-ace-restricted-mkdir',
        name: 'bash',
        input: { command: 'mkdir -p out' },
      },
      signal: new AbortController().signal,
      callbacks: { onToolStart: () => {}, onToolResult: () => {} },
      diffPermissionMode: 'default',
      permissionDefaultMode: 'allow',
      permissionRules: undefined,
      discoveryExclude: new Set(),
      getInlineSkillSession: () => null,
      setInlineSkillSession: () => {},
    })

    expect(reqSpy).not.toHaveBeenCalled()
    expect(execSpy).toHaveBeenCalled()
  })

  it('acceptEdits does not clear restricted ask for non-filesystem bash', async () => {
    setPermissionMode('acceptEdits')
    vi.spyOn(agentContext, 'getAgentContext').mockReturnValue({
      policyTier: 'restricted',
      config: { id: 'anthropic', name: 'x', apiKey: '' },
      model: 'm',
      systemPrompt: '',
      messages: [],
      signal: new AbortController().signal,
      agentId: 'test-restricted-curl',
    })
    const reqSpy = vi.spyOn(interactionState, 'requestPermission').mockResolvedValue({
      behavior: 'allow',
    })
    const execSpy = vi.spyOn(toolRegistry, 'execute').mockResolvedValue({ success: true, output: 'ok' })

    await runAgenticToolUse({
      toolUse: {
        id: 'tu-ace-restricted-curl',
        name: 'bash',
        input: { command: 'curl -s https://example.com' },
      },
      signal: new AbortController().signal,
      callbacks: { onToolStart: () => {}, onToolResult: () => {} },
      diffPermissionMode: 'default',
      permissionDefaultMode: 'allow',
      permissionRules: undefined,
      discoveryExclude: new Set(),
      getInlineSkillSession: () => null,
      setInlineSkillSession: () => {},
    })

    expect(reqSpy).toHaveBeenCalled()
    expect(execSpy).toHaveBeenCalled()
  })

  it('ASTRA_KILL_BYPASS_PERMISSIONS downgrades bypassPermissions so write_file prompts', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pole-kill-bp-'))
    const fp = path.join(tmp, 'w.txt')
    setWorkspacePath(tmp)
    vi.stubEnv('ASTRA_KILL_BYPASS_PERMISSIONS', '1')
    setPermissionMode('bypassPermissions')
    const reqSpy = vi.spyOn(interactionState, 'requestPermission').mockResolvedValue({
      behavior: 'allow',
    })
    vi.spyOn(toolRegistry, 'execute').mockImplementation(async () => {
      fs.writeFileSync(fp, 'z', 'utf8')
      return { success: true, output: 'ok' }
    })

    try {
      await runAgenticToolUse({
        toolUse: {
          id: 'tu-kbp',
          name: 'write_file',
          input: { filePath: fp, content: 'z' },
        },
        signal: new AbortController().signal,
        callbacks: { onToolStart: () => {}, onToolResult: () => {} },
        diffPermissionMode: 'default',
        permissionDefaultMode: 'ask',
        permissionRules: undefined,
        discoveryExclude: new Set(),
        getInlineSkillSession: () => null,
        setInlineSkillSession: () => {},
      })
      expect(reqSpy).toHaveBeenCalled()
    } finally {
      setWorkspacePath(null)
      try {
        fs.rmSync(tmp, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
  })

  it('ASTRA_KILL_AUTO_PERMISSION_MODES downgrades acceptEdits so write_file prompts', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pole-kill-auto-'))
    const fp = path.join(tmp, 'w.txt')
    setWorkspacePath(tmp)
    vi.stubEnv('ASTRA_KILL_AUTO_PERMISSION_MODES', '1')
    setPermissionMode('acceptEdits')
    const reqSpy = vi.spyOn(interactionState, 'requestPermission').mockResolvedValue({
      behavior: 'allow',
    })
    vi.spyOn(toolRegistry, 'execute').mockImplementation(async () => {
      fs.writeFileSync(fp, 'z', 'utf8')
      return { success: true, output: 'ok' }
    })

    try {
      await runAgenticToolUse({
        toolUse: {
          id: 'tu-kauto',
          name: 'write_file',
          input: { filePath: fp, content: 'z' },
        },
        signal: new AbortController().signal,
        callbacks: { onToolStart: () => {}, onToolResult: () => {} },
        diffPermissionMode: 'default',
        permissionDefaultMode: 'ask',
        permissionRules: undefined,
        discoveryExclude: new Set(),
        getInlineSkillSession: () => null,
        setInlineSkillSession: () => {},
      })
      expect(reqSpy).toHaveBeenCalled()
    } finally {
      setWorkspacePath(null)
      try {
        fs.rmSync(tmp, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
  })

  it('auto mode skips permission UI for safe read-only bash', async () => {
    setPermissionMode('auto')
    const reqSpy = vi.spyOn(interactionState, 'requestPermission')
    const execSpy = vi.spyOn(toolRegistry, 'execute').mockResolvedValue({ success: true, output: 'ok' })

    await runAgenticToolUse({
      toolUse: {
        id: 'tu-auto-ls',
        name: 'bash',
        input: { command: 'ls -la' },
      },
      signal: new AbortController().signal,
      callbacks: { onToolStart: () => {}, onToolResult: () => {} },
      diffPermissionMode: 'default',
      permissionDefaultMode: 'ask',
      permissionRules: undefined,
      discoveryExclude: new Set(),
      getInlineSkillSession: () => null,
      setInlineSkillSession: () => {},
    })

    expect(reqSpy).not.toHaveBeenCalled()
    expect(execSpy).toHaveBeenCalled()
  })

  it('auto mode prompts for inline python (stage2 heuristic)', async () => {
    setPermissionMode('auto')
    const reqSpy = vi.spyOn(interactionState, 'requestPermission').mockResolvedValue({
      behavior: 'allow',
    })
    const execSpy = vi.spyOn(toolRegistry, 'execute').mockResolvedValue({ success: true, output: 'ok' })

    await runAgenticToolUse({
      toolUse: {
        id: 'tu-auto-py',
        name: 'bash',
        input: { command: 'python3 -c "print(1)"' },
      },
      signal: new AbortController().signal,
      callbacks: { onToolStart: () => {}, onToolResult: () => {} },
      diffPermissionMode: 'default',
      permissionDefaultMode: 'ask',
      permissionRules: undefined,
      discoveryExclude: new Set(),
      getInlineSkillSession: () => null,
      setInlineSkillSession: () => {},
    })

    expect(reqSpy).toHaveBeenCalled()
    expect(execSpy).toHaveBeenCalled()
  })

  it('auto mode prompts for mutating bash (mkdir)', async () => {
    setPermissionMode('auto')
    const reqSpy = vi.spyOn(interactionState, 'requestPermission').mockResolvedValue({
      behavior: 'allow',
    })
    const execSpy = vi.spyOn(toolRegistry, 'execute').mockResolvedValue({ success: true, output: 'ok' })

    await runAgenticToolUse({
      toolUse: {
        id: 'tu-auto-mkdir',
        name: 'bash',
        input: { command: 'mkdir -p subdir' },
      },
      signal: new AbortController().signal,
      callbacks: { onToolStart: () => {}, onToolResult: () => {} },
      diffPermissionMode: 'default',
      permissionDefaultMode: 'ask',
      permissionRules: undefined,
      discoveryExclude: new Set(),
      getInlineSkillSession: () => null,
      setInlineSkillSession: () => {},
    })

    expect(reqSpy).toHaveBeenCalled()
    expect(execSpy).toHaveBeenCalled()
  })
})
