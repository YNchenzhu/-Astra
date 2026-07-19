import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  beginHookLlmExecution,
  endHookLlmExecution,
  getHookLlmNestingDepth,
  resolveHookPromptTemplate,
  shouldDeferPromptOrAgentHook,
  withHookLlmFrame,
} from './hookLlmExecution'

describe('hookLlmExecution', () => {
  it('defers prompt/agent only when nested', () => {
    // Outside any frame: depth is 0 regardless of begin calls.
    expect(shouldDeferPromptOrAgentHook('prompt')).toBe(false)
    expect(shouldDeferPromptOrAgentHook('command')).toBe(false)

    // Inside a frame: depth tracking is per-async-chain (audit #7).
    withHookLlmFrame(() => {
      beginHookLlmExecution()
      expect(shouldDeferPromptOrAgentHook('prompt')).toBe(true)
      expect(shouldDeferPromptOrAgentHook('agent')).toBe(true)
      expect(shouldDeferPromptOrAgentHook('command')).toBe(false)
      endHookLlmExecution()
      expect(getHookLlmNestingDepth()).toBe(0)
    })

    // After the frame returns, depth goes back to 0 for the outer scope.
    expect(shouldDeferPromptOrAgentHook('prompt')).toBe(false)
  })

  it('isolates depth across concurrent async chains', async () => {
    // Audit #7 — a global counter would leak between chains. Each `withHookLlmFrame`
    // should see its own counter without interfering with concurrent frames.
    const results: boolean[] = []
    await Promise.all([
      withHookLlmFrame(async () => {
        beginHookLlmExecution()
        await new Promise((r) => setTimeout(r, 10))
        results.push(shouldDeferPromptOrAgentHook('prompt'))
        endHookLlmExecution()
      }) as Promise<void>,
      withHookLlmFrame(async () => {
        // Don't begin in this chain — it must see depth=0 even while the
        // other chain has depth=1 running concurrently.
        results.push(shouldDeferPromptOrAgentHook('prompt'))
      }) as Promise<void>,
    ])
    expect(results).toContain(true)
    expect(results).toContain(false)
  })

  it('substitutes env placeholders in inline template', () => {
    const s = resolveHookPromptTemplate('Event $CLAUDE_HOOK_EVENT', '/tmp', {
      CLAUDE_HOOK_EVENT: 'PreToolUse',
      CLAUDE_TOOL_INPUT: '{}',
      CLAUDE_HOOK_STDIN_JSON: '{"hook_event_name":"PreToolUse"}',
      CLAUDE_TOOL_NAME: '',
      CLAUDE_CWD: '/tmp',
      CLAUDE_PROJECT_DIR: '/tmp',
      CLAUDE_TOOL_OUTPUT: '',
      CLAUDE_TOOL_SUCCESS: '',
    })
    expect(s).toContain('Event PreToolUse')
    expect(s).toContain('hook_event_name')
  })

  it('substitutes $ARGUMENTS with stdin JSON', () => {
    const stdin = '{"session_id":"x","hook_event_name":"PreToolUse"}'
    const s = resolveHookPromptTemplate('Input: $ARGUMENTS', '/tmp', {
      CLAUDE_HOOK_EVENT: 'PreToolUse',
      CLAUDE_TOOL_INPUT: '{}',
      CLAUDE_HOOK_STDIN_JSON: stdin,
      CLAUDE_TOOL_NAME: '',
      CLAUDE_CWD: '/tmp',
      CLAUDE_PROJECT_DIR: '/tmp',
      CLAUDE_TOOL_OUTPUT: '',
      CLAUDE_TOOL_SUCCESS: '',
    })
    expect(s.trim()).toBe(`Input: ${stdin}`)
  })

  it('reads @file: under cwd', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-llm-'))
    try {
      fs.writeFileSync(path.join(dir, 'p.md'), 'hello ${CLAUDE_TOOL_NAME}', 'utf-8')
      const body = resolveHookPromptTemplate('@file:p.md', dir, {
        CLAUDE_HOOK_EVENT: '',
        CLAUDE_TOOL_INPUT: '{}',
        CLAUDE_TOOL_NAME: 'Read',
        CLAUDE_CWD: dir,
        CLAUDE_PROJECT_DIR: dir,
        CLAUDE_TOOL_OUTPUT: '',
        CLAUDE_TOOL_SUCCESS: '',
      })
      expect(body).toBe('hello Read')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects path escape', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-llm-'))
    try {
      expect(() =>
        resolveHookPromptTemplate('@file:../outside', dir, {
          CLAUDE_HOOK_EVENT: '',
          CLAUDE_TOOL_INPUT: '{}',
          CLAUDE_TOOL_NAME: '',
          CLAUDE_CWD: dir,
          CLAUDE_PROJECT_DIR: dir,
          CLAUDE_TOOL_OUTPUT: '',
          CLAUDE_TOOL_SUCCESS: '',
        }),
      ).toThrow(/escapes cwd/)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
