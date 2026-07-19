import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { streamCompatibleFormat } from './compatibleClient'
import type { ProviderConfig, StreamCallbacks, StreamTextParams } from './client'

/**
 * Regression tests for the OpenAI / OpenAI2 → Claude tool-arg accumulation
 * path through `streamCompatibleFormat`.
 *
 * The bug being guarded:
 *   `claudeToOpenAI.ts` and `claudeToOpenAI2.ts` both emit a
 *   `content_block_start` Claude event with `input: {}` as a placeholder when
 *   a `function_call` / `tool_calls` start arrives — the *actual* tool
 *   arguments stream in via subsequent `input_json_delta` events. The
 *   compatible-client SSE consumer used to capture that empty `{}` as
 *   `eagerInput` and short-circuit `parseToolArguments(arguments)` in
 *   `flushToolCall`, so every Write/Edit/Agent call routed through
 *   `openai2-compat` arrived at the registry with `{}` and crashed the Zod
 *   validators with the misleading "expected string, received undefined".
 *
 *   The fix only treats `cb.input` as eager when it has at least one own
 *   property, AND defensively downgrades to delta mode if input_json_delta
 *   chunks still arrive (mirroring `anthropicCompatHttp.ts:798-800`).
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
    id: 'openai2',
    name: 'OpenAI2',
    apiKey: 'sk-test',
    baseUrl: 'https://mock.example/v1',
    ...overrides,
  }
}

function mkParams(): StreamTextParams {
  return {
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'write a hello world to /tmp/x.txt' }],
    tools: [
      {
        name: 'write_file',
        description: 'Create a new file',
        input_schema: {
          type: 'object',
          properties: {
            filePath: { type: 'string' },
            content: { type: 'string' },
          },
          required: ['filePath', 'content'],
        },
      },
    ],
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

describe('streamCompatibleFormat — tool-arg accumulation across stream dialects', () => {
  const origFetch = globalThis.fetch
  beforeEach(() => {
    vi.restoreAllMocks()
  })
  afterEach(() => {
    globalThis.fetch = origFetch
  })

  it('OpenAI2 Responses API: streamed function_call_arguments deltas land on the tool input (regression: `{}` placeholder must not short-circuit)', async () => {
    // Real OpenAI Responses API SSE for a tool call is:
    //   1) response.output_item.added  with item.type=function_call (no args yet)
    //   2) response.function_call_arguments.delta  N times
    //   3) response.output_item.done
    //   4) response.completed
    // The transformer turns (1) into `content_block_start` carrying
    // `input: {}` — that empty object MUST NOT win over the streamed deltas.
    const argsJson = JSON.stringify({
      filePath: '/tmp/x.txt',
      content: 'hello world\n',
    })
    const half = Math.floor(argsJson.length / 2)
    const chunks = [
      `data: {"type":"response.created"}\n\n`,
      `data: {"type":"response.output_item.added","item":{"type":"function_call","call_id":"call_writeA","id":"fc_1","name":"write_file"}}\n\n`,
      `data: {"type":"response.function_call_arguments.delta","delta":${JSON.stringify(argsJson.slice(0, half))}}\n\n`,
      `data: {"type":"response.function_call_arguments.delta","delta":${JSON.stringify(argsJson.slice(half))}}\n\n`,
      `data: {"type":"response.output_item.done"}\n\n`,
      `data: {"type":"response.completed"}\n\n`,
    ]
    globalThis.fetch = vi.fn().mockResolvedValue(makeResponse(chunks))

    const coll = makeCollector()
    await streamCompatibleFormat(
      mkConfig({ id: 'openai2' }),
      mkParams(),
      coll.calls,
      new AbortController().signal,
    )

    expect(coll.errors).toEqual([])
    expect(coll.tools).toHaveLength(1)
    // The critical assertion: `content` and `filePath` survive the stream.
    // Before the fix this test failed with `input: {}`.
    expect(coll.tools[0]).toMatchObject({
      id: 'call_writeA',
      name: 'write_file',
      input: { filePath: '/tmp/x.txt', content: 'hello world\n' },
    })
    expect(coll.ends).toBe(1)
  })

  it('OpenAI2 Responses API: Agent-tool args (description + prompt) survive multi-chunk streaming', async () => {
    // The user-reported Agent-tool error shape: model called Agent without
    // `prompt`/`description` because the tool arrived with `{}`.
    const argsJson = JSON.stringify({
      description: 'audit deps',
      prompt: 'List third-party deps in package.json and flag pinned majors.',
      subagent_type: 'general-purpose',
    })
    const a = argsJson.slice(0, 20)
    const b = argsJson.slice(20, 60)
    const c = argsJson.slice(60)
    const chunks = [
      `data: {"type":"response.output_item.added","item":{"type":"function_call","call_id":"call_ag1","id":"fc_2","name":"Agent"}}\n\n`,
      `data: {"type":"response.function_call_arguments.delta","delta":${JSON.stringify(a)}}\n\n`,
      `data: {"type":"response.function_call_arguments.delta","delta":${JSON.stringify(b)}}\n\n`,
      `data: {"type":"response.function_call_arguments.delta","delta":${JSON.stringify(c)}}\n\n`,
      `data: {"type":"response.output_item.done"}\n\n`,
      `data: {"type":"response.completed"}\n\n`,
    ]
    globalThis.fetch = vi.fn().mockResolvedValue(makeResponse(chunks))

    const coll = makeCollector()
    await streamCompatibleFormat(
      mkConfig({ id: 'openai2' }),
      { ...mkParams(), tools: [{ name: 'Agent', description: 'spawn sub-agent', input_schema: { type: 'object' } }] },
      coll.calls,
      new AbortController().signal,
    )

    expect(coll.errors).toEqual([])
    expect(coll.tools).toHaveLength(1)
    expect(coll.tools[0].name).toBe('Agent')
    expect(coll.tools[0].input).toMatchObject({
      description: 'audit deps',
      prompt: 'List third-party deps in package.json and flag pinned majors.',
      subagent_type: 'general-purpose',
    })
  })

  it('OpenAI Chat: split tool_calls.function.arguments across chunks lands on the tool input (regression: removed auto-stop)', async () => {
    // OpenAI Chat dialect: id+name+args may stream across multiple chunks;
    // chunk 1 has id+name+head args, chunk 2+ have only the args tail (orphan
    // from the schema's perspective, but they re-use the same tool_call
    // index so `compatibleClient` should accumulate them into the same
    // currentToolCall). Before removing the auto-`content_block_stop` from
    // `claudeToOpenAI.ts:498-499`, the transformer closed the block after
    // chunk 1 and the tail args were silently dropped.
    const argsJson = JSON.stringify({ filePath: '/tmp/x.txt', content: 'A B C' })
    const head = argsJson.slice(0, 10)
    const tail = argsJson.slice(10)
    const chunk1 = JSON.stringify({
      object: 'chat.completion.chunk',
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, id: 'call_oai_1', function: { name: 'write_file', arguments: head } },
            ],
          },
          finish_reason: null,
        },
      ],
    })
    const chunk2 = JSON.stringify({
      object: 'chat.completion.chunk',
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ index: 0, function: { arguments: tail } }] },
          finish_reason: null,
        },
      ],
    })
    const chunk3 = JSON.stringify({
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
    })
    const chunks = [
      `data: ${chunk1}\n\n`,
      `data: ${chunk2}\n\n`,
      `data: ${chunk3}\n\n`,
      `data: [DONE]\n\n`,
    ]
    globalThis.fetch = vi.fn().mockResolvedValue(makeResponse(chunks))

    const coll = makeCollector()
    await streamCompatibleFormat(
      mkConfig({ id: 'openai' }),
      mkParams(),
      coll.calls,
      new AbortController().signal,
    )

    expect(coll.errors).toEqual([])
    expect(coll.tools).toHaveLength(1)
    expect(coll.tools[0]).toMatchObject({
      id: 'call_oai_1',
      name: 'write_file',
      input: { filePath: '/tmp/x.txt', content: 'A B C' },
    })
  })

  it('OpenAI Chat: multiple back-to-back tool_use blocks (no explicit stop between them) retain ALL args (regression: implicit boundary flush in compatibleClient)', async () => {
    // Pathological-but-legitimate sequence: a third-party gateway streams two
    // separate tool calls in one block, never emitting `content_block_stop`
    // between them. Without the implicit-flush guard in
    // `compatibleClient.ts` (close prior currentToolCall when a new
    // `tool_use` start arrives), the second tool's start would overwrite
    // the first tool's currentToolCall and drop tool A's args. Multi-tool
    // turns (Read + Glob in parallel, multi-file Edit batches, etc.) would
    // silently miss arguments for every tool except the last.
    const argsA = JSON.stringify({ filePath: '/a.txt' })
    const argsB = JSON.stringify({ pattern: '**/*.ts' })
    const chunk1 = JSON.stringify({
      object: 'chat.completion.chunk',
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, id: 'call_a', function: { name: 'read_file', arguments: argsA } },
            ],
          },
          finish_reason: null,
        },
      ],
    })
    // Second tool starts WITHOUT a stop event — the only signal is a new
    // `id`+`name` pair for index 1.
    const chunk2 = JSON.stringify({
      object: 'chat.completion.chunk',
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 1, id: 'call_b', function: { name: 'glob', arguments: argsB } },
            ],
          },
          finish_reason: null,
        },
      ],
    })
    const chunk3 = JSON.stringify({
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
    })
    const chunks = [
      `data: ${chunk1}\n\n`,
      `data: ${chunk2}\n\n`,
      `data: ${chunk3}\n\n`,
      `data: [DONE]\n\n`,
    ]
    globalThis.fetch = vi.fn().mockResolvedValue(makeResponse(chunks))

    const coll = makeCollector()
    await streamCompatibleFormat(
      mkConfig({ id: 'openai' }),
      mkParams(),
      coll.calls,
      new AbortController().signal,
    )

    expect(coll.errors).toEqual([])
    // Both tools must arrive with their respective args intact.
    expect(coll.tools).toHaveLength(2)
    expect(coll.tools[0]).toMatchObject({
      id: 'call_a',
      name: 'read_file',
      input: { filePath: '/a.txt' },
    })
    expect(coll.tools[1]).toMatchObject({
      id: 'call_b',
      name: 'glob',
      input: { pattern: '**/*.ts' },
    })
  })

  it('preserves a non-empty eager input that arrives whole in content_block_start (no deltas)', async () => {
    // Anthropic-flavored gateway dialect occasionally folded into the
    // compatible client's path: the full args ride inside
    // `content_block_start.content_block.input` and there are NO deltas. We
    // must NOT discard those — only empty `{}` placeholders should be ignored.
    //
    // This is hard to drive through the OpenAI2 / OpenAI2 transformers
    // (which always emit `input: {}`), so we exercise an OpenAI-Chat-shaped
    // chunk that carries id+name+full-arguments in a single delta.
    const argsJson = JSON.stringify({ filePath: '/eager.txt', content: 'whole-shot' })
    const chunk1 = JSON.stringify({
      object: 'chat.completion.chunk',
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, id: 'call_eager', function: { name: 'write_file', arguments: argsJson } },
            ],
          },
          finish_reason: null,
        },
      ],
    })
    const chunk2 = JSON.stringify({
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
    })
    const chunks = [`data: ${chunk1}\n\n`, `data: ${chunk2}\n\n`, `data: [DONE]\n\n`]
    globalThis.fetch = vi.fn().mockResolvedValue(makeResponse(chunks))

    const coll = makeCollector()
    await streamCompatibleFormat(
      mkConfig({ id: 'openai' }),
      mkParams(),
      coll.calls,
      new AbortController().signal,
    )

    expect(coll.errors).toEqual([])
    expect(coll.tools).toHaveLength(1)
    expect(coll.tools[0].input).toEqual({ filePath: '/eager.txt', content: 'whole-shot' })
  })

  it('OpenAI Chat: write_file flushed after finish_reason=length carries the truncation marker even when its JSON parses cleanly', async () => {
    // Fix-2 regression: gateways may auto-close a max_tokens-cut tool block
    // into VALID-looking JSON (e.g. only `filePath` survived, `content` was
    // never streamed). The raw JSON needs no repair, so the old
    // `meta.truncationRepaired` signal alone missed it and the call fell
    // through to the misleading "dropped while streaming" Zod headline.
    // With stop_reason=max_tokens known at flush time, the trailing
    // write/edit call must be tagged so the schema refuses the write with
    // the dedicated max_tokens message.
    const chunk1 = JSON.stringify({
      object: 'chat.completion.chunk',
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call_cut_1',
                function: { name: 'write_file', arguments: '{"filePath":"/tmp/x.txt"}' },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    })
    const chunk2 = JSON.stringify({
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: {}, finish_reason: 'length' }],
    })
    const chunks = [`data: ${chunk1}\n\n`, `data: ${chunk2}\n\n`, `data: [DONE]\n\n`]
    globalThis.fetch = vi.fn().mockResolvedValue(makeResponse(chunks))

    const coll = makeCollector()
    await streamCompatibleFormat(
      mkConfig({ id: 'openai' }),
      mkParams(),
      coll.calls,
      new AbortController().signal,
    )

    expect(coll.errors).toEqual([])
    expect(coll.tools).toHaveLength(1)
    expect(coll.tools[0].input).toMatchObject({
      filePath: '/tmp/x.txt',
      __argsTruncatedByMaxTokens: true,
    })
  })

  it('OpenAI Chat: finish_reason=tool_calls does NOT tag the flushed write_file with the truncation marker', async () => {
    const chunk1 = JSON.stringify({
      object: 'chat.completion.chunk',
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call_ok_1',
                function: {
                  name: 'write_file',
                  arguments: '{"filePath":"/tmp/x.txt","content":"hello"}',
                },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    })
    const chunk2 = JSON.stringify({
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
    })
    const chunks = [`data: ${chunk1}\n\n`, `data: ${chunk2}\n\n`, `data: [DONE]\n\n`]
    globalThis.fetch = vi.fn().mockResolvedValue(makeResponse(chunks))

    const coll = makeCollector()
    await streamCompatibleFormat(
      mkConfig({ id: 'openai' }),
      mkParams(),
      coll.calls,
      new AbortController().signal,
    )

    expect(coll.errors).toEqual([])
    expect(coll.tools).toHaveLength(1)
    expect(coll.tools[0].input).toEqual({ filePath: '/tmp/x.txt', content: 'hello' })
    expect(coll.tools[0].input).not.toHaveProperty('__argsTruncatedByMaxTokens')
  })

  it('OpenAI2 Responses API: propagates incomplete as max_tokens', async () => {
    const chunks = [
      `data: {"type":"response.incomplete","response":{"status":"incomplete"}}\n\n`,
    ]
    globalThis.fetch = vi.fn().mockResolvedValue(makeResponse(chunks))

    const coll = makeCollector()
    await streamCompatibleFormat(
      mkConfig({ id: 'openai2' }),
      mkParams(),
      coll.calls,
      new AbortController().signal,
    )

    expect(coll.stopReasons).toEqual(['max_tokens'])
  })

  it('OpenAI Chat: propagates length finish_reason as max_tokens', async () => {
    const chunk = JSON.stringify({
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { content: 'partial' }, finish_reason: 'length' }],
    })
    globalThis.fetch = vi.fn().mockResolvedValue(makeResponse([`data: ${chunk}\n\n`]))

    const coll = makeCollector()
    await streamCompatibleFormat(
      mkConfig({ id: 'openai' }),
      mkParams(),
      coll.calls,
      new AbortController().signal,
    )

    expect(coll.text.join('')).toBe('partial')
    expect(coll.stopReasons).toEqual(['max_tokens'])
  })
})
