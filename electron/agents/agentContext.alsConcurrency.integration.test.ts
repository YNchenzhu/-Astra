/**
 * AC-1.11: AsyncLocalStorage isolates agent context across concurrent async chains.
 */

import { describe, it, expect } from 'vitest'
import {
  runWithAgentContextAsync,
  getAgentContext,
  type AgentContext,
} from './agentContext'
import type { ProviderConfig } from '../ai/client'

function stubCtx(agentId: string): AgentContext {
  return {
    config: { id: 'anthropic', name: 'Anthropic', apiKey: '' } as ProviderConfig,
    model: 'x',
    systemPrompt: '',
    messages: [],
    signal: new AbortController().signal,
    agentId,
  }
}

describe('agentContext ALS concurrency (integration)', () => {
  it('nested concurrent branches see distinct agentId', async () => {
    const results = await Promise.all([
      runWithAgentContextAsync(stubCtx('agent-a'), async () => {
        await new Promise((r) => setTimeout(r, 5))
        return getAgentContext()?.agentId
      }),
      runWithAgentContextAsync(stubCtx('agent-b'), async () => {
        await new Promise((r) => setTimeout(r, 2))
        return getAgentContext()?.agentId
      }),
    ])
    expect(results.sort()).toEqual(['agent-a', 'agent-b'])
  })
})
