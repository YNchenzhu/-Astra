/**
 * §3.1 — Optional Anthropic `messages.countTokens` prefetch for ContextManager thresholds.
 * Enable with `POLE_ANTHROPIC_COUNT_TOKENS=1` (1P Anthropic provider only).
 */

import { countAnthropicWireInputTokens } from '../ai/anthropicCountInputTokens'
import type { ToolDefinition } from '../tools/types'
import type { SystemPromptLayers } from '../ai/systemPrompt'

export function isAnthropicApiCountTokensEnabled(): boolean {
  return process.env.POLE_ANTHROPIC_COUNT_TOKENS === '1'
}

export type PrefetchAnthropicInputTokensParams = {
  providerId: string
  apiKey: string
  baseUrl?: string
  model: string
  messages: Array<Record<string, unknown>>
  systemPrompt: string
  systemPromptLayers?: SystemPromptLayers
  tools?: ToolDefinition[]
  signal?: AbortSignal
}

/** Resolves total input tokens via Anthropic count API when enabled and applicable; otherwise `undefined`. */
export async function tryPrefetchAnthropicInputTokens(
  params: PrefetchAnthropicInputTokensParams,
): Promise<number | undefined> {
  if (!isAnthropicApiCountTokensEnabled()) return undefined
  if (params.providerId !== 'anthropic') return undefined
  const n = await countAnthropicWireInputTokens({
    apiKey: params.apiKey,
    baseUrl: params.baseUrl,
    model: params.model,
    messages: params.messages,
    systemPrompt: params.systemPrompt,
    systemPromptLayers: params.systemPromptLayers,
    tools: params.tools,
    signal: params.signal,
  })
  return n ?? undefined
}
