import { describe, expect, it } from 'vitest'
import { buildContextBreakdown } from './contextBreakdown'

describe('buildContextBreakdown', () => {
  it('categorizes injected context instead of returning only a total', () => {
    const breakdown = buildContextBreakdown({
      systemPrompt: 'You are a coding agent.',
      toolTokens: 120,
      totalTokens: 1000,
      anchored: true,
      apiMessages: [
        {
          role: 'user',
          content: `# Today's date
Today's date is 2026-05-20.

# Project Memory
<project-memory>
Use npm run typecheck for this repository.
</project-memory>

# Current Session
<session-context>
State: investigating context usage.
</session-context>

# Skill index (compact)
- **/debug** — Diagnose issues

IMPORTANT: background context only.`,
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', content: 'large command output' }],
        },
        {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'prior reasoning' }],
        },
      ],
    })

    const byId = new Map(breakdown.categories.map((cat) => [cat.id, cat.tokens]))
    expect(breakdown.accuracy).toBe('anchored')
    expect(byId.get('system_prompt')).toBeGreaterThan(0)
    expect(byId.get('tool_schemas')).toBe(120)
    expect(byId.get('memory')).toBeGreaterThan(0)
    expect(byId.get('session')).toBeGreaterThan(0)
    expect(byId.get('skills')).toBeGreaterThan(0)
    expect(byId.get('tool_results')).toBeGreaterThan(0)
    expect(byId.get('thinking')).toBeGreaterThan(0)
  })

  it('drops negative server/anchor reconciliation so category percentages stay ≤ 100%', () => {
    const breakdown = buildContextBreakdown({
      systemPrompt: 'a'.repeat(4000),
      toolTokens: 0,
      totalTokens: 100,
      anchored: true,
      apiMessages: [],
    })

    expect(breakdown.categories.find((c) => c.id === 'reconciled_total')).toBeUndefined()
    const sum = breakdown.categories.reduce((acc, cat) => acc + cat.percentOfTotal, 0)
    expect(sum).toBeGreaterThan(0)
  })

  it('surfaces positive reconciliation when server reports more tokens than heuristic', () => {
    const breakdown = buildContextBreakdown({
      systemPrompt: 'short',
      toolTokens: 10,
      totalTokens: 5_000,
      anchored: true,
      apiMessages: [{ role: 'user', content: 'hi' }],
    })

    const reconciled = breakdown.categories.find((c) => c.id === 'reconciled_total')
    expect(reconciled?.tokens).toBeGreaterThan(0)
  })

  it('surfaces prompt-cache usage separately from content categories', () => {
    const breakdown = buildContextBreakdown({
      systemPrompt: 'cached prefix',
      toolTokens: 0,
      totalTokens: 1_500,
      anchored: true,
      usageSnapshot: {
        input_tokens: 300,
        output_tokens: 40,
        cache_creation_input_tokens: 200,
        cache_read_input_tokens: 1_000,
      },
      apiMessages: [{ role: 'user', content: 'hello' }],
    })

    expect(breakdown.cache).toEqual({
      inputTokens: 300,
      outputTokens: 40,
      cacheCreationInputTokens: 200,
      cacheReadInputTokens: 1_000,
      cachedInputTokens: 1_200,
      cacheHitRate: (1_000 / 1_500) * 100,
    })
  })
})
