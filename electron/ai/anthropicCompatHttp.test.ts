import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { streamAnthropicCompatHttp } from './anthropicCompatHttp'
import type { ProviderConfig, StreamCallbacks, StreamTextParams } from './client'

/**
 * Build a ReadableStream<Uint8Array> from an array of SSE chunks.
 *
 * Each entry becomes a single stream write. This lets tests assert that the
 * tolerant parser handles the dialect variations enumerated in
 * anthropicCompatHttp.ts (missing `event:`, NDJSON, `content_block_start`
 * with eager input, absent `message_stop`, etc.).
 */
function makeSseBody(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c))
      controller.close()
    },
  })
}

function makeResponse(chunks: string[], status = 200): Response {
  return new Response(makeSseBody(chunks), {
    status,
    headers: { 'Content-Type': 'text/event-stream' },
  }) as unknown as Response
}

function mkConfig(overrides?: Partial<ProviderConfig>): ProviderConfig {
  return {
    id: 'zhipu',
    name: 'Zhipu',
    apiKey: 'k',
    baseUrl: 'https://mock.example/anthropic',
    ...overrides,
  }
}

function mkParams(): StreamTextParams {
  return {
    model: 'glm-4.7',
    messages: [{ role: 'user', content: 'hi' }],
  }
}

type CollectedCallbacks = {
  calls: StreamCallbacks
  text: string[]
  tools: Array<{ id: string; name: string; input: Record<string, unknown> }>
  errors: string[]
  stopReasons: Array<string | undefined>
  ends: number
}

function makeCollector(): CollectedCallbacks {
  const text: string[] = []
  const tools: Array<{ id: string; name: string; input: Record<string, unknown> }> = []
  const errors: string[] = []
  const stopReasons: Array<string | undefined> = []
  let ends = 0
  const calls: StreamCallbacks = {
    onTextDelta: (t) => {
      text.push(t)
    },
    onToolUse: (t) => {
      tools.push({ id: t.id, name: t.name, input: t.input })
    },
    onMessageEnd: (usage) => {
      stopReasons.push(usage?.stopReason)
      ends += 1
    },
    onError: (e) => {
      errors.push(e)
    },
  }
  return {
    calls,
    text,
    tools,
    errors,
    stopReasons,
    get ends() {
      return ends
    },
  } as unknown as CollectedCallbacks
}

describe('streamAnthropicCompatHttp (tolerant SSE)', () => {
  const origFetch = globalThis.fetch
  beforeEach(() => {
    vi.restoreAllMocks()
  })
  afterEach(() => {
    globalThis.fetch = origFetch
  })

  it('parses standard Anthropic SSE with tool_use via input_json_delta', async () => {
    const chunks = [
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":0}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"c1","name":"Read","input":{}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"filePath\\":\\"x.txt\\"}"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":20}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ]
    globalThis.fetch = vi.fn().mockResolvedValue(makeResponse(chunks))

    const coll = makeCollector()
    const controller = new AbortController()
    await streamAnthropicCompatHttp(mkConfig(), mkParams(), coll.calls, controller.signal)

    expect(coll.errors).toEqual([])
    expect(coll.tools).toHaveLength(1)
    expect(coll.tools[0]).toMatchObject({
      id: 'c1',
      name: 'Read',
      input: { filePath: 'x.txt' },
    })
    expect(coll.ends).toBe(1)
  })

  it('handles dialect: content_block_start with eager input (no deltas)', async () => {
    const chunks = [
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"c2","name":"Bash","input":{"command":"ls"}}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ]
    globalThis.fetch = vi.fn().mockResolvedValue(makeResponse(chunks))

    const coll = makeCollector()
    await streamAnthropicCompatHttp(mkConfig(), mkParams(), coll.calls, new AbortController().signal)

    expect(coll.tools).toHaveLength(1)
    expect(coll.tools[0].input).toEqual({ command: 'ls' })
  })

  it('handles dialect: NDJSON (no data: prefix)', async () => {
    const chunks = [
      '{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"n1","name":"Glob","input":{}}}\n',
      '{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"pattern\\":\\"**/*.ts\\"}"}}\n',
      '{"type":"content_block_stop","index":0}\n',
      '{"type":"message_stop"}\n',
    ]
    globalThis.fetch = vi.fn().mockResolvedValue(makeResponse(chunks))

    const coll = makeCollector()
    await streamAnthropicCompatHttp(mkConfig(), mkParams(), coll.calls, new AbortController().signal)

    expect(coll.errors).toEqual([])
    expect(coll.tools).toHaveLength(1)
    expect(coll.tools[0]).toMatchObject({
      id: 'n1',
      name: 'Glob',
      input: { pattern: '**/*.ts' },
    })
  })

  it('handles dialect: missing event: line, only data:', async () => {
    const chunks = [
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"d1","name":"Read","input":{}}}\n\n',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"filePath\\":\\"a\\"}"}}\n\n',
      'data: {"type":"content_block_stop","index":0}\n\n',
      'data: {"type":"message_stop"}\n\n',
    ]
    globalThis.fetch = vi.fn().mockResolvedValue(makeResponse(chunks))

    const coll = makeCollector()
    await streamAnthropicCompatHttp(mkConfig(), mkParams(), coll.calls, new AbortController().signal)

    expect(coll.tools).toHaveLength(1)
  })

  it('handles dialect: EOS without message_stop', async () => {
    const chunks = [
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"eos1","name":"Read","input":{}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"filePath\\":\\"y\\"}"}}\n\n',
      // Stream ends without content_block_stop or message_stop
    ]
    globalThis.fetch = vi.fn().mockResolvedValue(makeResponse(chunks))

    const coll = makeCollector()
    await streamAnthropicCompatHttp(mkConfig(), mkParams(), coll.calls, new AbortController().signal)

    // Tool call flushed via the EOS recovery path.
    expect(coll.tools).toHaveLength(1)
    expect(coll.tools[0].input).toEqual({ filePath: 'y' })
  })

  it('propagates HTTP 401 as a structured error', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('invalid key', { status: 401 }) as unknown as Response,
    )

    const coll = makeCollector()
    await streamAnthropicCompatHttp(mkConfig(), mkParams(), coll.calls, new AbortController().signal)

    expect(coll.errors.length).toBe(1)
    expect(coll.errors[0]).toContain('401')
  })

  it('surfaces gateway error event as onError', async () => {
    const chunks = [
      'event: error\ndata: {"type":"error","error":{"message":"rate limit exceeded"}}\n\n',
    ]
    globalThis.fetch = vi.fn().mockResolvedValue(makeResponse(chunks))

    const coll = makeCollector()
    await streamAnthropicCompatHttp(mkConfig(), mkParams(), coll.calls, new AbortController().signal)

    expect(coll.errors).toEqual(['rate limit exceeded'])
  })

  it('parses text_delta into onTextDelta', async () => {
    const chunks = [
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello "}}\n\n',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"world"}}\n\n',
      'data: {"type":"content_block_stop","index":0}\n\n',
      'data: {"type":"message_stop"}\n\n',
    ]
    globalThis.fetch = vi.fn().mockResolvedValue(makeResponse(chunks))

    const coll = makeCollector()
    await streamAnthropicCompatHttp(mkConfig(), mkParams(), coll.calls, new AbortController().signal)

    expect(coll.text.join('')).toBe('Hello world')
  })

  it('normalizes OpenAI-style reasoning and text from an Anthropic-compatible endpoint', async () => {
    const chunks = [
      'data: {"type":"ping"}\n\n',
      'data: {"choices":[{"delta":{"reasoning_content":"check assumptions","content":"final answer"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ]
    globalThis.fetch = vi.fn().mockResolvedValue(makeResponse(chunks))

    const thinkingDeltas: string[] = []
    const thinkingBlocks: string[] = []
    const textDeltas: string[] = []
    const callbackOrder: string[] = []
    const calls: StreamCallbacks = {
      onTextDelta: (text) => {
        callbackOrder.push('text')
        textDeltas.push(text)
      },
      onThinkingDelta: (thinking) => {
        callbackOrder.push('thinking_delta')
        thinkingDeltas.push(thinking)
      },
      onThinkingBlock: (block) => {
        callbackOrder.push('thinking_block')
        thinkingBlocks.push(block.thinking)
      },
      onMessageEnd: () => undefined,
      onError: () => undefined,
    }

    await streamAnthropicCompatHttp(mkConfig(), mkParams(), calls, new AbortController().signal)

    expect(thinkingDeltas).toEqual(['check assumptions'])
    expect(thinkingBlocks).toEqual(['check assumptions'])
    expect(textDeltas).toEqual(['final answer'])
    expect(callbackOrder).toEqual(['thinking_delta', 'thinking_block', 'text'])
  })

  it('splits loose Claude deltas that carry reasoning beside visible text', async () => {
    const chunks = [
      'data: {"type":"content_block_start","index":3,"content_block":{"type":"text","text":""}}\n\n',
      'data: {"type":"content_block_delta","index":3,"delta":{"type":"text_delta","reasoning":"private plan","text":"visible"}}\n\n',
      'data: {"type":"content_block_stop","index":3}\n\n',
      'data: {"type":"message_stop"}\n\n',
    ]
    globalThis.fetch = vi.fn().mockResolvedValue(makeResponse(chunks))

    const thinking: string[] = []
    const text: string[] = []
    const calls: StreamCallbacks = {
      onTextDelta: (delta) => text.push(delta),
      onThinkingDelta: (delta) => thinking.push(delta),
      onMessageEnd: () => undefined,
      onError: () => undefined,
    }

    await streamAnthropicCompatHttp(mkConfig(), mkParams(), calls, new AbortController().signal)

    expect(thinking).toEqual(['private plan'])
    expect(text).toEqual(['visible'])
  })

  it('captures complete thinking blocks via onThinkingBlock (DeepSeek echo)', async () => {
    // DeepSeek's Anthropic-compat endpoint requires the model's `thinking`
    // content blocks to be echoed back in subsequent requests when thinking
    // mode is active. Verify that the SSE consumer accumulates thinking_delta
    // + signature_delta and emits a single complete block on content_block_stop.
    const chunks = [
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"step 1, "}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"step 2"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig-abc"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"answer"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ]
    globalThis.fetch = vi.fn().mockResolvedValue(makeResponse(chunks))

    const blocks: Array<{ thinking: string; signature?: string; thinkingTimeMs?: number; thinkingTokens?: number }> = []
    const deltas: string[] = []
    const calls: StreamCallbacks = {
      onTextDelta: () => {
        /* intentionally empty */
      },
      onThinkingDelta: (t) => {
        deltas.push(t)
      },
      onThinkingBlock: (b) => {
        blocks.push(b)
      },
      onMessageEnd: () => {
        /* intentionally empty */
      },
      onError: () => {
        /* intentionally empty */
      },
    }
    await streamAnthropicCompatHttp(
      mkConfig({ id: 'deepseek', baseUrl: 'https://mock.example/anthropic' }),
      { ...mkParams(), model: 'deepseek-v4-pro' },
      calls,
      new AbortController().signal,
    )

    expect(deltas.join('')).toBe('step 1, step 2')
    expect(blocks).toHaveLength(1)
    // `thinkingTimeMs` is stamped per-block from a wall-clock delta so the
    // renderer can persist elapsed time onto the ChatBlock (survives app
    // restart). `thinkingTokens` is a length-based heuristic stamped at
    // the same boundary (see `estimateThinkingTokens`); asserting
    // `any(Number)` on both keeps the test deterministic while locking
    // in that the fields are present.
    expect(blocks[0]).toEqual({
      thinking: 'step 1, step 2',
      signature: 'sig-abc',
      thinkingTimeMs: expect.any(Number),
      thinkingTokens: expect.any(Number),
    })
  })

  it('captures reasoning_summary deltas via onReasoningSummary{Delta,Block} (B / OpenAI Responses pseudo-Claude SSE)', async () => {
    // The transformer in `claudeToOpenAI2.ts` rewrites OpenAI Responses
    // `response.reasoning_summary_text.delta` events into a pseudo-Claude
    // SSE delta with `type: 'reasoning_summary_delta'`. This test stubs
    // that exact wire shape and verifies the consumer routes it to the
    // summary callbacks — distinct from thinking.
    const chunks = [
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"reasoning_summary","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"reasoning_summary_delta","text":"I considered "}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"reasoning_summary_delta","text":"two approaches."}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Final answer."}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ]
    globalThis.fetch = vi.fn().mockResolvedValue(makeResponse(chunks))

    const summaryDeltas: string[] = []
    const summaryBlocks: Array<{ text: string; thinkingTimeMs?: number; thinkingTokens?: number }> = []
    const thinkingDeltas: string[] = []
    const thinkingBlocks: Array<{ thinking: string }> = []
    const text: string[] = []
    const calls: StreamCallbacks = {
      onTextDelta: (t) => {
        text.push(t)
      },
      onThinkingDelta: (t) => {
        thinkingDeltas.push(t)
      },
      onThinkingBlock: (b) => {
        thinkingBlocks.push(b)
      },
      onReasoningSummaryDelta: (t) => {
        summaryDeltas.push(t)
      },
      onReasoningSummaryBlock: (b) => {
        summaryBlocks.push(b)
      },
      onMessageEnd: () => {
        /* intentionally empty */
      },
      onError: () => {
        /* intentionally empty */
      },
    }
    await streamAnthropicCompatHttp(
      mkConfig({ id: 'openai', baseUrl: 'https://mock.example/anthropic' }),
      { ...mkParams(), model: 'o4-mini' },
      calls,
      new AbortController().signal,
    )

    expect(summaryDeltas.join('')).toBe('I considered two approaches.')
    expect(summaryBlocks).toHaveLength(1)
    expect(summaryBlocks[0]).toEqual({
      text: 'I considered two approaches.',
      thinkingTimeMs: expect.any(Number),
      thinkingTokens: expect.any(Number),
    })
    // Distinct channels: nothing leaks into the thinking path.
    expect(thinkingDeltas).toHaveLength(0)
    expect(thinkingBlocks).toHaveLength(0)
    expect(text.join('')).toBe('Final answer.')
  })

  it('flushes thinking accumulators on EOS without content_block_stop', async () => {
    const chunks = [
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"trailing thought"}}\n\n',
      // Stream closes without content_block_stop or message_stop.
    ]
    globalThis.fetch = vi.fn().mockResolvedValue(makeResponse(chunks))

    const blocks: Array<{ thinking: string; signature?: string; thinkingTimeMs?: number }> = []
    const calls: StreamCallbacks = {
      onTextDelta: () => {
        /* intentionally empty */
      },
      onThinkingBlock: (b) => {
        blocks.push(b)
      },
      onMessageEnd: () => {
        /* intentionally empty */
      },
      onError: () => {
        /* intentionally empty */
      },
    }
    await streamAnthropicCompatHttp(
      mkConfig({ id: 'deepseek' }),
      { ...mkParams(), model: 'deepseek-v4-pro' },
      calls,
      new AbortController().signal,
    )

    expect(blocks).toHaveLength(1)
    expect(blocks[0].thinking).toBe('trailing thought')
  })

  it('marks DeepSeek thinking-only streams without stop_reason as max_tokens for recovery', async () => {
    const chunks = [
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"long internal reasoning"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ]
    globalThis.fetch = vi.fn().mockResolvedValue(makeResponse(chunks))

    const coll = makeCollector()
    await streamAnthropicCompatHttp(
      mkConfig({ id: 'deepseek' }),
      { ...mkParams(), model: 'deepseek-v4-pro' },
      coll.calls,
      new AbortController().signal,
    )

    expect(coll.stopReasons).toEqual(['max_tokens'])
  })

  it('tags a write_file drained at EOS after stop_reason=max_tokens with the truncation marker (fix-2: gateway-repaired clean JSON)', async () => {
    // The block never gets a `content_block_stop` (stream cut by max_tokens),
    // and the gateway delivered argument JSON that parses cleanly but is
    // missing `content`. The EOS fallback drain flushes the accumulator AFTER
    // `message_delta` reported max_tokens, so the marker must be applied even
    // though `parseToolArguments` needed no repair.
    const chunks = [
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"w1","name":"write_file","input":{}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"filePath\\":\\"x.md\\"}"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":20}}\n\n',
    ]
    globalThis.fetch = vi.fn().mockResolvedValue(makeResponse(chunks))

    const coll = makeCollector()
    await streamAnthropicCompatHttp(
      mkConfig(),
      mkParams(),
      coll.calls,
      new AbortController().signal,
    )

    expect(coll.tools).toHaveLength(1)
    expect(coll.tools[0].input).toMatchObject({
      filePath: 'x.md',
      __argsTruncatedByMaxTokens: true,
    })
  })

  it('does NOT tag a properly closed tool block (content_block_stop precedes stop_reason)', async () => {
    const chunks = [
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"w2","name":"write_file","input":{}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"filePath\\":\\"x.md\\",\\"content\\":\\"hello\\"}"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":20}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ]
    globalThis.fetch = vi.fn().mockResolvedValue(makeResponse(chunks))

    const coll = makeCollector()
    await streamAnthropicCompatHttp(
      mkConfig(),
      mkParams(),
      coll.calls,
      new AbortController().signal,
    )

    expect(coll.tools).toHaveLength(1)
    expect(coll.tools[0].input).toEqual({ filePath: 'x.md', content: 'hello' })
    expect(coll.tools[0].input).not.toHaveProperty('__argsTruncatedByMaxTokens')
  })

  it('forwards output_config.effort for DeepSeek Anthropic-compat requests', async () => {
    let sentBody: unknown
    globalThis.fetch = vi.fn(async (_url, init) => {
      sentBody = JSON.parse((init as RequestInit).body as string)
      return makeResponse(['data: {"type":"message_stop"}\n\n'])
    }) as unknown as typeof fetch

    const coll = makeCollector()
    await streamAnthropicCompatHttp(
      mkConfig({ id: 'deepseek' }),
      { ...mkParams(), model: 'deepseek-v4-pro', effort: 'low' },
      coll.calls,
      new AbortController().signal,
    )

    expect(sentBody).toMatchObject({
      output_config: { effort: 'low' },
    })
  })

  it('propagates max_tokens stop_reason across Anthropic-compat gateways', async () => {
    const configs: ProviderConfig[] = [
      mkConfig({ id: 'kimi' }),
      mkConfig({ id: 'minimax' }),
      mkConfig({ id: 'dashscope' }),
      mkConfig({ id: 'anthropic', baseUrl: 'https://third-party.example/anthropic' }),
    ]

    for (const config of configs) {
      const chunks = [
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":20}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ]
      globalThis.fetch = vi.fn().mockResolvedValue(makeResponse(chunks))

      const coll = makeCollector()
      await streamAnthropicCompatHttp(
        config,
        { ...mkParams(), model: config.id === 'kimi' ? 'kimi-k2.5' : 'compat-model' },
        coll.calls,
        new AbortController().signal,
      )

      expect(coll.stopReasons, config.id).toEqual(['max_tokens'])
    }
  })

  it('strips cache_control from request body (gateway does not support it)', async () => {
    let sentBody: unknown
    globalThis.fetch = vi.fn(async (_url, init) => {
      sentBody = JSON.parse((init as RequestInit).body as string)
      return makeResponse(['data: {"type":"message_stop"}\n\n'])
    }) as unknown as typeof fetch

    const params: StreamTextParams = {
      model: 'x',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } },
          ],
        },
      ],
    }
    const coll = makeCollector()
    await streamAnthropicCompatHttp(mkConfig(), params, coll.calls, new AbortController().signal)

    const body = sentBody as { messages: Array<{ content: Array<Record<string, unknown>> }> }
    const firstBlock = body.messages[0].content[0]
    expect(firstBlock.cache_control).toBeUndefined()
  })

  // ─── Multimodal stripping (vision-aware) ───────────────────────────────

  /**
   * Drives the "paste image → multimodal model" pipeline end-to-end.
   * Asserts that the downstream POST body either drops or preserves the
   * image block depending on whether the selected model looks vision-capable.
   */
  async function captureForwardedMessages(
    config: ProviderConfig,
    model: string,
  ): Promise<Array<{ role: string; content: unknown }>> {
    let sentBody: unknown
    globalThis.fetch = vi.fn(async (_url, init) => {
      sentBody = JSON.parse((init as RequestInit).body as string)
      return makeResponse(['data: {"type":"message_stop"}\n\n'])
    }) as unknown as typeof fetch

    const params: StreamTextParams = {
      model,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '这张图片是什么？' },
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/png',
                data: 'BASE64IMG',
              },
            },
          ],
        },
      ],
    }
    const coll = makeCollector()
    await streamAnthropicCompatHttp(config, params, coll.calls, new AbortController().signal)

    return (sentBody as { messages: Array<{ role: string; content: unknown }> }).messages
  }

  it('strips pasted image blocks on non-vision SKUs to avoid gateway hang (Kimi text SKU regression)', async () => {
    // Policy revision history:
    //   - v1: always strip when `quirks.supportsImageBlocks === false`. Hid
    //     the issue from users (silent data loss).
    //   - v2: always forward. Caused production hangs on DashScope's
    //     Anthropic-compat endpoint — the upstream RST'd the TLS connection
    //     on the first attempt and then HUNG the retry for 90s instead of
    //     returning a clean HTTP 400. End result: a multi-minute UI freeze
    //     with no actionable error.
    //   - v3 (current): strip when the gateway lacks native image support
    //     AND the model name doesn't look like a vision SKU. Forwarding to
    //     vision-capable model ids (qwen-vl-*, glm-4v, moonshot-*-vision*,
    //     etc.) is still allowed — those tests live below.
    //
    // This test pins v3 for `kimi-k2.5`, which is text-only and would
    // otherwise be at risk of the same hang as DashScope.
    const messages = await captureForwardedMessages(
      mkConfig({ id: 'kimi' }),
      'kimi-k2.5',
    )
    const firstContent = messages[0].content as Array<Record<string, unknown>>
    // Image MUST be stripped — keeping it would risk a gateway hang.
    expect(firstContent.find((b) => b.type === 'image')).toBeUndefined()
    // The strip path injects a `<system-reminder>` so the model knows what
    // happened and can ask the user to switch to a vision provider.
    const textBlocks = firstContent
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
    expect(textBlocks.some((t) => /omitted/i.test(t))).toBe(true)
    expect(textBlocks.some((t) => /system-reminder/i.test(t))).toBe(true)
  })

  it('forwards pasted image blocks for Qwen-VL', async () => {
    const messages = await captureForwardedMessages(
      mkConfig({ id: 'dashscope' }),
      'qwen3-vl-plus',
    )
    const firstContent = messages[0].content as Array<Record<string, unknown>>
    expect(firstContent.find((b) => b.type === 'image')).toBeTruthy()
  })

  it('forwards pasted image blocks for DashScope qwen3.6-plus', async () => {
    const messages = await captureForwardedMessages(
      mkConfig({
        id: 'dashscope',
        baseUrl: 'https://coding.dashscope.aliyuncs.com/apps/anthropic',
      }),
      'qwen3.6-plus',
    )
    const firstContent = messages[0].content as Array<Record<string, unknown>>
    expect(firstContent.find((b) => b.type === 'image')).toBeTruthy()
  })

  it('forwards pasted image blocks for GLM-4V style vision SKUs', async () => {
    const messages = await captureForwardedMessages(
      mkConfig({ id: 'zhipu' }),
      'glm-4v-plus',
    )
    const firstContent = messages[0].content as Array<Record<string, unknown>>
    expect(firstContent.find((b) => b.type === 'image')).toBeTruthy()
  })

  it('forwards pasted image blocks for Moonshot vision previews', async () => {
    const messages = await captureForwardedMessages(
      mkConfig({ id: 'kimi' }),
      'moonshot-v1-32k-vision-preview',
    )
    const firstContent = messages[0].content as Array<Record<string, unknown>>
    expect(firstContent.find((b) => b.type === 'image')).toBeTruthy()
  })

  it('forwards pasted image blocks for Anthropic providers with proxy baseUrls', async () => {
    // Users who point the `anthropic` provider at a third-party proxy (very
    // common: Chinese reverse proxies that serve Claude OR other vision models)
    // must keep getting their pasted images through.
    const messages = await captureForwardedMessages(
      mkConfig({
        id: 'anthropic',
        baseUrl: 'https://proxy.example.com/v1',
      }),
      'claude-sonnet-4-5-20251001',
    )
    const firstContent = messages[0].content as Array<Record<string, unknown>>
    expect(firstContent.find((b) => b.type === 'image')).toBeTruthy()
  })

  // Production-reported regression: user picked dashscope + a non-vision
  // Qwen text SKU on https://coding.dashscope.aliyuncs.com/apps/
  // anthropic and pasted an image. Forwarding the image caused the upstream
  // to RST the connection (ECONNRESET) on the first try and HANG the retry
  // for 90s. The strip path is the only safe behaviour for this combination.
  it('strips pasted image blocks for dashscope + non-vision Qwen text SKU (production hang regression)', async () => {
    const messages = await captureForwardedMessages(
      mkConfig({
        id: 'dashscope',
        baseUrl: 'https://coding.dashscope.aliyuncs.com/apps/anthropic',
      }),
      'qwen-plus',
    )
    const firstContent = messages[0].content as Array<Record<string, unknown>>
    expect(firstContent.find((b) => b.type === 'image')).toBeUndefined()
    const textBlocks = firstContent
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
    expect(textBlocks.some((t) => /omitted/i.test(t))).toBe(true)
  })

  // Production-reported regression #2 (2026-06): user picked dashscope +
  // qwen3.7-max (TEXT-ONLY — community articles call it "多模态" but image
  // input is not supported) and pasted an image. The vision heuristic of the
  // day forwarded the block and DashScope answered HTTP 400 InvalidParameter
  // "Unexpected item type in content." which surfaced RAW as the assistant
  // turn. The fallback must strip the images and re-run the stream once so
  // the user gets a real answer instead of an HTTP error.
  it('400 image-rejection fallback: strips images and retries once instead of surfacing the raw HTTP error', async () => {
    const sentBodies: Array<{ messages: Array<{ content: unknown }> }> = []
    let callCount = 0
    globalThis.fetch = vi.fn(async (_url, init) => {
      sentBodies.push(JSON.parse((init as RequestInit).body as string))
      callCount++
      if (callCount === 1) {
        return new Response(
          'event:error data: {"code":"InvalidParameter","message":"<400> InternalError.Algo.InvalidParameter: ' +
            'The provided messages input is invalid. The error info is [Unexpected item type in content.]",' +
            '"request_id":"e37d6e0f"}',
          { status: 400 },
        ) as unknown as Response
      }
      return makeResponse([
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"这张截图展示了…"}}\n\n',
        'data: {"type":"message_stop"}\n\n',
      ])
    }) as unknown as typeof fetch

    const params: StreamTextParams = {
      // `qwen3.6-plus` is on the vision whitelist → images get FORWARDED;
      // the mocked gateway then rejects them, exercising the fallback.
      model: 'qwen3.6-plus',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '图片中说了什么' },
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: 'BASE64IMG' },
            },
          ],
        },
      ],
    }
    const coll = makeCollector()
    await streamAnthropicCompatHttp(
      mkConfig({ id: 'dashscope', baseUrl: 'https://dashscope.aliyuncs.com/apps/anthropic' }),
      params,
      coll.calls,
      new AbortController().signal,
    )

    // Two POSTs: the rejected one with the image, the retry without.
    expect(callCount).toBe(2)
    const firstContent = sentBodies[0].messages[0].content as Array<Record<string, unknown>>
    expect(firstContent.find((b) => b.type === 'image')).toBeTruthy()
    const retryContent = sentBodies[1].messages[0].content as Array<Record<string, unknown>>
    expect(retryContent.find((b) => b.type === 'image')).toBeUndefined()
    // Strip path injects the standard <system-reminder> notice.
    const retryTexts = retryContent
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
    expect(retryTexts.some((t) => /omitted/i.test(t))).toBe(true)
    // The user sees a real answer, not the raw HTTP 400.
    expect(coll.errors).toEqual([])
    expect(coll.text.join('')).toContain('这张截图展示了')
  })

  it('400s that are NOT image rejections do not trigger the strip-retry', async () => {
    let callCount = 0
    globalThis.fetch = vi.fn(async () => {
      callCount++
      return new Response(
        '{"error":{"message":"max_tokens must be at least 1"}}',
        { status: 400 },
      ) as unknown as Response
    }) as unknown as typeof fetch

    const params: StreamTextParams = {
      model: 'qwen3.6-plus',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'hi' },
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: 'IMG' },
            },
          ],
        },
      ],
    }
    const coll = makeCollector()
    await streamAnthropicCompatHttp(
      mkConfig({ id: 'dashscope', baseUrl: 'https://dashscope.aliyuncs.com/apps/anthropic' }),
      params,
      coll.calls,
      new AbortController().signal,
    )

    expect(callCount).toBe(1)
    expect(coll.errors).toHaveLength(1)
    expect(coll.errors[0]).toContain('HTTP 400')
  })

  it('still strips type:"document" (PDF) blocks when the gateway does not advertise support', async () => {
    // Documents have a reliable fallback (the sibling text preamble carries
    // pdfjs-extracted text), so we continue stripping them on compat gateways
    // that don't accept `type:'document'`.
    let sentBody: unknown
    globalThis.fetch = vi.fn(async (_url, init) => {
      sentBody = JSON.parse((init as RequestInit).body as string)
      return makeResponse(['data: {"type":"message_stop"}\n\n'])
    }) as unknown as typeof fetch
    const params: StreamTextParams = {
      model: 'kimi-k2.5',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'please read the PDF' },
            {
              type: 'document',
              source: {
                type: 'base64',
                media_type: 'application/pdf',
                data: 'PDFBYTES',
              },
            },
          ],
        },
      ],
    }
    const coll = makeCollector()
    await streamAnthropicCompatHttp(mkConfig({ id: 'kimi' }), params, coll.calls, new AbortController().signal)

    const body = sentBody as { messages: Array<{ content: Array<Record<string, unknown>> }> }
    const firstContent = body.messages[0].content
    expect(firstContent.find((b) => b.type === 'document')).toBeUndefined()
    const noteText = firstContent
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join(' ')
    expect(noteText).toMatch(/PDF.*omitted/i)
  })

  describe('onToolInputDelta — Cursor 3-style live writing', () => {
    function makeCollectorWithInputDelta() {
      const tools: Array<{ id: string; name: string; input: Record<string, unknown> }> = []
      const inputDeltas: Array<{ toolUseId: string; toolName: string; partialJson: string }> = []
      const errors: string[] = []
      let ends = 0
      const calls: StreamCallbacks = {
        onTextDelta: () => {},
        onToolUse: (t) => {
          tools.push({ id: t.id, name: t.name, input: t.input })
        },
        onToolInputDelta: (d) => {
          inputDeltas.push({ ...d })
        },
        onMessageEnd: () => {
          ends += 1
        },
        onError: (e) => {
          errors.push(e)
        },
      }
      return {
        calls,
        tools,
        inputDeltas,
        errors,
        get ends() {
          return ends
        },
      }
    }

    it('emits onToolInputDelta on input_json_delta and force-flushes on content_block_stop', async () => {
      // Two small back-to-back deltas — the throttle COULD coalesce them
      // if they arrive within 50ms and total < 256 B, so the only
      // assertion we can lock in deterministically is that the final
      // force-flush on content_block_stop delivers the complete buffer.
      const chunks = [
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"w1","name":"write_file","input":{}}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"filePath\\":\\"a.ts\\","}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"content\\":\\"hi\\"}"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ]
      globalThis.fetch = vi.fn().mockResolvedValue(makeResponse(chunks))

      const coll = makeCollectorWithInputDelta()
      await streamAnthropicCompatHttp(
        mkConfig(),
        mkParams(),
        coll.calls,
        new AbortController().signal,
      )

      expect(coll.errors).toEqual([])
      expect(coll.tools).toHaveLength(1)
      expect(coll.tools[0].input).toEqual({ filePath: 'a.ts', content: 'hi' })
      // At least one input-delta callback fired (the final force-flush)
      expect(coll.inputDeltas.length).toBeGreaterThan(0)
      // The last emit must carry the complete accumulated JSON — that's
      // the contract the renderer relies on so the final partial state
      // parses to the same value as `tool_start.input`.
      const last = coll.inputDeltas[coll.inputDeltas.length - 1]
      expect(last).toMatchObject({ toolUseId: 'w1', toolName: 'write_file' })
      expect(last.partialJson).toBe('{"filePath":"a.ts","content":"hi"}')
    })

    it('throttles many small deltas — does not emit per chunk', async () => {
      // Ten ~10-byte deltas all arriving synchronously inside a single
      // microtask. Both throttle gates should suppress everything except
      // the final force-flush in content_block_stop, because:
      //   - sinceMs < 50ms (all in one event-loop tick)
      //   - sinceBytes per chunk < 256 (each is ~10 bytes)
      // Total accumulated bytes < 256 too.
      const fragments: string[] = []
      // Build a partial that totals < 256 bytes so neither gate trips.
      // 10 chunks × ~12 chars each ≈ 120 bytes.
      for (let i = 0; i < 10; i++) {
        fragments.push(`"k${i}":"v",`)
      }
      const inner = fragments.join('') // ~120 bytes, still < 256
      const chunks = [
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"w2","name":"write_file","input":{}}}\n\n',
        // First fragment opens the object.
        `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{"}}\n\n`,
        // Stream the remaining tiny fragments.
        ...fragments.map(
          (f) =>
            `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":${JSON.stringify(f)}}}\n\n`,
        ),
        // Close the object so flushToolCall parses cleanly.
        `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"end\\":1}"}}\n\n`,
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ]
      void inner // referenced for self-documenting size; not directly used
      globalThis.fetch = vi.fn().mockResolvedValue(makeResponse(chunks))

      const coll = makeCollectorWithInputDelta()
      await streamAnthropicCompatHttp(
        mkConfig(),
        mkParams(),
        coll.calls,
        new AbortController().signal,
      )

      // We sent 12 input_json_delta chunks. With both gates closed,
      // every emit would have to come from the time-window or the
      // final force-flush. Allow some slack (Date.now resolution +
      // event-loop ticks can vary across runs), but assert the ratio
      // is dramatically below the per-chunk worst case.
      expect(coll.inputDeltas.length).toBeLessThanOrEqual(4)
      // Final emit still carries the full buffer.
      expect(
        coll.inputDeltas[coll.inputDeltas.length - 1].partialJson.endsWith('"end":1}'),
      ).toBe(true)
    })

    it('escape hatch: a single >256B delta emits immediately (no waiting for time window)', async () => {
      const bigFragment = 'a'.repeat(400)
      const chunks = [
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"w3","name":"write_file","input":{}}}\n\n',
        // `filePath` leads the JSON (and points at a path that does not exist
        // on disk) so the C-grade Write preflight resolves it as a NEW-file
        // write and confirms the block safe — otherwise a `content`-first
        // write_file would be early-aborted before any onToolInputDelta fires.
        `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"filePath\\":\\"escape_hatch_new_file.ts\\",\\"content\\":\\"${bigFragment}"}}\n\n`,
        `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"}"}}\n\n`,
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ]
      globalThis.fetch = vi.fn().mockResolvedValue(makeResponse(chunks))

      const coll = makeCollectorWithInputDelta()
      await streamAnthropicCompatHttp(
        mkConfig(),
        mkParams(),
        coll.calls,
        new AbortController().signal,
      )

      // 1st delta (>256B) triggers the byte-gate immediately, 2nd is
      // throttled, then force-flush on content_block_stop. So we expect
      // at least 2 emits and the first one must contain the big payload.
      expect(coll.inputDeltas.length).toBeGreaterThanOrEqual(2)
      expect(coll.inputDeltas[0].partialJson.length).toBeGreaterThan(400)
    })
  })
})

describe('thinking request param gating', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  async function captureSentBody(
    config: ProviderConfig,
    params: StreamTextParams,
  ): Promise<Record<string, unknown>> {
    let sentBody: Record<string, unknown> = {}
    globalThis.fetch = vi.fn(async (_url, init) => {
      sentBody = JSON.parse((init as RequestInit).body as string)
      return makeResponse(['data: {"type":"message_stop"}\n\n'])
    }) as unknown as typeof fetch
    const coll = makeCollector()
    await streamAnthropicCompatHttp(config, params, coll.calls, new AbortController().signal)
    return sentBody
  }

  it('DashScope sends thinking for a thinking-capable Qwen SKU when alwaysThinking', async () => {
    const body = await captureSentBody(
      mkConfig({ id: 'dashscope', name: 'DashScope', baseUrl: 'https://dashscope.aliyuncs.com/apps/anthropic' }),
      { model: 'qwen3.7-plus', messages: [{ role: 'user', content: 'hi' }], alwaysThinking: true, maxTokens: 8192 },
    )
    expect(body.thinking).toBeDefined()
    expect((body.thinking as { type?: string }).type).toBe('enabled')
  })

  it('DashScope does NOT send thinking for non-thinking Qwen families (coder / long)', async () => {
    for (const model of ['qwen3-coder-plus', 'qwen3-coder-next', 'qwen-long']) {
      const body = await captureSentBody(
        mkConfig({ id: 'dashscope', name: 'DashScope', baseUrl: 'https://dashscope.aliyuncs.com/apps/anthropic' }),
        { model, messages: [{ role: 'user', content: 'hi' }], alwaysThinking: true, maxTokens: 8192 },
      )
      expect(body.thinking, `${model} should not carry thinking`).toBeUndefined()
    }
  })

  it('other thinking-enabled compat gateways send thinking provider-wide (no model gate)', async () => {
    // Kimi / Zhipu / MiniMax advertise thinking provider-wide, so even a
    // model name we don't specifically recognise still gets the thinking param.
    for (const id of ['kimi', 'zhipu', 'minimax'] as const) {
      const body = await captureSentBody(
        mkConfig({ id, name: id, baseUrl: 'https://mock.example/anthropic' }),
        { model: `${id}-some-model`, messages: [{ role: 'user', content: 'hi' }], alwaysThinking: true, maxTokens: 8192 },
      )
      expect(body.thinking, `${id} should carry thinking`).toBeDefined()
    }
  })

  it('custom Anthropic endpoints enable thinking in auto mode', async () => {
    const body = await captureSentBody(
      mkConfig({
        id: 'anthropic',
        name: 'Custom Anthropic',
        baseUrl: 'https://relay.example/v1',
        anthropicThinkingCapability: 'auto',
      }),
      { model: 'claude-compatible', messages: [{ role: 'user', content: 'hi' }], alwaysThinking: true, maxTokens: 8192 },
    )
    expect(body.thinking).toBeDefined()
  })

  it('custom Anthropic endpoints can disable the thinking request field', async () => {
    const body = await captureSentBody(
      mkConfig({
        id: 'anthropic',
        name: 'Custom Anthropic',
        baseUrl: 'https://relay.example/v1',
        anthropicThinkingCapability: 'unsupported',
      }),
      { model: 'claude-compatible', messages: [{ role: 'user', content: 'hi' }], alwaysThinking: true, maxTokens: 8192 },
    )
    expect(body.thinking).toBeUndefined()
  })
})

describe('mixed-mode tool input (eager + input_json_delta merge)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  // Regression: Zhipu/GLM emit part of the tool input eagerly in
  // `content_block_start` AND stream the rest via `input_json_delta`. The old
  // parser discarded the eager half on the first delta, so eager-only fields
  // were lost (production: write_file arrived with only `{filePath}`).
  it('merges eager filePath with delta-streamed content', async () => {
    const chunks = [
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t1","name":"demo_tool","input":{"filePath":"new_merge_a.ts"}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"content\\":\\"hello\\"}"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ]
    globalThis.fetch = vi.fn().mockResolvedValue(makeResponse(chunks))
    const coll = makeCollector()
    await streamAnthropicCompatHttp(mkConfig(), mkParams(), coll.calls, new AbortController().signal)
    expect(coll.tools).toHaveLength(1)
    expect(coll.tools[0].input).toEqual({ filePath: 'new_merge_a.ts', content: 'hello' })
  })

  it('preserves eager content when a later delta only restates filePath', async () => {
    const chunks = [
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t2","name":"demo_tool","input":{"filePath":"new_merge_b.ts","content":"BODY"}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"filePath\\":\\"new_merge_b.ts\\"}"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ]
    globalThis.fetch = vi.fn().mockResolvedValue(makeResponse(chunks))
    const coll = makeCollector()
    await streamAnthropicCompatHttp(mkConfig(), mkParams(), coll.calls, new AbortController().signal)
    expect(coll.tools).toHaveLength(1)
    expect(coll.tools[0].input).toEqual({ filePath: 'new_merge_b.ts', content: 'BODY' })
  })

  it('pure-eager (no delta) still flushes the eager object verbatim', async () => {
    const chunks = [
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t3","name":"demo_tool","input":{"filePath":"new_merge_c.ts","content":"C"}}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ]
    globalThis.fetch = vi.fn().mockResolvedValue(makeResponse(chunks))
    const coll = makeCollector()
    await streamAnthropicCompatHttp(mkConfig(), mkParams(), coll.calls, new AbortController().signal)
    expect(coll.tools).toHaveLength(1)
    expect(coll.tools[0].input).toEqual({ filePath: 'new_merge_c.ts', content: 'C' })
  })

  it('pure-delta (no eager) still parses the streamed JSON', async () => {
    const chunks = [
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t4","name":"demo_tool","input":{}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"filePath\\":\\"d.ts\\",\\"content\\":\\"X\\"}"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ]
    globalThis.fetch = vi.fn().mockResolvedValue(makeResponse(chunks))
    const coll = makeCollector()
    await streamAnthropicCompatHttp(mkConfig(), mkParams(), coll.calls, new AbortController().signal)
    expect(coll.tools).toHaveLength(1)
    expect(coll.tools[0].input).toEqual({ filePath: 'd.ts', content: 'X' })
  })
})
