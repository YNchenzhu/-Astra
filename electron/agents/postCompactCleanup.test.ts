import { describe, it, expect } from 'vitest'
import { postCompactCleanup, resetPostCompactCleanupDedupeForTests } from './postCompactCleanup'
import { getAgentContext, runWithAgentContext, type AgentContext } from './agentContext'

function mainCtx(): AgentContext {
  return {
    config: { id: 'anthropic', name: 'a', apiKey: 'k' },
    model: 'm',
    systemPrompt: 's',
    messages: [],
    signal: new AbortController().signal,
    agentId: 'main',
    streamConversationId: 'c1',
  }
}

describe('postCompactCleanup §17.3', () => {
  it('dedupeKey prevents double ceiling extension', () => {
    resetPostCompactCleanupDedupeForTests()
    runWithAgentContext(mainCtx(), () => {
      postCompactCleanup('micro', {
        dedupeKey: 'c1|micro|3|8000',
        outputBudgetCeilingExtension: 100,
      })
      expect(getAgentContext()?.poleCompactConsumedInputEstimate).toBe(100)
      postCompactCleanup('micro', {
        dedupeKey: 'c1|micro|3|8000',
        outputBudgetCeilingExtension: 100,
      })
      expect(getAgentContext()?.poleCompactConsumedInputEstimate).toBe(100)
    })
  })

  it('applies credit to sub-agent ALS (P2-2 fix)', () => {
    resetPostCompactCleanupDedupeForTests()
    const sub: AgentContext = { ...mainCtx(), agentId: 'worker-1' }
    runWithAgentContext(sub, () => {
      postCompactCleanup('auto', { outputBudgetCeilingExtension: 999 })
      // P2-2 — sub-agents now receive compact credit so they don't run out
      // of output budget mid-task after compaction.
      expect(getAgentContext()?.poleCompactConsumedInputEstimate).toBe(999)
    })
  })
})
