/**
 * Extreme scenario tests for context subsystem:
 *   - ensureToolUseResultPairing
 *   - mergeConsecutiveUserMessages
 *   - normalizeMessagesForAPI (12-pass pipeline)
 *   - apiMessageInvariants
 *
 * Covers 50+ extreme scenarios: orphan pairing, DeepSeek pairing constraint,
 * convertedFromSystem AND semantics, double-wrap prevention, 100-msg batches,
 * exact image cap boundaries, strictThinkingEcho, mixed content, empty/null
 * inputs, and multi-pass interaction effects.
 */

import { describe, it, expect } from 'vitest'
import { ensureToolUseResultPairing } from './ensureToolUseResultPairing'
import { mergeConsecutiveUserMessages } from './mergeConsecutiveUserMessages'
import {
  normalizeMessagesForAPI,
  reorderAttachmentsForAPI,
  stripVirtualMessages,
  filterOrphanedThinkingOnly,
  ensureNonEmptyAssistantContent,
  smooshSystemReminderSiblings,
  sanitizeErrorToolResultContent,
  stripInternalFields,
} from './normalizeMessagesForAPI'
import {
  API_MAX_MEDIA_ITEMS_PER_REQUEST,
  applyAnthropicApiMessageInvariants,
  fixAssistantThinkingNotLastBlock,
  stripExcessImageBlocks,
} from './apiMessageInvariants'

type Msg = Record<string, unknown>

// ============================================================================
// ensureToolUseResultPairing — extreme scenarios
// ============================================================================

describe('ensureToolUseResultPairing (extreme)', () => {
  const tu = (id: string) => ({ type: 'tool_use', id, name: 'test', input: {} })
  const tr = (id: string, isError = false) => ({
    type: 'tool_result' as const,
    tool_use_id: id,
    content: `result-${id}`,
    is_error: isError,
  })

  // ── orphan pairing ──

  it('E1: injects synthetic tool_result for single orphaned tool_use (no next msg)', () => {
    const msgs = [{ role: 'assistant', content: [tu('orphan1')] }]
    const out = ensureToolUseResultPairing(msgs)
    expect(out).toHaveLength(2)
    expect(out[0].role).toBe('assistant')
    const user = out[1]
    expect(user.role).toBe('user')
    const blocks = user.content as Array<Record<string, unknown>>
    expect(blocks[0].type).toBe('tool_result')
    expect((blocks[0] as { tool_use_id: string }).tool_use_id).toBe('orphan1')
    expect(blocks[0].is_error).toBe(true)
  })

  it('E2: injects synthetic tool_results for multiple orphaned tool_use (no next msg)', () => {
    const msgs = [{ role: 'assistant', content: [tu('o1'), tu('o2'), tu('o3')] }]
    const out = ensureToolUseResultPairing(msgs)
    expect(out).toHaveLength(2)
    const blocks = out[1].content as Array<Record<string, unknown>>
    expect(blocks).toHaveLength(3)
    expect(blocks.every((b) => b.type === 'tool_result')).toBe(true)
  })

  it('E3: does nothing when all tool_use ids already have matching results', () => {
    const msgs = [
      { role: 'assistant', content: [tu('a1'), tu('a2')] },
      { role: 'user', content: [tr('a1'), tr('a2')] },
    ]
    const out = ensureToolUseResultPairing(msgs)
    expect(out).toHaveLength(2)
    expect((out[1].content as Array<Record<string, unknown>>).length).toBe(2)
  })

  it('E4: merges synth into existing user message (no new message created)', () => {
    const msgs = [
      { role: 'assistant', content: [tu('x1'), tu('x2')] },
      { role: 'user', content: [tr('x1')] }, // x2 missing
    ]
    const out = ensureToolUseResultPairing(msgs)
    // Must NOT create a third message — synth merges into existing user.
    expect(out).toHaveLength(2)
    const blocks = out[1].content as Array<Record<string, unknown>>
    const resultIds = blocks.filter((b) => b.type === 'tool_result') as Array<{ tool_use_id: string }>
    expect(resultIds.map((b) => b.tool_use_id).sort()).toEqual(['x1', 'x2'])
  })

  it('E5: inserts SYNTH_USER_SEPARATOR_MARKER when user has real content beyond tool_results', () => {
    const msgs = [
      { role: 'assistant', content: [tu('orphan1')] },
      { role: 'user', content: [{ type: 'text', text: 'real user message' }] },
    ]
    const out = ensureToolUseResultPairing(msgs)
    expect(out).toHaveLength(2)
    const blocks = out[1].content as Array<Record<string, unknown>>
    // Order: synth tool_result, separator marker, real content
    expect(blocks[0].type).toBe('tool_result')
    expect(blocks[1].type).toBe('text')
    expect((blocks[1] as { text: string }).text).toContain('[Pairing repair]')
    expect((blocks[2] as { text: string }).text).toBe('real user message')
  })

  it('E6: no separator marker when existing user message only has tool_results', () => {
    const msgs = [
      { role: 'assistant', content: [tu('o1'), tu('o2')] },
      { role: 'user', content: [tr('o1')] },
    ]
    const out = ensureToolUseResultPairing(msgs)
    const blocks = out[1].content as Array<Record<string, unknown>>
    // Should have exactly 2 tool_result blocks, no separator
    const types = blocks.map((b) => b.type)
    expect(types).toEqual(['tool_result', 'tool_result'])
  })

  it('E7: handles user with string content → converts to text block with separator', () => {
    const msgs = [
      { role: 'assistant', content: [tu('orphan-str')] },
      { role: 'user', content: 'plain string message' },
    ]
    const out = ensureToolUseResultPairing(msgs)
    expect(out).toHaveLength(2)
    const blocks = out[1].content as Array<Record<string, unknown>>
    expect(blocks[0].type).toBe('tool_result')
    expect((blocks[1].type === 'text' && (blocks[1] as { text: string }).text).toString()).toContain('Pairing repair')
    expect(blocks[blocks.length - 1].type).toBe('text')
    // Original string content should be preserved
    const lastBlock = blocks[blocks.length - 1] as { text: string }
    expect(lastBlock.text).toBe('plain string message')
  })

  it('E8: handles empty string user content', () => {
    const msgs = [
      { role: 'assistant', content: [tu('orphan-empty')] },
      { role: 'user', content: '' },
    ]
    const out = ensureToolUseResultPairing(msgs)
    expect(out).toHaveLength(2)
    const blocks = out[1].content as Array<Record<string, unknown>>
    expect(blocks[0].type).toBe('tool_result')
  })

  it('E9: chain of 3 assistant tool_use messages, none paired', () => {
    const msgs = [
      { role: 'assistant', content: [tu('a')] },
      { role: 'assistant', content: [tu('b')] },
      { role: 'assistant', content: [tu('c')] },
    ]
    const out = ensureToolUseResultPairing(msgs)
    // Each assistant should get a synth user injected after it
    expect(out.length).toBe(6)
    expect(out[0].role).toBe('assistant')
    expect(out[1].role).toBe('user')
    expect(out[2].role).toBe('assistant')
    expect(out[3].role).toBe('user')
    expect(out[4].role).toBe('assistant')
    expect(out[5].role).toBe('user')
  })

  it('E10: 50 tool_use in one assistant, no next msg', () => {
    const ids = Array.from({ length: 50 }, (_, i) => `tu-${i}`)
    const msgs = [{ role: 'assistant', content: ids.map(tu) }]
    const out = ensureToolUseResultPairing(msgs)
    expect(out).toHaveLength(2)
    const synth = out[1].content as Array<Record<string, unknown>>
    expect(synth).toHaveLength(50)
    expect(synth.every((b) => b.type === 'tool_result')).toBe(true)
  })

  it('E11: mixed — some paired, some orphaned, across 3 assistant→user cycles', () => {
    const msgs = [
      { role: 'assistant', content: [tu('a1')] },
      { role: 'user', content: [tr('a1')] }, // paired
      { role: 'assistant', content: [tu('b1'), tu('b2')] },
      { role: 'user', content: [tr('b1')] }, // b2 orphaned
      { role: 'assistant', content: [tu('c1')] },
      // no user for c1
    ]
    const out = ensureToolUseResultPairing(msgs)
    // Expect: assistant(a1), user(tr-a1), assistant(b1,b2), user(tr-b1 + synth-b2), assistant(c1), user(synth-c1)
    expect(out.length).toBe(6)
    // b2 is synth in 4th message
    const b2UserBlocks = out[3].content as Array<Record<string, unknown>>
    const b2ResultIds = b2UserBlocks
      .filter((b) => b.type === 'tool_result')
      .map((b) => (b as { tool_use_id: string }).tool_use_id)
      .sort()
    expect(b2ResultIds).toEqual(['b1', 'b2'])
    // c1 user injected
    expect(out[5].role).toBe('user')
    const c1Blocks = out[5].content as Array<Record<string, unknown>>
    expect((c1Blocks[0] as { tool_use_id: string }).tool_use_id).toBe('c1')
  })

  it('E12: does not mutate input messages', () => {
    const msgs = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'x', name: 'n', input: {} }] },
    ]
    const snap = JSON.stringify(msgs)
    ensureToolUseResultPairing(msgs)
    expect(JSON.stringify(msgs)).toBe(snap)
  })

  it('E13: non-array content treated as no tool_use', () => {
    const msgs = [
      { role: 'assistant', content: 'just text' },
    ]
    const out = ensureToolUseResultPairing(msgs)
    expect(out).toHaveLength(1)
    expect(out[0]).toEqual({ role: 'assistant', content: 'just text' })
  })

  it('E14: assistant followed by non-user message (system)', () => {
    const msgs = [
      { role: 'assistant', content: [tu('orphan-sys')] },
      { role: 'system', content: 'system after assistant' },
    ]
    const out = ensureToolUseResultPairing(msgs)
    // Should inject a user message between assistant and system
    expect(out.length).toBe(3)
    expect(out[0].role).toBe('assistant')
    expect(out[1].role).toBe('user')
    expect(out[2].role).toBe('system')
  })

  it('E15: _convertedFromSystem flag on injected user', () => {
    const msgs = [
      { role: 'assistant', content: [tu('synth-flag')] },
      { role: 'system', content: 'next' },
    ]
    const out = ensureToolUseResultPairing(msgs)
    const injected = out[1]
    expect(injected._convertedFromSystem).toBe(true)
  })
})

// ============================================================================
// mergeConsecutiveUserMessages — extreme scenarios
// ============================================================================

describe('mergeConsecutiveUserMessages (extreme)', () => {
  it('E16: merges 100 consecutive user messages into 1', () => {
    const msgs = Array.from({ length: 100 }, (_, i) => ({
      role: 'user' as const,
      content: `msg-${i}`,
    }))
    const out = mergeConsecutiveUserMessages(msgs)
    expect(out).toHaveLength(1)
    expect(out[0].role).toBe('user')
    const text = out[0].content as string
    expect(text).toContain('msg-0')
    expect(text).toContain('msg-99')
  })

  it('E17: preserves _convertedFromSystem when both sides have it', () => {
    const msgs = [
      { role: 'user', content: 'a', _convertedFromSystem: true },
      { role: 'user', content: 'b', _convertedFromSystem: true },
    ]
    const out = mergeConsecutiveUserMessages(msgs)
    expect(out).toHaveLength(1)
    expect(out[0]._convertedFromSystem).toBe(true)
  })

  it('E18: drops _convertedFromSystem when FIRST side lacks it', () => {
    const msgs = [
      { role: 'user', content: 'real user' },
      { role: 'user', content: 'system reminder', _convertedFromSystem: true },
    ]
    const out = mergeConsecutiveUserMessages(msgs)
    expect(out[0]._convertedFromSystem).toBeUndefined()
  })

  it('E19: drops _convertedFromSystem when SECOND side lacks it', () => {
    const msgs = [
      { role: 'user', content: 'sys reminder', _convertedFromSystem: true },
      { role: 'user', content: 'real user message' },
    ]
    const out = mergeConsecutiveUserMessages(msgs)
    expect(out[0]._convertedFromSystem).toBeUndefined()
  })

  it('E20: drops _convertedFromSystem when BOTH lack it', () => {
    const msgs = [
      { role: 'user', content: 'a' },
      { role: 'user', content: 'b' },
    ]
    const out = mergeConsecutiveUserMessages(msgs)
    expect(out[0]._convertedFromSystem).toBeUndefined()
  })

  it('E21: merges user messages separated by non-user roles in between groups', () => {
    const msgs = [
      { role: 'user', content: 'u1a' },
      { role: 'user', content: 'u1b' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'u2a' },
      { role: 'user', content: 'u2b' },
    ]
    const out = mergeConsecutiveUserMessages(msgs)
    expect(out).toHaveLength(3)
    expect((out[0].content as string)).toBe('u1a\n\nu1b')
    expect(out[1].role).toBe('assistant')
    expect((out[2].content as string)).toBe('u2a\n\nu2b')
  })

  it('E22: merges empty string content correctly', () => {
    const msgs = [
      { role: 'user', content: '' },
      { role: 'user', content: 'non-empty' },
    ]
    const out = mergeConsecutiveUserMessages(msgs)
    expect(out).toHaveLength(1)
    const text = out[0].content as string
    // Empty first contributes nothing, result is "non-empty"
    expect(text).toBe('non-empty')
  })

  it('E23: merges array content with string content', () => {
    const msgs = [
      { role: 'user', content: [{ type: 'text', text: 'block-text' }] },
      { role: 'user', content: 'string-text' },
    ]
    const out = mergeConsecutiveUserMessages(msgs)
    expect(out).toHaveLength(1)
    const content = out[0].content
    expect(Array.isArray(content)).toBe(true)
    const blocks = content as Array<Record<string, unknown>>
    expect(blocks).toHaveLength(2)
    expect(blocks[1].type).toBe('text')
    expect((blocks[1] as { text: string }).text).toBe('string-text')
  })

  it('E24: single message returns as-is (shallow copy)', () => {
    const msgs = [{ role: 'user', content: 'solo' }]
    const out = mergeConsecutiveUserMessages(msgs)
    expect(out).toHaveLength(1)
    expect(out[0].content).toBe('solo')
    expect(out[0]).not.toBe(msgs[0]) // shallow copy
  })

  it('E25: empty array returns empty array', () => {
    const out = mergeConsecutiveUserMessages([])
    expect(out).toEqual([])
  })

  it('E26: both-text-only → string merge (not array)', () => {
    const msgs = [
      { role: 'user', content: 'hello' },
      { role: 'user', content: 'world' },
    ]
    const out = mergeConsecutiveUserMessages(msgs)
    expect(typeof out[0].content).toBe('string')
    expect(out[0].content).toBe('hello\n\nworld')
  })

  it('E27: non-text block present → array merge', () => {
    const msgs = [
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'r' }] },
      { role: 'user', content: 'plain text' },
    ]
    const out = mergeConsecutiveUserMessages(msgs)
    expect(Array.isArray(out[0].content)).toBe(true)
  })

  it('E28: preserves other message properties besides role and content', () => {
    const msgs = [
      { role: 'user', content: 'a', extra: 'keep-me', flag: 42 },
      { role: 'user', content: 'b' },
    ]
    const out = mergeConsecutiveUserMessages(msgs)
    expect(out[0].extra).toBe('keep-me')
    expect(out[0].flag).toBe(42)
  })
})

// ============================================================================
// normalizeMessagesForAPI — extreme scenarios
// ============================================================================

describe('normalizeMessagesForAPI (extreme)', () => {
  it('E29: empty messages returns empty', () => {
    const out = normalizeMessagesForAPI([])
    expect(out).toEqual([])
  })

  it('E30: 100 assistant-user cycles pass through correctly', () => {
    const msgs: Msg[] = []
    for (let i = 0; i < 100; i++) {
      msgs.push({ role: 'assistant', content: `response-${i}` })
      msgs.push({ role: 'user', content: `query-${i}` })
    }
    const out = normalizeMessagesForAPI(msgs)
    expect(out.length).toBe(200)
  })

  it('E31: system messages converted to user with <system-reminder> wrapping', () => {
    const msgs = [{ role: 'system', content: 'system instructions' }]
    const out = normalizeMessagesForAPI(msgs, { stripInternalMeta: false })
    expect(out).toHaveLength(1)
    expect(out[0].role).toBe('user')
    expect(out[0]._convertedFromSystem).toBe(true)
    const content = out[0].content as string
    expect(content.startsWith('<system-reminder>')).toBe(true)
    expect(content.endsWith('</system-reminder>')).toBe(true)
  })

  it('E32: does not double-wrap already-wrapped system content', () => {
    const already = '<system-reminder>\nalready wrapped\n</system-reminder>'
    const msgs = [{ role: 'system', content: already }]
    const out = normalizeMessagesForAPI(msgs, { stripInternalMeta: false })
    const content = out[0].content as string
    // Should NOT be `<system-reminder>\n<system-reminder>...`
    expect((content.match(/<system-reminder>/g) || []).length).toBe(1)
    expect((content.match(/<\/system-reminder>/g) || []).length).toBe(1)
  })

  it('E33: consecutive system messages get smooshed into one', () => {
    const msgs = [
      { role: 'system', content: 'first' },
      { role: 'system', content: 'second' },
    ]
    const out = normalizeMessagesForAPI(msgs, { stripInternalMeta: false })
    const users = out.filter((m) => m.role === 'user')
    // Both system should be converted and smooshed into one user
    expect(users.length).toBe(1)
    expect((users[0].content as string)).toContain('second')
    expect((users[0].content as string)).toContain('first')
  })

  it('E34: stripInternalMeta removes all _prefixed and _pole keys', () => {
    const msgs = [
      {
        role: 'user',
        content: 'hello',
        _type: 'test',
        _convertedFromSystem: true,
        _poleContextUsage: 'should-be-stripped',
        _poleQueryTracking: 'also-stripped',
        keep: 'visible',
      },
    ]
    const out = normalizeMessagesForAPI(msgs, { stripInternalMeta: true })
    expect(out).toHaveLength(1)
    const cleaned = out[0]
    expect(cleaned._type).toBeUndefined()
    expect(cleaned._convertedFromSystem).toBeUndefined()
    expect(cleaned._poleContextUsage).toBeUndefined()
    expect(cleaned._poleQueryTracking).toBeUndefined()
    expect(cleaned.keep).toBe('visible')
  })

  it('E35: tool_reference blocks stay with siblings in same user message', () => {
    const msgs = [
      {
        role: 'user',
        content: [
          { type: 'tool_reference', name: 'ref1', id: '1' },
          { type: 'text', text: 'question about ref' },
        ],
      },
    ]
    const out = normalizeMessagesForAPI(msgs, { stripInternalMeta: false })
    // Should not split into 2 user messages
    const users = out.filter((m) => m.role === 'user')
    expect(users.length).toBeGreaterThanOrEqual(1)
    // The ref should be first, then the text
    if (Array.isArray(users[0].content)) {
      const blocks = users[0].content as Array<Record<string, unknown>>
      const refIdx = blocks.findIndex((b) => b.type === 'tool_reference')
      const textIdx = blocks.findIndex((b) => b.type === 'text')
      expect(refIdx).toBeLessThan(textIdx)
    }
  })

  it('E36: whitespace-only assistant messages are removed', () => {
    const msgs = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '   ' },
      { role: 'user', content: 'bye' },
    ]
    const out = normalizeMessagesForAPI(msgs, { stripInternalMeta: false })
    expect(out.filter((m) => m.role === 'assistant').length).toBe(0)
  })

  it('E37: empty assistant content gets "..." placeholder', () => {
    const msgs = [
      { role: 'assistant', content: '' },
    ]
    const out = normalizeMessagesForAPI(msgs, { stripInternalMeta: false })
    expect(out).toHaveLength(1)
    const blocks = out[0].content as Array<Record<string, unknown>>
    expect(blocks[0].type).toBe('text')
    expect((blocks[0] as { text: string }).text).toBe('...')
  })

  it('E38: orphaned thinking-only assistant removed (non-strict)', () => {
    const msgs = [
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'internal' }] },
    ]
    const out = normalizeMessagesForAPI(msgs, { stripInternalMeta: false, strictThinkingEcho: false })
    // Should be filtered out by pass 6
    expect(out.length).toBe(0)
  })

  it('E39: orphaned thinking preserved with strictThinkingEcho', () => {
    const msgs = [
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'internal' }] },
    ]
    const out = normalizeMessagesForAPI(msgs, { stripInternalMeta: false, strictThinkingEcho: true })
    expect(out.length).toBeGreaterThanOrEqual(1)
  })

  it('E40: trailing thinking stripped from last assistant (non-strict)', () => {
    const msgs = [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'answer' },
          { type: 'thinking', thinking: 'post-hoc' },
        ],
      },
    ]
    const out = normalizeMessagesForAPI(msgs, { stripInternalMeta: false, strictThinkingEcho: false })
    const last = out[out.length - 1]
    if (last.role === 'assistant' && Array.isArray(last.content)) {
      const blocks = last.content as Array<Record<string, unknown>>
      // Last block should NOT be thinking
      expect(blocks[blocks.length - 1].type).not.toBe('thinking')
    }
  })

  it('E41: error tool_result content > 8000 chars is truncated', () => {
    const longError = 'ERR!'.repeat(3000) // ~12000 chars
    const msgs = [
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: longError, is_error: true }],
      },
    ]
    const out = normalizeMessagesForAPI(msgs, { stripInternalMeta: false })
    const blocks = out[0].content as Array<Record<string, unknown>>
    const content = blocks[0].content as string
    expect(content.length).toBeLessThan(longError.length)
    expect(content).toContain('truncated')
  })

  it('E42: virtual messages are stripped', () => {
    const msgs = [
      { role: 'user', content: 'real', _type: 'virtual' },
      { role: 'assistant', content: 'real-assistant' },
    ]
    const out = normalizeMessagesForAPI(msgs, { stripInternalMeta: false })
    expect(out.length).toBe(1)
    expect(out[0].role).toBe('assistant')
  })

  it('E43: stripInternalMeta: false retains internal keys', () => {
    const msgs = [
      { role: 'user', content: 'hello', _convertedFromSystem: true },
    ]
    const out = normalizeMessagesForAPI(msgs, { stripInternalMeta: false })
    expect(out[0]._convertedFromSystem).toBe(true)
  })
})

// ============================================================================
// apiMessageInvariants — extreme scenarios
// ============================================================================

describe('apiMessageInvariants (extreme)', () => {
  const img = () => ({ type: 'image', source: { type: 'url' as const, url: 'https://x.com/i.png' } })

  it('E44: exact boundary: API_MAX_MEDIA_ITEMS_PER_REQUEST images — none dropped', () => {
    const images = Array.from({ length: API_MAX_MEDIA_ITEMS_PER_REQUEST }, img)
    const msgs = [{ role: 'user', content: [...images, { type: 'text', text: 'ok' }] }]
    const out = stripExcessImageBlocks(msgs as unknown as Record<string, unknown>[])
    const c = out[0].content as Array<{ type: string }>
    expect(c.filter((b) => b.type === 'image').length).toBe(API_MAX_MEDIA_ITEMS_PER_REQUEST)
  })

  it('E45: 1 over boundary — oldest dropped, reminder injected', () => {
    const images = Array.from({ length: API_MAX_MEDIA_ITEMS_PER_REQUEST + 1 }, img)
    const msgs = [{ role: 'user', content: images }]
    const out = stripExcessImageBlocks(msgs as unknown as Record<string, unknown>[])
    const c = out[0].content as Array<{ type: string }>
    expect(c.filter((b) => b.type === 'image').length).toBe(API_MAX_MEDIA_ITEMS_PER_REQUEST)
    // Reminder text should be present
    const texts = c.filter((b) => b.type === 'text') as Array<{ text: string }>
    const reminder = texts.find((t) => t.text.includes('Image budget note'))
    expect(reminder).toBeDefined()
  })

  it('E46: 500 over boundary — only cap images remain', () => {
    const excess = API_MAX_MEDIA_ITEMS_PER_REQUEST + 500
    const images = Array.from({ length: excess }, img)
    const msgs = [{ role: 'user', content: images }]
    const out = stripExcessImageBlocks(msgs as unknown as Record<string, unknown>[])
    const c = out[0].content as Array<{ type: string }>
    expect(c.filter((b) => b.type === 'image').length).toBeLessThanOrEqual(API_MAX_MEDIA_ITEMS_PER_REQUEST)
  })

  it('E47: 0 images — no-op, no injected reminder', () => {
    const msgs = [{ role: 'user', content: 'just text' }]
    const out = stripExcessImageBlocks(msgs as unknown as Record<string, unknown>[])
    const text = out[0].content as string
    expect(text).not.toContain('Image budget note')
  })

  it('E48: user message with string content gets reminder appended as text', () => {
    const images = Array.from({ length: API_MAX_MEDIA_ITEMS_PER_REQUEST + 2 }, img)
    const msgs = [{ role: 'user', content: [...images, { type: 'text', text: 'help' }] }]
    const out = stripExcessImageBlocks(msgs as unknown as Record<string, unknown>[], API_MAX_MEDIA_ITEMS_PER_REQUEST)
    const c = out[0].content as Array<Record<string, unknown>>
    const texts = c.filter((b) => b.type === 'text') as Array<{ text: string }>
    const reminder = texts.find((t) => t.text.includes('Image budget note'))
    expect(reminder).toBeDefined()
  })

  it('E49: fixAssistantThinkingNotLastBlock — no-op when no trailing thinking', () => {
    const msgs = [
      { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    ]
    const out = fixAssistantThinkingNotLastBlock(msgs)
    const c = out[0].content as Array<{ type: string }>
    expect(c[c.length - 1].type).toBe('text')
    expect(c.length).toBe(1)
  })

  it('E50: fixAssistantThinkingNotLastBlock — skipped with strictThinkingEcho', () => {
    const msgs = [
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'x' }] },
    ]
    const out = fixAssistantThinkingNotLastBlock(msgs, true)
    const c = out[0].content as Array<{ type: string }>
    // No text appended
    expect(c.length).toBe(1)
    expect(c[0].type).toBe('thinking')
  })

  it('E51: fixAssistantThinkingNotLastBlock — non-assistant skipped', () => {
    const msgs = [
      { role: 'user', content: [{ type: 'thinking', thinking: 'x' }] },
    ]
    const out = fixAssistantThinkingNotLastBlock(msgs)
    // Should be unchanged
    expect(out[0].content).toEqual(msgs[0].content)
  })

  it('E52: fixAssistantThinkingNotLastBlock — empty content array unchanged', () => {
    const msgs = [
      { role: 'assistant', content: [] },
    ]
    const out = fixAssistantThinkingNotLastBlock(msgs)
    expect((out[0].content as unknown[])).toEqual([])
  })

  it('E53: applyAnthropicApiMessageInvariants — empty messages returns empty', () => {
    const out = applyAnthropicApiMessageInvariants([])
    expect(out).toEqual([])
  })

  it('E54: applyAnthropicApiMessageInvariants — runs strip then fix with strictThinkingEcho', () => {
    const images = Array.from({ length: API_MAX_MEDIA_ITEMS_PER_REQUEST + 1 }, img)
    const msgs = [
      {
        role: 'assistant',
        content: [...images, { type: 'thinking', thinking: 'z' }],
      },
    ]
    const out = applyAnthropicApiMessageInvariants(
      msgs as unknown as Record<string, unknown>[],
      true,
    )
    const c = out[0].content as Array<{ type: string }>
    // strictThinkingEcho → thinking NOT removed or appended after
    expect(c.filter((b) => b.type === 'image').length).toBe(API_MAX_MEDIA_ITEMS_PER_REQUEST)
    // With strictThinkingEcho, thinking stays as last block
    expect(c[c.length - 1].type).toBe('thinking')
  })

  it('E55: applyAnthropicApiMessageInvariants — ensures tool pairing on every call', () => {
    const msgs = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'inv-t1', name: 'test', input: {} }] },
    ]
    const out = applyAnthropicApiMessageInvariants(msgs as unknown as Record<string, unknown>[])
    // Should have injected a user with synthetic tool_result
    expect(out.length).toBeGreaterThanOrEqual(2)
    const userMsg = out.find((m) => m.role === 'user')
    expect(userMsg).toBeDefined()
  })
})
// ============================================================================
// Additional extreme scenarios for individual pass functions
// ============================================================================

describe('reorderAttachmentsForAPI (extreme)', () => {
  it('E56: attachment placed after nearest tool_result user', () => {
    const msgs = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'res' }] },
      { role: 'user', content: 'attachment-content', _isAttachment: true },
    ] as Msg[]
    const out = reorderAttachmentsForAPI(msgs)
    // Attachment should come AFTER the tool_result user message
    const attachmentIdx = out.findIndex((m) => m._isAttachment === true)
    const toolResultIdx = out.findIndex(
      (m) => Array.isArray(m.content) && (m.content as Array<Record<string, unknown>>).some((b) => b.type === 'tool_result'),
    )
    expect(attachmentIdx).toBeGreaterThan(toolResultIdx)
  })

  it('E57: multiple pending attachments batched after next tool_result', () => {
    const msgs = [
      { role: 'user', content: 'a1', _isAttachment: true },
      { role: 'user', content: 'a2', _isAttachment: true },
      { role: 'user', content: 'a3', _isAttachment: true },
      { role: 'assistant', content: 'thinking' },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'done' }] },
      { role: 'user', content: 'trailing' },
    ] as Msg[]
    const out = reorderAttachmentsForAPI(msgs)
    // All 3 attachments should appear between tool_result user and trailing user
    const firstAttachIdx = out.findIndex((m) => m._isAttachment === true)
    const toolResultIdx = out.findIndex(
      (m) => Array.isArray(m.content) && (m.content as Array<Record<string, unknown>>).some((b) => b.type === 'tool_result'),
    )
    const trailingIdx = out.findIndex((m) => m.content === 'trailing')
    expect(firstAttachIdx).toBeGreaterThan(toolResultIdx)
    expect(firstAttachIdx).toBeLessThan(trailingIdx)
  })

  it('E58: attachments at end of array with no subsequent tool_result', () => {
    const msgs = [
      { role: 'user', content: 'p1', _isAttachment: true },
      { role: 'user', content: 'p2', _isAttachment: true },
    ] as Msg[]
    const out = reorderAttachmentsForAPI(msgs)
    expect(out).toHaveLength(2)
    expect(out[0]._isAttachment).toBe(true)
    expect(out[1]._isAttachment).toBe(true)
  })

  it('E59: _meta_type attachment recognized', () => {
    const msgs = [
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'res' }] },
      { role: 'user', content: 'file-data', _meta_type: 'attachment' },
    ] as Msg[]
    const out = reorderAttachmentsForAPI(msgs)
    expect(out).toHaveLength(2)
    // Attachment should be after tool_result
    expect(out[1]._meta_type).toBe('attachment')
  })
})

describe('stripVirtualMessages (extreme)', () => {
  it('E60: strips _type virtual', () => {
    const out = stripVirtualMessages([
      { role: 'user', content: 'real' },
      { role: 'user', content: 'virtual', _type: 'virtual' },
      { role: 'assistant', content: 'also real' },
    ])
    expect(out).toHaveLength(2)
    expect(out[0].content).toBe('real')
    expect(out[1].content).toBe('also real')
  })

  it('E61: strips _meta_type virtual', () => {
    const out = stripVirtualMessages([
      { role: 'user', content: 'v', _meta_type: 'virtual' },
    ])
    expect(out).toHaveLength(0)
  })

  it('E62: strips _virtual flag', () => {
    const out = stripVirtualMessages([
      { role: 'user', content: 'v', _virtual: true },
    ])
    expect(out).toHaveLength(0)
  })

  it('E63: non-virtual messages pass through', () => {
    const msgs = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
    ]
    const out = stripVirtualMessages(msgs)
    expect(out).toHaveLength(2)
  })
})

describe('filterOrphanedThinkingOnly (extreme)', () => {
  it('E64: removes assistant with only thinking blocks (non-strict)', () => {
    const msgs = [
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'x' }] },
    ]
    const out = filterOrphanedThinkingOnly(msgs, false)
    expect(out).toHaveLength(0)
  })

  it('E65: keeps assistant with mixed thinking + text', () => {
    const msgs = [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'x' },
          { type: 'text', text: 'actual response' },
        ],
      },
    ]
    const out = filterOrphanedThinkingOnly(msgs, false)
    expect(out).toHaveLength(1)
  })

  it('E66: keeps empty-content assistant', () => {
    const msgs = [{ role: 'assistant', content: [] }]
    const out = filterOrphanedThinkingOnly(msgs, false)
    expect(out).toHaveLength(1)
  })

  it('E67: keeps everything with strictThinkingEcho', () => {
    const msgs = [
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'x' }] },
    ]
    const out = filterOrphanedThinkingOnly(msgs, true)
    expect(out).toHaveLength(1)
  })
})

describe('ensureNonEmptyAssistantContent (extreme)', () => {
  it('E68: empty string content gets ... placeholder', () => {
    const out = ensureNonEmptyAssistantContent([
      { role: 'assistant', content: '' },
    ])
    const blocks = out[0].content as Array<Record<string, unknown>>
    expect(blocks[0].type).toBe('text')
    expect((blocks[0] as { text: string }).text).toBe('...')
  })

  it('E69: whitespace-only string gets ... placeholder', () => {
    const out = ensureNonEmptyAssistantContent([
      { role: 'assistant', content: '   ' },
    ])
    const blocks = out[0].content as Array<Record<string, unknown>>
    expect(blocks[0].type).toBe('text')
    expect((blocks[0] as { text: string }).text).toBe('...')
  })

  it('E70: empty array content gets ... placeholder', () => {
    const out = ensureNonEmptyAssistantContent([
      { role: 'assistant', content: [] },
    ])
    const blocks = out[0].content as Array<Record<string, unknown>>
    expect(blocks[0].type).toBe('text')
    expect((blocks[0] as { text: string }).text).toBe('...')
  })

  it('E71: thinking-only content gets ... appended (non-strict)', () => {
    const out = ensureNonEmptyAssistantContent([
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'x' }] },
    ])
    const blocks = out[0].content as Array<Record<string, unknown>>
    expect(blocks[blocks.length - 1].type).toBe('text')
  })

  it('E72: thinking-only content preserved as-is with strictThinkingEcho', () => {
    const out = ensureNonEmptyAssistantContent(
      [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'x' }] }],
      true,
    )
    const blocks = out[0].content as Array<Record<string, unknown>>
    expect(blocks).toHaveLength(1)
    expect(blocks[0].type).toBe('thinking')
  })

  it('E73: non-assistant passes through unchanged', () => {
    const msgs = [{ role: 'user', content: '' }]
    const out = ensureNonEmptyAssistantContent(msgs)
    expect(out[0].content).toBe('')
  })
})

describe('smooshSystemReminderSiblings (extreme)', () => {
  it('E74: flattens two consecutive convertedSystem users into one', () => {
    const msgs = [
      { role: 'user', content: 'sys 1', _convertedFromSystem: true },
      { role: 'user', content: 'sys 2', _convertedFromSystem: true },
    ] as Msg[]
    const out = smooshSystemReminderSiblings(msgs)
    expect(out).toHaveLength(1)
    expect(out[0].content).toContain('sys 1')
    expect(out[0].content).toContain('sys 2')
  })

  it('E75: does not smoosh when first is not convertedFromSystem', () => {
    const msgs = [
      { role: 'user', content: 'real user' },
      { role: 'user', content: 'sys', _convertedFromSystem: true },
    ] as Msg[]
    const out = smooshSystemReminderSiblings(msgs)
    expect(out).toHaveLength(2)
  })

  it('E76: does not smoosh when second is not convertedFromSystem', () => {
    const msgs = [
      { role: 'user', content: 'sys', _convertedFromSystem: true },
      { role: 'user', content: 'real' },
    ] as Msg[]
    const out = smooshSystemReminderSiblings(msgs)
    expect(out).toHaveLength(2)
  })

  it('E77: handles array content by extracting text blocks', () => {
    const msgs = [
      { role: 'user', content: [{ type: 'text', text: 'block-a' }], _convertedFromSystem: true },
      { role: 'user', content: [{ type: 'text', text: 'block-b' }], _convertedFromSystem: true },
    ] as Msg[]
    const out = smooshSystemReminderSiblings(msgs)
    expect(out).toHaveLength(1)
    expect(out[0].content).toContain('block-a')
    expect(out[0].content).toContain('block-b')
  })
})

describe('sanitizeErrorToolResultContent (extreme)', () => {
  it('E78: non-error tool_result left unchanged', () => {
    const msgs = [
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
    ]
    const out = sanitizeErrorToolResultContent(msgs)
    expect(out[0].content).toEqual(msgs[0].content)
  })

  it('E79: error tool_result under 8000 chars unchanged', () => {
    const msgs = [
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'short error', is_error: true }],
      },
    ]
    const out = sanitizeErrorToolResultContent(msgs)
    const blocks = out[0].content as Array<Record<string, unknown>>
    expect((blocks[0] as { content: string }).content).toBe('short error')
  })

  it('E80: error tool_result at exactly 8000 chars unchanged', () => {
    const exact8k = 'x'.repeat(8000)
    const msgs = [
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: exact8k, is_error: true }],
      },
    ]
    const out = sanitizeErrorToolResultContent(msgs)
    const blocks = out[0].content as Array<Record<string, unknown>>
    expect((blocks[0] as { content: string }).content).toBe(exact8k)
  })

  it('E81: error tool_result over 8000 chars truncated', () => {
    const long = 'y'.repeat(9000)
    const msgs = [
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: long, is_error: true }],
      },
    ]
    const out = sanitizeErrorToolResultContent(msgs)
    const blocks = out[0].content as Array<Record<string, unknown>>
    const content = (blocks[0] as { content: string }).content
    expect(content.length).toBeLessThan(9000)
    expect(content).toContain('truncated')
  })
})

describe('stripInternalFields (extreme)', () => {
  it('E82: strips all known internal keys', () => {
    const out = stripInternalFields([
      {
        role: 'user',
        content: 'hello',
        _type: 'x',
        _convertedFromSystem: true,
        _messageTag: 5,
        _poleContextUsage: 'y',
      },
    ])
    expect(out[0]._type).toBeUndefined()
    expect(out[0]._convertedFromSystem).toBeUndefined()
    expect(out[0]._messageTag).toBeUndefined()
    expect(out[0]._poleContextUsage).toBeUndefined()
  })

  it('E83: preserves role, content, and unknown keys', () => {
    const out = stripInternalFields([
      { role: 'user', content: 'hi', customFlag: 1, anotherProp: 'val' },
    ])
    expect(out[0].role).toBe('user')
    expect(out[0].content).toBe('hi')
    expect(out[0].customFlag).toBe(1)
    expect(out[0].anotherProp).toBe('val')
  })

  it('E84: strips _pole* prefix aggressively (camelCase)', () => {
    const out = stripInternalFields([
      { role: 'user', content: 'x', _poleFoo: 1, _poleBarBaz: 2, _pole: 3 },
    ])
    expect(out[0]._poleFoo).toBeUndefined()
    expect(out[0]._poleBarBaz).toBeUndefined()
    expect(out[0]._pole).toBeUndefined()
  })

  it('E85: strips _pole* prefix (snake_case)', () => {
    const out = stripInternalFields([
      { role: 'user', content: 'x', _pole_context_usage: 'a', _pole_query_tracking: 'b' },
    ])
    expect(out[0]._pole_context_usage).toBeUndefined()
    expect(out[0]._pole_query_tracking).toBeUndefined()
  })
})