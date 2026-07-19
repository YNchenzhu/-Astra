/**
 * Informative-token overlap — shared, deterministic, CJK-aware text
 * comparison used by BOTH:
 *
 *   - `hostAttachments/objectiveConflict.ts` — turn-entry check that a NEW
 *     user message still relates to the recorded objective;
 *   - `tools/TodoWriteTool.ts#setTodoObjective` — write-time check that a
 *     MODEL-authored objective actually relates to the user's current
 *     request (2026-07 复审 P0 fix: an objective misread on the very first
 *     TodoWrite used to enter goal recitation unverified and get recited
 *     into the model's recency zone every request for the rest of the
 *     task).
 *
 * Extracted into `electron/context/` (pure, no imports) so the tool layer
 * can consume it without creating a cycle through the hostAttachments
 * module, which itself imports from the tool layer.
 */

/** Both texts must yield at least this many informative tokens for a
 *  zero-overlap verdict to be meaningful. */
export const MIN_INFORMATIVE_TOKENS = 3

const ASCII_WORD_RE = /[a-z0-9_./-]{3,}/g
const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf]/

/**
 * Informative tokens: lowercased ASCII words (≥ 3 chars) plus CJK
 * character bigrams. Bigrams give Chinese prose a usable overlap signal
 * without a segmenter — any shared two-character word ("解析", "支付")
 * counts as continuity.
 */
export function informativeTokens(text: string): Set<string> {
  const tokens = new Set<string>()
  const lower = text.toLowerCase()
  for (const m of lower.match(ASCII_WORD_RE) ?? []) tokens.add(m)
  // CJK bigrams over consecutive CJK chars only.
  for (let i = 0; i < lower.length - 1; i++) {
    const a = lower[i]!
    const b = lower[i + 1]!
    if (CJK_RE.test(a) && CJK_RE.test(b)) tokens.add(a + b)
  }
  return tokens
}

/**
 * True when the two texts share ZERO informative tokens (and both carry
 * enough of them to make "zero" meaningful). Deliberately conservative:
 * any topical continuity keeps this false, and short texts (greetings,
 * "继续", "go on") can never trigger it.
 */
export function looksLikeDirectionChange(objective: string, query: string): boolean {
  const objTokens = informativeTokens(objective)
  const queryTokens = informativeTokens(query)
  if (objTokens.size < MIN_INFORMATIVE_TOKENS) return false
  if (queryTokens.size < MIN_INFORMATIVE_TOKENS) return false
  for (const t of queryTokens) {
    if (objTokens.has(t)) return false
  }
  return true
}

/**
 * F2 (2026-07 会话审计) — cross-script comparability check.
 *
 * The token overlap above compares ASCII words against CJK bigrams; an
 * ENGLISH objective vs a CHINESE query (a very common pairing — models
 * habitually write English objectives for Chinese users) yields zero
 * overlap by construction, NOT because the direction changed. Consumers
 * that would take a negative action on a zero-overlap verdict (e.g.
 * downgrading an objective to candidate framing) should ABSTAIN when the
 * two texts have no comparable script in common.
 *
 * Returns `true` only in the clear-cut case: one text's informative
 * tokens are exclusively CJK while the other's are exclusively Latin.
 * Any shared script surface (a Chinese query mentioning `dashboard`,
 * an English objective quoting a Chinese term) keeps the comparison
 * meaningful and returns `false`.
 */
export function scriptsAreIncomparable(a: string, b: string): boolean {
  const profile = (text: string): { cjk: boolean; latin: boolean } => {
    let cjk = false
    let latin = false
    for (const t of informativeTokens(text)) {
      if (CJK_RE.test(t)) cjk = true
      else latin = true
      if (cjk && latin) break
    }
    return { cjk, latin }
  }
  const pa = profile(a)
  const pb = profile(b)
  return (
    (pa.cjk && !pa.latin && pb.latin && !pb.cjk) ||
    (pb.cjk && !pb.latin && pa.latin && !pa.cjk)
  )
}
