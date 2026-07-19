/**
 * Unit tests for the `buildReasoningTimeline` selector that powers the
 * `<ReasoningTimeline>` popover. The selector is the only piece of
 * non-trivial logic in the file — the component itself is straight
 * mapping + JSX, exercised end-to-end by ChatPanel tests / Storybook.
 *
 * Coverage focus:
 *   - Walk order matches conversation order (turn index correct)
 *   - Thinking + reasoning_summary blocks both surface, with kind tags
 *   - Empty / whitespace-only blocks are skipped (transient streaming gap)
 *   - Compaction sentinel flows through
 *   - Multiple blocks within a single turn each get their own entry
 *   - Aggregate summary sums durations + tokens
 */

import { describe, expect, it } from 'vitest'

import type { ChatMessage, ContentBlock } from '../../types'
import { buildReasoningTimeline } from './ReasoningTimeline'

function userMsg(id: string, content: string): ChatMessage {
  return { id, role: 'user', content, timestamp: 0 }
}

function assistantWithBlocks(id: string, blocks: ContentBlock[]): ChatMessage {
  return {
    id,
    role: 'assistant',
    content: '',
    timestamp: 0,
    blocks,
  }
}

describe('buildReasoningTimeline', () => {
  it('returns an empty list when no assistant message has reasoning blocks', () => {
    const messages: ChatMessage[] = [
      userMsg('u1', 'hi'),
      assistantWithBlocks('a1', [{ type: 'text', text: 'flat answer' }]),
      userMsg('u2', 'thanks'),
    ]
    const { entries, summary } = buildReasoningTimeline(messages)
    expect(entries).toEqual([])
    expect(summary).toEqual({ entryCount: 0, totalDurationMs: 0, totalTokens: 0 })
  })

  it('emits one entry per thinking block in turn order with 1-based turn indices', () => {
    const messages: ChatMessage[] = [
      userMsg('u1', 'first ask'),
      assistantWithBlocks('a1', [
        { type: 'thinking', text: 'Plan the answer', thinkingTimeMs: 1200, thinkingTokens: 80 },
        { type: 'text', text: 'Here you go' },
      ]),
      userMsg('u2', 'second ask'),
      assistantWithBlocks('a2', [
        { type: 'thinking', text: 'Debug the failure', thinkingTimeMs: 4500, thinkingTokens: 1300 },
        { type: 'text', text: 'Found the bug' },
      ]),
    ]
    const { entries, summary } = buildReasoningTimeline(messages)
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({
      messageId: 'a1',
      turnIndex: 1,
      intraTurnIndex: 0,
      kind: 'thinking',
      preview: 'Plan the answer',
      durationMs: 1200,
      tokens: 80,
      compacted: false,
    })
    expect(entries[1]).toMatchObject({
      messageId: 'a2',
      turnIndex: 2,
      intraTurnIndex: 0,
      kind: 'thinking',
      preview: 'Debug the failure',
      durationMs: 4500,
      tokens: 1300,
    })
    expect(summary).toEqual({
      entryCount: 2,
      totalDurationMs: 1200 + 4500,
      totalTokens: 80 + 1300,
    })
  })

  it('splits multi-block turns (thinking → tool → thinking → text) into separate entries with intra-turn indices', () => {
    const messages: ChatMessage[] = [
      userMsg('u1', 'investigate'),
      assistantWithBlocks('a1', [
        { type: 'thinking', text: 'Step 1: locate the bug', thinkingTimeMs: 800 },
        {
          type: 'tool_use',
          id: 'tu1',
          name: 'Grep',
          input: { pattern: 'foo' },
          status: 'completed',
        },
        { type: 'thinking', text: 'Step 2: synthesize fix', thinkingTimeMs: 1500 },
        { type: 'text', text: 'Done.' },
      ]),
    ]
    const { entries } = buildReasoningTimeline(messages)
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({
      messageId: 'a1',
      turnIndex: 1,
      intraTurnIndex: 0,
      preview: 'Step 1: locate the bug',
    })
    expect(entries[1]).toMatchObject({
      messageId: 'a1',
      turnIndex: 1,
      intraTurnIndex: 1,
      preview: 'Step 2: synthesize fix',
    })
  })

  it('surfaces reasoning_summary blocks with the correct kind tag', () => {
    const messages: ChatMessage[] = [
      userMsg('u1', 'ask'),
      assistantWithBlocks('a1', [
        { type: 'reasoning_summary', text: 'I considered two approaches.', thinkingTimeMs: 600 },
        { type: 'text', text: 'Answer.' },
      ]),
    ]
    const { entries } = buildReasoningTimeline(messages)
    expect(entries).toHaveLength(1)
    expect(entries[0].kind).toBe('reasoning_summary')
    expect(entries[0].preview).toBe('I considered two approaches.')
  })

  it('skips blocks whose text is empty / whitespace-only (transient streaming state)', () => {
    const messages: ChatMessage[] = [
      userMsg('u1', 'ask'),
      assistantWithBlocks('a1', [
        // Just-opened thinking block before the first delta lands.
        { type: 'thinking', text: '', isStreaming: true },
        { type: 'thinking', text: '   \n   ', isStreaming: true },
        { type: 'thinking', text: 'real content here', thinkingTimeMs: 300 },
      ]),
    ]
    const { entries } = buildReasoningTimeline(messages)
    expect(entries).toHaveLength(1)
    expect(entries[0].preview).toBe('real content here')
  })

  it('truncates previews longer than 80 characters and uses the first non-empty line', () => {
    const messages: ChatMessage[] = [
      userMsg('u1', 'ask'),
      assistantWithBlocks('a1', [
        {
          type: 'thinking',
          text:
            '\n\nThis is a very long first line of reasoning that should be truncated at 80 chars total when surfaced as a one-row timeline preview.\nSecond line of reasoning.',
        },
      ]),
    ]
    const { entries } = buildReasoningTimeline(messages)
    expect(entries[0].preview.endsWith('…')).toBe(true)
    expect(entries[0].preview.length).toBeLessThanOrEqual(81) // 80 chars + ellipsis
    expect(entries[0].preview.startsWith('This is a very long')).toBe(true)
  })

  it('flags compacted blocks with `compacted: true` (C feature)', () => {
    const messages: ChatMessage[] = [
      userMsg('u1', 'old conversation reopened'),
      assistantWithBlocks('a1', [
        {
          type: 'thinking',
          text: 'preview prefix …(2000 characters elided on save)',
          thinkingTimeMs: 4200,
          compactedAt: 1_700_000_000_000,
        },
      ]),
    ]
    const { entries } = buildReasoningTimeline(messages)
    expect(entries).toHaveLength(1)
    expect(entries[0].compacted).toBe(true)
  })

  it('omits durationMs / tokens fields when the source block had no measurement', () => {
    const messages: ChatMessage[] = [
      userMsg('u1', 'ask'),
      assistantWithBlocks('a1', [{ type: 'thinking', text: 'unstamped block' }]),
    ]
    const { entries, summary } = buildReasoningTimeline(messages)
    expect(entries).toHaveLength(1)
    expect(entries[0].durationMs).toBeUndefined()
    expect(entries[0].tokens).toBeUndefined()
    // Aggregates ignore unstamped blocks so a single unmeasured entry
    // doesn't inflate the timeline summary with zero-noise.
    expect(summary.totalDurationMs).toBe(0)
    expect(summary.totalTokens).toBe(0)
  })

  it('skips user messages and assistant messages without `blocks` entirely', () => {
    const messages: ChatMessage[] = [
      userMsg('u1', 'request'),
      // Assistant with legacy `thinking` string but no blocks — G left
      // the type field readable for old JSON, but the timeline only
      // surfaces canonical blocks-side entries (no legacy mining).
      {
        id: 'legacy',
        role: 'assistant',
        content: 'answer',
        timestamp: 0,
        thinking: 'old-data-only',
      } as ChatMessage,
      assistantWithBlocks('a1', [{ type: 'thinking', text: 'modern path' }]),
    ]
    const { entries } = buildReasoningTimeline(messages)
    expect(entries).toHaveLength(1)
    expect(entries[0].messageId).toBe('a1')
    // turnIndex counts ALL assistant messages, not just blocks-bearing
    // ones — so the legacy stub still bumps the index.
    expect(entries[0].turnIndex).toBe(2)
  })
})
