/**
 * upstream 报告第三章 / AC-3.x — 子智能体生命周期可自动化子集：
 * 侧链清理、Todo 分桶清理、async_agent 权限（dontAsk / bubble）、文本侧链摘要。
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { runSubAgent } from '../agents/subAgentRunner'
import { EXPLORE_AGENT } from '../agents/builtInAgents'
import { finalizeSubAgentLifecycle } from '../agents/subAgentLifecycleCleanup'
import { getSubAgentSidechainTranscript } from '../agents/subAgentSidechainTranscript'
import { setTodos, getTodos } from '../tools/TodoWriteTool'
import { runWithAgentContextAsync, type AgentContext } from '../agents/agentContext'
import { resolveSubAgentPermissionOverride } from '../agents/resolveSubAgentPermissionOverride'
import { getPermissionMode } from '../ai/interactionState'

vi.mock('../ai/client', () => ({
  streamText: vi.fn(async (_config, _params, callbacks) => {
    callbacks.onTextDelta('## Summary\nChapter 3 lifecycle OK.')
    callbacks.onMessageEnd?.({ inputTokens: 1, outputTokens: 2 })
  }),
}))

function minimalCtx(override: Partial<AgentContext>): AgentContext {
  const ac = new AbortController()
  return {
    config: { id: 'anthropic', name: 'anthropic', apiKey: 'k' },
    model: 'claude-sonnet-4-20250514',
    systemPrompt: 'sys',
    messages: [],
    signal: ac.signal,
    agentId: 'parent',
    ...override,
  } as AgentContext
}

describe('Chapter 3 agent lifecycle (integration subset)', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('finalizeSubAgentLifecycle clears todo bucket and sidechain for an id', async () => {
    const id = 'lifecycle-cleanup-test'
    setTodos(id, [{ content: 't', status: 'pending', activeForm: 'doing t' }])
    await finalizeSubAgentLifecycle(id)
    expect(getTodos(id)).toEqual([])
    expect(getSubAgentSidechainTranscript(id)).toEqual([])
  })

  it('runSubAgent clears sidechain in finally after completion', async () => {
    let capturedId = ''
    const ac = new AbortController()
    const result = await runSubAgent({
      config: { id: 'anthropic', name: 'anthropic', apiKey: 'test-key' },
      model: 'claude-sonnet-4-20250514',
      agentDef: EXPLORE_AGENT,
      prompt: 'One line.',
      signal: ac.signal,
      onEvent: (e) => {
        if (e.type === 'subagent_start') capturedId = e.agentId
      },
    })
    expect(result.success).toBe(true)
    expect(capturedId.length).toBeGreaterThan(0)
    expect(getSubAgentSidechainTranscript(capturedId)).toEqual([])
  })

  it('Explore async_profile resolves to dontAsk inside ALS (§3.2)', async () => {
    const mode = resolveSubAgentPermissionOverride({
      agentDef: EXPLORE_AGENT,
      runInBackground: false,
      parentEffectiveMode: 'default',
    })
    await runWithAgentContextAsync(
      minimalCtx({ permissionModeOverride: mode }),
      async () => {
        expect(getPermissionMode()).toBe('dontAsk')
      },
    )
  })

  it('Explore with bubble inherits parent effective mode', async () => {
    const def = { ...EXPLORE_AGENT, permissionMode: 'bubble' as const }
    const mode = resolveSubAgentPermissionOverride({
      agentDef: def,
      runInBackground: false,
      parentEffectiveMode: 'acceptEdits',
    })
    await runWithAgentContextAsync(
      minimalCtx({ permissionModeOverride: mode }),
      async () => {
        expect(getPermissionMode()).toBe('acceptEdits')
      },
    )
  })
})
