import { describe, it, expect, beforeEach } from 'vitest'
import {
  getContextManagerForConversation,
  peekContextManagerForConversation,
  resetConversationContextDisplay,
  updateConversationContextDisplay,
} from './conversationDisplayState'
import { contextManager, DEFAULT_THRESHOLDS } from './manager'

describe('per-conversation ContextManager scope (audit feature)', () => {
  beforeEach(() => {
    resetConversationContextDisplay()
    contextManager.updateThresholds(DEFAULT_THRESHOLDS)
  })

  it('returns distinct manager instances per conversation id', () => {
    const a = getContextManagerForConversation('conv-a')
    const b = getContextManagerForConversation('conv-b')
    expect(a).not.toBe(b)
    // Same id returns the same instance.
    const a2 = getContextManagerForConversation('conv-a')
    expect(a).toBe(a2)
  })

  it('peek returns undefined for unknown conversation, populated after create', () => {
    expect(peekContextManagerForConversation('never-seen')).toBeUndefined()
    getContextManagerForConversation('populated')
    expect(peekContextManagerForConversation('populated')).toBeDefined()
  })

  it('empty id falls back to global singleton', () => {
    const fallback = getContextManagerForConversation('')
    expect(fallback).toBe(contextManager)
  })

  it('thresholds from global propagate on access', () => {
    contextManager.updateThresholds({ warningTokens: 12345 })
    const a = getContextManagerForConversation('conv-threshold')
    // First creation seeds from global …
    expect(a.getThresholds().warningTokens).toBe(12345)
    // … and subsequent access re-aligns if global moved.
    contextManager.updateThresholds({ warningTokens: 99999 })
    const a2 = getContextManagerForConversation('conv-threshold')
    expect(a2.getThresholds().warningTokens).toBe(99999)
  })

  it('per-conversation state is isolated', () => {
    updateConversationContextDisplay(
      'conv-alpha',
      [{ role: 'user', content: 'x'.repeat(DEFAULT_THRESHOLDS.warningTokens * 4 + 100) }],
      '',
      0,
    )
    updateConversationContextDisplay('conv-beta', [{ role: 'user', content: 'short' }], '', 0)
    const alpha = getContextManagerForConversation('conv-alpha')
    const beta = getContextManagerForConversation('conv-beta')
    expect(alpha.getState().level).toBe('warning')
    expect(beta.getState().level).toBe('ok')
  })

  it('reset-all clears scoped managers + resets singleton', () => {
    getContextManagerForConversation('conv-A')
    getContextManagerForConversation('conv-B')
    expect(peekContextManagerForConversation('conv-A')).toBeDefined()
    resetConversationContextDisplay()
    expect(peekContextManagerForConversation('conv-A')).toBeUndefined()
    expect(peekContextManagerForConversation('conv-B')).toBeUndefined()
  })

  it('reset(id) clears only that scope', () => {
    getContextManagerForConversation('conv-X')
    getContextManagerForConversation('conv-Y')
    resetConversationContextDisplay('conv-X')
    expect(peekContextManagerForConversation('conv-X')).toBeUndefined()
    expect(peekContextManagerForConversation('conv-Y')).toBeDefined()
  })
})
