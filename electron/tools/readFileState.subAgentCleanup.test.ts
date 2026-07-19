import { describe, it, expect, afterEach } from 'vitest'
import { runWithAgentContext, type AgentContext } from '../agents/agentContext'
import type { ProviderConfig } from '../ai/client'
import {
  clearAllReadFileState,
  clearReadFileStateForSubAgent,
  recordSuccessfulRead,
  tryConsumeReadDedup,
} from './readFileState'

const cfg: ProviderConfig = { id: 'anthropic', name: 't', apiKey: '' }

function ctx(agentId: string, conv?: string): AgentContext {
  return {
    config: cfg,
    model: 'm',
    systemPrompt: '',
    messages: [],
    signal: new AbortController().signal,
    agentId,
    streamConversationId: conv,
  }
}

describe('readFileState sub-agent scope cleanup', () => {
  afterEach(() => {
    clearAllReadFileState()
  })

  it('clearReadFileStateForSubAgent removes only that conv+agent bucket', () => {
    const p = 'C:/tmp/read-scope-test.txt'.replace(/\\/g, '/')
    const readOpts = {
      mtimeMs: 1,
      isPartialView: false,
      fullFileContent: 'x',
      readOffset: 0,
      readLimit: 2000,
    } as const
    runWithAgentContext(ctx('agent-a', 'conv-1'), () => {
      recordSuccessfulRead(p, { ...readOpts, mtimeMs: 1, fullFileContent: 'a' })
    })
    runWithAgentContext(ctx('agent-b', 'conv-1'), () => {
      recordSuccessfulRead(p, { ...readOpts, mtimeMs: 2, fullFileContent: 'b' })
    })

    clearReadFileStateForSubAgent('agent-a', 'conv-1')

    runWithAgentContext(ctx('agent-a', 'conv-1'), () => {
      expect(tryConsumeReadDedup(p, 1, 0, 2000)).toMatchObject({ dedup: false })
    })
    runWithAgentContext(ctx('agent-b', 'conv-1'), () => {
      expect(tryConsumeReadDedup(p, 2, 0, 2000)).toMatchObject({ dedup: true })
    })
  })
})
