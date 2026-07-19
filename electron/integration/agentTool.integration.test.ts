/**
 * AC-1.1: Agent tool — production stack from {@link runAgenticToolUse} through
 * {@link createAgentTool} → {@link runSubAgent} → {@link runAgenticLoop} (mocked `streamText`, no network).
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { runAgenticToolUse } from '../ai/runAgenticToolUse'
import { runWithAgentContextAsync, type AgentContext } from '../agents/agentContext'
import { rebuildAgentDefinitions, toolRegistry } from '../tools/registry'
import { setPermissionMode } from '../ai/interactionState'

vi.mock('../ai/client', () => ({
  streamText: vi.fn(async (_config: unknown, _params: unknown, callbacks: {
    onTextDelta: (s: string) => void
    onMessageEnd?: (u: { inputTokens?: number; outputTokens?: number }) => void
  }) => {
    callbacks.onTextDelta('## Summary\nAgent tool integration OK.')
    callbacks.onMessageEnd?.({ inputTokens: 10, outputTokens: 20 })
  }),
}))

function parentAgentContext(): AgentContext {
  return {
    config: { id: 'anthropic', name: 'anthropic', apiKey: 'test-key' },
    model: 'claude-sonnet-4-20250514',
    systemPrompt: 'parent system prompt',
    messages: [],
    signal: new AbortController().signal,
    agentId: 'parent-ac-1-1',
    streamConversationId: 'conv-ac-1-1',
    sessionAgentType: 'general-purpose',
  }
}

describe('Agent tool integration (AC-1.1)', () => {
  beforeEach(() => {
    rebuildAgentDefinitions(null, undefined)
  })

  afterEach(() => {
    vi.clearAllMocks()
    setPermissionMode('default')
  })

  it('executes Agent tool via runAgenticToolUse and completes Explore sub-agent (mock stream)', async () => {
    setPermissionMode('default')
    expect(toolRegistry.get('Agent')).toBeTruthy()

    const toolStarts: string[] = []
    const toolResults: Array<{ success: boolean; error?: string }> = []

    await runWithAgentContextAsync(parentAgentContext(), async () => {
      const out = await runAgenticToolUse({
        toolUse: {
          id: 'tu-agent-ac11',
          name: 'Agent',
          input: {
            description: 'Probe sub-agent',
            prompt: 'Reply with one section only.',
            subagent_type: 'Explore',
          },
        },
        signal: new AbortController().signal,
        callbacks: {
          onToolStart: (t) => toolStarts.push(t.name),
          onToolResult: (r) => toolResults.push({ success: r.success, error: r.error }),
        },
        diffPermissionMode: 'default',
        permissionDefaultMode: 'ask',
        permissionRules: [],
        discoveryExclude: new Set(),
        getInlineSkillSession: () => null,
        setInlineSkillSession: () => {},
      })

      expect(out.type).toBe('tool_result')
      const content = String((out as { content?: string }).content)
      expect(content).toMatch(/Agent tool integration OK/i)

      const parsed = JSON.parse(content) as { success?: boolean; output?: string }
      expect(parsed.success !== false).toBe(true)
      expect(String(parsed.output ?? '')).toMatch(/Agent tool integration OK/i)
    })

    expect(toolStarts).toEqual(['Agent'])
    expect(toolResults).toHaveLength(1)
    expect(toolResults[0]?.success).toBe(true)
  })

  it('rejects allowed_subagent_types mismatch before sub-agent loop', async () => {
    setPermissionMode('default')

    await runWithAgentContextAsync(parentAgentContext(), async () => {
      const out = await runAgenticToolUse({
        toolUse: {
          id: 'tu-agent-allowlist',
          name: 'Agent',
          input: {
            description: 'Wrong allowlist',
            prompt: 'Task',
            subagent_type: 'Explore',
            allowed_subagent_types: ['Plan', 'Debug'],
          },
        },
        signal: new AbortController().signal,
        callbacks: {
          onToolStart: () => {},
          onToolResult: () => {},
        },
        diffPermissionMode: 'default',
        permissionDefaultMode: 'ask',
        permissionRules: [],
        discoveryExclude: new Set(),
        getInlineSkillSession: () => null,
        setInlineSkillSession: () => {},
      })

      expect(out.type).toBe('tool_result')
      const content = String((out as { content?: string }).content)
      expect(content).toMatch(/Error:/i)
      expect(content).toMatch(/not in allowed_subagent_types/i)
    })
  })
})
