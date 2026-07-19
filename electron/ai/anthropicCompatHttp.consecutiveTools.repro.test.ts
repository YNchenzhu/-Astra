/**
 * Repro test — 连续两个 edit_file tool_use 块的 onToolInputDelta 流式发射。
 *
 * 用户报告:主聊天里连续编辑时,只有第一张 Write/Edit 卡片有"平滑流式渲染",
 * 后续卡片直到编辑完成才出现。渲染层 store 的等价测试
 * (`mainStreamRouter.consecutiveEdits.repro.test.ts`)已经证明 store 处理正确,
 * 所以问题(若存在于本层)应当在 provider 的 SSE 消费侧:第二个 tool_use 块的
 * `input_json_delta` 是否仍然触发 `onToolInputDelta`。
 *
 * DeepSeek 走 `streamAnthropicCompatHttp`(quirks.useAnthropicCompatHttpClient
 * = true;日志里的 "使用 Anthropic Messages SDK,不走兼容客户端" 只是
 * shouldUseCompatibleClient 对 OpenAI 兼容客户端的判定,与真实路由无关)。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { streamAnthropicCompatHttp } from './anthropicCompatHttp'
import type { ProviderConfig, StreamCallbacks, StreamTextParams } from './client'

function makeSseBody(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c))
      controller.close()
    },
  })
}

function makeResponse(chunks: string[]): Response {
  return new Response(makeSseBody(chunks), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  }) as unknown as Response
}

function sse(obj: Record<string, unknown>): string {
  return `event: ${obj.type}\ndata: ${JSON.stringify(obj)}\n\n`
}

const config: ProviderConfig = {
  id: 'deepseek',
  name: 'DeepSeek',
  apiKey: 'k',
  baseUrl: 'https://api.deepseek.com/anthropic',
}

const params: StreamTextParams = {
  model: 'deepseek-v4-pro',
  messages: [{ role: 'user', content: '连续编辑两个文件' }],
}

const origFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = origFetch
  vi.restoreAllMocks()
})

describe('anthropicCompatHttp — 连续两个 edit_file 的 tool_input_delta', () => {
  it('同一条流里第二个 tool_use 块仍然发射 onToolInputDelta(含 stop 前的强制尾刷)', async () => {
    const chunks = [
      sse({ type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } }),
      // index 0: thinking 块(DeepSeek 常规形态)
      sse({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }),
      sse({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '计划编辑两个文件' } }),
      sse({ type: 'content_block_stop', index: 0 }),
      // index 1: 第一个 edit_file
      sse({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'edit-1', name: 'edit_file', input: {} } }),
      sse({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"filePath":"a.ts","oldString":"aaa"' } }),
      sse({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: ',"newString":"bbb"}' } }),
      sse({ type: 'content_block_stop', index: 1 }),
      // index 2: 第二个 edit_file(同一 assistant 消息内连续)
      sse({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'edit-2', name: 'edit_file', input: {} } }),
      sse({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"filePath":"b.ts","oldString":"mmm"' } }),
      sse({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: ',"newString":"nnn"}' } }),
      sse({ type: 'content_block_stop', index: 2 }),
      sse({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 50 } }),
      sse({ type: 'message_stop' }),
    ]
    globalThis.fetch = vi.fn().mockResolvedValue(makeResponse(chunks))

    const deltas: Array<{ toolUseId: string; toolName: string; partialJson: string }> = []
    const tools: Array<{ id: string; name: string }> = []
    const callbacks: StreamCallbacks = {
      onTextDelta: () => {},
      onToolUse: (t) => {
        tools.push({ id: t.id, name: t.name })
      },
      onToolInputDelta: (d) => {
        deltas.push({ ...d })
      },
      onMessageEnd: () => {},
      onError: (e) => {
        throw new Error(`stream error: ${e}`)
      },
    }

    await streamAnthropicCompatHttp(config, params, callbacks, new AbortController().signal)

    // 两个 tool_use 都完整落地
    expect(tools.map((t) => t.id)).toEqual(['edit-1', 'edit-2'])

    const d1 = deltas.filter((d) => d.toolUseId === 'edit-1')
    const d2 = deltas.filter((d) => d.toolUseId === 'edit-2')

    // 每个工具:首个 delta 立即发射(节流窗口 lastEmitAt=0 直接放行),
    // content_block_stop 强制尾刷保证最后一帧是闭合 JSON。
    expect(d1.length).toBeGreaterThanOrEqual(2)
    expect(d2.length).toBeGreaterThanOrEqual(2)

    // 尾刷帧必须是完整 JSON(渲染层据此收起光标)
    expect(d1[d1.length - 1].partialJson).toBe('{"filePath":"a.ts","oldString":"aaa","newString":"bbb"}')
    expect(d2[d2.length - 1].partialJson).toBe('{"filePath":"b.ts","oldString":"mmm","newString":"nnn"}')

    // 第二个工具的首帧同样带 toolName,供渲染层同步 seed 占位卡片
    expect(d2[0].toolName).toBe('edit_file')
  })

  it('无 index 字段(全部折叠到 0)的宽松方言下,第二个工具仍发射 onToolInputDelta', async () => {
    const chunks = [
      sse({ type: 'content_block_start', content_block: { type: 'tool_use', id: 'w-1', name: 'edit_file', input: {} } }),
      sse({ type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"filePath":"a.ts","oldString":"x","newString":"y"}' } }),
      sse({ type: 'content_block_stop' }),
      sse({ type: 'content_block_start', content_block: { type: 'tool_use', id: 'w-2', name: 'edit_file', input: {} } }),
      sse({ type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"filePath":"b.ts","oldString":"p","newString":"q"}' } }),
      sse({ type: 'content_block_stop' }),
      sse({ type: 'message_stop' }),
    ]
    globalThis.fetch = vi.fn().mockResolvedValue(makeResponse(chunks))

    const deltas: Array<{ toolUseId: string }> = []
    const callbacks: StreamCallbacks = {
      onTextDelta: () => {},
      onToolUse: () => {},
      onToolInputDelta: (d) => {
        deltas.push({ toolUseId: d.toolUseId })
      },
      onMessageEnd: () => {},
      onError: (e) => {
        throw new Error(`stream error: ${e}`)
      },
    }

    await streamAnthropicCompatHttp(config, params, callbacks, new AbortController().signal)

    expect(deltas.some((d) => d.toolUseId === 'w-1')).toBe(true)
    expect(deltas.some((d) => d.toolUseId === 'w-2')).toBe(true)
  })
})
