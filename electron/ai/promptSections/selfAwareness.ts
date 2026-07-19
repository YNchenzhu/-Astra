import type { SystemPromptSection } from './types'

/**
 * Working-assumptions section — short bullets that live in the static
 * layer so the block rides the 1h prompt cache.
 *
 * Bullet inventory (audit-curated; do not extend without a comment):
 *
 *   1. "Avoid time estimates" — frontier models calibrate this badly
 *      and confidently misstate completion times if not told otherwise.
 *   2. "Tool execution latency is on the host — just call the tool"
 *      — original anti "this will take a moment" narration rule.
 *   3. "Do not narrate what you're about to do — just do it"
 *      (upstream-main `src/constants/prompts.ts:884` parity, 2026-05
 *      audit). Replaces the deleted `# Doing tasks` bullet that paired
 *      a long "intent-to-act SAME turn" rule with example phrases
 *      that overlapped with `ANTI_ACTION_HALLUCINATION_BLOCK`'s "safe
 *      substitute" list. The bundled long bullet was systematically
 *      losing to the conflict in long-run conversations
 *      (model picked the "I'll edit X next" + end_turn local
 *      stable point because that satisfied the safe-substitute
 *      examples verbatim). upstream's seven-word version is short
 *      enough to retain attention even when the surrounding
 *      `# Doing tasks` block grows long.
 *
 * Audit fix R1-2 (2026-05) — two earlier bullets here were paraphrased
 * duplicates of rules already in `instructionBlockSection`:
 *   - "You are highly capable and often allow users to complete
 *     ambitious tasks…" was already in `# Doing tasks` (see
 *     `renderSystemPromptInstructionSection` in `systemPrompt.ts`).
 *   - "All text you output outside of tool use is displayed to the
 *     user" was already in `HOST_RUNTIME_CONTRACT_BLOCK`'s `# System`
 *     section.
 *
 * Two near-identical-but-differently-worded copies of the same rule
 * read as conflicting guidance to the model. Canonical phrasings live
 * in `instructionBlockSection`; this file keeps only the genuinely-
 * unique self-awareness bullets.
 */
export const SELF_AWARENESS_BLOCK = `# Working assumptions
- Avoid giving time estimates or predictions for how long tasks will take. If the user asks "how long", say what the next concrete step is instead of guessing minutes.
- Tool execution latency is on the host — do not narrate "this will take a moment" before a tool call; just call the tool.
- Do not narrate what you're about to do — just do it. If the next action is reversible and inside your tool surface, invoke the tool in the SAME turn rather than ending with a plan and waiting for the user to say "go ahead". If you genuinely have nothing actionable left, end with a concrete answer or a specific question, not a dangling promise.`

export const selfAwarenessSection: SystemPromptSection = {
  id: 'self-awareness',
  owner: 'core',
  layer: 'system',
  build: () => SELF_AWARENESS_BLOCK,
}
