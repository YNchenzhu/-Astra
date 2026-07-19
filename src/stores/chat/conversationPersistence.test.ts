/**
 * Unit tests for the persistence-layer transforms in
 * `conversationPersistence.ts`. Focus is on the C-feature
 * `compactThinkingInMessages` helper and the new options-aware
 * `stripStreamingUiFlags` / `cleanMessagesForPersist` entry points.
 *
 * `dehydrateMessages` (attachment sentinel rewrite) and
 * `preStageBlockImages` (main-process IPC) are deliberately NOT in scope
 * — they belong to the attachment cache subsystem and have their own
 * coverage. The tests here run in pure JS without IPC mocks.
 */

import { describe, expect, it } from 'vitest'

import type { ChatMessage, ContentBlock } from '../../types'
import {
  COMPACT_THINKING_PREVIEW_LENGTH,
  COMPACT_THINKING_THRESHOLD,
  compactThinkingInMessages,
  stripStreamingUiFlags,
} from './conversationPersistence'

// ─── Fixtures ────────────────────────────────────────────────────────

function makeMessage(blocks: ContentBlock[]): ChatMessage {
  return {
    id: 'msg-1',
    role: 'assistant',
    content: '',
    timestamp: 1_700_000_000_000,
    blocks,
  }
}

function thinkingOfSize(len: number, extras: Record<string, unknown> = {}): ContentBlock {
  return {
    type: 'thinking',
    text: 'x'.repeat(len),
    isStreaming: false,
    ...extras,
  } as ContentBlock
}

// ─── compactThinkingInMessages ──────────────────────────────────────

describe('compactThinkingInMessages', () => {
  it('leaves blocks at or below the threshold unchanged', () => {
    const msg = makeMessage([thinkingOfSize(COMPACT_THINKING_THRESHOLD)])
    const out = compactThinkingInMessages([msg])
    expect(out[0].blocks?.[0]).toEqual(msg.blocks?.[0])
  })

  it('truncates over-threshold blocks and stamps compactedAt', () => {
    const longBlock = thinkingOfSize(COMPACT_THINKING_THRESHOLD + 500, {
      thinkingTimeMs: 4200,
      thinkingTokens: 1300,
      signature: 'sig-original',
    })
    const msg = makeMessage([longBlock])
    const out = compactThinkingInMessages([msg])
    const block = out[0].blocks?.[0] as Extract<ContentBlock, { type: 'thinking' }>
    expect(block).toBeDefined()
    // Preview prefix + elided suffix.
    expect(block.text.startsWith('x'.repeat(COMPACT_THINKING_PREVIEW_LENGTH))).toBe(true)
    expect(block.text).toContain('characters elided on save')
    // Cost / timing meta preserved.
    expect(block.thinkingTimeMs).toBe(4200)
    expect(block.thinkingTokens).toBe(1300)
    // Signature dropped because truncation would invalidate it.
    expect((block as { signature?: string }).signature).toBeUndefined()
    // compactedAt stamped.
    expect(typeof block.compactedAt).toBe('number')
    expect(block.compactedAt).toBeGreaterThan(0)
  })

  it('is idempotent — a block already marked compactedAt is left alone', () => {
    const previouslyCompacted: ContentBlock = {
      type: 'thinking',
      text: 'short preview …(2000 characters elided on save)',
      isStreaming: false,
      thinkingTimeMs: 1000,
      compactedAt: 1_699_999_999_999,
    }
    const out = compactThinkingInMessages([makeMessage([previouslyCompacted])])
    expect(out[0].blocks?.[0]).toEqual(previouslyCompacted)
  })

  it('returns the original array reference when no message needs touching (cheap no-op for short conversations)', () => {
    const msgs: ChatMessage[] = [
      makeMessage([{ type: 'text', text: 'hello' }]),
      makeMessage([thinkingOfSize(100)]),
    ]
    expect(compactThinkingInMessages(msgs)).toBe(msgs)
  })

  it('skips reasoning_summary blocks (summaries are short by API contract)', () => {
    const summary: ContentBlock = {
      type: 'reasoning_summary',
      text: 'y'.repeat(COMPACT_THINKING_THRESHOLD + 100),
      isStreaming: false,
    }
    const msg = makeMessage([summary])
    const out = compactThinkingInMessages([msg])
    expect(out[0].blocks?.[0]).toEqual(summary)
  })

  it('handles messages without blocks gracefully', () => {
    const msg: ChatMessage = {
      id: 'msg-2',
      role: 'assistant',
      content: 'flat content',
      timestamp: 0,
    }
    expect(compactThinkingInMessages([msg])).toEqual([msg])
  })

  it('only touches the message containing the over-threshold block (preserves identity of siblings)', () => {
    const shortMsg = makeMessage([thinkingOfSize(50)])
    const longMsg = makeMessage([thinkingOfSize(COMPACT_THINKING_THRESHOLD + 100)])
    const out = compactThinkingInMessages([shortMsg, longMsg])
    // Sibling untouched → same identity.
    expect(out[0]).toBe(shortMsg)
    // Compacted → new identity.
    expect(out[1]).not.toBe(longMsg)
  })
})

// ─── stripStreamingUiFlags with options ─────────────────────────────

describe('stripStreamingUiFlags (compactThinking option)', () => {
  it('does NOT compact when the option is omitted (default behaviour unchanged)', () => {
    const msg = makeMessage([thinkingOfSize(COMPACT_THINKING_THRESHOLD + 100)])
    msg.isStreaming = true
    msg.isThinking = true
    const out = stripStreamingUiFlags([msg])
    const block = out[0].blocks?.[0] as Extract<ContentBlock, { type: 'thinking' }>
    expect(block.text.length).toBe(COMPACT_THINKING_THRESHOLD + 100)
    expect(block.compactedAt).toBeUndefined()
    // The streaming-flag strip behaviour is still applied.
    expect(out[0].isStreaming).toBeUndefined()
    expect(out[0].isThinking).toBeUndefined()
  })

  it('compacts when compactThinking: true is passed', () => {
    const msg = makeMessage([thinkingOfSize(COMPACT_THINKING_THRESHOLD + 100)])
    const out = stripStreamingUiFlags([msg], { compactThinking: true })
    const block = out[0].blocks?.[0] as Extract<ContentBlock, { type: 'thinking' }>
    expect(block.text.length).toBeLessThan(COMPACT_THINKING_THRESHOLD)
    expect(block.compactedAt).toBeGreaterThan(0)
  })

  it('applying compaction does NOT affect the streaming-flag strip — both transforms run independently', () => {
    const msg = makeMessage([
      { type: 'thinking', text: 'x'.repeat(COMPACT_THINKING_THRESHOLD + 1), isStreaming: true },
    ])
    msg.isStreaming = true
    const out = stripStreamingUiFlags([msg], { compactThinking: true })
    expect(out[0].isStreaming).toBeUndefined()
    const block = out[0].blocks?.[0] as Extract<ContentBlock, { type: 'thinking' }>
    expect(block.isStreaming).toBe(false)
    expect(block.compactedAt).toBeGreaterThan(0)
  })

  // Parity coverage: reasoning_summary mid-stream must also have its
  // `isStreaming` cleared on persist. Without this, a session that quit /
  // crashed while a summary was still streaming reloads with the spinner
  // permanently spinning (no message_stop will ever arrive for the dead
  // session,so the UI never naturally clears the flag).
  it('clears isStreaming on reasoning_summary blocks too (parity with thinking)', () => {
    const msg = makeMessage([
      {
        type: 'reasoning_summary',
        text: 'partial summary mid-stream',
        isStreaming: true,
      },
    ])
    msg.isStreaming = true
    const out = stripStreamingUiFlags([msg])
    const block = out[0].blocks?.[0] as Extract<
      ContentBlock,
      { type: 'reasoning_summary' }
    >
    expect(block.isStreaming).toBe(false)
    // The text payload itself stays intact — strip is purely flag-level,
    // separate from cancelMessage's tombstone-lite which clears text too.
    expect(block.text).toBe('partial summary mid-stream')
  })

  // IDE-style live-writing buffer. The router clears
  // `streamingInput` on `tool_start` and `tool_result` already, but a
  // quit-during-args / crash recovery can persist a message that's
  // still holding a partial JSON buffer — without the strip the next
  // session reload would resurrect a phantom "still typing" card
  // (with no model upstream to ever complete it).
  it('strips streamingInput from tool_use entries', () => {
    const msg: ChatMessage = {
      id: 'msg-1',
      role: 'assistant',
      content: '',
      timestamp: 1_700_000_000_000,
      blocks: [
        { type: 'tool_use', id: 't1', name: 'write_file', input: {}, status: 'running' },
      ],
      toolUses: [
        {
          id: 't1',
          name: 'write_file',
          input: {},
          status: 'running',
          streamingInput: { partialJson: '{"filePath":"a.ts","content":"par' },
          streamingProgress: { text: 'irrelevant' },
        },
      ],
    }
    const out = stripStreamingUiFlags([msg])
    const tu = out[0].toolUses?.[0]
    expect(tu?.streamingInput).toBeUndefined()
    expect(tu?.streamingProgress).toBeUndefined()
    // Identity preserved on the surrounding object shape — only the
    // two flags are nulled.
    expect(tu?.id).toBe('t1')
    expect(tu?.status).toBe('running')
  })
})
