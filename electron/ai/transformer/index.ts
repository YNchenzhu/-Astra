/**
 * 主转换器 - 自动检测格式并执行转换
 */

import type { TransformContext, ClaudeRequest, ClaudeResponse } from './types'
import { claudeToOpenAIChat, openAIChatToClaude, openAIChatStreamToClaude } from './claudeToOpenAI'
import { claudeToOpenAI2, openAI2ToClaude, openAI2StreamToClaude } from './claudeToOpenAI2'
import { claudeToGemini, geminiToClaude, geminiStreamToClaude } from './claudeToGemini'

export type APIFormat = 'claude' | 'openai' | 'openai2' | 'gemini'

/**
 * 检测 API 响应格式
 */
export function detectResponseFormat(response: unknown): APIFormat {
  if (!response || typeof response !== 'object') {
    return 'claude'
  }
  const r = response as Record<string, unknown>

  // Claude 格式检测
  if (r.type === 'message' && r.role === 'assistant' && Array.isArray(r.content)) {
    return 'claude'
  }

  // OpenAI Chat 格式检测
  if (r.object === 'chat.completion' && Array.isArray(r.choices)) {
    return 'openai'
  }

  // OpenAI2 格式检测
  if (r.type === 'message' && Array.isArray(r.output)) {
    return 'openai2'
  }

  // Gemini 格式检测
  if (Array.isArray(r.candidates)) {
    return 'gemini'
  }

  return 'claude'
}

/**
 * 检测流式事件格式
 *
 * 参考 ccNexus 各格式的流式事件特征：
 * - OpenAI Chat: object === 'chat.completion.chunk'
 * - OpenAI2 Responses API: type 以 'response.' 开头（response.created / response.output_text.delta / ...）
 * - Gemini: 有 candidates 数组
 * - Claude: type 为 message_start / content_block_delta / ...
 */
export function detectStreamFormat(event: unknown): APIFormat {
  if (!event || typeof event !== 'object') {
    return 'claude'
  }
  const e = event as Record<string, unknown>

  // OpenAI Chat 流式格式
  if (e.object === 'chat.completion.chunk') {
    return 'openai'
  }

  // OpenAI2 Responses API 流式格式
  if (typeof e.type === 'string' && e.type.startsWith('response.')) {
    return 'openai2'
  }

  // Gemini 流式格式
  if (Array.isArray(e.candidates)) {
    return 'gemini'
  }

  // Claude 流式格式（默认）
  return 'claude'
}

/**
 * 转换请求为目标格式
 *
 * Return is intentionally `unknown`: each target format produces a
 * differently-shaped `Record<string, unknown>` (OpenAIChatRequest /
 * OpenAI2Request / GeminiRequest / ClaudeRequest). Callers that need
 * concrete shape should call the dedicated `claudeToOpenAIChat` etc.
 * functions directly instead of this dispatcher.
 */
export function transformRequest(
  claudeRequest: ClaudeRequest,
  targetFormat: APIFormat,
  ctx: TransformContext
): unknown {
  switch (targetFormat) {
    case 'openai':
      return claudeToOpenAIChat(claudeRequest, ctx)
    case 'openai2':
      return claudeToOpenAI2(claudeRequest, ctx)
    case 'gemini':
      return claudeToGemini(claudeRequest, ctx)
    case 'claude':
    default:
      return claudeRequest
  }
}

/**
 * 转换响应为 Claude 格式
 */
export function transformResponse(
  response: unknown,
  sourceFormat: APIFormat,
  ctx: TransformContext
): ClaudeResponse | unknown {
  switch (sourceFormat) {
    case 'openai':
      return openAIChatToClaude(response as Record<string, unknown>, ctx)
    case 'openai2':
      return openAI2ToClaude(response as Record<string, unknown>, ctx)
    case 'gemini':
      return geminiToClaude(response as Record<string, unknown>, ctx)
    case 'claude':
    default:
      return response
  }
}

/**
 * 转换流式事件为 Claude 格式
 *
 * Returned value is either a Claude-shaped stream event record, an array
 * thereof (OpenAI/Gemini streams can fan out one upstream event into
 * multiple Claude deltas), `null` when the upstream event is a no-op, or
 * the pass-through source event when `sourceFormat === 'claude'`.
 */
export function transformStreamEvent(
  event: unknown,
  sourceFormat: APIFormat,
  ctx: TransformContext
): Record<string, unknown> | Record<string, unknown>[] | null | unknown {
  switch (sourceFormat) {
    case 'openai':
      return openAIChatStreamToClaude(event as Record<string, unknown>, ctx)
    case 'openai2':
      return openAI2StreamToClaude(event as Record<string, unknown>, ctx)
    case 'gemini':
      return geminiStreamToClaude(event as Record<string, unknown>, ctx)
    case 'claude':
    default:
      return event
  }
}

/**
 * 创建转换上下文
 */
export function createTransformContext(): TransformContext {
  return {
    toolUseIDToName: new Map(),
    pendingToolCallsByName: new Map(),
    toolCallOrdinal: 0,
    inThinkingTag: false,
    thinkingBuffer: '',
    estimatedInputTokens: 0,
    estimatedOutputTokens: 0,
  }
}

export {
  enqueuePendingToolCall,
  dequeuePendingToolCallByName,
  peekPendingToolCallByName,
} from './toolCallQueue'

/**
 * 估算 Token 数量（Fallback 机制）
 */
export function estimateTokens(
  requestBody: string,
  outputText: string,
  inputTokens: number,
  outputTokens: number
): { inputTokens: number; outputTokens: number } {
  // 如果已有 Token 数据，直接返回
  if (inputTokens > 0 && outputTokens > 0) {
    return { inputTokens, outputTokens }
  }

  // 简单估算：1 token ≈ 4 个字符
  const estimatedInput = inputTokens || Math.ceil(requestBody.length / 4)
  const estimatedOutput = outputTokens || Math.ceil(outputText.length / 4)

  return {
    inputTokens: estimatedInput,
    outputTokens: estimatedOutput,
  }
}

/**
 * 处理思考块标签（用于流式响应）
 */
export function processThinkingTags(
  content: string,
  _ctx: TransformContext
): { thinking: string[]; text: string } {
  const thinkingBlocks: string[] = []
  let textContent = content

  // 查找所有 <think>...</think> 标签
  const thinkRegex = /<think>([\s\S]*?)<\/think>/g
  let match

  while ((match = thinkRegex.exec(content)) !== null) {
    thinkingBlocks.push(match[1])
  }

  // 移除思考块标签
  textContent = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim()

  return {
    thinking: thinkingBlocks,
    text: textContent,
  }
}

/**
 * 导出所有转换函数供外部使用
 */
export {
  claudeToOpenAIChat,
  openAIChatToClaude,
  openAIChatStreamToClaude,
  claudeToOpenAI2,
  openAI2ToClaude,
  openAI2StreamToClaude,
  claudeToGemini,
  geminiToClaude,
  geminiStreamToClaude,
}
