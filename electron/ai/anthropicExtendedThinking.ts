/**
 * upstream 上下文报告 §10.1 — Anthropic Messages `thinking` 请求体（扩展/自适应推理）。
 * 与设置「深度思考」传入的 {@link StreamTextParams.alwaysThinking} 对齐；仅在本模块判定模型可能支持时下发。
 *
 * 可选 beta：`POLE_ANTHROPIC_THINKING_BETA`（逗号分隔，与 `messages.stream` 的 `anthropic-beta` 合并）。
 */

export type AnthropicThinkingStreamParam =
  | { type: 'enabled'; budget_tokens: number }
  | { type: 'adaptive' }

function parseCommaTokens(raw: string | undefined): string[] {
  if (!raw?.trim()) return []
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/** 与 `thinking` 同请求发送的额外 beta token（若 API 要求）。 */
export function anthropicThinkingRequestBetaTokens(active: boolean): string[] {
  if (!active) return []
  return parseCommaTokens(process.env.POLE_ANTHROPIC_THINKING_BETA)
}

/**
 * 直连 / Bedrock / Vertex 等模型 id 启发式（含 `us.anthropic.claude-*`）。
 *
 * 第三方 Anthropic-compat 网关（DeepSeek / Zhipu / Kimi / DashScope / MiniMax）
 * 的 thinking 支持现在由 {@link ProviderQuirks.supportsThinkingBlocks} 统一控制，
 * 调用方通过 `providerSupportsThinking: true` 直接跳过本启发式，因此这里
 * 不再硬编码任何第三方模型名。
 */
export function anthropicExtendedThinkingLikelySupported(model: string): boolean {
  const m = model.toLowerCase()
  if (m.includes('claude-3-7') || m.includes('claude-3.7') || m.includes('3-7-sonnet')) return true
  if (m.includes('claude-opus-4') || m.includes('claude-sonnet-4') || m.includes('claude-haiku-4'))
    return true
  if (m.includes('anthropic.claude-opus-4') || m.includes('anthropic.claude-sonnet-4')) return true
  if (m.includes('anthropic.claude-haiku-4')) return true
  // Third-party Anthropic-compat gateways with confirmed thinking support.
  // DeepSeek v4 / reasoner models accept `thinking` blocks (budget_tokens
  // is ignored server-side but does not error).  ProviderQuirks provides
  // the authoritative per-gateway flag; this heuristic catches the model
  // name when `buildAnthropicThinkingForStreamRequest` is called without
  // an explicit `providerSupportsThinking` gate.
  if (m.startsWith('deepseek-') && (m.includes('v4') || m.includes('reasoner'))) return true
  return false
}

/** §10.1 — 与报告一致：部分新模型走 `adaptive`。 */
export function anthropicAdaptiveThinkingLikelySupported(model: string): boolean {
  const m = model.toLowerCase()
  if (m.includes('haiku')) return false
  return m.includes('sonnet-4-5') || m.includes('sonnet-4.5') || m.includes('4-5-20250929')
}

function maxThinkingBudgetCapForModel(model: string): number {
  const m = model.toLowerCase()
  if (m.includes('haiku')) return 4096
  if (m.includes('opus')) return 16_384
  return 8192
}

const MIN_THINKING_BUDGET = 1024

/**
 * 返回供 `client.messages.stream` 使用的 `thinking` 字段；不适用时返回 `null`。
 *
 * @param options.providerSupportsThinking — 当调用方已通过 {@link ProviderQuirks}
 *   确认 provider 支持 thinking 时传入 `true`，可跳过本模块内的模型名启发式检查。
 *   这消除了对第三方网关（如 DeepSeek）的硬编码模型名匹配。
 */
export function buildAnthropicThinkingForStreamRequest(options: {
  model: string
  maxOutputTokens: number
  alwaysThinking?: boolean
  /** 当调用方已通过 quirks 确认支持时，跳过模型名启发式。 */
  providerSupportsThinking?: boolean
}): AnthropicThinkingStreamParam | null {
  if (!options.alwaysThinking) return null
  const explicitlySupported = options.providerSupportsThinking === true
  if (!explicitlySupported && !anthropicExtendedThinkingLikelySupported(options.model)) return null

  const maxOut = options.maxOutputTokens
  if (!Number.isFinite(maxOut) || maxOut <= MIN_THINKING_BUDGET) return null

  if (anthropicAdaptiveThinkingLikelySupported(options.model)) {
    return { type: 'adaptive' }
  }

  const modelCap = maxThinkingBudgetCapForModel(options.model)
  const budget = Math.min(modelCap, maxOut - 1)
  if (budget < MIN_THINKING_BUDGET) return null
  return { type: 'enabled', budget_tokens: budget }
}
