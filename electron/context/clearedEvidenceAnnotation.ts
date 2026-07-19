/**
 * 2026-06 multi-turn degradation fix (root cause 3) — symmetric claim
 * downgrade when tool evidence is cleared.
 *
 * `clearCompletedToolResultsExceptRecent` (soft_clear / idle clear) and
 * `microCompact` replace old `tool_result` bodies with placeholders, but
 * the assistant narration describing that evidence ("✅ 任务已完成…")
 * used to survive verbatim. The resulting "claims persist, evidence
 * cleared" asymmetry primed long-run models to treat declarative
 * completion text as the factual record — one of the root causes of the
 * premature-completion (P3) regressions.
 *
 * This module appends a short host note to the narration that belongs to
 * a cleared evidence group, so the model reads it as a historical claim
 * rather than verified fact. Deterministic, idempotent, no LLM calls.
 */

type Msg = Record<string, unknown>

/** Idempotency sentinel — present in every appended note. */
export const CLEARED_EVIDENCE_NOTE_SENTINEL =
  'tool evidence for this step was cleared'

/**
 * The note is intentionally short (the suffix accrues once per cleared
 * turn) and phrased as host metadata, matching the existing bracket-marker
 * convention (`[Old tool result content cleared]`, `[host note] …`).
 */
export const CLEARED_EVIDENCE_NOTE =
  `\n\n[host note: the ${CLEARED_EVIDENCE_NOTE_SENTINEL} from context. ` +
  `Narration in this message is a historical claim, NOT verified fact — ` +
  `re-verify against the current state before relying on it.]`

function isRealUserTurn(msg: Msg): boolean {
  if (msg.role !== 'user') return false
  const c = msg.content
  if (typeof c === 'string') return true
  if (!Array.isArray(c)) return false
  // tool_result-only user rows are loop plumbing, not a user turn.
  return (c as Msg[]).every((b) => b?.type !== 'tool_result')
}

function annotateTextOfAssistant(msg: Msg): Msg | null {
  const c = msg.content
  if (typeof c === 'string') {
    if (!c.trim()) return null
    if (c.includes(CLEARED_EVIDENCE_NOTE_SENTINEL)) return msg
    return { ...msg, content: `${c}${CLEARED_EVIDENCE_NOTE}` }
  }
  if (!Array.isArray(c)) return null
  const blocks = c as Msg[]
  // Find the LAST non-empty text block — that's where completion
  // narration lives (thinking blocks are signed and must not be touched).
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i]
    if (b?.type !== 'text' || typeof b.text !== 'string' || !b.text.trim()) continue
    if (b.text.includes(CLEARED_EVIDENCE_NOTE_SENTINEL)) return msg
    const nextBlocks = blocks.slice()
    nextBlocks[i] = { ...b, text: `${b.text}${CLEARED_EVIDENCE_NOTE}` }
    return { ...msg, content: nextBlocks }
  }
  return null
}

/**
 * Walk FORWARD from the cleared tool_result group at `fromIdx` and
 * annotate the first assistant message that carries narration text.
 *
 * Forward (not backward) because in both the in-turn shape and the
 * post-fix rebuilt shape, tool-bearing assistant rows carry no text
 * (pre-tool text is stripped); the claims live in the final
 * no-tool-use assistant row that FOLLOWS the last results row of the
 * turn. The scan stops at the next real user turn — claims beyond it
 * belong to a different round.
 *
 * Mutates `messages[i]` slots in place (the callers operate on their own
 * cloned arrays). Returns true when a note was added or already present.
 */
export function annotateNarrationForClearedEvidence(
  messages: Msg[],
  fromIdx: number,
): boolean {
  for (let i = fromIdx + 1; i < messages.length; i++) {
    const msg = messages[i]
    if (!msg) continue
    if (isRealUserTurn(msg)) return false
    if (msg.role !== 'assistant') continue
    const annotated = annotateTextOfAssistant(msg)
    if (annotated === null) continue // no narration text — keep scanning
    messages[i] = annotated
    return true
  }
  return false
}
