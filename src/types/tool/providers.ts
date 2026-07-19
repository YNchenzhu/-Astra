// ============================================================================
// Provider / model option types
// ============================================================================

export type ProviderId =
  | 'anthropic'
  | 'openai'
  | 'openai2'
  | 'gemini'
  | 'bedrock'
  | 'vertex'
  | 'foundry'
  | 'compatible'
  | 'dashscope'
  | 'minimax'
  | 'zhipu'
  | 'kimi'
  | 'deepseek'

export interface ProviderOption {
  id: ProviderId
  name: string
}

export interface ModelOption {
  id: string
  name: string
  providerId: ProviderId
}
