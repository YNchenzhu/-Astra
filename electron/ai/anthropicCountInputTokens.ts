/**
 * upstream §3.1 — Anthropic Messages `countTokens` (1P API only).
 * Bedrock/Vertex SDK 在本仓库中未暴露等价 countTokens，故仅 `providerId === 'anthropic'` 时调用。
 */

import Anthropic from '@anthropic-ai/sdk'
import type { MessageParam, Tool } from '@anthropic-ai/sdk/resources/messages/messages'
import { normalizeAnthropicCompatBaseUrl } from './client'
import { buildAnthropicSystemParam } from './anthropicSystemWire'
import type { SystemPromptLayers } from './systemPrompt'
import type { ToolDefinition } from '../tools/types'
import { stripPoleContextUsageFromApiMessages } from '../context/tokenUsageAccounting'

function mapToolsForCount(tools: ToolDefinition[] | undefined): Tool[] | undefined {
  if (!tools?.length) return undefined
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: (t.input_schema ?? { type: 'object', properties: {} }) as Tool['input_schema'],
  }))
}

export type CountAnthropicInputTokensParams = {
  apiKey: string
  baseUrl?: string
  model: string
  messages: Array<Record<string, unknown>>
  systemPrompt: string
  systemPromptLayers?: SystemPromptLayers
  tools?: ToolDefinition[]
  signal?: AbortSignal
}

/**
 * Returns server-reported input token count for messages + system + tools, or `null` on failure.
 */
export async function countAnthropicWireInputTokens(
  params: CountAnthropicInputTokensParams,
): Promise<number | null> {
  const key = (params.apiKey || '').trim()
  if (!key) return null
  const model = (params.model || '').trim()
  if (!model) return null

  const stripped = stripPoleContextUsageFromApiMessages(params.messages) ?? []
  const messages = stripped as unknown as MessageParam[]
  const systemWire = buildAnthropicSystemParam(params.systemPrompt, params.systemPromptLayers)
  const mappedTools = mapToolsForCount(params.tools)

  const baseUrl = params.baseUrl?.trim()
    ? normalizeAnthropicCompatBaseUrl(params.baseUrl.trim(), 'https://api.anthropic.com')
    : undefined

  const isThirdPartyBaseUrl =
    baseUrl && !baseUrl.toLowerCase().includes('api.anthropic.com')
  const client = new Anthropic({
    apiKey: key,
    ...(isThirdPartyBaseUrl ? { authToken: key } : {}),
    ...(baseUrl ? { baseURL: baseUrl } : {}),
  })

  try {
    const body = {
      model,
      messages,
      ...(systemWire !== undefined && systemWire !== '' ? { system: systemWire } : {}),
      ...(mappedTools && mappedTools.length > 0 ? { tools: mappedTools } : {}),
    } satisfies Anthropic.MessageCountTokensParams
    const res = await client.messages.countTokens(body, {
      signal: params.signal,
    })
    const n = res.input_tokens
    if (typeof n === 'number' && Number.isFinite(n) && n > 0) return n
    return null
  } catch (e) {
    console.warn('[anthropicCountInputTokens] countTokens failed:', e)
    return null
  }
}
