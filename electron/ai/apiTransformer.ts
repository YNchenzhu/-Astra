/**
 * API 格式转换器 - 自动识别并转换多种 API 格式为 Claude 原生格式
 * 支持: OpenAI Chat, OpenAI Responses API (OpenAI2), Google Gemini
 */

import type { Anthropic } from '@anthropic-ai/sdk'

// ========== 类型定义 ==========

export type APIFormat = 'claude' | 'openai' | 'openai2' | 'gemini' | 'unknown'

export interface DetectionResult {
  format: APIFormat
  confidence: number
  reason: string
}

export interface TransformResult {
  messages: Anthropic.MessageParam[]
  system?: string | Anthropic.TextBlockParam[]
  tools?: Anthropic.Tool[]
  maxTokens?: number
  temperature?: number
}

// ========== Minimal upstream shapes ==========
//
// We refuse `any` at the API boundary. Each upstream format has its own
// tolerant shape — only the fields we actually read are declared; the
// rest falls through via `Record<string, unknown>` or specific nested
// unknown/string types. `data` arrives from arbitrary JSON, so detection
// uses `unknown` and narrows.

type UnknownRecord = Record<string, unknown>

interface OpenAIMessageLike {
  role?: string
  content?: string | Array<UnknownRecord>
  tool_calls?: Array<UnknownRecord>
  tool_call_id?: string
}

interface OpenAIRequestLike {
  messages?: OpenAIMessageLike[]
  system?: unknown
  tools?: UnknownRecord[]
  temperature?: number
  max_completion_tokens?: number
  max_tokens?: number
}

interface OpenAI2InputItemLike {
  type?: string
  role?: string
  content?: Array<UnknownRecord>
  name?: string
  call_id?: string
  input?: UnknownRecord
  output?: unknown
}

interface OpenAI2RequestLike {
  input?: OpenAI2InputItemLike[]
  instructions?: string
  tools?: UnknownRecord[]
  temperature?: number
  max_output_tokens?: number
}

interface GeminiPartLike {
  text?: string
  thought?: string
  thoughtSignature?: string
  thought_signature?: string
  functionCall?: {
    name?: string
    args?: UnknownRecord
    thoughtSignature?: string
    thought_signature?: string
  }
  functionResponse?: {
    name?: string
    response?: { result?: unknown }
  }
  inlineData?: {
    mimeType?: string
    data?: string
  }
}

interface GeminiContentLike {
  role?: string
  parts?: GeminiPartLike[]
}

interface GeminiRequestLike {
  contents?: GeminiContentLike[]
  systemInstruction?: { parts?: GeminiPartLike[] }
  tools?: Array<{ functionDeclarations?: UnknownRecord[] }>
  generationConfig?: {
    maxOutputTokens?: number
    temperature?: number
  }
}

type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
function asImageMediaType(v: string): ImageMediaType {
  if (v === 'image/jpeg' || v === 'image/png' || v === 'image/gif' || v === 'image/webp') return v
  return 'image/jpeg'
}

// ========== API 格式检测 ==========

/**
 * 检测 API 请求格式
 */
export function detectAPIFormat(data: unknown): DetectionResult {
  if (!data || typeof data !== 'object') {
    return { format: 'unknown', confidence: 0, reason: '无效的数据格式' }
  }
  const d = data as UnknownRecord

  // Claude 格式检测
  if (Array.isArray(d.messages)) {
    const hasClaudeFeatures = (d.messages as UnknownRecord[]).some((msg) =>
      Array.isArray(msg.content) &&
      (msg.content as UnknownRecord[]).some((block) =>
        ['tool_use', 'tool_result', 'thinking'].includes(String(block?.type))
      )
    )
    if (hasClaudeFeatures || d.system) {
      return {
        format: 'claude',
        confidence: 0.95,
        reason: 'Claude 原生格式（包含 tool_use/tool_result/thinking 或 system 字段）'
      }
    }
  }

  // OpenAI Responses API (OpenAI2) 检测
  if (Array.isArray(d.input) && d.instructions !== undefined) {
    return {
      format: 'openai2',
      confidence: 0.9,
      reason: 'OpenAI Responses API 格式（input + instructions）'
    }
  }

  // Gemini 格式检测
  if (Array.isArray(d.contents) && d.systemInstruction !== undefined) {
    return {
      format: 'gemini',
      confidence: 0.9,
      reason: 'Google Gemini 格式（contents + systemInstruction）'
    }
  }

  // OpenAI Chat 格式检测
  if (Array.isArray(d.messages)) {
    const hasOpenAIFeatures = (d.messages as UnknownRecord[]).some((msg) =>
      typeof msg.role === 'string' && ['user', 'assistant', 'system', 'tool'].includes(msg.role)
    )
    if (hasOpenAIFeatures) {
      return {
        format: 'openai',
        confidence: 0.85,
        reason: 'OpenAI Chat 格式（messages 数组）'
      }
    }
  }

  return { format: 'unknown', confidence: 0, reason: '无法识别的格式' }
}

// ========== OpenAI Chat 转 Claude ==========

function transformOpenAIToClaude(data: OpenAIRequestLike): TransformResult {
  const messages: Anthropic.MessageParam[] = []
  let system: string | undefined

  const inputMessages = data.messages ?? []

  // 提取 system 消息
  const systemMessages = inputMessages.filter((msg) => msg.role === 'system')
  if (systemMessages.length > 0) {
    system = systemMessages
      .map((msg) => (typeof msg.content === 'string' ? msg.content : ''))
      .join('\n')
  }

  // 转换消息
  for (const msg of inputMessages) {
    if (msg.role === 'system') continue

    const role: 'user' | 'assistant' = msg.role === 'assistant' ? 'assistant' : 'user'
    const content: Anthropic.ContentBlockParam[] = []

    // 处理文本内容
    if (typeof msg.content === 'string') {
      content.push({ type: 'text', text: msg.content })
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        const type = block?.type
        if (type === 'text' && typeof block.text === 'string') {
          content.push({ type: 'text', text: block.text })
        } else if (type === 'image_url') {
          const imageUrl = block.image_url as { url?: string } | undefined
          const url = imageUrl?.url
          if (typeof url === 'string' && url.startsWith('data:')) {
            const [header, payload] = url.split(',')
            const mediaType = header.match(/data:([^;]+)/)?.[1] || 'image/jpeg'
            content.push({
              type: 'image',
              source: {
                type: 'base64',
                media_type: asImageMediaType(mediaType),
                data: payload ?? '',
              },
            })
          }
        }
      }
    }

    // 处理工具调用
    if (Array.isArray(msg.tool_calls)) {
      for (const raw of msg.tool_calls) {
        const toolCall = raw as {
          id?: string
          type?: string
          function?: { name?: string; arguments?: string | UnknownRecord }
        }
        if (toolCall.type === 'function' && toolCall.function) {
          const args = toolCall.function.arguments
          let parsed: UnknownRecord = {}
          if (typeof args === 'string') {
            try {
              parsed = JSON.parse(args) as UnknownRecord
            } catch {
              parsed = {}
            }
          } else if (args && typeof args === 'object') {
            parsed = args
          }
          content.push({
            type: 'tool_use',
            id: toolCall.id ?? `call_${Date.now()}`,
            name: toolCall.function.name ?? '',
            input: parsed,
          })
        }
      }
    }

    // 处理工具结果
    if (msg.role === 'tool' && msg.tool_call_id) {
      messages.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: msg.tool_call_id,
          content: typeof msg.content === 'string' ? msg.content : '',
        }]
      })
      continue
    }

    if (content.length > 0) {
      const first = content[0]
      messages.push({
        role,
        content:
          content.length === 1 && first?.type === 'text'
            ? first.text
            : content,
      })
    }
  }

  const result: TransformResult = { messages }
  if (system) result.system = system
  if (data.max_completion_tokens) result.maxTokens = data.max_completion_tokens
  if (data.temperature !== undefined) result.temperature = data.temperature
  if (data.tools) result.tools = transformOpenAITools(data.tools)

  return result
}

function transformOpenAITools(tools: UnknownRecord[]): Anthropic.Tool[] {
  return tools.map((tool) => {
    const fn = (tool.function ?? {}) as {
      name?: string
      description?: string
      parameters?: UnknownRecord
    }
    return {
      name: fn.name ?? '',
      description: fn.description || '',
      input_schema:
        (fn.parameters as Anthropic.Tool['input_schema']) ??
        ({ type: 'object', properties: {} } as Anthropic.Tool['input_schema']),
    }
  })
}

// ========== OpenAI2 (Responses API) 转 Claude ==========

function transformOpenAI2ToClaude(data: OpenAI2RequestLike): TransformResult {
  const messages: Anthropic.MessageParam[] = []
  const system = data.instructions

  // 转换 input 消息
  if (Array.isArray(data.input)) {
    let pendingToolUses: Anthropic.ToolUseBlockParam[] = []
    let pendingToolResults: Anthropic.ToolResultBlockParam[] = []

    for (const item of data.input) {
      if (item.type === 'message') {
        // 先刷新待处理的工具调用和结果
        if (pendingToolUses.length > 0) {
          messages.push({ role: 'assistant', content: pendingToolUses })
          pendingToolUses = []
        }
        if (pendingToolResults.length > 0) {
          messages.push({ role: 'user', content: pendingToolResults })
          pendingToolResults = []
        }

        const role: 'user' | 'assistant' =
          item.role === 'assistant' ? 'assistant' : 'user'
        const content: Anthropic.ContentBlockParam[] = []

        if (Array.isArray(item.content)) {
          for (const block of item.content) {
            const type = block?.type
            if ((type === 'input_text' || type === 'output_text') && typeof block.text === 'string') {
              content.push({ type: 'text', text: block.text })
            }
          }
        }

        if (content.length > 0) {
          const first = content[0]
          messages.push({
            role,
            content: content.length === 1 && first?.type === 'text' ? first.text : content,
          })
        }
      } else if (item.type === 'tool_use') {
        console.log(
          `[API Transformer] 转换工具调用: name=${item.name}, call_id=${item.call_id}, input=`,
          item.input,
        )
        pendingToolUses.push({
          type: 'tool_use',
          id: item.call_id || `call_${Date.now()}`,
          name: item.name ?? '',
          input: item.input ?? {},
        })
      } else if (item.type === 'tool_result') {
        pendingToolResults.push({
          type: 'tool_result',
          tool_use_id: item.call_id || `call_${Date.now()}`,
          content: typeof item.output === 'string' ? item.output : '',
        })
      }
    }

    // 刷新剩余的工具调用和结果
    if (pendingToolUses.length > 0) {
      messages.push({ role: 'assistant', content: pendingToolUses })
    }
    if (pendingToolResults.length > 0) {
      messages.push({ role: 'user', content: pendingToolResults })
    }
  }

  const result: TransformResult = { messages }
  if (system) result.system = system
  if (data.max_output_tokens) result.maxTokens = data.max_output_tokens
  if (data.temperature !== undefined) result.temperature = data.temperature
  if (data.tools) result.tools = transformOpenAI2Tools(data.tools)

  return result
}

function transformOpenAI2Tools(tools: UnknownRecord[]): Anthropic.Tool[] {
  return tools.map((tool) => {
    const t = tool as { name?: string; description?: string; parameters?: UnknownRecord }
    return {
      name: t.name ?? '',
      description: t.description || '',
      input_schema:
        (t.parameters as Anthropic.Tool['input_schema']) ??
        ({ type: 'object', properties: {} } as Anthropic.Tool['input_schema']),
    }
  })
}

// ========== Gemini 转 Claude ==========

function transformGeminiToClaude(data: GeminiRequestLike): TransformResult {
  const messages: Anthropic.MessageParam[] = []
  let system: string | undefined

  // 提取 system instruction
  if (data.systemInstruction?.parts) {
    const systemParts = data.systemInstruction.parts
      .filter((p) => typeof p.text === 'string')
      .map((p) => p.text as string)
    if (systemParts.length > 0) {
      system = systemParts.join('\n')
    }
  }

  // 转换 contents
  if (Array.isArray(data.contents)) {
    for (const content of data.contents) {
      const role: 'user' | 'assistant' = content.role === 'model' ? 'assistant' : 'user'
      const blocks: Anthropic.ContentBlockParam[] = []

      if (Array.isArray(content.parts)) {
        for (const part of content.parts) {
          if (typeof part.text === 'string') {
            blocks.push({ type: 'text', text: part.text })
          }
          if (typeof part.thought === 'string') {
            // The SDK's public `ContentBlockParam` union doesn't include
            // `thinking` in older typings; assert through the union to
            // keep the field (consumers of the result know how to handle).
            blocks.push({
              type: 'thinking',
              thinking: part.thought,
            } as unknown as Anthropic.ContentBlockParam)
          }
          if (part.functionCall) {
            const fc = part.functionCall
            const sigFromPart =
              typeof part.thoughtSignature === 'string'
                ? part.thoughtSignature
                : typeof part.thought_signature === 'string'
                  ? part.thought_signature
                  : undefined
            const sigFromFc =
              typeof fc.thoughtSignature === 'string'
                ? fc.thoughtSignature
                : typeof fc.thought_signature === 'string'
                  ? fc.thought_signature
                  : undefined
            const thoughtSignature = sigFromPart ?? sigFromFc
            blocks.push({
              type: 'tool_use',
              id: `call_${fc.name ?? ''}`,
              name: fc.name ?? '',
              input: fc.args ?? {},
              ...(typeof thoughtSignature === 'string' ? { thoughtSignature } : {}),
            })
          }
          if (part.functionResponse) {
            const result = part.functionResponse.response?.result
            blocks.push({
              type: 'tool_result',
              tool_use_id: `call_${part.functionResponse.name ?? ''}`,
              content: typeof result === 'string' ? result : '',
            })
          }
          if (part.inlineData && typeof part.inlineData.data === 'string') {
            blocks.push({
              type: 'image',
              source: {
                type: 'base64',
                media_type: asImageMediaType(part.inlineData.mimeType ?? 'image/jpeg'),
                data: part.inlineData.data,
              },
            })
          }
        }
      }

      if (blocks.length > 0) {
        const first = blocks[0]
        messages.push({
          role,
          content:
            blocks.length === 1 && first?.type === 'text' ? first.text : blocks,
        })
      }
    }
  }

  const result: TransformResult = { messages }
  if (system) result.system = system
  if (data.generationConfig?.maxOutputTokens) {
    result.maxTokens = data.generationConfig.maxOutputTokens
  }
  if (data.generationConfig?.temperature !== undefined) {
    result.temperature = data.generationConfig.temperature
  }
  if (data.tools?.[0]?.functionDeclarations) {
    result.tools = transformGeminiTools(data.tools[0].functionDeclarations)
  }

  return result
}

function transformGeminiTools(funcDecls: UnknownRecord[]): Anthropic.Tool[] {
  return funcDecls.map((decl) => {
    const d = decl as { name?: string; description?: string; parameters?: UnknownRecord }
    return {
      name: d.name ?? '',
      description: d.description || '',
      input_schema:
        (d.parameters as Anthropic.Tool['input_schema']) ??
        ({ type: 'object', properties: {} } as Anthropic.Tool['input_schema']),
    }
  })
}

// ========== 主转换函数 ==========

/**
 * 自动检测并转换 API 请求为 Claude 格式
 */
export function transformToClaudeFormat(data: unknown): {
  result: TransformResult
  detection: DetectionResult
} {
  const detection = detectAPIFormat(data)
  const d = (data ?? {}) as UnknownRecord

  let result: TransformResult

  switch (detection.format) {
    case 'openai':
      result = transformOpenAIToClaude(d as OpenAIRequestLike)
      break
    case 'openai2':
      result = transformOpenAI2ToClaude(d as OpenAI2RequestLike)
      break
    case 'gemini':
      result = transformGeminiToClaude(d as GeminiRequestLike)
      break
    case 'claude':
      // 已经是 Claude 格式，直接使用
      result = {
        messages: (d.messages as Anthropic.MessageParam[] | undefined) ?? [],
        system: d.system as TransformResult['system'],
        tools: d.tools as Anthropic.Tool[] | undefined,
        maxTokens: typeof d.max_tokens === 'number' ? d.max_tokens : undefined,
        temperature: typeof d.temperature === 'number' ? d.temperature : undefined,
      }
      break
    default:
      throw new Error(`无法识别的 API 格式: ${detection.reason}`)
  }

  return { result, detection }
}

/**
 * 检查 baseUrl 是否为兼容格式的端点
 * 任何非空的自定义 baseUrl 都被认为是兼容端点
 */
export function isCompatibleEndpoint(baseUrl: string): boolean {
  if (!baseUrl || !baseUrl.trim()) return false

  // 排除官方 Anthropic 端点
  const url = baseUrl.toLowerCase()
  if (url.includes('api.anthropic.com')) return false

  // 任何其他 baseUrl 都被认为是兼容端点
  return true
}
