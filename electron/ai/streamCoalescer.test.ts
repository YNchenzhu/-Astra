import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __getStreamPaceCharsForTests,
  __resetStreamCoalescerForTests,
  coalesceForIpc,
} from './streamCoalescer'

describe('streamCoalescer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    __resetStreamCoalescerForTests()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('coalesces consecutive text_delta events from the same stream into one IPC', () => {
    const send = vi.fn()
    const base = { conversationId: 'conv-1', agentId: 'main' }

    coalesceForIpc({ ...base, type: 'text_delta', text: 'Hel' }, send)
    coalesceForIpc({ ...base, type: 'text_delta', text: 'lo, ' }, send)
    coalesceForIpc({ ...base, type: 'text_delta', text: 'world' }, send)

    expect(send).not.toHaveBeenCalled()
    vi.advanceTimersByTime(20)

    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      type: 'text_delta',
      text: 'Hello, world',
      conversationId: 'conv-1',
      agentId: 'main',
    })
  })

  it('flushes pending deltas before forwarding a non-delta event (preserves order)', () => {
    const send = vi.fn()
    const base = { conversationId: 'conv-1', agentId: 'main' }

    coalesceForIpc({ ...base, type: 'text_delta', text: 'before tool' }, send)
    coalesceForIpc(
      {
        ...base,
        type: 'tool_start',
        toolUse: { id: 't1', name: 'Read', input: {} },
      },
      send,
    )

    // Two synchronous calls: the buffered text first, then the tool_start.
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      type: 'text_delta',
      text: 'before tool',
    })
    expect(send.mock.calls[1]?.[0]).toMatchObject({ type: 'tool_start' })
  })

  it('keeps text and thinking buffers independent inside the same stream', () => {
    const send = vi.fn()
    const base = { conversationId: 'conv-1', agentId: 'main' }

    coalesceForIpc({ ...base, type: 'text_delta', text: 'A' }, send)
    coalesceForIpc({ ...base, type: 'thinking_delta', text: '1' }, send)
    coalesceForIpc({ ...base, type: 'text_delta', text: 'B' }, send)
    coalesceForIpc({ ...base, type: 'thinking_delta', text: '2' }, send)

    vi.advanceTimersByTime(20)

    expect(send).toHaveBeenCalledTimes(2)
    const sentTypes = send.mock.calls.map((c) => (c[0] as { type: string }).type)
    expect(sentTypes).toContain('text_delta')
    expect(sentTypes).toContain('thinking_delta')
    const textCall = send.mock.calls.find(
      (c) => (c[0] as { type: string }).type === 'text_delta',
    )?.[0] as { text: string } | undefined
    const thinkingCall = send.mock.calls.find(
      (c) => (c[0] as { type: string }).type === 'thinking_delta',
    )?.[0] as { text: string } | undefined
    expect(textCall?.text).toBe('AB')
    expect(thinkingCall?.text).toBe('12')
  })

  it('keys per stream — different conversations and agents do not merge', () => {
    const send = vi.fn()

    coalesceForIpc(
      { conversationId: 'A', agentId: 'main', type: 'text_delta', text: 'a1' },
      send,
    )
    coalesceForIpc(
      { conversationId: 'B', agentId: 'main', type: 'text_delta', text: 'b1' },
      send,
    )
    coalesceForIpc(
      { conversationId: 'A', agentId: 'sub-1', type: 'subagent_text', text: 's1' },
      send,
    )

    vi.advanceTimersByTime(20)

    expect(send).toHaveBeenCalledTimes(3)
    const texts = send.mock.calls.map((c) => (c[0] as { text: string }).text).sort()
    expect(texts).toEqual(['a1', 'b1', 's1'])
  })

  it('coalesces subagent_text and subagent_thinking_delta the same way as their main-agent counterparts', () => {
    const send = vi.fn()
    const base = { conversationId: 'conv-1', agentId: 'sub-1' }

    coalesceForIpc({ ...base, type: 'subagent_text', text: 'sub ' }, send)
    coalesceForIpc({ ...base, type: 'subagent_text', text: 'agent ' }, send)
    coalesceForIpc({ ...base, type: 'subagent_text', text: 'output' }, send)

    vi.advanceTimersByTime(20)

    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      type: 'subagent_text',
      text: 'sub agent output',
      agentId: 'sub-1',
    })
  })

  it('forwards a non-delta event with no pending buffer immediately', () => {
    const send = vi.fn()
    coalesceForIpc(
      {
        conversationId: 'conv-1',
        type: 'message_stop',
        usage: { inputTokens: 1, outputTokens: 2 },
      },
      send,
    )
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]?.[0]).toMatchObject({ type: 'message_stop' })
  })

  // ── Reasoning summary bucket (third independent stream alongside text + thinking)
  //
  // Regression coverage for the third bucket added in B / sub-agent
  // reasoning_summary plumbing. The earlier two-bucket model would have
  // mixed summary text into the text bucket, losing the `type` on flush
  // (the LAST sample event's type wins, so a summary chunk arriving
  // after a text chunk would have its content emitted as a `text_delta`
  // — invisible regression because the renderer's per-block routing in
  // applyBatchedDeltas would land it on the wrong block kind).

  it('splits a large upstream delta across frame-sized timer ticks', () => {
    const send = vi.fn()
    const pace = __getStreamPaceCharsForTests()
    const text = 'x'.repeat(pace * 2 + 7)

    coalesceForIpc(
      { conversationId: 'conv-large', type: 'text_delta', text },
      send,
    )

    vi.advanceTimersByTime(16)
    expect(send).toHaveBeenCalledTimes(1)
    expect((send.mock.calls[0]?.[0] as { text: string }).text).toHaveLength(pace)

    vi.advanceTimersByTime(16)
    expect(send).toHaveBeenCalledTimes(2)

    vi.advanceTimersByTime(16)
    expect(send).toHaveBeenCalledTimes(3)
    const joined = send.mock.calls.map((call) => (call[0] as { text: string }).text).join('')
    expect(joined).toBe(text)
  })

  it('keeps message_stop behind a paced large delta', () => {
    const send = vi.fn()
    const pace = __getStreamPaceCharsForTests()
    const text = 'y'.repeat(pace * 3)
    const base = { conversationId: 'conv-boundary', agentId: 'main' }

    coalesceForIpc({ ...base, type: 'text_delta', text }, send)
    coalesceForIpc({ ...base, type: 'message_stop' }, send)

    expect(send).not.toHaveBeenCalled()
    vi.advanceTimersByTime(16)
    expect(send).toHaveBeenCalledTimes(1)
    expect((send.mock.calls[0]?.[0] as { type: string }).type).toBe('text_delta')

    vi.advanceTimersByTime(32)
    const sent = send.mock.calls.map((call) => call[0] as { type: string; text?: string })
    expect(sent.at(-1)?.type).toBe('message_stop')
    expect(sent.filter((event) => event.type === 'text_delta').map((event) => event.text).join('')).toBe(text)
  })

  it('does not split a surrogate pair at the pacing boundary', () => {
    const send = vi.fn()
    const pace = __getStreamPaceCharsForTests()
    const text = `${'a'.repeat(pace - 1)}😀tail`

    coalesceForIpc({ conversationId: 'conv-unicode', type: 'text_delta', text }, send)
    vi.advanceTimersByTime(32)

    const joined = send.mock.calls.map((call) => (call[0] as { text: string }).text).join('')
    expect(joined).toBe(text)
    expect((send.mock.calls[0]?.[0] as { text: string }).text.endsWith('😀')).toBe(true)
  })

  it('coalesces reasoning_summary_delta in its own bucket — does NOT merge into text', () => {
    const send = vi.fn()
    const base = { conversationId: 'conv-1', agentId: 'main' }

    coalesceForIpc({ ...base, type: 'reasoning_summary_delta', text: 'I ' }, send)
    coalesceForIpc({ ...base, type: 'reasoning_summary_delta', text: 'considered ' }, send)
    coalesceForIpc({ ...base, type: 'reasoning_summary_delta', text: 'two approaches.' }, send)

    expect(send).not.toHaveBeenCalled()
    vi.advanceTimersByTime(20)

    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      type: 'reasoning_summary_delta',
      text: 'I considered two approaches.',
    })
  })

  it('keeps text + thinking + reasoning_summary buffers all independent inside one stream', () => {
    const send = vi.fn()
    const base = { conversationId: 'conv-1', agentId: 'main' }

    // Interleaved deltas across all three soft-merge peers — the bucket
    // separation must produce exactly three flushed events (one per
    // kind) with each kind's text fully coalesced, and the `type`
    // field intact.
    coalesceForIpc({ ...base, type: 'text_delta', text: 'A' }, send)
    coalesceForIpc({ ...base, type: 'thinking_delta', text: '1' }, send)
    coalesceForIpc({ ...base, type: 'reasoning_summary_delta', text: 'X' }, send)
    coalesceForIpc({ ...base, type: 'text_delta', text: 'B' }, send)
    coalesceForIpc({ ...base, type: 'reasoning_summary_delta', text: 'Y' }, send)
    coalesceForIpc({ ...base, type: 'thinking_delta', text: '2' }, send)

    vi.advanceTimersByTime(20)

    expect(send).toHaveBeenCalledTimes(3)
    const byType = new Map<string, string>()
    for (const call of send.mock.calls) {
      const ev = call[0] as { type: string; text: string }
      byType.set(ev.type, ev.text)
    }
    expect(byType.get('text_delta')).toBe('AB')
    expect(byType.get('thinking_delta')).toBe('12')
    expect(byType.get('reasoning_summary_delta')).toBe('XY')
  })

  it('flushes reasoning_summary buffer when a non-delta event arrives (preserves order)', () => {
    const send = vi.fn()
    const base = { conversationId: 'conv-1', agentId: 'main' }

    coalesceForIpc(
      { ...base, type: 'reasoning_summary_delta', text: 'pending summary' },
      send,
    )
    coalesceForIpc({ ...base, type: 'tool_start', toolUse: { id: 't1', name: 'X', input: {} } }, send)

    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      type: 'reasoning_summary_delta',
      text: 'pending summary',
    })
    expect(send.mock.calls[1]?.[0]).toMatchObject({ type: 'tool_start' })
  })

  it('coalesces subagent_reasoning_summary_delta the same way as the main-agent variant', () => {
    const send = vi.fn()
    const base = { conversationId: 'conv-1', agentId: 'sub-1' }

    coalesceForIpc(
      { ...base, type: 'subagent_reasoning_summary_delta', text: 'sub-' },
      send,
    )
    coalesceForIpc(
      { ...base, type: 'subagent_reasoning_summary_delta', text: 'agent ' },
      send,
    )
    coalesceForIpc(
      { ...base, type: 'subagent_reasoning_summary_delta', text: 'summary' },
      send,
    )

    vi.advanceTimersByTime(20)

    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      type: 'subagent_reasoning_summary_delta',
      text: 'sub-agent summary',
      agentId: 'sub-1',
    })
  })
})
