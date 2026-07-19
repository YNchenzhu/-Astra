/**
 * Rough token estimation without provider-specific APIs.
 * Matches upstream's approach:
 *   text: length / 4   (ASCII / latin)
 *   JSON: length / 2
 *   images: fixed 2,000
 *
 * CJK adjustment: the `length / 4` divisor encodes the empirical ASCII ratio
 * (~0.25 tokens per char). CJK scripts (Han / Hiragana / Katakana / Hangul /
 * fullwidth forms) tokenize far denser — cl100k / Claude BPE land around
 * 1–2 tokens per codepoint. Counting them at /4 under-estimates a Chinese /
 * Japanese / Korean conversation by ~4–8x, which makes every ContextManager
 * threshold fire far too late: the turn then dies with a raw provider
 * `context_length_exceeded` instead of compacting first. We split the count —
 * non-CJK chars keep the /4 divisor, CJK codepoints are counted at
 * {@link CJK_TOKENS_PER_CHAR} (default 1.0: 4x the old value, deliberately
 * below the worst-case real ratio so we never wildly over-count and trigger
 * premature compaction).
 */

import { BYTES_PER_TOKEN } from '../constants/toolLimits'

/**
 * Han ideographs + Japanese kana + Korean Hangul + CJK symbols/punctuation
 * + fullwidth/halfwidth forms. Matched per-codepoint with the `u` flag so
 * surrogate-paired ideographs (CJK Ext-B+) count once, not twice.
 */
const CJK_RE =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303F\uFF00-\uFFEF]/gu

/**
 * Tokens-per-CJK-codepoint weight. Tunable via `POLE_CJK_TOKENS_PER_CHAR`
 * for operators on tokenizers that differ from the cl100k/Claude norm.
 * Read once at module load (matches the rest of the codebase's env pattern).
 */
const CJK_TOKENS_PER_CHAR: number = (() => {
  const raw = process.env?.POLE_CJK_TOKENS_PER_CHAR
  const n = raw ? Number.parseFloat(raw) : NaN
  return Number.isFinite(n) && n > 0 ? n : 1.0
})()

export function estimateTextTokens(text: string): number {
  if (!text) return 0
  const cjkMatches = text.match(CJK_RE)
  const cjkCount = cjkMatches ? cjkMatches.length : 0
  if (cjkCount === 0) {
    return Math.ceil(text.length / BYTES_PER_TOKEN)
  }
  // `text.length` counts UTF-16 units; CJK Ext-B ideographs are surrogate
  // pairs (length 2) but match `CJK_RE` once. Use codepoint length so the
  // non-CJK remainder can't go negative on astral-plane-heavy input.
  const codepointLength = [...text].length
  const nonCjk = Math.max(0, codepointLength - cjkCount)
  return Math.ceil(nonCjk / BYTES_PER_TOKEN + cjkCount * CJK_TOKENS_PER_CHAR)
}

export function estimateJsonTokens(json: string): number {
  return Math.ceil(json.length / 2)
}

export function estimateContentBlockTokens(
  block: Record<string, unknown>,
): number {
  const type = block.type as string

  if (type === 'text') {
    return estimateTextTokens(String(block.text || ''))
  }
  if (type === 'image' || type === 'document') {
    return 2000
  }
  if (type === 'tool_use') {
    const name = String((block as { name?: string }).name || '')
    return estimateTextTokens(name) + estimateJsonTokens(JSON.stringify(block.input || {})) + 20
  }
  if (type === 'tool_result') {
    const content = block.content
    if (typeof content === 'string') {
      return estimateTextTokens(content)
    }
    if (Array.isArray(content)) {
      return content.reduce((sum: number, b: Record<string, unknown>) => {
        if (b.type === 'text') return sum + estimateTextTokens(String(b.text || ''))
        if (b.type === 'image' || b.type === 'document') return sum + 2000
        return sum
      }, 0)
    }
    return 0
  }
  if (type === 'thinking') {
    return estimateTextTokens(String(block.thinking || ''))
  }
  if (type === 'redacted_thinking') {
    const data = (block as { data?: string }).data
    return typeof data === 'string' ? estimateTextTokens(data) : 0
  }
  return 0
}

export function estimateMessageTokens(
  message: Record<string, unknown>,
): number {
  const content = message.content
  if (typeof content === 'string') {
    return estimateTextTokens(content)
  }
  if (Array.isArray(content)) {
    return (content as Record<string, unknown>[]).reduce(
      (sum, block) => sum + estimateContentBlockTokens(block),
      0,
    )
  }
  return 0
}

export function estimateConversationTokens(
  messages: Array<Record<string, unknown>>,
  systemPrompt?: string,
): number {
  let total = 0
  if (systemPrompt) {
    total += estimateTextTokens(systemPrompt)
  }
  for (const msg of messages) {
    total += estimateMessageTokens(msg)
  }
  return total
}

/**
 * Token estimate for a suffix of the transcript only (upstream anchored tail / §3.3).
 */
export function estimateMessagesOnlyTokens(messages: Array<Record<string, unknown>>): number {
  return estimateConversationTokens(messages, '')
}

export function estimateToolDefinitionsTokens(
  tools: Array<{
    name: string
    description: string
    input_schema: Record<string, unknown>
  }>,
): number {
  let total = 0
  for (const tool of tools) {
    // P2 audit fix: `tool.name` was previously excluded from the estimate,
    // which systematically under-counted tool-definition payloads. With
    // ~10–40 tools per request and names up to 30 chars (`mcp__server__tool`,
    // etc.), the omission added up to ~80–400 missed tokens per request and
    // caused compact decisions to fire slightly later than the real wire
    // payload warranted. We count names with the same char-heuristic as the
    // rest of the surface so the relative ordering stays consistent.
    total += estimateTextTokens(tool.name)
    total += estimateTextTokens(tool.description)
    total += estimateJsonTokens(JSON.stringify(tool.input_schema))
    total += 50
  }
  return total
}
