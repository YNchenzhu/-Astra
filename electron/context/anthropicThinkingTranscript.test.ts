import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  applyAnthropicThinkingTranscriptCore,
  flushThinkingStreamModelPersistence,
  initThinkingStreamModelPersistence,
  normalizeAnthropicThinkingTranscript,
  peekLastStreamModelForThinkingTranscript,
  providerUsesAnthropicMessagesApi,
  rememberLastStreamModelForThinkingTranscript,
  assistantFollowsAllErrorToolBatch,
  removeThinkingAndRedactedBlocksFromAssistants,
  resetThinkingTranscriptStreamModelMapForTests,
  stripThinkingSignaturesFromAssistantBlocks,
  truncateHistoricalThinkingByDistance,
} from './anthropicThinkingTranscript'

describe('anthropicThinkingTranscript (§10.2 / §10.3)', () => {
  afterEach(() => {
    resetThinkingTranscriptStreamModelMapForTests()
  })
  it('providerUsesAnthropicMessagesApi matches streamAnthropic routes', () => {
    expect(providerUsesAnthropicMessagesApi('anthropic')).toBe(true)
    expect(providerUsesAnthropicMessagesApi('bedrock')).toBe(true)
    expect(providerUsesAnthropicMessagesApi('openai')).toBe(false)
    expect(providerUsesAnthropicMessagesApi('gemini')).toBe(false)
  })

  it('stripThinkingSignaturesFromAssistantBlocks removes signature only on thinking blocks', () => {
    const messages: Array<Record<string, unknown>> = [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'x', signature: 'sig-a' },
          { type: 'text', text: 'hi' },
        ],
      },
    ]
    const out = stripThinkingSignaturesFromAssistantBlocks(messages)
    const blocks = out[0].content as Record<string, unknown>[]
    expect(blocks[0].signature).toBeUndefined()
    expect(blocks[0].thinking).toBe('x')
  })

  it('removeThinkingAndRedactedBlocksFromAssistants drops blocks and preserves tool_use', () => {
    const messages: Array<Record<string, unknown>> = [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'plan' },
          { type: 'tool_use', id: '1', name: 'Read', input: {} },
        ],
      },
    ]
    const out = removeThinkingAndRedactedBlocksFromAssistants(messages)
    const blocks = out[0].content as Record<string, unknown>[]
    expect(blocks).toHaveLength(1)
    expect(blocks[0].type).toBe('tool_use')
  })

  it('removeThinkingAndRedactedBlocksFromAssistants uses placeholder when assistant becomes empty', () => {
    const out = removeThinkingAndRedactedBlocksFromAssistants([
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'only' }] },
    ])
    const blocks = out[0].content as Record<string, unknown>[]
    expect(blocks).toEqual([{ type: 'text', text: ' ' }])
  })

  it('normalize: inactive thinking strips thinking then appends trailing text (§10.2)', () => {
    const messages: Array<Record<string, unknown>> = [
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'z' }] },
    ]
    const out = normalizeAnthropicThinkingTranscript(messages, {
      providerId: 'anthropic',
      currentModel: 'claude-sonnet-4-20250514',
      thinkingRequestActive: false,
      stripSignaturesOnModelChange: false,
    })
    const blocks = out[0].content as Record<string, unknown>[]
    expect(blocks[blocks.length - 1].type).toBe('text')
  })

  it('normalize: model change strips signature before send (§10.3)', () => {
    const messages: Array<Record<string, unknown>> = [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'x', signature: 's' },
          { type: 'text', text: 'ok' },
        ],
      },
    ]
    const out = normalizeAnthropicThinkingTranscript(messages, {
      providerId: 'anthropic',
      currentModel: 'claude-haiku-4-5-20251001',
      previousStreamSnapshot: {
        provider: 'anthropic',
        model: 'claude-opus-4-20250115',
      },
      thinkingRequestActive: true,
      stripSignaturesOnModelChange: true,
    })
    const blocks = out[0].content as Record<string, unknown>[]
    expect(blocks[0].signature).toBeUndefined()
  })

  it('normalize: provider switch (same model id) strips signature (§10.3 三元组)', () => {
    // bedrock 的 us.anthropic.claude-sonnet-4 与 anthropic 直连的 claude-sonnet-4
    // 模型名后缀一样但签名互不通用。三元组对比会捕获 provider 维度的 mismatch。
    const messages: Array<Record<string, unknown>> = [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'x', signature: 'bedrock-sig' },
        ],
      },
    ]
    const out = normalizeAnthropicThinkingTranscript(messages, {
      providerId: 'anthropic',
      currentModel: 'claude-sonnet-4-20250514',
      previousStreamSnapshot: {
        provider: 'bedrock',
        model: 'claude-sonnet-4-20250514',
      },
      thinkingRequestActive: true,
      stripSignaturesOnModelChange: true,
    })
    const blocks = out[0].content as Record<string, unknown>[]
    expect(blocks[0].signature).toBeUndefined()
  })

  it('normalize: configId switch (same provider+model) strips signature (§10.3 三元组)', () => {
    // 同 provider 同 model 但用户在两个 ApiConfig 之间切换 → API key 变了 → 旧签名失效。
    const messages: Array<Record<string, unknown>> = [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'x', signature: 'old-key-sig' },
        ],
      },
    ]
    const out = normalizeAnthropicThinkingTranscript(messages, {
      providerId: 'anthropic',
      currentModel: 'claude-sonnet-4-20250514',
      currentConfigId: 'cfg-new',
      previousStreamSnapshot: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        configId: 'cfg-old',
      },
      thinkingRequestActive: true,
      stripSignaturesOnModelChange: true,
    })
    const blocks = out[0].content as Record<string, unknown>[]
    expect(blocks[0].signature).toBeUndefined()
  })

  it('normalize: same triple keeps signature (no spurious strip)', () => {
    const messages: Array<Record<string, unknown>> = [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'x', signature: 'sig-keep' },
          { type: 'text', text: 'ok' },
        ],
      },
    ]
    const out = normalizeAnthropicThinkingTranscript(messages, {
      providerId: 'anthropic',
      currentModel: 'claude-sonnet-4-20250514',
      currentConfigId: 'cfg-a',
      previousStreamSnapshot: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        configId: 'cfg-a',
      },
      thinkingRequestActive: true,
      stripSignaturesOnModelChange: true,
    })
    const blocks = out[0].content as Record<string, unknown>[]
    expect(blocks[0].signature).toBe('sig-keep')
  })

  it('normalize: no signature strip when stripSignaturesOnModelChange is false', () => {
    const messages: Array<Record<string, unknown>> = [
      {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'x', signature: 'keep' }],
      },
    ]
    const out = normalizeAnthropicThinkingTranscript(messages, {
      providerId: 'anthropic',
      currentModel: 'm-b',
      previousStreamSnapshot: { provider: 'anthropic', model: 'm-a' },
      thinkingRequestActive: true,
      stripSignaturesOnModelChange: false,
    })
    expect((out[0].content as Record<string, unknown>[])[0].signature).toBe('keep')
  })

  it('normalize: passthrough for non-Anthropic providers without forceClaudeShapedMessages', () => {
    const messages = [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'x' }] }]
    const out = normalizeAnthropicThinkingTranscript(messages, {
      providerId: 'openai',
      currentModel: 'gpt-4o',
      thinkingRequestActive: false,
      stripSignaturesOnModelChange: true,
    })
    expect(out).toBe(messages)
  })

  it('normalize: forceClaudeShapedMessages strips thinking for compatible-style provider id', () => {
    const messages = [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'x' }] }]
    const out = normalizeAnthropicThinkingTranscript(messages, {
      providerId: 'compatible',
      currentModel: 'gpt-4o',
      thinkingRequestActive: false,
      stripSignaturesOnModelChange: false,
      forceClaudeShapedMessages: true,
    })
    const blocks = out[0].content as Record<string, unknown>[]
    expect(blocks[blocks.length - 1].type).toBe('text')
  })

  it('applyAnthropicThinkingTranscriptCore is idempotent with strip + fix', () => {
    const messages: Array<Record<string, unknown>> = [
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'z' }] },
    ]
    const once = applyAnthropicThinkingTranscriptCore(messages, {
      currentProvider: 'anthropic',
      currentModel: 'm',
      thinkingRequestActive: false,
      stripSignaturesOnModelChange: false,
    })
    const twice = applyAnthropicThinkingTranscriptCore(once, {
      currentProvider: 'anthropic',
      currentModel: 'm',
      thinkingRequestActive: false,
      stripSignaturesOnModelChange: false,
    })
    expect(twice).toEqual(once)
  })

  it('peek/remember last stream snapshot for §10.3 (三元组)', () => {
    expect(peekLastStreamModelForThinkingTranscript('c1')).toBeUndefined()
    rememberLastStreamModelForThinkingTranscript('c1', {
      provider: 'anthropic',
      model: 'model-a',
    })
    expect(peekLastStreamModelForThinkingTranscript('c1')).toEqual({
      provider: 'anthropic',
      model: 'model-a',
    })
    rememberLastStreamModelForThinkingTranscript('c1', {
      provider: 'anthropic',
      model: 'model-b',
      configId: 'cfg-1',
    })
    expect(peekLastStreamModelForThinkingTranscript('c1')).toEqual({
      provider: 'anthropic',
      model: 'model-b',
      configId: 'cfg-1',
    })
  })

  it('persists thinking-stream model map across simulated process restart (§10.3 cross-restart)', () => {
    // Regression for the previous in-memory-only behaviour: a user switching
    // models WHILE the IDE process restarts (e.g. they quit mid-session,
    // change the model dropdown in settings on next boot, then continue) used
    // to lose the §10.3 strip-on-model-change trigger because the module-
    // scoped map was wiped. The fix persists to a sidecar JSON next to the
    // conversation buckets; this test exercises that round-trip.
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'thinking-persist-'))
    try {
      // Round 1: init, record, flush (mimics a normal turn settling onto disk).
      initThinkingStreamModelPersistence(tmpRoot)
      rememberLastStreamModelForThinkingTranscript('conv-cross-restart', {
        provider: 'anthropic',
        model: 'claude-4.6-sonnet',
        configId: 'cfg-x',
      })
      flushThinkingStreamModelPersistence()
      // The sidecar should now exist at the documented path.
      const sidecar = path.join(tmpRoot, 'conversations', '_thinking-stream-models.json')
      expect(fs.existsSync(sidecar)).toBe(true)

      // Round 2: simulate process restart — clear in-memory map, re-init from
      // the same root. The remembered snapshot must come back without any
      // intermediate remember call.
      resetThinkingTranscriptStreamModelMapForTests()
      expect(peekLastStreamModelForThinkingTranscript('conv-cross-restart')).toBeUndefined()
      initThinkingStreamModelPersistence(tmpRoot)
      expect(peekLastStreamModelForThinkingTranscript('conv-cross-restart')).toEqual({
        provider: 'anthropic',
        model: 'claude-4.6-sonnet',
        configId: 'cfg-x',
      })
    } finally {
      // Belt and suspenders: ensure we don't leave persist state pointing at
      // the temp dir between tests, even though afterEach already calls
      // `resetThinkingTranscriptStreamModelMapForTests`.
      resetThinkingTranscriptStreamModelMapForTests()
      try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  })

  it('tolerates a missing / corrupt persistence sidecar (§10.3 degraded mode)', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'thinking-persist-bad-'))
    try {
      // Pre-write garbage so the loader has to swallow a JSON parse error.
      const dir = path.join(tmpRoot, 'conversations')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, '_thinking-stream-models.json'), 'not-json{{{')

      // Init should NOT throw — degraded mode keeps the in-memory map empty
      // and the next remember call rewrites the file cleanly with v2 schema.
      expect(() => initThinkingStreamModelPersistence(tmpRoot)).not.toThrow()
      expect(peekLastStreamModelForThinkingTranscript('any')).toBeUndefined()
      rememberLastStreamModelForThinkingTranscript('c-recover', {
        provider: 'openai',
        model: 'gpt-5.5',
      })
      flushThinkingStreamModelPersistence()
      const raw = fs.readFileSync(path.join(dir, '_thinking-stream-models.json'), 'utf-8')
      const parsed = JSON.parse(raw) as {
        version: number
        byConversationId: Record<string, { provider: string; model: string; configId?: string }>
      }
      expect(parsed.version).toBe(2)
      expect(parsed.byConversationId['c-recover']).toEqual({
        provider: 'openai',
        model: 'gpt-5.5',
      })
    } finally {
      resetThinkingTranscriptStreamModelMapForTests()
      try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  })

  it('reads a v1 sidecar and migrates entries to provider=unknown (v1→v2 兼容)', () => {
    // 一次 v1 文件被旧版本写过，新版本启动后必须能读出来。provider 标记 'unknown'
    // 让下一轮请求一定 mismatch（多 strip 一次 — 无害），然后 remember 覆盖为 v2。
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'thinking-persist-v1-'))
    try {
      const dir = path.join(tmpRoot, 'conversations')
      fs.mkdirSync(dir, { recursive: true })
      // 手写一个 v1 文件
      fs.writeFileSync(
        path.join(dir, '_thinking-stream-models.json'),
        JSON.stringify({
          version: 1,
          byConversationId: { 'conv-from-v1': 'claude-3-7-sonnet' },
        }),
      )

      initThinkingStreamModelPersistence(tmpRoot)
      const snap = peekLastStreamModelForThinkingTranscript('conv-from-v1')
      expect(snap).toEqual({ provider: 'unknown', model: 'claude-3-7-sonnet' })

      // 下次 remember 后写回应该是 v2 schema
      rememberLastStreamModelForThinkingTranscript('conv-from-v1', {
        provider: 'anthropic',
        model: 'claude-3-7-sonnet',
      })
      flushThinkingStreamModelPersistence()
      const raw = fs.readFileSync(path.join(dir, '_thinking-stream-models.json'), 'utf-8')
      const parsed = JSON.parse(raw) as { version: number }
      expect(parsed.version).toBe(2)
    } finally {
      resetThinkingTranscriptStreamModelMapForTests()
      try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  })
})

// ─── R1 — distance-based historical thinking truncation ──────────────────

describe('truncateHistoricalThinkingByDistance (R1)', () => {
  // Helper builders. The function operates on Anthropic-shape records
  // (`Record<string, unknown>`), not the renderer ChatMessage type.
  function userMsg(text: string): Record<string, unknown> {
    return { role: 'user', content: text }
  }
  function assistantWithThinking(text: string, signature?: string): Record<string, unknown> {
    const block: Record<string, unknown> = { type: 'thinking', thinking: text }
    if (signature !== undefined) block.signature = signature
    return {
      role: 'assistant',
      content: [block, { type: 'text', text: 'answer' }],
    }
  }

  it('returns the input array unchanged when nothing exceeds any threshold', () => {
    const msgs = [userMsg('hi'), assistantWithThinking('short reasoning')]
    const out = truncateHistoricalThinkingByDistance(msgs)
    // Same identity = the cheap no-touch fast path.
    expect(out).toBe(msgs)
  })

  it('preserves the most-recent assistant turn (distance 0) verbatim', () => {
    const longText = 'x'.repeat(2000)
    const msgs = [
      userMsg('start'),
      assistantWithThinking(longText, 'sig-old'),
      userMsg('continue'),
      assistantWithThinking(longText, 'sig-new'), // distance 0 — last
    ]
    const out = truncateHistoricalThinkingByDistance(msgs)
    const lastAssistant = out[out.length - 1] as { content: Array<Record<string, unknown>> }
    const lastBlock = lastAssistant.content[0]
    // Last turn should still be full text + signature intact.
    expect(lastBlock.thinking).toBe(longText)
    expect(lastBlock.signature).toBe('sig-new')
  })

  it('preserves distance-1 (last completed turn) verbatim too', () => {
    const longText = 'x'.repeat(2000)
    const msgs = [
      userMsg('start'),
      assistantWithThinking(longText, 'sig-d1'), // distance 1
      userMsg('continue'),
      assistantWithThinking('current short answer'), // distance 0
    ]
    const out = truncateHistoricalThinkingByDistance(msgs)
    const dist1Assistant = out[1] as { content: Array<Record<string, unknown>> }
    const block = dist1Assistant.content[0]
    expect(block.thinking).toBe(longText)
    expect(block.signature).toBe('sig-d1')
  })

  it('truncates distance-2 thinking to ~800 chars + suffix and drops signature', () => {
    const longText = 'x'.repeat(2000)
    const msgs = [
      userMsg('start'),
      assistantWithThinking(longText, 'sig-d2'), // distance 2
      userMsg('mid'),
      assistantWithThinking('mid', 'sig-d1'),
      userMsg('end'),
      assistantWithThinking('end answer', 'sig-d0'),
    ]
    const out = truncateHistoricalThinkingByDistance(msgs)
    const d2 = out[1] as { content: Array<Record<string, unknown>> }
    const block = d2.content[0] as { thinking: string; signature?: string }
    expect(block.thinking.startsWith('x'.repeat(800))).toBe(true)
    expect(block.thinking).toContain('chars of historical reasoning elided')
    expect(block.thinking).toContain('1200 chars') // 2000 - 800 elided
    expect(block.signature).toBeUndefined()
  })

  it('truncates distance-3+ thinking to ~200 chars + suffix and drops signature', () => {
    const longText = 'x'.repeat(2000)
    const msgs = [
      userMsg('u1'),
      assistantWithThinking(longText, 'sig-d3'), // distance 3
      userMsg('u2'),
      assistantWithThinking('a2'),
      userMsg('u3'),
      assistantWithThinking('a3'),
      userMsg('u4'),
      assistantWithThinking('a4 (current)'),
    ]
    const out = truncateHistoricalThinkingByDistance(msgs)
    const d3 = out[1] as { content: Array<Record<string, unknown>> }
    const block = d3.content[0] as { thinking: string; signature?: string }
    expect(block.thinking.startsWith('x'.repeat(200))).toBe(true)
    expect(block.thinking).toContain('1800 chars') // 2000 - 200 elided
    expect(block.thinking).toContain('3 turns ago')
    expect(block.signature).toBeUndefined()
  })

  it('skips blocks already shortened by save-time compaction (idempotent with C)', () => {
    const compacted = `${'x'.repeat(200)}\n…(1800 characters elided on save)`
    const msgs = [
      userMsg('u1'),
      assistantWithThinking(compacted, 'sig-c'), // distance 2 but already short
      userMsg('u2'),
      assistantWithThinking('a2'),
      userMsg('u3'),
      assistantWithThinking('current'),
    ]
    const out = truncateHistoricalThinkingByDistance(msgs)
    const block = (out[1] as { content: Array<Record<string, unknown>> }).content[0] as {
      thinking: string
      signature?: string
    }
    // Text intact (already compacted by C — don't re-truncate).
    expect(block.thinking).toBe(compacted)
    // Signature preserved on already-compacted blocks (C did its own
    // signature handling at save time; R1 trusts the prior pass).
    expect(block.signature).toBe('sig-c')
  })

  it('skips blocks already truncated by a prior R1 pass (idempotent with itself)', () => {
    const alreadyR1 =
      'x'.repeat(200) +
      '\n…[1800 chars of historical reasoning elided (3 turns ago) to avoid anchoring]'
    const msgs = [
      userMsg('u1'),
      assistantWithThinking(alreadyR1),
      userMsg('u2'),
      assistantWithThinking('a2'),
      userMsg('u3'),
      assistantWithThinking('a3'),
      userMsg('u4'),
      assistantWithThinking('current'),
    ]
    const before = (msgs[1] as { content: Array<Record<string, unknown>> }).content[0]
      .thinking as string
    const out = truncateHistoricalThinkingByDistance(msgs)
    const after = (out[1] as { content: Array<Record<string, unknown>> }).content[0]
      .thinking as string
    expect(after).toBe(before)
  })

  it('leaves redacted_thinking blocks alone (already opaque, not our concern)', () => {
    const msgs = [
      userMsg('u1'),
      {
        role: 'assistant',
        content: [
          { type: 'redacted_thinking', data: 'opaque-blob-' + 'x'.repeat(2000) },
          { type: 'text', text: 'answer' },
        ],
      }, // distance 2
      userMsg('u2'),
      assistantWithThinking('a2'),
      userMsg('u3'),
      assistantWithThinking('current'),
    ]
    const out = truncateHistoricalThinkingByDistance(msgs)
    const d2 = out[1] as { content: Array<Record<string, unknown>> }
    expect(d2.content[0]).toEqual(msgs[1].content[0]) // unchanged
  })

  it('integrates with applyAnthropicThinkingTranscriptCore — fires for non-strict providers', () => {
    const longText = 'x'.repeat(2000)
    const msgs = [
      userMsg('u1'),
      assistantWithThinking(longText, 'sig-d2'),
      userMsg('u2'),
      assistantWithThinking('a2'),
      userMsg('u3'),
      assistantWithThinking('current'),
    ]
    const out = applyAnthropicThinkingTranscriptCore(msgs, {
      currentModel: 'm',
      thinkingRequestActive: true,
      stripSignaturesOnModelChange: false,
      strictThinkingEcho: false, // non-DeepSeek path → R1 fires
    })
    const d2 = out[1] as { content: Array<Record<string, unknown>> }
    const block = d2.content[0] as { thinking: string }
    expect(block.thinking.length).toBeLessThan(longText.length)
    expect(block.thinking).toContain('chars of historical reasoning elided')
  })

  it('integrates with applyAnthropicThinkingTranscriptCore — SKIPS for strictThinkingEcho (DeepSeek)', () => {
    const longText = 'x'.repeat(2000)
    const msgs = [
      userMsg('u1'),
      assistantWithThinking(longText, 'sig-d2'),
      userMsg('u2'),
      assistantWithThinking('a2'),
      userMsg('u3'),
      assistantWithThinking('current'),
    ]
    const out = applyAnthropicThinkingTranscriptCore(msgs, {
      currentModel: 'm',
      thinkingRequestActive: true,
      stripSignaturesOnModelChange: false,
      strictThinkingEcho: true, // DeepSeek path → R1 must skip (would 400)
    })
    const d2 = out[1] as { content: Array<Record<string, unknown>> }
    const block = d2.content[0] as { thinking: string; signature?: string }
    // Verbatim — text not truncated, signature kept.
    expect(block.thinking).toBe(longText)
    expect(block.signature).toBe('sig-d2')
  })
})

describe('post-failure reflection exemption (#15, 2026-07 uplift)', () => {
  function userText(text: string): Record<string, unknown> {
    return { role: 'user', content: text }
  }
  function assistantThinking(text: string): Record<string, unknown> {
    return {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: text },
        { type: 'text', text: 'answer' },
      ],
    }
  }
  function toolResults(
    blocks: Array<{ ok: boolean }>,
  ): Record<string, unknown> {
    return {
      role: 'user',
      content: blocks.map((b, i) => ({
        type: 'tool_result',
        tool_use_id: `tu_${i}`,
        ...(b.ok ? { content: 'done' } : { content: 'Error: boom', is_error: true }),
      })),
    }
  }

  afterEach(() => {
    delete process.env.POLE_THINKING_REFLECTION_EXEMPT
  })

  describe('assistantFollowsAllErrorToolBatch', () => {
    it('true when every tool_result in the span failed', () => {
      const msgs = [
        assistantThinking('a1'),
        toolResults([{ ok: false }, { ok: false }]),
        assistantThinking('reflection'),
      ]
      expect(assistantFollowsAllErrorToolBatch(msgs, 2)).toBe(true)
    })

    it('false on mixed batches, no-tool spans, and turn boundaries', () => {
      const mixed = [
        assistantThinking('a1'),
        toolResults([{ ok: false }, { ok: true }]),
        assistantThinking('a2'),
      ]
      expect(assistantFollowsAllErrorToolBatch(mixed, 2)).toBe(false)

      const noTools = [userText('hi'), assistantThinking('a1')]
      expect(assistantFollowsAllErrorToolBatch(noTools, 1)).toBe(false)

      // Errors BEFORE the previous assistant message don't count.
      const boundary = [
        toolResults([{ ok: false }]),
        assistantThinking('a1'),
        userText('go on'),
        assistantThinking('a2'),
      ]
      expect(assistantFollowsAllErrorToolBatch(boundary, 3)).toBe(false)
    })

    it('scans past host-attachment user messages after the tool_result carrier', () => {
      const msgs = [
        assistantThinking('a1'),
        toolResults([{ ok: false }]),
        userText('<system-reminder>attachment</system-reminder>'),
        assistantThinking('reflection'),
      ]
      expect(assistantFollowsAllErrorToolBatch(msgs, 3)).toBe(true)
    })
  })

  it('keeps full reflection thinking at distance 2-4; normal schedule elsewhere', () => {
    const longText = 'r'.repeat(2000)
    const msgs = [
      userText('task'),
      assistantThinking('n'.repeat(2000)), // distance 3 — normal → 200 cap
      toolResults([{ ok: true }]),
      assistantThinking(longText), // distance 2 — REFLECTION (all-error batch below is its span)
      toolResults([{ ok: true }]),
      assistantThinking('short'), // distance 1
      toolResults([{ ok: true }]),
      assistantThinking('current'), // distance 0
    ]
    // Make the distance-2 turn a reflection: its preceding span must be
    // all-errors. Rebuild with the error batch before it.
    msgs[2] = toolResults([{ ok: false }, { ok: false }])
    const out = truncateHistoricalThinkingByDistance(msgs)
    const reflection = out[3] as { content: Array<Record<string, unknown>> }
    expect(reflection.content[0]!.thinking).toBe(longText) // exempt — full text
    const normal = out[1] as { content: Array<Record<string, unknown>> }
    expect(String(normal.content[0]!.thinking)).toContain('chars of historical reasoning elided')
  })

  it('reflection turns beyond the keep-through distance truncate normally', () => {
    const longText = 'r'.repeat(2000)
    const msgs: Array<Record<string, unknown>> = [
      userText('task'),
      assistantThinking('a-old'),
      toolResults([{ ok: false }]),
      assistantThinking(longText), // reflection, but will sit at distance 5
    ]
    for (let i = 0; i < 5; i++) {
      msgs.push(toolResults([{ ok: true }]))
      msgs.push(assistantThinking(`later-${i}`))
    }
    const out = truncateHistoricalThinkingByDistance(msgs)
    const reflection = out[3] as { content: Array<Record<string, unknown>> }
    expect(String(reflection.content[0]!.thinking)).toContain(
      'chars of historical reasoning elided',
    )
  })

  it('honours the POLE_THINKING_REFLECTION_EXEMPT=0 kill-switch', () => {
    process.env.POLE_THINKING_REFLECTION_EXEMPT = '0'
    const longText = 'r'.repeat(2000)
    const msgs = [
      userText('task'),
      assistantThinking('a1'),
      toolResults([{ ok: false }]),
      assistantThinking(longText), // distance 2 reflection — but exemption off
      toolResults([{ ok: true }]),
      assistantThinking('short'),
      toolResults([{ ok: true }]),
      assistantThinking('current'),
    ]
    const out = truncateHistoricalThinkingByDistance(msgs)
    const reflection = out[3] as { content: Array<Record<string, unknown>> }
    expect(String(reflection.content[0]!.thinking)).toContain(
      'chars of historical reasoning elided',
    )
  })
})
