/**
 * Native @google/generative-ai stream: when to ask for structured thought parts and how to read them.
 */

/** Request `thinkingConfig.includeThoughts` so reasoning can arrive in `part.thought` instead of only `part.text`. */
export function geminiRequestsStructuredThoughtParts(
  modelId: string,
  alwaysThinking?: boolean,
): boolean {
  if (alwaysThinking) return true
  const m = modelId.toLowerCase().trim()
  // IDs are often `models/gemini-2.5-flash` or `google/gemini-2.5-pro` — do not require `startsWith('gemini')`.
  if (!m.includes('gemini')) return false
  if (m.includes('gemini-2.5')) return true
  if (m.includes('gemini-2.0') && m.includes('thinking')) return true
  if (m.includes('flash-thinking')) return true
  if (m.includes('-thinking') || m.endsWith('thinking')) return true
  return false
}

/** Gemini Part may expose thought as `thought` or `thinking` (snake/camel varies by gateway). */
export function extractThoughtDeltaFromGeminiPart(part: unknown): string | undefined {
  if (!part || typeof part !== 'object') return undefined
  const r = part as Record<string, unknown>
  const t = r.thought ?? r.thinking
  if (typeof t === 'string' && t.length > 0) return t
  return undefined
}
