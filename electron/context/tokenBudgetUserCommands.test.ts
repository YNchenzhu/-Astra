import { describe, it, expect } from 'vitest'
import {
  applyPoleOutputTokenBudgetFromUserText,
  extractLastUserTurnPlainText,
  getPoleOutputBudgetBlockMessage,
  parsePoleOutputTokenBudgetAdditions,
} from './tokenBudgetUserCommands'
import {
  getAgentContext,
  runWithAgentContext,
  type AgentContext,
} from '../agents/agentContext'
import { resetPostCompactCleanupDedupeForTests } from '../agents/postCompactCleanup'

function mainCtx(over?: Partial<AgentContext>): AgentContext {
  return {
    config: { id: 'anthropic', name: 'a', apiKey: 'k' },
    model: 'm',
    systemPrompt: 's',
    messages: [],
    signal: new AbortController().signal,
    agentId: 'main',
    ...over,
  }
}

describe('tokenBudgetUserCommands §3.5', () => {
  it('parsePoleOutputTokenBudgetAdditions sums +k / +m / use … tokens', () => {
    expect(parsePoleOutputTokenBudgetAdditions('hi +500k there')).toBe(500_000)
    expect(parsePoleOutputTokenBudgetAdditions('use 2m tokens please')).toBe(2_000_000)
    expect(parsePoleOutputTokenBudgetAdditions('+1k use 1m tokens')).toBe(1_000 + 1_000_000)
  })

  it('extractLastUserTurnPlainText prefers trailing user with text blocks', () => {
    const messages: Array<Record<string, unknown>> = [
      { role: 'user', content: 'old' },
      { role: 'assistant', content: 'a' },
      {
        role: 'user',
        content: [{ type: 'text', text: 'tail line' }],
      },
    ]
    expect(extractLastUserTurnPlainText(messages)).toBe('tail line')
  })

  it('apply + getPoleOutputBudgetBlockMessage respect main ceiling', () => {
    resetPostCompactCleanupDedupeForTests()
    runWithAgentContext(mainCtx({ poleOutputTokenBudgetUsed: 0 }), () => {
      applyPoleOutputTokenBudgetFromUserText('use 10k tokens')
      const ctx = getAgentContext()!
      expect(ctx.poleOutputTokenBudgetCeiling).toBe(10_000)
      expect(getPoleOutputBudgetBlockMessage()).toBeNull()
    })
    runWithAgentContext(
      mainCtx({ poleOutputTokenBudgetCeiling: 100, poleOutputTokenBudgetUsed: 100 }),
      () => {
        expect(getPoleOutputBudgetBlockMessage()).not.toBeNull()
      },
    )
    runWithAgentContext(
      mainCtx({
        poleOutputTokenBudgetCeiling: 100,
        poleOutputTokenBudgetUsed: 50,
        poleCompactConsumedInputEstimate: 60,
      }),
      () => {
        expect(getPoleOutputBudgetBlockMessage()).toBeNull()
      },
    )
  })
})
