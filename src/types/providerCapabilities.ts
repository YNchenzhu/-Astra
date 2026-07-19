export type AnthropicThinkingCapability = 'auto' | 'supported' | 'unsupported'

export function normalizeAnthropicThinkingCapability(
  value: unknown,
): AnthropicThinkingCapability {
  return value === 'supported' || value === 'unsupported' ? value : 'auto'
}
