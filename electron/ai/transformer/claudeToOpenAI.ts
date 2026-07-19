/**
 * Claude → OpenAI Chat 格式转换
 */

import type {
  ClaudeRequest,
  ClaudeContentBlock,
  ClaudeResponse,
  ClaudeTool,
  OpenAIRequest,
  OpenAIMessage,
  OpenAIContentPart,
  OpenAIResponse,
  OpenAITool,
  OpenAIToolCall,
  TransformContext,
} from './types'
import { sanitizeToolSchemaForWire } from '../toolSchemaSanitizer'
import { mapStopReasonToClaude } from '../stopReasonMap'
import { parseToolArguments, stringifyToolInputForOpenAi } from './parseToolArguments'
import { enqueuePendingToolCall } from './toolCallQueue'

/**
 * Pick reasoning/thinking text from an OpenAI-style `delta` regardless of
 * which key the upstream uses:
 *   - `reasoning_content` — canonical OpenAI o-series
 *   - `reasoning`         — DeepSeek R1, SiliconFlow, some generic proxies
 *   - `thinking`          — Moonshot / Kimi-thinking
 *
 * Each key may be either a string or `{text: string}` (rare but seen on
 * self-hosted runtimes).
 */
function pickReasoningText(delta: Record<string, unknown>): string | undefined {
  const candidates = ['reasoning_content', 'reasoning', 'thinking'] as const
  for (const k of candidates) {
    const v = delta[k]
    if (typeof v === 'string' && v.length > 0) return v
    if (v && typeof v === 'object' && 'text' in (v as Record<string, unknown>)) {
      const t = (v as { text?: unknown }).text
      if (typeof t === 'string' && t.length > 0) return t
    }
  }
  return undefined
}

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
 * 转换 Claude 消息为 OpenAI 格式
 */
function convertClaudeMessageToOpenAI(
  msg: { role: string; content: string | ClaudeContentBlock[] },
  ctx: TransformContext
): OpenAIMessage[] {
  const result: OpenAIMessage[] = []

  if (typeof msg.content === 'string') {
    result.push({
      role: msg.role as 'user' | 'assistant',
      content: msg.content,
    })
    return result
  }

  // 处理复杂内容块
  const textParts: string[] = []
  // Multimodal parts for user messages (OpenAI supports image_url content items
  // on vision-capable models). Accumulated separately and appended to the final
  // message's content array if any exist.
  const mediaParts: Array<Record<string, unknown>> = []
  const toolCalls: OpenAIToolCall[] = []
  const toolResults: OpenAIMessage[] = []

  for (const block of msg.content) {
    switch (block.type) {
      case 'text':
        textParts.push(block.text)
        break

      case 'thinking':
        // Claude 的思考块不转发给 OpenAI
        break

      case 'tool_use': {
        // Register in FIFO queue so we can resolve tool_result id by name on
        // gateways that drop the id (primarily Gemini, but some OpenAI
        // proxies also lose it in tool-role reply bodies).
        enqueuePendingToolCall(ctx, block.name, block.id)
        // `stringifyToolInputForOpenAi` defends against history-replay where
        // `block.input` arrived as a JSON string (re-serialized by an
        // upstream proxy in the previous round-trip). A naive
        // `JSON.stringify` would double-encode that into
        // `"\"{ \\\"path\\\": ... }\""` and the model would see a
        // stringified-string as the function's arguments.
        const args = stringifyToolInputForOpenAi(block.input)
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: { name: block.name, arguments: args },
        })
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
        toolResults.push({
          role: 'tool',
          content: resultContent,
          tool_call_id: block.tool_use_id,
        })
        break
      }

      case 'image': {
        // Convert Anthropic image block → OpenAI image_url content item.
        // base64 → data URL; URL source passed through as-is.
        const b = block as {
          source?: { type?: string; data?: string; media_type?: string; url?: string }
        }
        const src = b.source
        if (src && typeof src === 'object') {
          if (src.type === 'base64' && src.data) {
            const mt = src.media_type || 'image/png'
            mediaParts.push({
              type: 'image_url',
              image_url: { url: `data:${mt};base64,${src.data}` },
            })
          } else if (src.type === 'url' && typeof src.url === 'string') {
            mediaParts.push({
              type: 'image_url',
              image_url: { url: src.url },
            })
          }
        }
        break
      }

      case 'document': {
        // OpenAI Chat Completions has no native document block. Downgrade:
        // - If the upstream pipeline attached an extracted text companion, it
        //   will already be in this message as a separate `text` block next to
        //   the document block (see contextBuilder.fileAttachmentToBlocks).
        //   In that case we can safely drop the raw PDF here.
        // - Otherwise leave a short notice so the model knows a doc was sent.
        const b = block as { source?: { type?: string; data?: string } }
        if (b.source?.type === 'base64' && b.source.data) {
          // The sibling text block (if any) carries the extracted content.
          textParts.push('\n[Attached PDF omitted in raw form — text extract follows if available.]\n')
        }
        break
      }

      // ── Anthropic PTC downgrade ───────────────────────────────────
      // OpenAI has no code_execution tool. Preserve intent in-context by
      // rendering the generated Python + its output as plain text so the
      // model keeps its place in the reasoning chain when a user switches
      // providers mid-session.

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
        const code = typeof c?.return_code === 'number' ? c.return_code : 0
        const parts = [`[PTC result — exit=${code}]`]
        if (stdout) parts.push(`stdout:\n${stdout}`)
        if (stderr) parts.push(`stderr:\n${stderr}`)
        textParts.push(`\n${parts.join('\n')}\n`)
        break
      }
    }
  }

  // OpenAI Chat requires assistant tool_calls to be followed immediately by
  // role="tool" messages. Claude user turns may mix tool_result blocks with
  // text (for example our synthetic pairing-repair marker), so emit tool
  // results before any user text/media from the same Claude message.
  if (msg.role === 'user') {
    result.push(...toolResults)
  }

  // 添加文本消息
  if (textParts.length > 0 || toolCalls.length > 0 || mediaParts.length > 0) {
    const joinedText = textParts.join('')
    // Vision-capable models accept an array of content items for user messages.
    // When we have media parts, always send the array form. Otherwise, keep
    // plain string content (broader compat with non-vision models).
    let content: OpenAIMessage['content']
    if (mediaParts.length > 0) {
      const arr: OpenAIContentPart[] = []
      if (joinedText) arr.push({ type: 'text', text: joinedText })
      for (const m of mediaParts) arr.push(m as OpenAIContentPart)
      content = arr
    } else {
      content = joinedText || null
    }
    const message: OpenAIMessage = {
      role: msg.role as 'user' | 'assistant',
      content,
    }
    if (toolCalls.length > 0) {
      message.tool_calls = toolCalls
    }
    result.push(message)
  }

  // 添加工具结果消息
  if (msg.role !== 'user') {
    result.push(...toolResults)
  }

  return result
}

const SYNTHETIC_TOOL_RESULT_CONTENT =
  'Error: Tool execution result was unavailable after context compaction (synthetic tool message inserted to satisfy OpenAI Chat protocol).'

/**
 * OpenAI Chat is stricter than Anthropic transcript replay:
 * every assistant message with `tool_calls` must be followed immediately by
 * exactly matching `role:"tool"` messages, and `role:"tool"` messages are
 * invalid without a preceding assistant `tool_calls`.
 *
 * Claude-shaped histories can violate this after compaction/snipping, where a
 * `tool_result` survives but its assistant `tool_use` parent was dropped, or
 * vice versa. Repair that at the wire boundary so strict gateways do not 400.
 */
function repairOpenAIToolMessageAdjacency(messages: OpenAIMessage[]): OpenAIMessage[] {
  const out: OpenAIMessage[] = []
  let pendingToolIds: Set<string> | null = null

  const flushMissingToolResults = (): void => {
    if (!pendingToolIds || pendingToolIds.size === 0) return
    for (const id of pendingToolIds) {
      out.push({
        role: 'tool',
        tool_call_id: id,
        content: SYNTHETIC_TOOL_RESULT_CONTENT,
      })
    }
    pendingToolIds = null
  }

  for (const msg of messages) {
    if (msg.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      flushMissingToolResults()
      out.push(msg)
      pendingToolIds = new Set(
        msg.tool_calls.map((tc) => tc.id).filter((id): id is string => typeof id === 'string' && id.length > 0),
      )
      continue
    }

    if (msg.role === 'tool') {
      const id = typeof msg.tool_call_id === 'string' ? msg.tool_call_id : ''
      if (pendingToolIds?.has(id)) {
        out.push(msg)
        pendingToolIds.delete(id)
        if (pendingToolIds.size === 0) pendingToolIds = null
      }
      continue
    }

    flushMissingToolResults()
    out.push(msg)
  }

  flushMissingToolResults()
  return out
}

/**
 * 转换工具定义
 *
 * Schema sanitization: we default to the `openai-compat` policy because this
 * transformer is used exclusively by `compatibleClient.ts` — native OpenAI
 * Chat goes through `providers/openai.ts` which keeps the richer schema. The
 * compat policy strips `additionalProperties` / `$schema` / combinators so
 * the broad spectrum of OpenAI-compatible Chinese proxies and self-hosted
 * runtimes don't 400 on unknown keywords.
 */
function convertClaudeToolsToOpenAI(tools: ClaudeTool[] | undefined): OpenAITool[] | undefined {
  if (!tools) return undefined

  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description || '',
      parameters: sanitizeToolSchemaForWire(tool.input_schema, 'openai-compat'),
    },
  }))
}

/**
 * 转换工具选择策略
 */
function convertToolChoice(
  toolChoice: ClaudeRequest['tool_choice']
): OpenAIRequest['tool_choice'] | undefined {
  if (!toolChoice) return undefined

  if (typeof toolChoice === 'string') {
    if (toolChoice === 'any') return 'required'
    return toolChoice // 'auto'
  }

  if (typeof toolChoice === 'object' && toolChoice.type === 'tool') {
    return {
      type: 'function',
      function: { name: toolChoice.name },
    }
  }

  return undefined
}

/**
 * Claude 请求 → OpenAI Chat 请求
 */
export function claudeToOpenAIChat(
  claudeReq: ClaudeRequest,
  ctx: TransformContext
): OpenAIRequest {
  // 转换系统提示
  const messages: OpenAIMessage[] = []
  const systemText = extractSystemText(claudeReq.system)
  if (systemText) {
    messages.push({
      role: 'system',
      content: systemText,
    })
  }

  // 转换消息
  for (const msg of claudeReq.messages) {
    messages.push(...convertClaudeMessageToOpenAI(msg, ctx))
  }
  const repairedMessages = repairOpenAIToolMessageAdjacency(messages)

  // 构建请求
  const openaiReq: OpenAIRequest = {
    model: claudeReq.model,
    messages: repairedMessages,
  }

  // upstream parity (anthropicToOpenaiChat.ts): omit `max_tokens` /
  // `max_completion_tokens` so the upstream provider uses its own default/max.
  // An explicit value either truncates thinking-heavy turns prematurely (too
  // small, e.g. 8192) or 400s gateways with lower ceilings (too large).

  if (claudeReq.temperature !== undefined) {
    openaiReq.temperature = claudeReq.temperature
  }
  if (claudeReq.top_p !== undefined) {
    openaiReq.top_p = claudeReq.top_p
  }

  if (claudeReq.tools && claudeReq.tools.length > 0) {
    openaiReq.tools = convertClaudeToolsToOpenAI(claudeReq.tools)

    // 转换工具选择
    const toolChoice = convertToolChoice(claudeReq.tool_choice)
    if (toolChoice) {
      openaiReq.tool_choice = toolChoice
    }
  }

  if (claudeReq.stream) {
    openaiReq.stream = true
    openaiReq.stream_options = { include_usage: true }
  }

  return openaiReq
}

/**
 * OpenAI Chat 响应 → Claude 响应
 */
export function openAIChatToClaude(
  openaiResp: Record<string, unknown>,
   
  _ctx?: TransformContext
): ClaudeResponse {
  const resp = openaiResp as unknown as OpenAIResponse
  const content: ClaudeContentBlock[] = []

  // 处理第一个 choice
  const choice = resp.choices?.[0]
  if (!choice) {
    return { content, usage: { input_tokens: 0, output_tokens: 0 } } as ClaudeResponse
  }

  const message = choice.message

  // 添加文本内容
  if (message.content) {
    // OpenAI responses normally return `content: string`; vision-capable
    // models may echo the array form too — flatten the text parts in that
    // case so the Claude side still sees a single text block.
    const flatText =
      typeof message.content === 'string'
        ? message.content
        : Array.isArray(message.content)
          ? message.content
              .filter((p): p is { type: 'text'; text: string } => p?.type === 'text' && typeof p.text === 'string')
              .map((p) => p.text)
              .join('')
          : ''
    content.push({ type: 'text', text: flatText })
  }

  // 处理工具调用
  let emittedToolUse = false
  if (message.tool_calls && Array.isArray(message.tool_calls)) {
    for (const toolCall of message.tool_calls) {
      if (toolCall.type === 'function') {
        const args = parseToolArguments(toolCall.function.arguments)
        content.push({
          type: 'tool_use',
          id: toolCall.id,
          name: toolCall.function.name,
          input: args,
        })
        emittedToolUse = true
      }
    }
  }

  return {
    id: resp.id || `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    content,
    model: resp.model,
    // Map OpenAI `finish_reason` → Claude vocabulary so downstream
    // `agenticLoop` checks for `max_tokens` / `tool_use` keep working.
    stop_reason: mapStopReasonToClaude('openai-compat', choice.finish_reason, {
      hasToolUseBlocks: emittedToolUse,
    }),
    stop_sequence: null,
    usage: {
      input_tokens: resp.usage?.prompt_tokens || 0,
      output_tokens: resp.usage?.completion_tokens || 0,
    },
  }
}

/**
 * OpenAI Chat 流式事件 → Claude 流式事件
 *
 * 参考 ccNexus OpenAIStreamToClaude：
 * - delta.reasoning_content → thinking_delta
 * - delta.content → text_delta
 * - delta.tool_calls → tool_use content blocks
 * - finish_reason → message_stop
 */
export function openAIChatStreamToClaude(
  event: Record<string, unknown>,
  ctx: TransformContext
): Record<string, unknown> | Record<string, unknown>[] | null {
  const ev = event as unknown as {
    object?: string
    choices?: Array<{
      delta?: {
        /** Standard OpenAI o-series reasoning stream. */
        reasoning_content?: string
        /** DeepSeek / SiliconFlow / some Chinese proxies use bare `reasoning`. */
        reasoning?: string | { text?: string }
        /** Moonshot / Kimi sometimes use `thinking`. */
        thinking?: string | { text?: string }
        content?: string
        tool_calls?: Array<{
          index?: number
          id?: string
          function?: { name?: string; arguments?: string }
        }>
      }
      finish_reason?: string | null
    }>
  }
  // Some loose gateways drop `object: "chat.completion.chunk"` on chunks.
  // We accept any event that carries a `choices` array with a `delta` object.
  if (ev.object !== 'chat.completion.chunk') {
    const looksLikeChunk = Array.isArray(ev.choices) && ev.choices[0]?.delta !== undefined
    if (!looksLikeChunk) return null
  }

  const choice = ev.choices?.[0]
  if (!choice) return null

  const delta = choice.delta || {}
  const out: Record<string, unknown>[] = []

  // 处理 reasoning/thinking 增量（o3/o4/DeepSeek R1/Kimi-thinking 等模型）
  const reasoningText = pickReasoningText(delta)
  if (reasoningText) {
    out.push({
      type: 'content_block_delta',
      delta: {
        type: 'thinking_delta',
        thinking: reasoningText,
      },
    })
  }

  // 处理文本增量
  if (delta.content) {
    out.push({
      type: 'content_block_delta',
      delta: {
        type: 'text_delta',
        text: delta.content,
      },
    })
  }

  // 处理工具调用（支持增量参数）
  //
  // OpenAI Chat 流式协议允许 `function.arguments` 跨多个 chunk 流出：
  //   chunk 1: tool_calls=[{id, name, arguments:'{"f":"'}]
  //   chunk 2: tool_calls=[{index:0, function:{arguments:'b"}'}}]
  //   chunk 3: finish_reason='tool_calls'
  // 因此**绝对不能**在第一个非空 args chunk 后立即 emit `content_block_stop`：
  // 一旦发了 stop，下游 `compatibleClient` 就会 flush 当前工具并清空
  // currentToolCall；chunk 2 的尾段 args 变成 orphan，最终丢失 → 工具落到
  // 校验器时 `content`/`prompt` 等长字段缺失。
  //
  // 同包多工具的边界（罕见但允许：tool_calls 数组里有不同 index 的多个元素，
  // 每个都带 id+name+args）由 `compatibleClient` 在收到下一个
  // `content_block_start` 时自动 flush 旧的 currentToolCall 来兜底；并且
  // `finish_reason` 时 `flushToolCall('message_stop')` 也会兜底，所以无需
  // transformer 自己发 stop。
  //
  // 历史教训：`claudeToOpenAI2.ts` 同样的 `input:{}` 占位曾经被
  // `compatibleClient` 误识别为 eagerInput 短路掉真实 args；上一轮在消费端
  // 加了 `Object.keys(...).length > 0` 判空。这里继续依赖那条护栏。
  if (delta.tool_calls) {
    for (const toolCall of delta.tool_calls) {
      if (toolCall.id && toolCall.function?.name) {
        ctx.toolUseIDToName.set(toolCall.id, toolCall.function.name)
        out.push({
          type: 'content_block_start',
          content_block: {
            type: 'tool_use',
            id: toolCall.id,
            name: toolCall.function.name,
            input: {},
          },
        })
        const argChunk = toolCall.function.arguments
        if (typeof argChunk === 'string' && argChunk.length > 0) {
          out.push({
            type: 'content_block_delta',
            delta: {
              type: 'input_json_delta',
              partial_json: argChunk,
            },
          })
        }
        continue
      }
      if (toolCall.function?.arguments) {
        // 续传 args delta：网关只发 args 不重发 id/name。compatibleClient 会
        // 把这段拼到 currentToolCall.arguments 上；若 currentToolCall 还没
        // 建立（极罕见的开局乱序），会进 pendingOrphanArgs 等下一个 start
        // 来认领。
        out.push({
          type: 'content_block_delta',
          delta: {
            type: 'input_json_delta',
            partial_json: toolCall.function.arguments,
          },
        })
      }
    }
  }

  // 处理完成
  if (choice.finish_reason) {
    out.push({
      type: 'message_stop',
    })
  }

  if (out.length === 1) return out[0]
  if (out.length > 1) return out
  return null
}
