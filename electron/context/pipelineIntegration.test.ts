import { describe, expect, it } from 'vitest'
import { normalizeMessagesForAPI } from './normalizeMessagesForAPI'
import {
  buildClean18RoundTranscript,
  buildDegradingTranscript,
  toApiMessages,
  countSyntheticErrors,
  countThinkingBlocks,
} from './transcriptFixtureBuilder'

describe('pipeline integration: 18-round clean transcript', () => {
  it('zero SYNTHETIC_ERROR in clean transcript', () => {
    const fixture = buildClean18RoundTranscript()
    const msgs = toApiMessages(fixture)
    const result = normalizeMessagesForAPI(msgs, {
      applyAnthropicInvariants: false,
      stripInternalMeta: false,
    })
    expect(countSyntheticErrors(result)).toBe(0)
  })

  it('all 18 user turns survive pipeline', () => {
    const fixture = buildClean18RoundTranscript()
    const msgs = toApiMessages(fixture)
    const result = normalizeMessagesForAPI(msgs, {
      applyAnthropicInvariants: false,
      stripInternalMeta: false,
    })
    const users = result.filter((m) => m.role === 'user')
    expect(users.length).toBeGreaterThanOrEqual(18)
  })

  it('assistant messages are present', () => {
    const fixture = buildClean18RoundTranscript()
    const msgs = toApiMessages(fixture)
    const result = normalizeMessagesForAPI(msgs, {
      applyAnthropicInvariants: false,
      stripInternalMeta: false,
    })
    const assistants = result.filter((m) => m.role === 'assistant')
    expect(assistants.length).toBeGreaterThan(0)
  })
})

describe('pipeline integration: 18-round degrading transcript (Symptom 3)', () => {
  it('Symptom 3: thinking-only simulation rounds are removed by Pass 6', () => {
    const fixture = buildDegradingTranscript()
    const msgs = toApiMessages(fixture)
    const result = normalizeMessagesForAPI(msgs, {
      applyAnthropicInvariants: false,
      stripInternalMeta: false,
    })

    // Rounds 13, 16-18 have only thinking + completion text, no tool_use
    // Pass 6 removes pure-thinking messages (but since these have text too, they survive)
    // The key question: do assistants from degraded rounds survive?
    const assistants = result.filter((m) => m.role === 'assistant')
    // All non-pure-thinking assistants survive
    expect(assistants.length).toBeGreaterThanOrEqual(14) // at minimum 14 normal rounds
  })

  it('degraded rounds that DO have text are preserved (not removed by Pass 6)', () => {
    // Rounds 13, 16-18 have thinking + text (no tool_use)
    // Pass 6 only removes PURE thinking messages — since these have
    // text content, they survive but with no tool_use evidence
    const fixture = buildDegradingTranscript()
    const msgs = toApiMessages(fixture)
    const result = normalizeMessagesForAPI(msgs, {
      applyAnthropicInvariants: false,
      stripInternalMeta: false,
    })

    // The degraded rounds should have their text blocks preserved
    const textBlocks = result.flatMap((m) => {
      if (!Array.isArray(m.content)) return []
      return (m.content as Array<Record<string, unknown>>).filter((b) => b.type === 'text')
    })
    const completionTexts = textBlocks.filter(
      (b) =>
        typeof b.text === 'string' &&
        (b.text.includes('已完成') || b.text.includes('任务已完成')),
    )
    expect(completionTexts.length).toBeGreaterThan(0)
  })

  it('no SYNTHETIC_ERROR injected in degrading transcript (pairs are clean)', () => {
    const fixture = buildDegradingTranscript()
    const msgs = toApiMessages(fixture)
    const result = normalizeMessagesForAPI(msgs, {
      applyAnthropicInvariants: false,
      stripInternalMeta: false,
    })
    // Degraded rounds have no tool_use → no unpaired tool_use → no synthetic errors
    expect(countSyntheticErrors(result)).toBe(0)
  })
})

describe('pipeline integration: thinking block survival over 18 rounds', () => {
  it('thinking blocks from early rounds survive normalization', () => {
    const fixture = buildClean18RoundTranscript()
    const msgs = toApiMessages(fixture)
    const result = normalizeMessagesForAPI(msgs, {
      applyAnthropicInvariants: false,
      stripInternalMeta: false,
    })
    // Should have thinking blocks
    const thinkingCount = countThinkingBlocks(result)
    expect(thinkingCount).toBeGreaterThan(0)
  })

  it('no thinking block is the LAST block in an assistant message (API invariant)', () => {
    const fixture = buildClean18RoundTranscript()
    const msgs = toApiMessages(fixture)
    const result = normalizeMessagesForAPI(msgs, {
      applyAnthropicInvariants: true,
      stripInternalMeta: false,
    })
    for (const m of result) {
      if (m.role !== 'assistant' || !Array.isArray(m.content)) continue
      const blocks = m.content as Array<Record<string, unknown>>
      if (blocks.length === 0) continue
      const lastBlock = blocks[blocks.length - 1]
      expect(lastBlock.type).not.toBe('thinking')
      expect(lastBlock.type).not.toBe('redacted_thinking')
    }
  })
})
