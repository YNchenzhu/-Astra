/**
 * upstream 报告 §3.3 / §3.4 / §2.3：用量拆解、锚点估算、窗口占比。
 * §3.1：可选 Anthropic 1P `messages.countTokens`（`POLE_ANTHROPIC_COUNT_TOKENS=1`）经
 * {@link tryPrefetchAnthropicInputTokens} → {@link ContextManager.setPrefetchedInputTokensForNextEvaluate}；
 * 其余路径仍以锚点 + 粗糙估算为主。
 */

import { estimateMessagesOnlyTokens } from './tokenCounter'
import { getModelContextWindowTokens } from './openClaudeParityConstants'

const USAGE_KEY = '_poleContextUsage' as const

/** §16.2 — stripped alongside usage anchors before provider requests. */
export const POLE_QUERY_TRACKING_KEY = '_poleQueryTracking' as const

const INTERNAL_MESSAGE_STRIP_KEYS = [USAGE_KEY, POLE_QUERY_TRACKING_KEY] as const

function num(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v
  return 0
}

/**
 * §3.4 — 完整上下文用量（input + 写入缓存 + 读缓存），用于阈值与 upstream 式锚点。
 */
export function getTokenCountFromUsage(usage: Record<string, unknown>): number {
  return (
    num(usage.input_tokens) +
    num(usage.cache_creation_input_tokens) +
    num(usage.cache_read_input_tokens)
  )
}

/**
 * §3.4 — 服务端“剩余预算”类倒计时：不含 cache 读/写计费项，仅常规 input + output。
 */
export function finalContextTokensFromLastResponse(usage: Record<string, unknown>): number {
  return num(usage.input_tokens) + num(usage.output_tokens)
}

/**
 * §3.4 — 仅 output；文档注明不应用于阈值比较。
 */
export function messageTokenCountFromLastApiResponse(usage: Record<string, unknown>): number {
  return num(usage.output_tokens)
}

/**
 * §2.3 — totalInputTokens / contextWindowSize * 100
 */
export function contextUsagePercentOfWindow(
  totalInputTokens: number,
  contextWindowTokens: number,
): number {
  if (!Number.isFinite(totalInputTokens) || totalInputTokens <= 0) return 0
  if (!Number.isFinite(contextWindowTokens) || contextWindowTokens <= 0) return 0
  return Math.min(100, (totalInputTokens / contextWindowTokens) * 100)
}

export function contextUsagePercentForModel(
  totalInputTokens: number,
  model: string,
): number {
  return contextUsagePercentOfWindow(totalInputTokens, getModelContextWindowTokens(model))
}

export type MessageUsageAnchor = { index: number; usage: Record<string, unknown> }

function roleOf(m: Record<string, unknown>): string | undefined {
  return typeof m.role === 'string' ? m.role : undefined
}

function assistantId(m: Record<string, unknown>): string | undefined {
  const id = m.id
  if (typeof id !== 'string') return undefined
  const t = id.trim()
  return t.length > 0 ? t : undefined
}

/**
 * 从后往前找带 `_poleContextUsage` 的锚点（内部字段，不会发往 API）。
 * §3.3 — 若存在同 `id` 的 assistant 续写块，忽略**较早**块上的用量，避免把已延续到后段的同轮回复当成独立锚点。
 */
export function findLastMessageUsageAnchor(
  messages: Array<Record<string, unknown>>,
): MessageUsageAnchor | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const u = messages[i][USAGE_KEY]
    if (!u || typeof u !== 'object') continue
    const usage = u as Record<string, unknown>
    if (getTokenCountFromUsage(usage) <= 0) continue

    const rid = roleOf(messages[i])
    const aid = rid === 'assistant' ? assistantId(messages[i]) : undefined
    if (aid) {
      let hasLaterSameId = false
      for (let k = i + 1; k < messages.length; k++) {
        if (roleOf(messages[k]) === 'assistant' && assistantId(messages[k]) === aid) {
          hasLaterSameId = true
          break
        }
      }
      if (hasLaterSameId) continue
    }
    return { index: i, usage }
  }
  return null
}

/**
 * §3.3 — `getTokenCountFromUsage(usage) + rough(messages.slice(i + 1))` + tool 定义侧估算（与 ContextManager 一致单独加 toolTokens）。
 */
export function tokenCountWithEstimationFromMessageAnchors(
  messages: Array<Record<string, unknown>>,
  toolTokens: number,
): number | null {
  const anchor = findLastMessageUsageAnchor(messages)
  if (!anchor) return null
  const tail = messages.slice(anchor.index + 1)
  return getTokenCountFromUsage(anchor.usage) + estimateMessagesOnlyTokens(tail) + toolTokens
}

export { USAGE_KEY as POLE_CONTEXT_USAGE_MESSAGE_KEY }

/** 与 {@link StreamMessageUsage} 对齐的流结束用量（避免 electron/ai ↔ context 循环依赖）。 */
export type PoleStreamUsageShape = {
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens?: number
  cacheReadInputTokens?: number
}

/**
 * 写入 assistant 消息用的 `_poleContextUsage` 对象（Anthropic usage 字段名）。
 */
export function buildPoleContextUsageSnapshot(usage: PoleStreamUsageShape): Record<string, unknown> {
  const o: Record<string, unknown> = {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
  }
  if (usage.cacheCreationInputTokens != null && usage.cacheCreationInputTokens > 0) {
    o.cache_creation_input_tokens = usage.cacheCreationInputTokens
  }
  if (usage.cacheReadInputTokens != null && usage.cacheReadInputTokens > 0) {
    o.cache_read_input_tokens = usage.cacheReadInputTokens
  }
  return o
}

/**
 * 发往各 provider 前从每条消息上移除内部字段（`_poleContextUsage`、`_poleQueryTracking` 等）。
 */
export function stripPoleContextUsageFromApiMessages(
  messages: Array<Record<string, unknown>> | undefined,
): Array<Record<string, unknown>> | undefined {
  if (!messages?.length) return messages
  return messages.map((m) => {
    let out: Record<string, unknown> = m
    for (const key of INTERNAL_MESSAGE_STRIP_KEYS) {
      if (key in out) {
        const { [key]: _drop, ...rest } = out
        out = rest
      }
    }
    return out
  })
}
