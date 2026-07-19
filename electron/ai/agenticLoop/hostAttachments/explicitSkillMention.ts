/**
 * Explicit-skill-mention collector — deterministic trigger surface for
 * skills the user referenced BY NAME in the current turn (2026-07
 * skill-attention uplift).
 *
 * ## Why
 *
 * The skill-attention stack is probabilistic everywhere upstream of the
 * Skill tool: the compact index competes with 20-30K tokens of scaffolding,
 * and `<skill-discovery>` injection is TF-IDF-ranked (turn-1 prefetch is
 * even default-off). When the user EXPLICITLY writes `/debug` or
 * `@deep-research` in their message, none of those layers guarantees the
 * model connects the mention to the Skill tool — the reference rides
 * inside `<user-query>` prose and may lose the attention race like any
 * other token. Codex CLI solves this with the `$skill-name` inline text
 * marker; Claude Code with `/name` direct invocation. This collector is
 * our host-side equivalent: a cheap, deterministic scan of the current
 * user query for `/name` / `@name` tokens that resolve to loaded,
 * model-invocable skills, surfaced as a one-shot `<system-reminder>` at
 * turn entry.
 *
 * The nudge never forces invocation — the mention may be incidental
 * (quoting a path, discussing the skill itself). It states the detection
 * and tells the model to invoke the Skill tool early UNLESS clearly
 * inapplicable.
 *
 * ## Gating
 *
 * - `iteration_top` only, first iteration of a turn (`state.iteration <= 1`)
 *   — same shape as `objectiveConflict`.
 * - Main chat only; tools must be enabled (no Skill tool otherwise).
 * - Mention syntax is STRICT: `/name` or `@name` where the prefix is at
 *   string start or preceded by a non-path character. Bare-name mentions
 *   ("用 debug 技能") are deliberately NOT matched — skill names collide
 *   with ordinary words (debug/loop/verify) and false positives here are
 *   worse than misses (TF-IDF discovery still covers the semantic case).
 * - Names must resolve via `findSkill` to a model-invocable skill
 *   (manual-only `disable-model-invocation` skills are skipped — the model
 *   cannot call them, and the renderer popup handles the real `/` flow).
 * - The active inline skill session's own name is skipped (already loaded).
 * - Once per (conversation, query+names) pair — retry / regenerate of the
 *   same turn does not double-nudge.
 * - On by default. Disable via `POLE_EXPLICIT_SKILL_MENTION=0`.
 */

import { createHash } from 'node:crypto'
import type { Collector } from '../hostAttachments'
import { getAgentContext } from '../../../agents/agentContext'
import { extractCurrentUserQueryText } from '../../../context/anchorUserQuery'
import {
  SIDE_CHANNEL_KIND,
  makeSideChannelUserMessage,
} from '../../../constants/sideChannelKinds'
import { findSkill } from '../../../skills/skillTool'
import type { SkillDefinition } from '../../../skills/types'

/** First-line bracket marker (disk-resume detection + tests/telemetry greps). */
export const EXPLICIT_SKILL_MENTION_MARKER = '[Explicit skill mention]'

/** Cap on skills surfaced per turn — an explicit mention is precise; more
 *  than a few in one message means the user is enumerating, not invoking. */
export const MAX_MENTIONED_SKILLS = 3

const MAX_SCOPE_BUCKETS = 32
const MAX_DESC_CHARS = 220

/**
 * `/name` or `@name` tokens. The prefix must sit at string start or after
 * a character that rules out paths / URLs / scoped npm packages:
 * `\w` (path segment: `src/foo`), `/` (`https://…/x`), `.` (`x.com/y`),
 * `:` (`g:/workspace`), `@` (`user@@host`). CJK chars and whitespace both
 * pass, so `请用/debug排查` and `run /debug now` match. Name charset
 * mirrors the loader's folder-name convention (alnum + `-` + `_`).
 */
const MENTION_RE = /(^|[^\w/@.:])[/@]([a-zA-Z0-9][a-zA-Z0-9_-]{1,63})/g

function isEnabled(): boolean {
  const raw = process.env.POLE_EXPLICIT_SKILL_MENTION?.trim().toLowerCase()
  return !(raw === '0' || raw === 'false' || raw === 'no' || raw === 'off')
}

/**
 * Extract candidate skill names (lowercased, order-preserving, deduped)
 * from raw user text. Pure syntax pass — callers resolve candidates
 * against the registry. Exported for tests.
 */
export function extractExplicitSkillMentions(text: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  MENTION_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = MENTION_RE.exec(text)) !== null) {
    const name = m[2]!.toLowerCase()
    if (seen.has(name)) continue
    seen.add(name)
    out.push(name)
  }
  return out
}

// ─── Once-per-pair latch (same shape as objectiveConflict) ──────────────

const lastEmittedKeyByScope = new Map<string, string>()

function pairKey(query: string, names: string[]): string {
  return createHash('sha256')
    .update(query)
    .update('\u0000')
    .update(names.join(','))
    .digest('hex')
    .slice(0, 16)
}

/** @internal Test-only seam. */
export function __resetExplicitSkillMentionTrackingForTests(): void {
  lastEmittedKeyByScope.clear()
}

function truncateDesc(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= MAX_DESC_CHARS ? flat : `${flat.slice(0, MAX_DESC_CHARS - 1)}…`
}

/** Render the reminder body. Exported for tests. */
export function renderExplicitSkillMentionBody(skills: SkillDefinition[]): string {
  const lines = [
    EXPLICIT_SKILL_MENTION_MARKER,
    '',
    'The user\'s current message references the loaded skill(s) below by explicit `/name` or `@name` token. ' +
      'This is a deterministic host detection, not a semantic guess. ' +
      'Unless the reference is clearly incidental (e.g. quoting a path or discussing the skill itself), ' +
      'invoke the **Skill** tool with the exact skill name as an EARLY step of this turn — ' +
      'do not re-implement its workflow from memory and do not substitute a different skill.',
    '',
  ]
  for (const s of skills) {
    const hint = s.argumentHint ? ` (args: ${s.argumentHint})` : ''
    lines.push(`- /${s.name} — ${truncateDesc(s.description)}${hint}`)
  }
  return lines.join('\n')
}

export const explicitSkillMentionCollector: Collector = {
  name: 'explicit_skill_mention',
  callSites: ['iteration_top'],

  async run(ctx) {
    if (!isEnabled()) return null
    const { state } = ctx
    // First iteration of a turn only — that's when the fresh user message
    // is the transcript tail and the mention is a live instruction signal.
    if (state.iteration > 1) return null
    if (!state.enableTools) return null

    const agentCtx = getAgentContext()
    if ((agentCtx?.agentId ?? 'main') !== 'main') return null

    const query = extractCurrentUserQueryText(state.apiMessages)?.trim()
    if (!query) return null

    const candidates = extractExplicitSkillMentions(query)
    if (candidates.length === 0) return null

    const activeName = state.activeInlineSkillSession?.skillName?.toLowerCase()
    const matched: SkillDefinition[] = []
    const seen = new Set<string>()
    for (const name of candidates) {
      const skill = findSkill(name)
      if (!skill || skill.disableModelInvocation) continue
      const key = skill.name.toLowerCase()
      if (key === activeName) continue
      if (seen.has(key)) continue
      seen.add(key)
      matched.push(skill)
      if (matched.length >= MAX_MENTIONED_SKILLS) break
    }
    if (matched.length === 0) return null

    const scopeKey = agentCtx?.streamConversationId?.trim() || 'main'
    const key = pairKey(query, matched.map((s) => s.name.toLowerCase()))
    if (lastEmittedKeyByScope.get(scopeKey) === key) return null
    lastEmittedKeyByScope.set(scopeKey, key)
    while (lastEmittedKeyByScope.size > MAX_SCOPE_BUCKETS) {
      const oldest = lastEmittedKeyByScope.keys().next().value
      if (oldest === undefined) break
      lastEmittedKeyByScope.delete(oldest)
    }

    state.appendixReport('P2_Q_compaction_reminder', {
      iteration: state.iteration,
      kind: 'explicit_skill_mention',
      skillNames: matched.map((s) => s.name),
    })

    return {
      kind: 'push_message',
      sideChannelKind: SIDE_CHANNEL_KIND.explicitSkillMention,
      message: makeSideChannelUserMessage(
        SIDE_CHANNEL_KIND.explicitSkillMention,
        renderExplicitSkillMentionBody(matched),
      ),
    }
  },
}
