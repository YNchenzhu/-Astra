import { describe, it, expect, vi, beforeEach } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { microCompact, autoCompact } from './compact'
import * as aiClient from '../ai/client'
import {
  clearContextCollapseStoreForTests,
  consumeContextCollapseSummaries,
} from './contextCollapseStore'

vi.mock('../ai/client', () => ({
  streamText: vi.fn(
    async (
      _c: unknown,
      _p: unknown,
      callbacks: {
        onTextDelta?: (t: string) => void
        onMessageEnd?: () => void
        onError?: (e: string) => void
      },
    ) => {
      callbacks.onTextDelta?.('stub compact summary')
      callbacks.onMessageEnd?.()
    },
  ),
}))

describe('microCompact', () => {
  it('keeps recent tool results intact', () => {
    const msgs = [
      { role: 'user', content: [{ type: 'tool_result', content: 'x'.repeat(300), tool_use_id: 't1' }] },
      { role: 'user', content: [{ type: 'tool_result', content: 'y'.repeat(300), tool_use_id: 't2' }] },
      { role: 'user', content: [{ type: 'tool_result', content: 'z'.repeat(300), tool_use_id: 't3' }] },
    ]
    const result = microCompact(msgs, 3)
    // All 3 are recent, none should be truncated
    expect(result.length).toBe(3)
    for (const msg of result) {
      const blocks = msg.content as Array<Record<string, unknown>>
      const tr = blocks.find((b: Record<string, unknown>) => b.type === 'tool_result')!
      expect((tr.content as string)).not.toContain('truncated')
    }
  })

  it('truncates old tool results beyond keepRecentIterations', () => {
    const msgs = [
      { role: 'user', content: [{ type: 'tool_result', content: 'x'.repeat(300), tool_use_id: 't1' }] },
      { role: 'user', content: [{ type: 'tool_result', content: 'y'.repeat(300), tool_use_id: 't2' }] },
      { role: 'user', content: [{ type: 'tool_result', content: 'z'.repeat(300), tool_use_id: 't3' }] },
      { role: 'user', content: [{ type: 'tool_result', content: 'w'.repeat(300), tool_use_id: 't4' }] },
    ]
    const result = microCompact(msgs, 2)
    // First 2 should be truncated (tool result group 3 and 4 are recent)
    const first = result[0].content as Array<Record<string, unknown>>
    const firstTr = first.find((b: Record<string, unknown>) => b.type === 'tool_result')!
    expect((firstTr.content as string)).toContain('truncated')

    const last = result[3].content as Array<Record<string, unknown>>
    const lastTr = last.find((b: Record<string, unknown>) => b.type === 'tool_result')!
    expect((lastTr.content as string)).not.toContain('truncated')
  })

  it('does not truncate short tool results', () => {
    const msgs = [
      { role: 'user', content: [{ type: 'tool_result', content: 'short', tool_use_id: 't1' }] },
      { role: 'user', content: [{ type: 'tool_result', content: 'short2', tool_use_id: 't2' }] },
    ]
    const result = microCompact(msgs, 1)
    // First msg is old but content is short (<200 chars), should not be truncated
    const first = result[0].content as Array<Record<string, unknown>>
    const firstTr = first.find((b: Record<string, unknown>) => b.type === 'tool_result')!
    expect((firstTr.content as string)).not.toContain('truncated')
  })

  it('preserves non-tool-result messages', () => {
    const msgs = [
      { role: 'user', content: 'Plain text message' },
      { role: 'assistant', content: 'Response' },
      { role: 'user', content: [{ type: 'tool_result', content: 'x'.repeat(300), tool_use_id: 't1' }] },
    ]
    const result = microCompact(msgs, 2)
    expect(result[0]).toEqual(msgs[0])
    expect(result[1]).toEqual(msgs[1])
  })

  it('does not mutate original messages', () => {
    const original = [
      { role: 'user', content: [{ type: 'tool_result', content: 'x'.repeat(300), tool_use_id: 't1' }] },
      { role: 'user', content: [{ type: 'tool_result', content: 'y'.repeat(300), tool_use_id: 't2' }] },
    ]
    const copy = JSON.parse(JSON.stringify(original))
    microCompact(original, 1)
    expect(original).toEqual(copy)
  })

  it('handles empty messages array', () => {
    const result = microCompact([], 3)
    expect(result).toEqual([])
  })

  it('handles messages without tool results', () => {
    const msgs = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'World' },
    ]
    const result = microCompact(msgs, 3)
    expect(result).toEqual(msgs)
  })

  it('preserves tool_use blocks alongside tool_result in same message', () => {
    const msgs = [
      {
        role: 'user',
        content: [
          { type: 'tool_result', content: 'x'.repeat(300), tool_use_id: 't1' },
          { type: 'text', text: 'Additional context' },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', content: 'y'.repeat(300), tool_use_id: 't2' },
        ],
      },
    ]
    const result = microCompact(msgs, 1)
    // First message should have truncated tool_result but preserved text block
    const first = result[0].content as Array<Record<string, unknown>>
    const textBlock = first.find((b: Record<string, unknown>) => b.type === 'text')
    expect(textBlock).toBeDefined()
    expect((textBlock as { text: string }).text).toBe('Additional context')
  })

  it('protects Read receipts from truncation (writeIntegrityGuard dependency)', () => {
    // assistant tool_use → user tool_result pairs. Read result must survive
    // micro-compact even when it falls outside `keepRecentIterations`.
    const msgs = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu_read_1', name: 'Read', input: { filePath: 'a.ts' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', content: 'authoritative file body '.repeat(40), tool_use_id: 'tu_read_1' }],
      },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu_grep_1', name: 'Grep', input: { pattern: 'foo' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', content: 'grep matches '.repeat(40), tool_use_id: 'tu_grep_1' }],
      },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu_edit_1', name: 'Edit', input: { filePath: 'a.ts', oldString: 'a', newString: 'b' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', content: 'edit applied', tool_use_id: 'tu_edit_1' }],
      },
    ]
    const result = microCompact(msgs, 1) // only keep newest group → Read result is "old"

    // Read result should NOT be truncated (protected)
    const readResult = (result[1].content as Array<Record<string, unknown>>).find(
      (b) => b.type === 'tool_result',
    )!
    expect(readResult.content as string).not.toContain('truncated')
    expect((readResult.content as string).length).toBeGreaterThan(200)

    // Grep result SHOULD be truncated (not protected)
    const grepResult = (result[3].content as Array<Record<string, unknown>>).find(
      (b) => b.type === 'tool_result',
    )!
    expect(grepResult.content as string).toContain('truncated')
  })

  it('protects task-ledger referenced tool results from truncation', () => {
    const msgs = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu_agent_1', name: 'Agent', input: { agent_type: 'Explore' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', content: 'sub-agent findings '.repeat(40), tool_use_id: 'tu_agent_1' }],
      },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu_bash_1', name: 'Bash', input: { command: 'echo ok' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', content: 'bash output '.repeat(40), tool_use_id: 'tu_bash_1' }],
      },
    ]
    const result = microCompact(msgs, 1, ['tu_agent_1'])
    const agentResult = (result[1].content as Array<Record<string, unknown>>).find(
      (b) => b.type === 'tool_result',
    )!
    expect(agentResult.content as string).not.toContain('truncated')
  })

  it('drops the embedded tool-batch ledger when its tool_results are truncated (ledger TTL)', () => {
    // 2026-06 long-run hallucination fix — host-authored "-> success"
    // ledger claims must share the lifetime of the tool_result evidence.
    const ledger = (id: string) =>
      `<system-reminder>\n[Previous tool batch ledger — host-generated]\n- Bash id=${id} -> success; input={}; result=ok\n</system-reminder>`
    const msgs = [
      {
        role: 'user',
        content: [
          { type: 'tool_result', content: 'x'.repeat(300), tool_use_id: 't_old' },
          { type: 'text', text: ledger('t_old') },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', content: 'y'.repeat(300), tool_use_id: 't_new' },
          { type: 'text', text: ledger('t_new') },
        ],
      },
    ]
    const result = microCompact(msgs, 1)

    // Old group: result truncated, ledger dropped.
    const oldBlocks = result[0].content as Array<Record<string, unknown>>
    expect(
      (oldBlocks.find((b) => b.type === 'tool_result')!.content as string),
    ).toContain('truncated')
    expect(oldBlocks.some((b) => b.type === 'text')).toBe(false)

    // Recent group: result and ledger both intact.
    const newBlocks = result[1].content as Array<Record<string, unknown>>
    expect(
      (newBlocks.find((b) => b.type === 'tool_result')!.content as string),
    ).not.toContain('truncated')
    expect(
      newBlocks.some(
        (b) =>
          b.type === 'text' &&
          typeof b.text === 'string' &&
          (b.text as string).includes('[Previous tool batch ledger'),
      ),
    ).toBe(true)
  })

  it('keeps non-ledger text blocks in truncated groups', () => {
    const msgs = [
      {
        role: 'user',
        content: [
          { type: 'tool_result', content: 'x'.repeat(300), tool_use_id: 't_old' },
          { type: 'text', text: 'Additional context' },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', content: 'y'.repeat(300), tool_use_id: 't_new' }],
      },
    ]
    const result = microCompact(msgs, 1)
    const oldBlocks = result[0].content as Array<Record<string, unknown>>
    expect(
      oldBlocks.some((b) => b.type === 'text' && b.text === 'Additional context'),
    ).toBe(true)
  })
})

describe('autoCompact', () => {
  beforeEach(() => {
    clearContextCollapseStoreForTests()
  })

  it('queues §13 collapse summary when collapseConversationKey is set', async () => {
    const key = `${path.join(os.tmpdir(), 'ws')}::conv-1`
    const messages = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ] as Array<Record<string, unknown>>
    await autoCompact({
      config: { id: 'openai', name: 'o', apiKey: 'x' } as import('../ai/client').ProviderConfig,
      model: 'gpt-4',
      systemPrompt: 'sys',
      messages,
      signal: new AbortController().signal,
      collapseConversationKey: key,
    })
    const drained = consumeContextCollapseSummaries(key)
    expect(drained.length).toBe(1)
    expect(drained[0]).toContain('stub compact summary')
  })

  it('does not queue collapse when key is omitted', async () => {
    const key = `${path.join(os.tmpdir(), 'ws')}::conv-2`
    const messages = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ] as Array<Record<string, unknown>>
    await autoCompact({
      config: { id: 'openai', name: 'o', apiKey: 'x' } as import('../ai/client').ProviderConfig,
      model: 'gpt-4',
      systemPrompt: 'sys',
      messages,
      signal: new AbortController().signal,
    })
    expect(consumeContextCollapseSummaries(key)).toEqual([])
  })

  // Regression: the post-compact summary message must be wrapped in
  // `<system-reminder>` so the standing system prompt's "treat
  // <system-reminder> as side-channel context, not a fresh user
  // statement" rule applies. Pre-fix, the bare `[Previous conversation
  // was compacted ...]` blob occasionally got read on non-Anthropic
  // providers as "the user is narrating their own past", and the model
  // either re-did already-completed work or apologized for things it
  // hadn't done.
  it('wraps the post-compact summary in <system-reminder> with an authoritative-record framing', async () => {
    const messages = [
      { role: 'user', content: 'long convo' },
      { role: 'assistant', content: 'lots of work happened' },
    ] as Array<Record<string, unknown>>
    const result = await autoCompact({
      config: { id: 'openai', name: 'o', apiKey: 'x' } as import('../ai/client').ProviderConfig,
      model: 'gpt-4',
      systemPrompt: 'sys',
      messages,
      signal: new AbortController().signal,
    })
    expect(result.wasCompacted).toBe(true)
    // First message of the rebuilt transcript MUST be the wrapped recap.
    const head = result.messages[0]
    expect(head?.role).toBe('user')
    const headContent =
      typeof head?.content === 'string' ? head.content : ''
    expect(headContent).toMatch(/^<system-reminder>/u)
    expect(headContent).toMatch(/<\/system-reminder>$/u)
    expect(headContent).toContain('[Previous conversation was compacted')
    // Body must explicitly tell the model to treat the recap as the
    // authoritative record, NOT as a user narration.
    expect(headContent).toMatch(/authoritative record/iu)
    expect(headContent).toMatch(/Do NOT re-do work/u)
    // `_convertedFromSystem` flag still set so downstream gates treat
    // it as system-injected.
    expect((head as { _convertedFromSystem?: unknown })._convertedFromSystem).toBe(true)
  })

  it('appends a transcriptPath hint when CompactOptions.transcriptPath is provided', async () => {
    const transcriptPath = '/tmp/conv-store/abc/conv-123.json'
    const messages = [
      { role: 'user', content: 'investigation in progress' },
      { role: 'assistant', content: 'noted, will continue next turn' },
    ] as Array<Record<string, unknown>>
    const result = await autoCompact({
      config: { id: 'openai', name: 'o', apiKey: 'x' } as import('../ai/client').ProviderConfig,
      model: 'gpt-4',
      systemPrompt: 'sys',
      messages,
      signal: new AbortController().signal,
      transcriptPath,
    })
    const head = result.messages[0]
    const headContent =
      typeof head?.content === 'string' ? head.content : ''
    expect(headContent).toContain(
      `Read the full pre-compact transcript at: ${transcriptPath}`,
    )
  })

  // ── GAP 2 (2026-06) — host-verified tool fact ledger in the summarizer input ──
  it('feeds the summarizer a <host-verified-tool-facts> ledger when the window has tool calls', async () => {
    const streamTextMock = vi.mocked(aiClient.streamText)
    streamTextMock.mockClear()
    const messages = [
      { role: 'user', content: 'fix the file' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '全部修正完毕' },
          { type: 'tool_use', id: 'tu_1', name: 'edit_file', input: { file_path: 'src/a.ts' } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' }],
      },
    ] as Array<Record<string, unknown>>
    await autoCompact({
      config: { id: 'openai', name: 'o', apiKey: 'x' } as import('../ai/client').ProviderConfig,
      model: 'gpt-4',
      systemPrompt: 'sys',
      messages,
      signal: new AbortController().signal,
    })
    const call = streamTextMock.mock.calls.at(-1)!
    const body = (call[1] as { messages: Array<{ content: string }> }).messages[0].content
    // Ledger present (assert on the marker LINE — the bare tag name also
    // appears in the static prompt's cross-check rule), placed BEFORE the
    // conversation marker so the prompt-too-long retry never slices it away.
    const ledgerMarker = '[Host-verified tool execution facts'
    expect(body).toContain(ledgerMarker)
    expect(body.indexOf(ledgerMarker)).toBeLessThan(body.indexOf('\n\n---\n'))
    expect(body).toContain('- edit_file: 1 success')
    expect(body).toContain('success targets: src/a.ts')
    // Prompt carries the cross-check rule.
    expect(body).toContain('claimed but NOT verified by tool results')
  })

  it('omits the fact ledger for a window without tool calls', async () => {
    const streamTextMock = vi.mocked(aiClient.streamText)
    streamTextMock.mockClear()
    await autoCompact({
      config: { id: 'openai', name: 'o', apiKey: 'x' } as import('../ai/client').ProviderConfig,
      model: 'gpt-4',
      systemPrompt: 'sys',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
      ] as Array<Record<string, unknown>>,
      signal: new AbortController().signal,
    })
    const call = streamTextMock.mock.calls.at(-1)!
    const body = (call[1] as { messages: Array<{ content: string }> }).messages[0].content
    expect(body).not.toContain('[Host-verified tool execution facts')
  })

  it('omits the transcriptPath hint when no path is supplied', async () => {
    const messages = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ] as Array<Record<string, unknown>>
    const result = await autoCompact({
      config: { id: 'openai', name: 'o', apiKey: 'x' } as import('../ai/client').ProviderConfig,
      model: 'gpt-4',
      systemPrompt: 'sys',
      messages,
      signal: new AbortController().signal,
    })
    const head = result.messages[0]
    const headContent =
      typeof head?.content === 'string' ? head.content : ''
    expect(headContent).not.toContain('Read the full pre-compact transcript at:')
  })

  // 防回归 — side-query thinking policy。compact 的摘要 LLM 调用必须显式
  // 传 `alwaysThinking: false`，否则全局深度思考会让 thinking 内容混进
  // 摘要、再回灌成 history 给主模型读到，是典型的"思考链噪声→幻觉"链路。
  // 对应 plan Phase 0；如果未来有人重构 compact.ts 去掉这一字段，本断言
  // 会立刻挂。
  it('passes alwaysThinking:false to streamText so the summarizer never opens thinking', async () => {
    const mockedStreamText = vi.mocked(aiClient.streamText)
    mockedStreamText.mockClear()
    const messages = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ] as Array<Record<string, unknown>>
    await autoCompact({
      config: { id: 'openai', name: 'o', apiKey: 'x' } as import('../ai/client').ProviderConfig,
      model: 'gpt-4',
      systemPrompt: 'sys',
      messages,
      signal: new AbortController().signal,
    })
    expect(mockedStreamText).toHaveBeenCalled()
    const [, params] = mockedStreamText.mock.calls[0]!
    expect((params as { alwaysThinking?: boolean }).alwaysThinking).toBe(false)
  })
})
