/**
 * upstream 上下文报告 §9.1 — exactly **one** message-level `cache_control` on the wire
 * (ephemeral breakpoint on a text block). Fork analogue: breakpoint on `messages[length-2]` when requested.
 *
 * Opt-in: `POLE_ANTHROPIC_MESSAGE_CACHE_CONTROL=1`.
 * Optional 1h TTL (§9.2): `POLE_ANTHROPIC_PROMPT_CACHE_TTL_1H=1`, or on **Bedrock** only
 * `ENABLE_PROMPT_CACHING_1H_BEDROCK=1` (报告 3P 别名；须在 `apply…` 的 `providerId: 'bedrock'` 时传入)。
 */

import type Anthropic from '@anthropic-ai/sdk'

function cloneMessagesDeep(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  try {
    if (typeof structuredClone === 'function') {
      return structuredClone(messages)
    }
  } catch {
    /* ignore */
  }
  return JSON.parse(JSON.stringify(messages)) as Anthropic.MessageParam[]
}

/** Remove every `cache_control` from message content blocks (idempotent for §9.1 single-marker invariant). */
export function stripMessageContentCacheControls(messages: Anthropic.MessageParam[]): void {
  for (const m of messages) {
    const c = m.content
    if (!Array.isArray(c)) continue
    for (const b of c) {
      if (b && typeof b === 'object' && 'cache_control' in b) {
        delete (b as unknown as Record<string, unknown>).cache_control
      }
    }
  }
}

/** §9.2 — 全局 1h 开关，或 Bedrock 专用别名（与 upstream 报告一致）。 */
export function shouldUseAnthropicMessagePromptCacheTtl1h(providerId?: string): boolean {
  if (process.env.POLE_ANTHROPIC_PROMPT_CACHE_TTL_1H === '1') return true
  const pid = providerId?.trim()
  if (pid === 'bedrock' && process.env.ENABLE_PROMPT_CACHING_1H_BEDROCK === '1') return true
  return false
}

function buildEphemeralCacheControl(use1hTtl: boolean): { type: 'ephemeral'; ttl?: '1h' } {
  const base = { type: 'ephemeral' as const }
  if (use1hTtl) {
    return { ...base, ttl: '1h' as const }
  }
  return base
}

function attachSingleBreakpointToMessage(
  messages: Anthropic.MessageParam[],
  index: number,
  use1hTtl: boolean,
): void {
  const msg = messages[index]
  if (!msg) return
  const cc = buildEphemeralCacheControl(use1hTtl)

  if (typeof msg.content === 'string') {
    ;(msg as { content: unknown }).content = [
      { type: 'text' as const, text: msg.content, cache_control: cc },
    ]
    return
  }

  if (Array.isArray(msg.content)) {
    const blocks = msg.content as unknown as Array<Record<string, unknown>>
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i]
      if (b && b.type === 'text' && typeof b.text === 'string') {
        blocks[i] = { ...b, cache_control: cc }
        return
      }
    }
    blocks.unshift({ type: 'text', text: ' ', cache_control: cc })
  }
}

export type AnthropicMessagePromptCacheOptions = {
  /** §9.1 fork-style: use `messages[length-2]` when true and length >= 2 */
  secondToLastBreakpoint?: boolean
  /**
   * §9.2 — 用于解析 Bedrock 1h TTL 别名 `ENABLE_PROMPT_CACHING_1H_BEDROCK`（仅 `bedrock` 时生效）。
   * 不传则仅 `POLE_ANTHROPIC_PROMPT_CACHE_TTL_1H` 可打开 1h。
   */
  providerId?: string
}

/**
 * Returns a **deep-cloned** message array with all prior message `cache_control` stripped and
 * exactly one `cache_control` placed on the last text block of the chosen message.
 */
export function applyAnthropicSingleMessagePromptCache(
  messages: Anthropic.MessageParam[],
  options: AnthropicMessagePromptCacheOptions,
): Anthropic.MessageParam[] {
  if (!messages.length) return messages
  const out = cloneMessagesDeep(messages)
  stripMessageContentCacheControls(out)
  const idx =
    options.secondToLastBreakpoint === true && out.length >= 2
      ? out.length - 2
      : out.length - 1
  const use1hTtl = shouldUseAnthropicMessagePromptCacheTtl1h(options.providerId)
  attachSingleBreakpointToMessage(out, idx, use1hTtl)
  return out
}

/** True when layered `system` already carries an ephemeral cache breakpoint (§7.2 vs §9.1 exclusivity). */
export function anthropicSystemWireUsesMessageLevelStyleCache(systemWire: unknown): boolean {
  if (!Array.isArray(systemWire)) return false
  return systemWire.some((b) => {
    if (!b || typeof b !== 'object') return false
    const cc = (b as { cache_control?: { type?: string } }).cache_control
    return cc?.type === 'ephemeral'
  })
}
