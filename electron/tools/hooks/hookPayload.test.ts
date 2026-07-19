import { describe, expect, it, vi } from 'vitest'

vi.mock('../../agents/agentContext', () => {
  const mockCtx = {
    config: {},
    model: 'm',
    systemPrompt: '',
    messages: [],
    signal: new AbortController().signal,
    agentId: 'main',
    streamConversationId: 'conv-1',
  }
  return {
    getAgentContext: () => mockCtx,
  }
})

vi.mock('../../ai/interactionState', () => ({
  getPermissionMode: () => 'plan' as const,
}))

vi.mock('../../conversation/service', () => ({
  getConversationFilePathForHooks: (id: string, ws: string) =>
    `/data/conversations/${ws.replace(/[/\\]/g, '_')}/${id}.json`,
}))

vi.mock('../workspaceState', () => ({
  getWorkspacePath: () => '/proj/ws',
}))

import { buildClaudeCodeHookStdinPayload } from './hookPayload'

describe('hookPayload', () => {
  it('builds PreToolUse stdin shape with tool_name and tool_input', () => {
    const p = buildClaudeCodeHookStdinPayload({
      event: 'PreToolUse',
      toolName: 'Bash',
      toolInput: { command: 'npm test' },
      cwd: '/proj',
    })
    expect(p.hook_event_name).toBe('PreToolUse')
    expect(p.session_id).toBe('conv-1')
    expect(p.permission_mode).toBe('plan')
    expect(p.cwd).toBe('/proj')
    expect(p.tool_name).toBe('Bash')
    expect(p.tool_input).toEqual({ command: 'npm test' })
  })

  it('sets transcript_path from conversation file helper', () => {
    const p = buildClaudeCodeHookStdinPayload({
      event: 'UserPromptSubmit',
      toolName: 'user_prompt',
      toolInput: { prompt: 'hi', messageCount: 3 },
      cwd: '/proj',
    })
    expect(String(p.transcript_path)).toContain('conv-1')
    expect(String(p.transcript_path)).toContain('.json')
  })

  it('merges UserPromptSubmit fields', () => {
    const p = buildClaudeCodeHookStdinPayload({
      event: 'UserPromptSubmit',
      toolName: 'user_prompt',
      toolInput: { prompt: 'hi', messageCount: 3 },
      cwd: '/proj',
    })
    expect(p.prompt).toBe('hi')
    expect(p.messageCount).toBe(3)
  })

  it('builds PreSkillUse stdin with tool_name and tool_input', () => {
    const p = buildClaudeCodeHookStdinPayload({
      event: 'PreSkillUse',
      toolName: 'debug',
      toolInput: { skill: 'debug', args: '--verbose', context: 'inline', invoker: 'model' },
      cwd: '/proj',
    })
    expect(p.hook_event_name).toBe('PreSkillUse')
    expect(p.tool_name).toBe('debug')
    expect(p.tool_input).toEqual({
      skill: 'debug',
      args: '--verbose',
      context: 'inline',
      invoker: 'model',
    })
  })
})
