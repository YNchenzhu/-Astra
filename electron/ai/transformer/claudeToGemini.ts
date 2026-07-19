/**
 * Claude → Gemini 格式转换
 */

import type {
  ClaudeRequest,
  ClaudeContentBlock,
  ClaudeResponse,
  ClaudeTool,
  GeminiRequest,
  GeminiContent,
  GeminiPart,
  TransformContext,
} from './types'
import { sanitizeToolSchemaForWire } from '../toolSchemaSanitizer'
import { mapStopReasonToClaude } from '../stopReasonMap'
import { parseToolArguments } from './parseToolArguments'
import {
  dequeuePendingToolCallByName,
  enqueuePendingToolCall,
  peekPendingToolCallByName,
} from './toolCallQueue'

/** 从 Gemini Part / functionCall 读取 thought 签名（优先 Part 层，与官方响应一致） */
export function extractGeminiThoughtSignature(
  part: Record<string, unknown>,
  functionCall?: Record<string, unknown>,
): string | undefined {
  if ('thoughtSignature' in part && typeof part.thoughtSignature === 'string') return part.thoughtSignature as string
  if ('thought_signature' in part && typeof part.thought_signature === 'string') return part.thought_signature as string
  const fc = functionCall || {}
  if ('thoughtSignature' in fc && typeof fc.thoughtSignature === 'string') return fc.thoughtSignature
  if ('thought_signature' in fc && typeof fc.thought_signature === 'string') return fc.thought_signature
  return undefined
}

/**
 * 提取系统提示文本
 */
function extractSystemText(system: string | ClaudeContentBlock[] | undefined): string {
  if (!system) return ''
  if (typeof system === 'string') return system

  // 2026-06 semantic-drift audit (F3): blank-line join, parity with the
  // other transformers + anthropicCompatHttp's systemMustBeString path.
  const parts: string[] = []
  for (const block of system) {
    if (block.type === 'text') {
      parts.push(block.text)
    }
  }
  return parts.join('\n\n')
}

/**
 * 转换 Claude 内容块为 Gemini parts
 */
function convertClaudeContentToGeminiParts(
  content: ClaudeContentBlock[],
  ctx: TransformContext
): GeminiPart[] {
  const parts: GeminiPart[] = []

  for (const block of content) {
    switch (block.type) {
      case 'text':
        parts.push({
          text: block.text,
        })
        break

      case 'thinking':
        // 与 OpenAI / OpenAI2 通路保持一致：不把历史 thinking 内容回灌给
        // Gemini。即便 Gemini 能解析 <think> 标签，把上轮模型的内部推理
        // 作为下一轮输入也会引入"被自己上轮带偏"的噪声/幻觉风险——这是
        // upstream-main 的全局原则（`anthropicToOpenaiChat.ts:167` 等处
        // 都是 `// Skip thinking blocks`）。
        // 如需保留思考链，正确做法是走 Gemini 原生的 `thoughtSignature`
        // 协议（已在 tool_use 分支处理），而不是把 reasoning 当作 text
        // part 塞回模型。
        break

      case 'tool_use': {
        // FIFO enqueue so the matching `functionResponse` from Gemini
        // (which only carries `name`, no id) can resolve back to this
        // specific call. Critical when the same tool is called twice in
        // a single turn (R3).
        enqueuePendingToolCall(ctx, block.name, block.id)

        const sig =
          typeof block.thoughtSignature === 'string' && block.thoughtSignature.length > 0
            ? block.thoughtSignature
            : ''
        // History replay through some Anthropic-compat proxies re-serializes
        // `tool_use.input` as a JSON string. Gemini's
        // `functionCall.args` schema requires an object; passing a string
        // either rejects the call (400) or silently drops args. Routing
        // through `parseToolArguments` accepts object / JSON-string /
        // wrapped `{ raw_arguments: ... }` uniformly — same protection we
        // already apply when reading Gemini→Claude functionCalls.
        const args = parseToolArguments(block.input)
        parts.push({
          functionCall: {
            name: block.name,
            args,
          },
          ...(sig ? { thoughtSignature: sig } : {}),
        })
        break
      }

      case 'tool_result': {
        const toolName = ctx.toolUseIDToName.get(block.tool_use_id) || 'unknown'
        if (typeof block.content === 'string') {
          parts.push({
            functionResponse: {
              name: toolName,
              response: {
                result:
                  block.content.length > 0 ? block.content : '(empty tool result)',
              },
            },
          })
          break
        }
        if (Array.isArray(block.content)) {
          let textAccum = ''
          const mediaInlineParts: GeminiPart[] = []
          for (const c of block.content) {
            if (c.type === 'text' && typeof c.text === 'string') {
              textAccum += (textAccum ? '\n' : '') + c.text
            }
            if (c.type === 'image' && c.source?.data) {
              const data = c.source.data
              const mime = c.source.media_type || 'image/png'
              if (typeof data === 'string' && data.trim()) {
                mediaInlineParts.push({
                  inlineData: { mimeType: mime, data },
                })
              }
            }
            if (c.type === 'document' && c.source?.data) {
              const data = c.source.data
              const mime = c.source.media_type || 'application/pdf'
              if (typeof data === 'string' && data.trim()) {
                mediaInlineParts.push({
                  inlineData: { mimeType: mime, data },
                })
              }
            }
          }
          const responseStruct: Record<string, unknown> =
            textAccum.length > 0
              ? { result: textAccum }
              : mediaInlineParts.length > 0
                ? { result: `[${mediaInlineParts.length} file(s) attached]` }
                : { result: '(empty tool result)' }
          parts.push({
            functionResponse: {
              name: toolName,
              response: responseStruct,
            },
          })
          for (const ip of mediaInlineParts) {
            parts.push(ip)
          }
          break
        }
        parts.push({
          functionResponse: {
            name: toolName,
            response: { result: JSON.stringify(block.content ?? null) },
          },
        })
        break
      }

      case 'image': {
        const data = block.source?.data
        const mime = block.source?.media_type || 'image/png'
        if (typeof data === 'string' && data.trim()) {
          parts.push({ inlineData: { mimeType: mime, data } })
        } else {
          parts.push({ text: '[image omitted: empty data]' })
        }
        break
      }

      case 'document': {
        const data = block.source?.data
        const mime = block.source?.media_type || 'application/pdf'
        if (typeof data === 'string' && data.trim()) {
          parts.push({ inlineData: { mimeType: mime, data } })
        } else {
          parts.push({ text: '[document omitted: empty data]' })
        }
        break
      }

      // ── Anthropic PTC downgrade ───────────────────────────────────
      // Gemini has no `code_execution_20260120` equivalent. Preserve the
      // intent in-context as text so model reasoning continues to work
      // when a user switches provider mid-session.
      case 'server_tool_use': {
        const code = typeof block.input?.code === 'string' ? block.input.code : ''
        parts.push({
          text: `\n[PTC: Claude ran the following Python in a code_execution sandbox]\n\`\`\`python\n${code}\n\`\`\`\n`,
        })
        break
      }

      case 'code_execution_tool_result': {
        const c = block.content
        const stdout = typeof c?.stdout === 'string' ? c.stdout : ''
        const stderr = typeof c?.stderr === 'string' ? c.stderr : ''
        const rc = typeof c?.return_code === 'number' ? c.return_code : 0
        const parts_: string[] = [`[PTC result — exit=${rc}]`]
        if (stdout) parts_.push(`stdout:\n${stdout}`)
        if (stderr) parts_.push(`stderr:\n${stderr}`)
        parts.push({ text: `\n${parts_.join('\n')}\n` })
        break
      }
    }
  }

  return parts
}

/**
 * 转换 Claude 消息为 Gemini content
 */
function convertClaudeMessageToGemini(
  msg: { role: string; content: string | ClaudeContentBlock[] },
  ctx: TransformContext
): GeminiContent {
  const role = msg.role === 'assistant' ? 'model' : 'user'
  let parts: GeminiPart[] = []

  if (typeof msg.content === 'string') {
    parts = [{ text: msg.content }]
  } else {
    parts = convertClaudeContentToGeminiParts(msg.content, ctx)
  }

  if (parts.length === 0) {
    parts = [{ text: ' ' }]
  }

  return {
    role,
    parts,
  }
}

const SYNTHETIC_FUNCTION_RESPONSE = {
  result:
    'Error: Tool execution result was unavailable after context compaction (synthetic functionResponse inserted to satisfy Gemini function-calling protocol).',
}

function repairGeminiFunctionAdjacency(contents: GeminiContent[]): GeminiContent[] {
  const out: GeminiContent[] = []
  const pendingNames: string[] = []

  const flushMissing = (): void => {
    if (pendingNames.length === 0) return
    out.push({
      role: 'user',
      parts: pendingNames.splice(0).map((name) => ({
        functionResponse: { name, response: SYNTHETIC_FUNCTION_RESPONSE },
      })),
    })
  }

  for (const content of contents) {
    const functionCallNames = content.parts
      .map((p) => p.functionCall?.name)
      .filter((name): name is string => typeof name === 'string' && name.length > 0)

    if (content.role === 'model' && functionCallNames.length > 0) {
      flushMissing()
      out.push(content)
      pendingNames.push(...functionCallNames)
      continue
    }

    if (content.role === 'user') {
      const matchingResponses: GeminiPart[] = []
      const remainingParts: GeminiPart[] = []
      for (const part of content.parts) {
        const name = part.functionResponse?.name
        if (typeof name === 'string') {
          const idx = pendingNames.indexOf(name)
          if (idx >= 0) {
            pendingNames.splice(idx, 1)
            matchingResponses.push(part)
          }
          continue
        }
        if (matchingResponses.length > 0 && part.inlineData) {
          matchingResponses.push(part)
          continue
        }
        remainingParts.push(part)
      }
      if (matchingResponses.length > 0) {
        out.push({ role: 'user', parts: matchingResponses })
      }
      flushMissing()
      if (remainingParts.length > 0) {
        out.push({ ...content, parts: remainingParts })
      }
      continue
    }

    flushMissing()
    out.push(content)
  }

  flushMissing()
  return out
}

/**
 * 清理 JSON Schema 以适配 Gemini
 *
 * 参考 ccNexus cleanSchemaForGemini：
 * 1. 移除 additionalProperties、$schema（Gemini 不支持）
 * 2. 递归处理 properties 中的每个字段
 * 3. 递归处理 items（数组元素 schema）
 * 4. 为缺少 items 的 array 类型补充默认 items: { type: 'string' }
 */
/** Exported for electron/ai/client.ts Gemini tool schema sanitization. */
export function cleanSchemaForGemini(schema: Record<string, unknown>): Record<string, unknown> {
  if (!schema || typeof schema !== 'object') return schema

  const cleaned = { ...schema }
  delete cleaned.additionalProperties
  delete cleaned.$schema
  // object 类型不应带 items（易与 array 混淆，部分中转会误判 metadata 等字段）
  if (cleaned.type === 'object' && 'items' in cleaned) {
    delete cleaned.items
  }

  // array 类型必须有 items，否则 Gemini 会报错
  if (cleaned.type === 'array') {
    if (cleaned.items && typeof cleaned.items === 'object') {
      cleaned.items = cleanSchemaForGemini(cleaned.items as Record<string, unknown>)
    } else {
      cleaned.items = { type: 'string' }
    }
  }

  // 递归处理 properties
  if (cleaned.properties && typeof cleaned.properties === 'object') {
    const props = { ...(cleaned.properties as Record<string, unknown>) }
    for (const key in props) {
      if (props[key] && typeof props[key] === 'object') {
        props[key] = cleanSchemaForGemini(props[key] as Record<string, unknown>)
      }
    }
    cleaned.properties = props
  }

  return cleaned
}

/**
 * 转换工具定义
 *
 * Uses the unified schema sanitizer. The legacy in-file
 * {@link cleanSchemaForGemini} is kept exported for backward compatibility
 * (other code paths import it from here) but all new callers should use
 * {@link sanitizeToolSchemaForWire} directly.
 */
function convertClaudeToolsToGemini(tools: ClaudeTool[] | undefined): GeminiRequest['tools'] {
  if (!tools) return undefined

  const functionDeclarations = tools.map((tool) => ({
    name: tool.name,
    description: tool.description || '',
    parameters: sanitizeToolSchemaForWire(tool.input_schema, 'gemini-compat'),
  }))

  return [
    {
      functionDeclarations,
    },
  ]
}

/**
 * Claude 请求 → Gemini 请求
 */
export function claudeToGemini(
  claudeReq: ClaudeRequest,
  ctx: TransformContext
): GeminiRequest {
  const contents: GeminiContent[] = []

  // 转换消息
  for (const msg of claudeReq.messages) {
    contents.push(convertClaudeMessageToGemini(msg, ctx))
  }
  const repairedContents = repairGeminiFunctionAdjacency(contents)

  // 构建请求
  const geminiReq: GeminiRequest = {
    model: claudeReq.model,
    contents: repairedContents,
  }

  // 系统提示
  const systemText = extractSystemText(claudeReq.system)
  if (systemText) {
    geminiReq.systemInstruction = {
      parts: [{ text: systemText }],
    }
  }

  // 生成配置
  geminiReq.generationConfig = {}
  if (claudeReq.max_tokens) {
    geminiReq.generationConfig.maxOutputTokens = claudeReq.max_tokens
  }
  if (claudeReq.temperature !== undefined) {
    geminiReq.generationConfig.temperature = claudeReq.temperature
  }
  if (claudeReq.top_p !== undefined) {
    geminiReq.generationConfig.topP = claudeReq.top_p
  }

  const extendedReq = claudeReq as ClaudeRequest & {
    thinking?: { type?: string; budget_tokens?: number }
  }
  if (extendedReq.thinking?.type === 'enabled') {
    geminiReq.generationConfig.thinkingConfig = {
      includeThoughts: true,
      thinkingBudget: Math.min(extendedReq.thinking.budget_tokens ?? 8192, 26240),
    }
  }

  // 工具定义
  if (claudeReq.tools && claudeReq.tools.length > 0) {
    geminiReq.tools = convertClaudeToolsToGemini(claudeReq.tools)
  }

  if (claudeReq.stream) {
    geminiReq.stream = true
  }

  return geminiReq
}

/**
 * Gemini 响应 → Claude 响应
 */
export function geminiToClaude(
  geminiResp: Record<string, unknown>,
  ctx: TransformContext
): ClaudeResponse {
  const content: ClaudeContentBlock[] = []

  // 处理候选项
  const candidates = geminiResp['candidates'] as Array<Record<string, unknown>> | undefined
  const candidate = candidates?.[0]
  if (!candidate) {
    return { content, usage: { input_tokens: 0, output_tokens: 0 } } as ClaudeResponse
  }

  const geminiContent = candidate['content'] as { parts?: Array<Record<string, unknown>> } | undefined
  let geminiFcIndex = 0
  if (geminiContent?.parts) {
    for (const part of geminiContent.parts) {
      const partText = part['text']
      if (typeof partText === 'string' && partText) {
        // 处理思考块标签
        const text = partText
        const thinkMatch = text.match(/<think>([\s\S]*?)<\/think>/)
        if (thinkMatch) {
          content.push({
            type: 'thinking',
            thinking: thinkMatch[1],
          })
          // 添加标签外的文本
          const tagStart = thinkMatch.index ?? 0
          const beforeThink = text.substring(0, tagStart)
          const afterThink = text.substring(tagStart + thinkMatch[0].length)
          if (beforeThink) {
            content.push({
              type: 'text',
              text: beforeThink,
            })
          }
          if (afterThink) {
            content.push({
              type: 'text',
              text: afterThink,
            })
          }
        } else {
          content.push({
            type: 'text',
            text,
          })
        }
      } else {
        const functionCall = part['functionCall'] as Record<string, unknown> | undefined
        if (functionCall && typeof functionCall.name === 'string') {
          geminiFcIndex += 1
          const callId = `call_${functionCall.name}_${Date.now()}_${geminiFcIndex}_${Math.random().toString(36).slice(2, 10)}`
          const sig = extractGeminiThoughtSignature(part, functionCall)
          content.push({
            type: 'tool_use',
            id: callId,
            name: functionCall.name,
            // Gemini sometimes serializes args as a string on compat gateways;
            // run through the shared parser so malformed JSON surfaces as
            // `__rawArguments` instead of silently collapsing to `{}`.
            input: parseToolArguments(functionCall.args),
            ...(sig !== undefined ? { thoughtSignature: sig } : {}),
          })
        } else {
          const functionResponse = part['functionResponse'] as
            | { name: string; response: unknown }
            | undefined
          if (functionResponse) {
            // FIFO resolve: multiple calls to the same tool in a single turn
            // must receive distinct responses. Before this change we used a
            // `Map<name, id>` that overwrote, so the second call's result
            // always replaced the first one's (R3).
            const matchedId =
              dequeuePendingToolCallByName(ctx, functionResponse.name) ??
              `call_${functionResponse.name}`
            content.push({
              type: 'tool_result',
              tool_use_id: matchedId,
              content: JSON.stringify(functionResponse.response),
            })
          }
        }
      }
    }
  }

  const usageMeta = geminiResp['usageMetadata'] as
    | { promptTokenCount?: number; candidatesTokenCount?: number }
    | undefined

  const hasToolUseBlocks = content.some((b) => b.type === 'tool_use')
  return {
    id: (geminiResp['id'] as string | undefined) || `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    content,
    model: (geminiResp['model'] as string | undefined) || 'gemini-pro',
    stop_reason: mapStopReasonToClaude(
      'gemini-compat',
      candidate['finishReason'] as string | undefined,
      { hasToolUseBlocks },
    ),
    stop_sequence: null,
    usage: {
      input_tokens: usageMeta?.promptTokenCount || 0,
      output_tokens: usageMeta?.candidatesTokenCount || 0,
    },
  }
}

/**
 * Gemini 流式事件 → Claude 流式事件
 *
 * 参考 ccNexus GeminiStreamToClaude：
 * - 一个 Gemini chunk 可能包含多个 parts（text + functionCall）
 * - 返回事件数组，调用方需逐个处理
 */
export function geminiStreamToClaude(
  event: Record<string, unknown>,
  ctx: TransformContext
): Record<string, unknown> | Record<string, unknown>[] | null {
  const candidates = event['candidates'] as Array<Record<string, unknown>> | undefined
  const candidate = candidates?.[0]
  if (!candidate) return null

  const content = candidate['content'] as { parts?: Array<Record<string, unknown>> } | undefined
  const parts = content?.parts || []
  const result: Array<Record<string, unknown>> = []
  let functionCallPartIndex = 0

  for (const part of parts) {
    const partThought = part['thought'] ?? part['thinking']
    if (typeof partThought === 'string' && partThought.length > 0) {
      result.push({
        type: 'content_block_delta',
        delta: { type: 'thinking_delta', thinking: partThought },
      })
    }
    const partText = part['text']
    if (typeof partText === 'string' && partText) {
      result.push({
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: partText },
      })
    }
    const functionCall = part['functionCall'] as Record<string, unknown> | undefined
    if (functionCall && typeof functionCall.name === 'string') {
      functionCallPartIndex += 1
      // 同一毫秒内多工具并行时 Date.now() 相同，必须区分 id，否则 tool_result 映射错乱
      const callId = `call_${functionCall.name}_${Date.now()}_${functionCallPartIndex}_${Math.random().toString(36).slice(2, 10)}`
      // Peek: when the same tool name was already enqueued (i.e. we're
      // replaying a call that was sent on the wire), reuse that id so the
      // eventual `functionResponse` FIFO dequeue matches up. Otherwise
      // enqueue a fresh id.
      const existingId = peekPendingToolCallByName(ctx, functionCall.name)
      const effectiveId = existingId ?? callId
      if (!existingId) {
        enqueuePendingToolCall(ctx, functionCall.name, effectiveId)
      }
      const sig = extractGeminiThoughtSignature(part, functionCall)
      // content_block_start for tool_use
      result.push({
        type: 'content_block_start',
        content_block: {
          type: 'tool_use',
          id: effectiveId,
          name: functionCall.name,
          input: {},
          ...(sig !== undefined ? { thoughtSignature: sig } : {}),
        },
      })
      // input_json_delta with full arguments
      const args = JSON.stringify(functionCall.args || {})
      result.push({
        type: 'content_block_delta',
        delta: { type: 'input_json_delta', partial_json: args },
      })
      // content_block_stop
      result.push({ type: 'content_block_stop' })
    }
  }

  if (candidate['finishReason']) {
    result.push({ type: 'message_stop' })
  }

  return result.length === 1 ? result[0] : result.length > 1 ? result : null
}
