/**
 * upstream §4.4 — detect prompt-too-long style errors on the compaction LLM call itself.
 */

export function isLikelyCompactPromptTooLongError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error)
  return /prompt[\s_-]*(too\s*long|length)|prompt\s+is\s+too\s+long|context\s*(length|window|limit)|too\s+many\s+tokens|413|prompt_too_long|exceeds?\s+(the\s+)?context|input\s+length\s+and\s+max_tokens/i.test(
    msg,
  )
}
