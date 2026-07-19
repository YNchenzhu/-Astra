import { describe, expect, it, vi, afterEach } from 'vitest'
import { execHook } from './execCommand'
import type { HookResult } from './types'

describe('execHook http kind', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('POSTs CLAUDE_TOOL_INPUT to URL and parses JSON stdout', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () =>
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow',
          },
        }),
    })) as unknown as typeof fetch

    const r = (await execHook({
      command: 'https://hooks.example/hook',
      executionKind: 'http',
      cwd: process.cwd(),
      env: {
        CLAUDE_HOOK_EVENT: 'PreToolUse',
        CLAUDE_TOOL_NAME: 'Read',
        CLAUDE_TOOL_INPUT: '{"path":"a"}',
        CLAUDE_TOOL_OUTPUT: '',
        CLAUDE_CWD: process.cwd(),
        CLAUDE_PROJECT_DIR: process.cwd(),
      },
    })) as HookResult

    expect(r.exitCode).toBe(0)
    expect(r.parsedOutput?.permissionDecision).toBe('allow')
    expect(globalThis.fetch).toHaveBeenCalled()
  })

  it('POST body prefers CLAUDE_HOOK_STDIN_JSON over CLAUDE_TOOL_INPUT', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(init?.body).toBe('{"hook_event_name":"PreToolUse","x":1}')
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => '{}',
      }
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await execHook({
      command: 'https://hooks.example/hook',
      executionKind: 'http',
      cwd: process.cwd(),
      env: {
        CLAUDE_HOOK_EVENT: 'PreToolUse',
        CLAUDE_TOOL_NAME: 'Read',
        CLAUDE_TOOL_INPUT: '{"path":"a"}',
        CLAUDE_HOOK_STDIN_JSON: '{"hook_event_name":"PreToolUse","x":1}',
        CLAUDE_TOOL_OUTPUT: '',
        CLAUDE_CWD: process.cwd(),
        CLAUDE_PROJECT_DIR: process.cwd(),
      },
    })

    expect(fetchMock).toHaveBeenCalled()
  })

  it('rejects non-URL command for http kind', async () => {
    const r = (await execHook({
      command: 'not-a-url',
      executionKind: 'http',
      cwd: process.cwd(),
      env: {
        CLAUDE_HOOK_EVENT: 'X',
        CLAUDE_TOOL_NAME: 't',
        CLAUDE_TOOL_INPUT: '{}',
        CLAUDE_TOOL_OUTPUT: '',
        CLAUDE_CWD: process.cwd(),
        CLAUDE_PROJECT_DIR: process.cwd(),
      },
    })) as HookResult

    expect(r.exitCode).toBe(2)
  })
})
