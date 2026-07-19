/**
 * Strict function calling (OpenAI-style `function.strict` + constrained JSON Schema)
 * vs Anthropic-style tool `input_schema` (no equivalent `strict` flag in our Anthropic SDK usage).
 *
 * Used to gate {@link StreamTextParams.openAiStrictToolNames} and to document provider behavior.
 */

import type { ProviderId } from './client'

/** How much the stack can rely on provider-enforced tool argument shape. */
export type StrictToolCallingLevel =
  /** OpenAI Chat Completions: we can send per-tool `strict: true` (model + account must support it). */
  | 'openai_chat_native'
  /** Third-party or translated formats: may ignore or reject `strict`; do not enable by default. */
  | 'unknown_or_gateway'
  /** Anthropic Messages, Gemini native, etc.: no OpenAI `strict` in our integration. */
  | 'not_applicable'

export type StrictToolCallingInfo = {
  level: StrictToolCallingLevel
  /** Short rationale for logs / settings tooltips. */
  notes: string
}

/**
 * Per-provider strict tool calling support (OpenAI structured outputs style).
 *
 * Counterpoint: labeling a provider `not_applicable` only reflects **our** wire format (Anthropic tools
 * have no `strict` bit); upstream could still loosely follow JSON Schema — that is not provider-guaranteed.
 */
export const STRICT_TOOL_CALLING_BY_PROVIDER: Record<ProviderId, StrictToolCallingInfo> = {
  openai: {
    level: 'openai_chat_native',
    notes:
      'Native OpenAI SDK chat.completions: per-function `strict` is supported when the model/API allows structured function calling.',
  },
  openai2: {
    level: 'unknown_or_gateway',
    notes:
      'Responses API / mixed gateways: tool `strict` may or may not be honored; routed via compatible client when used.',
  },
  compatible: {
    level: 'unknown_or_gateway',
    notes:
      'User-defined OpenAI/Anthropic/Gemini compatible endpoints: do not assume `strict` is accepted.',
  },
  anthropic: {
    level: 'not_applicable',
    notes: 'Anthropic Messages tools use `input_schema` only; we do not send OpenAI `strict`.',
  },
  bedrock: {
    level: 'not_applicable',
    notes: 'Bedrock uses Anthropic Messages tool schema — no OpenAI `strict` flag.',
  },
  vertex: {
    level: 'not_applicable',
    notes: 'Vertex Anthropic uses Messages tool schema — no OpenAI `strict` flag.',
  },
  foundry: {
    level: 'not_applicable',
    notes: 'Azure Foundry Anthropic uses Messages tool schema — no OpenAI `strict` flag.',
  },
  gemini: {
    level: 'not_applicable',
    notes: 'Gemini uses function declarations; we do not set OpenAI-style `strict` on native Gemini path.',
  },
  dashscope: {
    level: 'not_applicable',
    notes: 'DashScope is called through Anthropic-compatible Messages — no OpenAI `strict`.',
  },
  minimax: {
    level: 'not_applicable',
    notes: 'MiniMax Anthropic-compatible API — no OpenAI `strict`.',
  },
  zhipu: {
    level: 'not_applicable',
    notes: '智谱 Anthropic-compatible API — no OpenAI `strict`.',
  },
  kimi: {
    level: 'not_applicable',
    notes: 'Kimi Anthropic-compatible API — no OpenAI `strict`.',
  },
  deepseek: {
    level: 'not_applicable',
    notes: 'DeepSeek Anthropic-compatible API — no OpenAI `strict`.',
  },
}

export function getStrictToolCallingInfo(providerId: ProviderId): StrictToolCallingInfo {
  return STRICT_TOOL_CALLING_BY_PROVIDER[providerId]
}

/** Whether we may attach OpenAI Chat `function.strict` for selected tools (native OpenAI path only). */
export function providerAllowsOpenAiNativeStrictTools(providerId: ProviderId): boolean {
  return STRICT_TOOL_CALLING_BY_PROVIDER[providerId].level === 'openai_chat_native'
}
