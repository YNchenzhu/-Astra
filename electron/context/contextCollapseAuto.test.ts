import { describe, it, expect } from 'vitest'
import { autoFoldOldestMessagesForContextCollapse } from './contextCollapseAuto'
import { DEFAULT_THRESHOLDS } from './manager'

describe('contextCollapseAuto', () => {
  it('returns null when POLE_CONTEXT_COLLAPSE_AUTO is unset', async () => {
    const prev = process.env.POLE_CONTEXT_COLLAPSE_AUTO
    delete process.env.POLE_CONTEXT_COLLAPSE_AUTO
    const msgs = Array.from({ length: 14 }, (_, i) => ({
      role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: 'x'.repeat(200),
    })) as Array<Record<string, unknown>>
    const r = await autoFoldOldestMessagesForContextCollapse({
      messages: msgs,
      systemPrompt: '',
      thresholds: DEFAULT_THRESHOLDS,
      toolDefsTokens: 0,
      config: { id: 'anthropic', name: 'Anthropic', apiKey: 'x' },
      model: 'claude-sonnet-4-20250514',
      signal: new AbortController().signal,
      collapseConversationKey: 'ws::c1',
    })
    expect(r).toBeNull()
    if (prev === undefined) delete process.env.POLE_CONTEXT_COLLAPSE_AUTO
    else process.env.POLE_CONTEXT_COLLAPSE_AUTO = prev
  })
})
