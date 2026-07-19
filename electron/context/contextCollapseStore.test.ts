import { describe, expect, it, beforeEach } from 'vitest'
import {
  appendContextCollapseSummary,
  buildContextCollapseConversationKey,
  clearContextCollapseStoreForTests,
  consumeContextCollapseSummaries,
} from './contextCollapseStore'
import { drainContextCollapseForReactiveCompact } from './contextCollapseDrain'

beforeEach(() => {
  clearContextCollapseStoreForTests()
})

describe('contextCollapseStore', () => {
  it('buildContextCollapseConversationKey joins workspace + id', () => {
    expect(buildContextCollapseConversationKey('/w', 'c1')).toBe('/w::c1')
    expect(buildContextCollapseConversationKey(undefined, 'c1')).toBe('::c1')
    expect(buildContextCollapseConversationKey('/w', undefined)).toBeUndefined()
  })

  it('consume drains summaries for reactive inject', () => {
    const k = 'ws::conv'
    appendContextCollapseSummary(k, 'alpha')
    appendContextCollapseSummary(k, 'beta')
    const msgs = [{ role: 'user', content: 'tail' }] as Array<Record<string, unknown>>
    const out = drainContextCollapseForReactiveCompact(msgs, { conversationKey: k })
    expect(out.length).toBe(2)
    expect(String(out[0].content)).toContain('alpha')
    expect(String(out[0].content)).toContain('beta')
    expect(out[1]).toBe(msgs[0])
    expect(consumeContextCollapseSummaries(k)).toEqual([])
  })
})
