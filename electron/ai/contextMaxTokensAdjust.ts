/**
 * upstream §12.6-style: parse overload errors and suggest a lower max_tokens for one retry.
 */

const CONTEXT_HINT_RE =
  /context\s*(?:window|limit|length)|max_tokens|input\s*(?:length|tokens)|exceeds?\s+the\s+context|too\s+many\s+tokens|prompt\s+is\s+too\s+long|input\s+length\s+and\s+max_tokens\s+exceed\s+context\s+limit/i

/** §12.6 — safety margin below the context ceiling */
const SAFETY_BUFFER_TOKENS = 1000

/** Minimum max_tokens we will try on retry (upstream §12.6 uses 3000). */
const FLOOR_MAX_TOKENS = 3000

/**
 * If the error looks like input+max_tokens exceeding context, return a reduced max_tokens.
 * Uses a conservative heuristic when the API does not expose numeric limits.
 */
export function suggestReducedMaxTokensForContextError(
  error: unknown,
  currentMaxTokens: number,
): number | null {
  if (!Number.isFinite(currentMaxTokens) || currentMaxTokens <= FLOOR_MAX_TOKENS) {
    return null
  }
  const msg = extractErrorText(error)
  if (!msg || !CONTEXT_HINT_RE.test(msg)) {
    return null
  }

  const parsedLimit = tryParseLimitFromMessage(msg)
  const parsedInput = tryParseInputTokensFromMessage(msg)

  if (parsedLimit != null && parsedInput != null) {
    const available = Math.max(FLOOR_MAX_TOKENS, parsedLimit - parsedInput - SAFETY_BUFFER_TOKENS)
    const next = Math.min(currentMaxTokens, available)
    return next < currentMaxTokens && next >= FLOOR_MAX_TOKENS ? next : null
  }

  const half = Math.max(FLOOR_MAX_TOKENS, Math.floor(currentMaxTokens / 2))
  return half < currentMaxTokens ? half : null
}

function extractErrorText(error: unknown): string {
  if (error == null) return ''
  if (typeof error === 'string') return error
  if (typeof error !== 'object') return String(error)
  const e = error as {
    message?: string
    error?: { message?: string }
    body?: unknown
  }
  const parts = [e.message, e.error?.message]
  if (typeof e.body === 'string') parts.push(e.body)
  return parts.filter(Boolean).join(' ')
}

function tryParseLimitFromMessage(msg: string): number | null {
  const m =
    msg.match(/limit\s*(?:is|of|:)?\s*([0-9]{3,9})/i) ||
    msg.match(/context\s*(?:window|length)\s*(?:of|is)?\s*([0-9]{3,9})/i) ||
    msg.match(/([0-9]{3,9})\s*tokens?\s*(?:context|limit)/i)
  if (!m) return null
  const n = Number(m[1])
  return Number.isFinite(n) ? n : null
}

function tryParseInputTokensFromMessage(msg: string): number | null {
  const m =
    msg.match(/input[_\s]*tokens?\s*(?:is|:)?\s*([0-9]{3,9})/i) ||
    msg.match(/([0-9]{3,9})\s*input\s*tokens?/i)
  if (!m) return null
  const n = Number(m[1])
  return Number.isFinite(n) ? n : null
}
