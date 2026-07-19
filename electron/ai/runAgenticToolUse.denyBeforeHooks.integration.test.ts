/**
 * AC-5.4: Settings deny must block before PreToolUse / PermissionRequest hooks run.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import * as hookEngine from '../tools/hooks/engine'
import { runAgenticToolUse } from './runAgenticToolUse'
import { setPermissionMode } from './interactionState'

describe('runAgenticToolUse deny before hooks (integration)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    setPermissionMode('default')
  })

  it('does not invoke runHooks or runPermissionRequestHooks when deny rule matches read_file', async () => {
    const runHooksSpy = vi.spyOn(hookEngine, 'runHooks')
    const permSpy = vi.spyOn(hookEngine, 'runPermissionRequestHooks')

    const out = await runAgenticToolUse({
      toolUse: {
        id: 'tu-deny-hooks',
        name: 'read_file',
        input: { filePath: 'package.json' },
      },
      signal: new AbortController().signal,
      callbacks: {
        onToolStart: () => {},
        onToolResult: () => {},
      },
      diffPermissionMode: 'default',
      permissionDefaultMode: 'ask',
      permissionRules: [{ id: 'block-read', pattern: 'read_file', mode: 'deny' }],
      discoveryExclude: new Set(),
      getInlineSkillSession: () => null,
      setInlineSkillSession: () => {},
    })

    expect(out.type).toBe('tool_result')
    expect(String((out as { content?: string }).content)).toMatch(/Permission denied/i)
    // PermissionDenied hook fires (correct behavior); PreToolUse must NOT fire.
    const preToolUseCalls = runHooksSpy.mock.calls.filter(
      (args) => args[0] === 'PreToolUse',
    )
    expect(preToolUseCalls).toHaveLength(0)
    expect(permSpy).not.toHaveBeenCalled()
  })
})
