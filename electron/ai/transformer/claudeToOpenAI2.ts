/**
 * Claude → OpenAI2 (Responses API) 格式转换
 */

import type {
  ClaudeRequest,
  ClaudeContentBlock,
  ClaudeMessage,
  ClaudeTool,
  ClaudeResponse,
  OpenAI2Request,
  OpenAI2InputItem,
  OpenAI2ContentItem,
  OpenAI2ReasoningPayload,
  OpenAI2Tool,
  TransformContext,
} from './types'
import { sanitizeToolSchemaForWire } from '../toolSchemaSanitizer'
import { mapStopReasonToClaude } from '../stopReasonMap'
import { parseToolArguments, stringifyToolInputForOpenAi } from './parseToolArguments'
import { enqueuePendingToolCall } from './toolCallQueue'

/**
 * 提取系统提示文本
 */
function extractSystemText(system: string | ClaudeContentBlock[] | undefined): string {
  if (!system) return ''
  if (typeof system === 'string') return system

  // 2026-06 semantic-drift audit (F3): join blocks with a blank line, same
  // as `anthropicCompatHttp.ts`'s systemMustBeString coercion. Bare `+=`
  // glued the last line of one layer onto the `#` heading of the next,
  // breaking markdown structure the moment a second system block exists.
  const parts: string[] = []
  for (const block of system) {
    if (block.type === 'text') {
      parts.push(block.text)
    }
  }
  return parts.join('\n\n')
}

/**
 * 转换 Claude 消息为 OpenAI2 input 项
 */
/** Read the opaque reasoning payload (if any) stored on a tool_use block. */
function readToolUseReasoning(
  block: ClaudeContentBlock,
): OpenAI2ReasoningPayload | null {
  const raw = (block as { openai2Reasoning?: unknown }).openai2Reasoning
  if (!raw || typeof raw !== 'object') return null
  const r = raw as { id?: unknown; encrypted_content?: unknown }
  if (typeof r.encrypted_content !== 'string' || r.encrypted_content.length === 0) return null
  return {
    ...(typeof r.id === 'string' && r.id.length > 0 ? { id: r.id } : {}),
    encrypted_content: r.encrypted_content,
  }
}

function convertClaudeMessageToOpenAI2(
  msg: { role: string; content: string | ClaudeContentBlock[] },
  ctx: TransformContext,
  /**
   * F1 — replay stored reasoning items for this message. True only for
   * assistant messages after the most recent genuine user turn (in-turn tool
   * loop); older reasoning is dropped to bound request size.
   */
  allowReasoningReplay = false,
): OpenAI2InputItem[] {
  const result: OpenAI2InputItem[] = []

  if (typeof msg.content === 'string') {
    const textType = msg.role === 'assistant' ? 'output_text' : 'input_text'
    result.push({
      type: 'message',
      role: msg.role as 'user' | 'assistant',
      content: [
        {
          type: textType,
          text: msg.content,
        },
      ],
    })
    return result
  }

  // 处理复杂内容块
  const textParts: string[] = []
  const mediaParts: Array<Record<string, unknown>> = []
  const textType = msg.role === 'assistant' ? 'output_text' : 'input_text'

  for (const block of msg.content) {
    switch (block.type) {
      case 'text':
        textParts.push(block.text)
        break

      case 'thinking':
        // OpenAI2 不支持思考块，跳过
        break

      case 'tool_use': {
        enqueuePendingToolCall(ctx, block.name, block.id)
        // F1 — replay the reasoning item that preceded this function_call in
        // the original response. The Responses API requires reasoning items
        // to appear BEFORE the function_call they belong to in `input`.
        if (allowReasoningReplay) {
          const reasoning = readToolUseReasoning(block)
          if (reasoning && reasoning.id) {
            result.push({
              type: 'reasoning',
              id: reasoning.id,
              encrypted_content: reasoning.encrypted_content,
              summary: [],
            } as unknown as OpenAI2InputItem)
          }
        }
        // Claude tool_use → OpenAI2 function_call (arguments 必须是 JSON 字符串)
        // Use the shared serializer to avoid double-encoding when history
        // replay carries a stringified `block.input` (see
        // `stringifyToolInputForOpenAi` for the failure mode).
        result.push({
          type: 'function_call',
          call_id: block.id,
          name: block.name,
          arguments: stringifyToolInputForOpenAi(block.input),
        } as unknown as OpenAI2InputItem)
        break
      }

      case 'tool_result': {
        let resultContent = ''
        if (typeof block.content === 'string') {
          resultContent = block.content
        } else if (Array.isArray(block.content)) {
          for (const c of block.content) {
            if (c.type === 'text') {
              resultContent += c.text
            }
          }
        }
        // Claude tool_result → OpenAI2 function_call_output
        result.push({
          type: 'function_call_output',
          call_id: block.tool_use_id,
          output: resultContent,
        } as unknown as OpenAI2InputItem)
        break
      }

      case 'image': {
        // OpenAI2 Responses API supports `input_image` content items on
        // vision-capable models. base64 → data URL. URL pass-through.
        const b = block as {
          source?: { type?: string; data?: string; media_type?: string; url?: string }
        }
        const src = b.source
        if (src && typeof src === 'object') {
          if (src.type === 'base64' && src.data) {
            const mt = src.media_type || 'image/png'
            mediaParts.push({
              type: 'input_image',
              image_url: `data:${mt};base64,${src.data}`,
            })
          } else if (src.type === 'url' && typeof src.url === 'string') {
            mediaParts.push({ type: 'input_image', image_url: src.url })
          }
        }
        break
      }

      case 'document':
        // No native doc support in Responses API chat messages — rely on the
        // sibling extracted-text block emitted by contextBuilder.
        break

      // ── Anthropic PTC downgrade ───────────────────────────────────
      case 'server_tool_use': {
        const code = typeof block.input?.code === 'string' ? block.input.code : ''
        textParts.push(
          `\n[PTC: Claude ran the following Python in a code_execution sandbox]\n\`\`\`python\n${code}\n\`\`\`\n`,
        )
        break
      }

      case 'code_execution_tool_result': {
        const c = block.content
        const stdout = typeof c?.stdout === 'string' ? c.stdout : ''
        const stderr = typeof c?.stderr === 'string' ? c.stderr : ''
        const rc = typeof c?.return_code === 'number' ? c.return_code : 0
        const parts = [`[PTC result — exit=${rc}]`]
        if (stdout) parts.push(`stdout:\n${stdout}`)
        if (stderr) parts.push(`stderr:\n${stderr}`)
        textParts.push(`\n${parts.join('\n')}\n`)
        break
      }
    }
  }

  // 添加文本消息
  if (textParts.length > 0 || mediaParts.length > 0) {
    const contentItems: OpenAI2ContentItem[] = []
    if (textParts.length > 0) {
      contentItems.push({ type: textType, text: textParts.join('') })
    }
    for (const m of mediaParts) contentItems.push(m as OpenAI2ContentItem)
    result.push({
      type: 'message',
      role: msg.role as 'user' | 'assistant',
      content: contentItems,
    })
  }

  return result
}

/**
 * 转换工具定义
 *
 * Compat policy: most Responses-API users route through a third-party
 * gateway (`openai2` provider via compat client), so we strip richer schema
 * keywords. Native OpenAI Responses can handle more but it doesn't reject
 * the subset, so using `openai2-compat` uniformly is safe.
 */
function convertClaudeToolsToOpenAI2(tools: ClaudeTool[] | undefined): OpenAI2Tool[] | undefined {
  if (!tools) return undefined

  return tools.map((tool) => ({
    type: 'function' as const,
    name: tool.name,
    description: tool.description || '',
    parameters: sanitizeToolSchemaForWire(tool.input_schema, 'openai2-compat'),
  }))
}

/**
 * 转换工具选择策略
 *
 * Previous behavior: when the caller didn't specify, we forced `required` on
 * the first turn. That produced spurious tool calls for models that
 * legitimately wanted to answer in natural language first — the resulting
 * garbage arguments then showed up as validation errors. Aligning with the
 * Anthropic default (`auto`) removes that failure mode.
 */
function convertToolChoice(
  toolChoice: ClaudeRequest['tool_choice'],
  _hasToolResult: boolean
): 'auto' | 'required' | { type: 'function'; name: string } {
  if (!toolChoice) {
    return 'auto'
  }

  if (typeof toolChoice === 'string') {
    if (toolChoice === 'any') return 'required'
    return toolChoice // 'auto'
  }

  if (typeof toolChoice === 'object' && toolChoice.type === 'tool') {
    return {
      type: 'function',
      name: toolChoice.name,
    }
  }

  return 'auto'
}

/**
 * 检查消息中是否有工具结果
 */
function hasToolResult(messages: ClaudeMessage[]): boolean {
  for (const msg of messages) {
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'tool_result') {
          return true
        }
      }
    }
  }
  return false
}

/**
 * Claude 请求 → OpenAI2 请求
 */
/**
 * F1 — index of the most recent "genuine" user turn: a user message whose
 * content carries NO tool_result blocks. Tool-loop iterations interleave
 * assistant(tool_use) / user(tool_result…), so this boundary marks the start
 * of the current turn; reasoning replay is scoped to assistant messages
 * after it. Returns -1 when no such message exists (replay everything).
 */
function findLastGenuineUserIndex(messages: ClaudeMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'user') continue
    if (typeof m.content === 'string') return i
    if (Array.isArray(m.content) && !m.content.some((b) => b.type === 'tool_result')) {
      return i
    }
  }
  return -1
}

export function claudeToOpenAI2(
  claudeReq: ClaudeRequest,
  ctx: TransformContext
): OpenAI2Request {
  const input: OpenAI2InputItem[] = []

  // 转换消息
  const reasoningEnabled = ctx.openai2ReasoningEnabled === true
  const lastGenuineUserIdx = reasoningEnabled
    ? findLastGenuineUserIndex(claudeReq.messages)
    : -1
  for (let i = 0; i < claudeReq.messages.length; i++) {
    const msg = claudeReq.messages[i]
    const allowReplay =
      reasoningEnabled && msg.role === 'assistant' && i > lastGenuineUserIdx
    input.push(...convertClaudeMessageToOpenAI2(msg, ctx, allowReplay))
  }

  // 构建请求
  const openai2Req: OpenAI2Request = {
    model: claudeReq.model,
    input,
  }

  // F1 — stateless reasoning passthrough (see OpenAI2Request field docs).
  // Only sent when enabled: gateways that don't know these fields would 400,
  // and the compatibleClient 400-fallback latch handles the ones that do.
  if (reasoningEnabled) {
    openai2Req.store = false
    openai2Req.include = ['reasoning.encrypted_content']
  }

  // 系统提示
  const systemText = extractSystemText(claudeReq.system)
  if (systemText) {
    openai2Req.instructions = systemText
  }

  // upstream parity (anthropicToOpenaiResponses.ts): omit `max_output_tokens`
  // so the upstream provider uses its own default/max — avoids both premature
  // truncation (value too small) and 400s (value too large).

  if (claudeReq.temperature !== undefined) {
    openai2Req.temperature = claudeReq.temperature
  }
  if (claudeReq.top_p !== undefined) {
    openai2Req.top_p = claudeReq.top_p
  }

  if (claudeReq.tools && claudeReq.tools.length > 0) {
    openai2Req.tools = convertClaudeToolsToOpenAI2(claudeReq.tools)

    // 智能工具选择
    const hasResult = hasToolResult(claudeReq.messages)
    openai2Req.tool_choice = convertToolChoice(claudeReq.tool_choice, hasResult) as OpenAI2Request['tool_choice']
  }

  if (claudeReq.stream) {
    openai2Req.stream = true
  }

  return openai2Req
}

/**
 * OpenAI2 响应 → Claude 响应
 */
export function openAI2ToClaude(
  openai2Resp: Record<string, unknown>,
  ctx: TransformContext
): ClaudeResponse {
  void ctx
  const content: ClaudeContentBlock[] = []
  let hasToolUseBlocks = false

  // 处理输出项
  const output = openai2Resp.output
  if (output && Array.isArray(output)) {
    for (const item of output) {
      const row = item as Record<string, unknown>
      if (row.type === 'message' && row.content) {
        const parts = row.content as Array<Record<string, unknown>>
        for (const block of parts) {
          if (block.type === 'output_text' || block.type === 'input_text') {
            content.push({
              type: 'text',
              text: typeof block.text === 'string' ? block.text : String(block.text ?? ''),
            })
          }
        }
      } else if (row.type === 'tool_use' || row.type === 'function_call') {
        // Official Responses API emits `type: "function_call"` with `arguments` as a
        // JSON string; some Responses-compat gateways echo back our `tool_use`
        // request shape. Accept both. Parse arguments through the shared helper
        // so a malformed payload surfaces as `__rawArguments` instead of
        // collapsing to an empty object.
        const input = row.type === 'function_call'
          ? parseToolArguments(row.arguments)
          : parseToolArguments(row.input)
        content.push({
          type: 'tool_use',
          id: typeof row.call_id === 'string' ? row.call_id : typeof row.id === 'string' ? row.id : String(row.call_id ?? row.id ?? ''),
          name: typeof row.name === 'string' ? row.name : String(row.name ?? ''),
          input,
        })
        hasToolUseBlocks = true
      }
    }
  }

  const usage = openai2Resp.usage as Record<string, unknown> | undefined
  const rawStopReason =
    typeof openai2Resp.stop_reason === 'string'
      ? openai2Resp.stop_reason
      : typeof openai2Resp.status === 'string'
        ? openai2Resp.status
        : undefined

  return {
    id: (typeof openai2Resp.id === 'string' ? openai2Resp.id : undefined) || `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    content,
    model: typeof openai2Resp.model === 'string' ? openai2Resp.model : '',
    stop_reason: mapStopReasonToClaude('openai2-compat', rawStopReason, {
      hasToolUseBlocks,
    }),
    stop_sequence: null,
    usage: {
      input_tokens: typeof usage?.input_tokens === 'number' ? usage.input_tokens : 0,
      output_tokens: typeof usage?.output_tokens === 'number' ? usage.output_tokens : 0,
    },
  }
}

/**
 * OpenAI2 Responses API 流式事件 → Claude 流式事件
 *
 * 参考 ccNexus OpenAI2StreamToClaude 实现：
 * - response.created        → (初始化上下文)
 * - response.output_text.delta → content_block_delta (text_delta)
 * - response.output_item.added (function_call) → content_block_start (tool_use)
 * - response.function_call_arguments.delta → content_block_delta (input_json_delta)
 * - response.output_item.done → content_block_stop
 * - response.completed      → message_stop
 */
/** 从 Responses 流式事件中取出文本增量（兼容字符串 delta 与部分网关的对象形态） */
function extractOutputTextDelta(event: Record<string, unknown>): string {
  const d = event.delta
  if (typeof d === 'string') return d
  if (d && typeof d === 'object' && 'text' in d && typeof (d as { text: unknown }).text === 'string') {
    return (d as { text: string }).text
  }
  return ''
}

/**
 * Extract a reasoning-summary text delta from a Responses stream event.
 *
 * OpenAI's Responses API exposes the model's safe-to-show summary of its
 * reasoning via `response.reasoning_summary_text.delta` events, which
 * carry either a bare string `delta` or a `{type: 'summary_text', text}`
 * shape (varies by gateway). Some gateways also use
 * `response.reasoning.delta` for the same payload. We accept both names
 * — see the dispatch in `openAI2StreamToClaude` below.
 *
 * Returns the empty string when the event carries no usable text so the
 * caller can short-circuit without emitting a noop delta downstream.
 */
function extractReasoningSummaryDelta(event: Record<string, unknown>): string {
  const d = event.delta
  if (typeof d === 'string') return d
  if (d && typeof d === 'object') {
    const obj = d as Record<string, unknown>
    if (typeof obj.text === 'string') return obj.text
    // Some gateways nest the payload under `summary_text` to match the
    // non-streaming `output[].summary[]` element shape.
    const inner = obj.summary_text
    if (typeof inner === 'string') return inner
    if (inner && typeof inner === 'object' && typeof (inner as { text?: unknown }).text === 'string') {
      return (inner as { text: string }).text
    }
  }
  return ''
}

export function openAI2StreamToClaude(
  event: Record<string, unknown>,
  ctx: TransformContext
): Record<string, unknown> | null {
  const eventType: string = (typeof event.type === 'string' ? event.type : '') || ''

  switch (eventType) {
    case 'response.created':
    case 'response.in_progress':
      return null

    case 'response.output_text.delta': {
      const text = extractOutputTextDelta(event)
      if (!text) return null
      return {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text },
      }
    }

    // 注意：勿把 response.output_text.done 转成 text_delta，官方流在 delta 之后还会发 done（全文），会重复输出

    // ── Reasoning summary (Responses API safe-to-show TL;DR) ──────────
    //
    // Translates `response.reasoning_summary_text.delta` (canonical OpenAI
    // event name as of GA) plus a couple of gateway-aliased variants
    // (`response.reasoning.delta`, `response.reasoning_summary.delta`)
    // into a pseudo-Claude `content_block_delta` carrying our internal
    // `reasoning_summary_delta` payload. The Anthropic-compat consumer
    // recognises this delta type and surfaces it via a dedicated
    // `onReasoningSummary*` callback channel; from there it's a separate
    // ChatBlock kind (`reasoning_summary`) in the renderer, NOT mashed
    // into the regular `thinking` block — the wire format and product
    // semantics are different (no signature, output-only, presented as
    // a separate UI affordance).
    case 'response.reasoning_summary_text.delta':
    case 'response.reasoning_summary.delta':
    case 'response.reasoning.delta': {
      const text = extractReasoningSummaryDelta(event)
      if (!text) return null
      return {
        type: 'content_block_delta',
        delta: { type: 'reasoning_summary_delta', text },
      }
    }

    // The corresponding `.done` events carry the full summary text again,
    // same pattern as `response.output_text.done`. We intentionally skip
    // them so the delta stream isn't duplicated; the downstream
    // accumulator already has the full text from the prior deltas.
    case 'response.reasoning_summary_text.done':
    case 'response.reasoning_summary.done':
    case 'response.reasoning.done':
      return null

    case 'response.output_item.added': {
      const item = event.item as Record<string, unknown> | undefined
      if (item?.type === 'function_call') {
        const callIdRaw = item.call_id ?? item.id
        const callId =
          typeof callIdRaw === 'string' ? callIdRaw : callIdRaw != null ? String(callIdRaw) : `tool_${Date.now()}`
        const name = typeof item.name === 'string' ? item.name : ''
        if (name) {
          enqueuePendingToolCall(ctx, name, callId)
        }
        return {
          type: 'content_block_start',
          content_block: { type: 'tool_use', id: callId, name, input: {} },
        }
      }
      return null
    }

    case 'response.function_call_arguments.delta': {
      const argsDelta = typeof event.delta === 'string' ? event.delta : ''
      if (!argsDelta) return null
      return {
        type: 'content_block_delta',
        delta: { type: 'input_json_delta', partial_json: argsDelta },
      }
    }

    case 'response.output_item.done': {
      // F1 — reasoning items carry their `encrypted_content` only on the
      // `done` event (the `added` event has an empty shell). Surface them as
      // an internal pseudo-event so `compatibleClient` can attach the payload
      // to the NEXT tool_use block (`openai2Reasoning`, thoughtSignature
      // precedent). We never emitted a `content_block_start` for reasoning
      // items, so this must NOT fall through to `content_block_stop`.
      const item = event.item as Record<string, unknown> | undefined
      if (item?.type === 'reasoning') {
        const ec = item.encrypted_content
        if (typeof ec === 'string' && ec.length > 0) {
          return {
            type: 'openai2_reasoning_item',
            reasoning: {
              ...(typeof item.id === 'string' && item.id.length > 0 ? { id: item.id } : {}),
              encrypted_content: ec,
            },
          }
        }
        return null
      }
      return { type: 'content_block_stop' }
    }

    case 'response.completed':
      return { type: 'message_stop' }

    default:
      return null
  }
}
