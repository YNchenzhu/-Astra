/**
 * Streaming-delta batching behaviour of `handleMainStreamEvent`:
 *   - text_delta coalescing
 *   - thinking_delta merging + thinking_block_complete signature plumbing
 *   - ordering vs non-delta events
 *   - late deltas after cancellation
 *
 * Split out of the original monolithic `handleMainStreamEvent.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../services/electronAPI', async () => {
  const m = await import('./mainStreamRouter.testMocks')
  return m.electronApiMock()
})
vi.mock('../useSettingsStore', async () => {
  const m = await import('./mainStreamRouter.testMocks')
  return m.settingsStoreMock()
})
vi.mock('../useFileStore', async () => {
  const m = await import('./mainStreamRouter.testMocks')
  return m.fileStoreMock()
})
vi.mock('../useWorkspaceStore', async () => {
  const m = await import('./mainStreamRouter.testMocks')
  return m.workspaceStoreMock()
})
vi.mock('../useBuddyStore', async () => {
  const m = await import('./mainStreamRouter.testMocks')
  return m.buddyStoreMock()
})

import type { ChatMessage, StreamEvent } from '../../types'
import type { ContentBlock } from '../../types/tool'
import { handleMainStreamEvent, useChatStore } from './storeCompose'
import { pendingAssistantByConversation } from './sessionSlice'
import { flushPendingDeltasNow } from './streamingDeltaBatcher'
import {
  CONV_ID,
  ASSISTANT_ID,
  TOOL_USE_ID,
  installBlankStreamingAssistant,
  currentAssistantMessage,
  resetChatStoreState,
  flushAndClearPending,
} from './mainStreamRouter.testHelpers'

beforeEach(() => {
  resetChatStoreState()
})

afterEach(() => {
  flushAndClearPending()
})

describe('handleMainStreamEvent: text_delta batching', () => {
  it('multiple text_delta events coalesce into a single content mutation', () => {
    installBlankStreamingAssistant()

    // Before any flush, none of the deltas have been applied.
    for (const delta of ['he', 'llo ', 'world']) {
      handleMainStreamEvent({
        type: 'text_delta',
        conversationId: CONV_ID,
        text: delta,
      } as unknown as StreamEvent)
    }
    expect(currentAssistantMessage()?.content).toBe('')

    flushPendingDeltasNow()

    const msg = currentAssistantMessage()
    expect(msg?.content).toBe('hello world')
    expect(msg?.blocks).toEqual([{ type: 'text', text: 'hello world' }])
  })

  it('thinking_delta followed by text_delta produces two sealed blocks after flush', () => {
    installBlankStreamingAssistant()

    handleMainStreamEvent({
      type: 'thinking_delta',
      conversationId: CONV_ID,
      text: 'reasoning…',
    } as unknown as StreamEvent)
    handleMainStreamEvent({
      type: 'text_delta',
      conversationId: CONV_ID,
      text: 'answer',
    } as unknown as StreamEvent)

    flushPendingDeltasNow()

    const msg = currentAssistantMessage()
    // G: `m.thinking` legacy mirror is no longer maintained — read from
    // the canonical `blocks` array instead. `m.content` IS still kept
    // up to date (text concat lives on the message for empty-detect /
    // export-text consumers).
    expect(msg?.content).toBe('answer')
    expect(msg?.thinking).toBeUndefined()
    // The thinking block must be sealed (isStreaming: false) once text follows.
    expect(msg?.blocks).toEqual([
      { type: 'thinking', text: 'reasoning…', isStreaming: false },
      { type: 'text', text: 'answer' },
    ])
  })

  it('interleaved thinking + text deltas at token granularity (screenshot bug repro)', () => {
    // The exact pattern from the bug screenshot: every chunk from the
    // upstream provider carries BOTH a tiny thought and a tiny text part,
    // so onThinkingDelta and onTextDelta fire alternately at token speed.
    // Each toggle currently pushes a NEW block (lastBlock type mismatch
    // breaks merge), producing dozens of "Thought for 0.0s" rows in the UI.
    installBlankStreamingAssistant()

    const pairs = [
      ['思考1', '报告已'],
      ['思考2', '完整'],
      ['思考3', '\n输出。'],
      ['思考4', '你'],
      ['思考5', '希望'],
      ['思考6', '我对哪些'],
      ['思考7', '问题'],
      ['思考8', '直接动手'],
    ]
    for (const [t, x] of pairs) {
      handleMainStreamEvent({
        type: 'thinking_delta',
        conversationId: CONV_ID,
        text: t,
      } as unknown as StreamEvent)
      handleMainStreamEvent({
        type: 'text_delta',
        conversationId: CONV_ID,
        text: x,
      } as unknown as StreamEvent)
    }
    flushPendingDeltasNow()

    const msg = currentAssistantMessage()
    const blocks = msg?.blocks ?? []
    const thinkingBlocks = blocks.filter((b: ContentBlock) => b.type === 'thinking')
    const textBlocks = blocks.filter((b: ContentBlock) => b.type === 'text')
    // Goal: ONE thinking block + ONE text block, regardless of token-level
    // interleaving from the wire. 8 of each is the bug.
    expect(thinkingBlocks).toHaveLength(1)
    expect(textBlocks).toHaveLength(1)
    expect((thinkingBlocks[0] as { text: string }).text).toBe(
      pairs.map((p) => p[0]).join(''),
    )
    expect((textBlocks[0] as { text: string }).text).toBe(
      pairs.map((p) => p[1]).join(''),
    )
  })

  it('many sequential thinking_deltas merge into a SINGLE thinking block (regression)', () => {
    // Bug repro: providers like 智谱/DeepSeek emit chain-of-thought as many
    // tiny deltas (a few CJK chars each). The router's `flushPendingDeltasNow`
    // dance around enqueueThinkingDelta MUST still merge consecutive deltas
    // into one block — otherwise the UI renders one ThinkingBlock per delta
    // (the screenshot bug: "Thought for 0.0s" header repeating between every
    // 2-4 chars).
    installBlankStreamingAssistant()

    const fragments = [
      '报告已',
      '完整',
      '输出。',
      '你',
      '希望我对哪些问题',
      '直接动手',
      '修',
      '？选项',
      '：',
      '\n• P0 — ',
      '把 `',
      'time',
      '.sleep(1)`',
      '冷却',
    ]
    for (const f of fragments) {
      handleMainStreamEvent({
        type: 'thinking_delta',
        conversationId: CONV_ID,
        text: f,
      } as unknown as StreamEvent)
    }
    flushPendingDeltasNow()

    const msg = currentAssistantMessage()
    const expectedJoined = fragments.join('')
    // G: blocks are now the only source of truth — assert merge ratio
    // directly on `blocks` rather than via the deprecated `m.thinking`
    // legacy mirror (now always undefined for new writes).
    expect(msg?.thinking).toBeUndefined()
    // Critical: ONE thinking block, not 14.
    const thinkingBlocks = (msg?.blocks ?? []).filter(
      (b: ContentBlock) => b.type === 'thinking',
    )
    expect(thinkingBlocks).toHaveLength(1)
    expect(thinkingBlocks[0]).toMatchObject({
      type: 'thinking',
      text: expectedJoined,
      isStreaming: true,
    })
  })
})

describe('handleMainStreamEvent: thinking_block_complete signature plumbing', () => {
  it('stamps the signature onto the trailing thinking block and replaces the merged text with the canonical payload', () => {
    // End-to-end coverage for the DeepSeek / Anthropic native `content[].thinking`
    // round-trip invariant: after the server sends `content_block_stop` for a
    // thinking block, the renderer MUST capture the signature so the next turn
    // can echo it back, otherwise DeepSeek returns
    // `400 "content[].thinking in the thinking mode must be passed back to the API"`
    // and Anthropic native rejects with a shape-validation error when the
    // same assistant also had a `tool_use` block.
    installBlankStreamingAssistant()

    handleMainStreamEvent({
      type: 'thinking_delta',
      conversationId: CONV_ID,
      text: 'draft-reasoning',
    } as unknown as StreamEvent)

    // The non-delta `thinking_block_complete` event triggers an internal flush
    // of pending deltas, so by the time the handler runs the delta is already
    // materialised on the block and can be authoritatively replaced.
    handleMainStreamEvent({
      type: 'thinking_block_complete',
      conversationId: CONV_ID,
      thinkingBlock: {
        thinking: 'canonical-reasoning',
        signature: 'sig-abc-123',
      },
    } as unknown as StreamEvent)

    const msg = currentAssistantMessage()
    expect(msg?.blocks).toEqual([
      {
        type: 'thinking',
        text: 'canonical-reasoning',
        isStreaming: false,
        signature: 'sig-abc-123',
      },
    ])
  })

  it('tolerates providers that omit signature (DeepSeek text-only reasoning_content)', () => {
    installBlankStreamingAssistant()
    handleMainStreamEvent({
      type: 'thinking_delta',
      conversationId: CONV_ID,
      text: 'why strawberry has three Rs',
    } as unknown as StreamEvent)
    handleMainStreamEvent({
      type: 'thinking_block_complete',
      conversationId: CONV_ID,
      thinkingBlock: { thinking: 'why strawberry has three Rs' },
    } as unknown as StreamEvent)

    const msg = currentAssistantMessage()
    const block = msg?.blocks?.[0] as (ContentBlock & { type: 'thinking' }) | undefined
    expect(block?.text).toBe('why strawberry has three Rs')
    expect(block?.isStreaming).toBe(false)
    // No `signature` key should appear when the provider didn't send one.
    expect(block && 'signature' in block).toBe(false)
  })

  it('synthesizes a fresh thinking block when the complete event arrives without any preceding deltas', () => {
    // Fast-mode / non-streamed providers may emit a single thinking block
    // without any delta frames. The renderer should still produce a valid
    // block so cross-turn replay works.
    installBlankStreamingAssistant()

    handleMainStreamEvent({
      type: 'thinking_block_complete',
      conversationId: CONV_ID,
      thinkingBlock: { thinking: 'one-shot', signature: 'sig-one' },
    } as unknown as StreamEvent)

    const msg = currentAssistantMessage()
    expect(msg?.blocks).toContainEqual({
      type: 'thinking',
      text: 'one-shot',
      isStreaming: false,
      signature: 'sig-one',
    })
  })

  it('prefers an IN-FLIGHT thinking block over a more-recent already-stamped one (reverse-order _complete defence)', () => {
    // Defence against protocol regressions where `_complete` events arrive
    // in a different order than the wire blocks themselves. Concretely:
    // the renderer first received `_complete(B)` and stamped B
    // (isStreaming=false, signature=sig-B). A late-arriving `_complete(A)`
    // then reaches the renderer — geometrically, A's thinking block sits
    // EARLIER in the transcript than B. The old single-pass heuristic
    // "find the last thinking block" would mis-target B and overwrite its
    // already-stamped payload with A's. Two-pass targeting prefers the
    // remaining in-flight thinking block (A) so each `_complete` lands
    // on the right home.
    installBlankStreamingAssistant()
    const existing: ChatMessage = {
      id: ASSISTANT_ID,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      isStreaming: true,
      blocks: [
        // A: still in-flight (its `_complete` hasn't been processed yet).
        { type: 'thinking', text: 'first-streaming', isStreaming: true },
        {
          type: 'tool_use',
          id: 'tu1',
          name: 'Bash',
          input: { command: 'ls' },
          status: 'completed',
        },
        // B: already stamped by an earlier `_complete(B)`.
        {
          type: 'thinking',
          text: 'second-canonical',
          isStreaming: false,
          signature: 'sig-B',
        },
      ],
      toolUses: [],
    }
    useChatStore.setState({
      currentConversationId: CONV_ID,
      messages: [existing],
      sessionBuffers: {
        [CONV_ID]: {
          messages: [existing],
          todos: [],
          isTyping: true,
          pendingPermissionRequest: null,
          pendingAskUserQuestion: null,
          pendingTeamPlanApproval: null,
          pendingPlanApproval: null,
        },
      },
    })
    pendingAssistantByConversation.set(CONV_ID, ASSISTANT_ID)

    handleMainStreamEvent({
      type: 'thinking_block_complete',
      conversationId: CONV_ID,
      thinkingBlock: { thinking: 'first-canonical', signature: 'sig-A' },
    } as unknown as StreamEvent)

    const msg = currentAssistantMessage()
    expect(msg?.blocks).toEqual([
      // A picked up its own canonical payload — NOT overwritten by B's prior stamp.
      {
        type: 'thinking',
        text: 'first-canonical',
        isStreaming: false,
        signature: 'sig-A',
      },
      {
        type: 'tool_use',
        id: 'tu1',
        name: 'Bash',
        input: { command: 'ls' },
        status: 'completed',
      },
      // B's already-stamped payload is preserved untouched.
      {
        type: 'thinking',
        text: 'second-canonical',
        isStreaming: false,
        signature: 'sig-B',
      },
    ])
  })

  it('idempotently overwrites the trailing stamped block when a duplicate _complete arrives (gateway replay)', () => {
    // Some gateways / proxies retry SSE frames on transient drops and end
    // up replaying the same `_complete` event after we already processed
    // it. The first pass (in-flight) finds nothing because every thinking
    // block is already stamped; the fallback pass picks the trailing
    // thinking block and overwrites it with the same canonical payload.
    // Idempotent — no ghost thinking row gets appended.
    installBlankStreamingAssistant()
    const existing: ChatMessage = {
      id: ASSISTANT_ID,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      isStreaming: true,
      blocks: [
        {
          type: 'thinking',
          text: 'canonical-reasoning',
          isStreaming: false,
          signature: 'sig-stable',
        },
      ],
      toolUses: [],
    }
    useChatStore.setState({
      currentConversationId: CONV_ID,
      messages: [existing],
      sessionBuffers: {
        [CONV_ID]: {
          messages: [existing],
          todos: [],
          isTyping: true,
          pendingPermissionRequest: null,
          pendingAskUserQuestion: null,
          pendingTeamPlanApproval: null,
          pendingPlanApproval: null,
        },
      },
    })
    pendingAssistantByConversation.set(CONV_ID, ASSISTANT_ID)

    handleMainStreamEvent({
      type: 'thinking_block_complete',
      conversationId: CONV_ID,
      thinkingBlock: {
        thinking: 'canonical-reasoning',
        signature: 'sig-stable',
      },
    } as unknown as StreamEvent)

    const msg = currentAssistantMessage()
    // Exactly one thinking block, content unchanged — no synthetic duplicate.
    expect(msg?.blocks).toEqual([
      {
        type: 'thinking',
        text: 'canonical-reasoning',
        isStreaming: false,
        signature: 'sig-stable',
      },
    ])
  })

  it('targets the MOST-RECENT thinking block when the turn contains multiple (thinking → tool_use → thinking)', () => {
    // Models sometimes emit `thinking → tool_use → thinking → text`.
    // Only the trailing thinking is in-flight when `thinking_block_complete`
    // arrives — the earlier block already closed with its own signature on
    // the prior stop event.
    installBlankStreamingAssistant()
    // Seed the transcript with an older, already-signed thinking block followed
    // by a tool_use. Then the current streaming thinking delta.
    const existing: ChatMessage = {
      id: ASSISTANT_ID,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      isStreaming: true,
      blocks: [
        {
          type: 'thinking',
          text: 'first-thought',
          isStreaming: false,
          signature: 'sig-old',
        },
        {
          type: 'tool_use',
          id: 'tu1',
          name: 'Bash',
          input: { command: 'ls' },
          status: 'completed',
        },
        { type: 'thinking', text: 'second-', isStreaming: true },
      ],
      toolUses: [],
    }
    useChatStore.setState({
      currentConversationId: CONV_ID,
      messages: [existing],
      sessionBuffers: {
        [CONV_ID]: {
          messages: [existing],
          todos: [],
          isTyping: true,
          pendingPermissionRequest: null,
          pendingAskUserQuestion: null,
          pendingTeamPlanApproval: null,
          pendingPlanApproval: null,
        },
      },
    })
    pendingAssistantByConversation.set(CONV_ID, ASSISTANT_ID)

    handleMainStreamEvent({
      type: 'thinking_block_complete',
      conversationId: CONV_ID,
      thinkingBlock: { thinking: 'second-thought-final', signature: 'sig-new' },
    } as unknown as StreamEvent)

    const msg = currentAssistantMessage()
    expect(msg?.blocks).toEqual([
      // First thinking + its tool_use stay intact with the OLD signature.
      {
        type: 'thinking',
        text: 'first-thought',
        isStreaming: false,
        signature: 'sig-old',
      },
      {
        type: 'tool_use',
        id: 'tu1',
        name: 'Bash',
        input: { command: 'ls' },
        status: 'completed',
      },
      // Only the TRAILING thinking was updated.
      {
        type: 'thinking',
        text: 'second-thought-final',
        isStreaming: false,
        signature: 'sig-new',
      },
    ])
  })
})

describe('handleMainStreamEvent: batching preserves ordering with non-delta events', () => {
  it('a tool_start arriving right after text deltas is applied AFTER the text', () => {
    installBlankStreamingAssistant()

    handleMainStreamEvent({
      type: 'text_delta',
      conversationId: CONV_ID,
      text: 'Calling a tool: ',
    } as unknown as StreamEvent)

    // A tool_start arriving before a manual flush MUST first drain the
    // pending text so the tool card appears after the text in `blocks`.
    handleMainStreamEvent({
      type: 'tool_start',
      conversationId: CONV_ID,
      toolUse: {
        id: TOOL_USE_ID,
        name: 'Bash',
        input: { command: 'ls' },
      },
    } as unknown as StreamEvent)

    const msg = currentAssistantMessage()
    expect(msg?.content).toBe('Calling a tool: ')
    // Block order: text first, then tool_use.
    expect(msg?.blocks?.length).toBe(2)
    expect(msg?.blocks?.[0]).toEqual({ type: 'text', text: 'Calling a tool: ' })
    expect(msg?.blocks?.[1]?.type).toBe('tool_use')
  })

  it('message_stop drains pending deltas before clearing the streaming flag', () => {
    installBlankStreamingAssistant()

    handleMainStreamEvent({
      type: 'text_delta',
      conversationId: CONV_ID,
      text: 'final',
    } as unknown as StreamEvent)

    handleMainStreamEvent({
      type: 'message_stop',
      conversationId: CONV_ID,
    } as unknown as StreamEvent)

    const msg = currentAssistantMessage()
    // Final text is present even though the delta was still in the batcher
    // queue when message_stop arrived — the dispatcher flushed first.
    expect(msg?.content).toBe('final')
  })
})

describe('handleMainStreamEvent: late deltas after the message is finalized', () => {
  // Regression: pressing Stop flipped the message-level `isStreaming` to
  // false but `applyBatchedDeltasToSlice` unconditionally re-stamped
  // `isStreaming: true` on the thinking block when a straggler
  // `thinking_delta` arrived after the cancel — the abort path on the main
  // process is async, so deltas can still be in flight. The local
  // `ThinkingBlock` tick effect keyed off the per-block `isStreaming`, so
  // the counter ran away ("Thinking 253.7s") even though the user had
  // already pressed Stop.
  it('drops a thinking_delta that arrives after the message has been cancelled', () => {
    installBlankStreamingAssistant()

    // Simulate `cancelMessage` having already flipped the message-level
    // `isStreaming` to false (and the per-block thinking `isStreaming` to
    // false on any pre-existing thinking block).
    useChatStore.setState((s) => ({
      messages: s.messages.map((m) =>
        m.id === ASSISTANT_ID ? { ...m, isStreaming: false, isThinking: false } : m,
      ),
      isTyping: false,
    }))

    handleMainStreamEvent({
      type: 'thinking_delta',
      conversationId: CONV_ID,
      text: 'late-reasoning-after-stop',
    } as unknown as StreamEvent)
    flushPendingDeltasNow()

    const msg = currentAssistantMessage()
    expect(msg?.isStreaming).toBe(false)
    // No phantom thinking block should have been created from the late
    // delta — the cancel state must be the last word. (Previously this
    // test also asserted `m.thinking ?? ''` was empty; G removed that
    // legacy mirror so the blocks check is the sole invariant.)
    expect((msg?.blocks ?? []).some((b) => b.type === 'thinking')).toBe(false)
    expect(msg?.thinking).toBeUndefined()
  })

  it('drops a text_delta that arrives after the message has been cancelled', () => {
    installBlankStreamingAssistant()

    useChatStore.setState((s) => ({
      messages: s.messages.map((m) =>
        m.id === ASSISTANT_ID ? { ...m, isStreaming: false, isThinking: false } : m,
      ),
      isTyping: false,
    }))

    handleMainStreamEvent({
      type: 'text_delta',
      conversationId: CONV_ID,
      text: 'this-should-not-appear',
    } as unknown as StreamEvent)
    flushPendingDeltasNow()

    const msg = currentAssistantMessage()
    expect(msg?.content).toBe('')
    expect((msg?.blocks ?? []).some((b) => b.type === 'text')).toBe(false)
  })
})
