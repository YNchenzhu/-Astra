/**
 * Active-skill recitation — ephemeral per-request re-surfacing of the
 * ACTIVE inline skill's workflow text at the very END of the model's
 * context (Codex parity, 2026-07).
 *
 * ## Why
 *
 * Codex CLI attaches skill instructions as an input item ON THE TURN
 * that uses them ("recommended for better performance"), so the workflow
 * text always sits in the model's recency zone. Our inline skill body is
 * delivered ONCE as a tool_result and then scrolls hundreds of messages
 * deep; on 1M-window models it can end up several hundred K tokens from
 * the tail, where its attention weight approaches zero while the model
 * anchors on its own recent (possibly wrong) restatements of the rules.
 * The existing `activeSkillReminderCollector` pushes a short persisted
 * pointer every ~6 turns; this module complements it with the TEXT
 * itself, near the tail, on every request. (2026-07 复审 item 6 — the
 * unified tail-slot policy in `stream.ts` places this SECOND-closest to
 * generation: the goal recitation owns the final slot, because the
 * user's objective must win every recency contest.)
 *
 * ## Design constraints (mirrors `goalRecitation.ts`)
 *
 *   1. **Ephemeral, never persisted.** Appended to a COPY of the messages
 *      at request time in `stream.ts`; `state.apiMessages` is untouched,
 *      so nothing accumulates across iterations.
 *   2. **Deterministic data source.** The body comes from the
 *      invoked-skills registry record written by the `Skill` tool —
 *      byte-identical to what the tool_result carried (up to the
 *      registry's record cap), never LLM-summarized.
 *   3. **Cache-friendly.** Appended at the absolute tail, so the prompt
 *      prefix — and provider prompt cache — is unaffected.
 *   4. **Honest about truncation.** A cut body is the classic
 *      misread-the-spec trap; any truncation is labeled explicitly with
 *      the SKILL.md re-read path.
 *
 * Gating: skip while the skill was loaded very recently (the model just
 * read the full tool_result — reciting would be pure duplication).
 * Disable via `POLE_ACTIVE_SKILL_RECITATION=0`.
 */

import { getAgentContext } from '../../agents/agentContext'
import { asAgentId } from '../../tools/ids'
import {
  peekInvokedSkillRecordForAgent,
  type InvokedSkillRecord,
} from '../../skills/invokedSkillsRegistry'
import { computeSkillTurnCounts } from './hostAttachments/activeSkillReminder'
import {
  SIDE_CHANNEL_KIND,
  wrapSideChannelBody,
} from '../../constants/sideChannelKinds'

type Msg = Record<string, unknown>

/** First body line — marker for tests / telemetry greps. */
export const ACTIVE_SKILL_RECITATION_MARKER =
  '[Active skill recitation — host-generated]'

/**
 * Assistant turns that must have passed since the `Skill` tool_use before
 * recitation starts. Right after load the full body is already the most
 * recent tool_result; reciting it would double the tokens for nothing.
 */
export const RECITATION_MIN_TURNS_SINCE_SKILL_LOAD = 2

/**
 * Char cap for the recited body. Most SKILL.md bodies fit whole; larger
 * ones are cut at a newline with an explicit truncation notice (the
 * ORIGINAL tool_result deeper in context stays complete — the tool-result
 * budget exempts skill blocks — so nothing is lost, only de-emphasized).
 */
export const RECITED_SKILL_BODY_MAX_CHARS = 6_000

export function isActiveSkillRecitationEnabled(): boolean {
  const raw = process.env.POLE_ACTIVE_SKILL_RECITATION?.trim().toLowerCase()
  return !(raw === '0' || raw === 'false' || raw === 'no' || raw === 'off')
}

/**
 * Render the recitation body from a registry record. Pure — exported for
 * tests. Returns `null` when the record carries no usable text.
 */
export function buildActiveSkillRecitationText(
  record: Pick<InvokedSkillRecord, 'skillName' | 'skillPath' | 'content'>,
): string | null {
  const body = record.content.trim()
  if (!body) return null

  // Forward slashes on Windows — parity with the registry's rebuild block
  // and `activeSkillReminder`, so re-read hints share one path shape.
  const dir =
    process.platform === 'win32'
      ? record.skillPath.replace(/\\/g, '/')
      : record.skillPath
  const skillMdPath = dir ? `${dir}/SKILL.md` : undefined
  let recited = body
  let truncated = false
  if (recited.length > RECITED_SKILL_BODY_MAX_CHARS) {
    const sliced = recited.slice(0, RECITED_SKILL_BODY_MAX_CHARS)
    const lastNewline = sliced.lastIndexOf('\n')
    recited = lastNewline > 0 ? sliced.slice(0, lastNewline) : sliced
    truncated = true
  }

  const lines = [
    ACTIVE_SKILL_RECITATION_MARKER,
    `The skill "${record.skillName}" is ACTIVE for the current task. Its workflow is re-surfaced here so it stays in recent attention — this is the same directive loaded earlier, not a new instruction:`,
    `<skill-instructions skill="${record.skillName}"${skillMdPath ? ` source="${skillMdPath}"` : ''}>`,
    recited,
    '</skill-instructions>',
  ]
  if (truncated) {
    lines.push(
      `[NOTE: truncated for recitation. The COMPLETE instructions are in the earlier Skill tool_result${skillMdPath ? ` and on disk at ${skillMdPath}` : ''} — verify against the full text before applying rules not visible above.]`,
    )
  }
  lines.push(
    'Follow these instructions strictly and in order; verify each step against the skill\'s own criteria before moving on. Do not reconstruct the rules from memory — when unsure, re-check the text above.',
  )
  return lines.join('\n')
}

/**
 * Append `recitationText` to the END of a COPY of `messages` (same shape
 * rules as `appendEphemeralGoalRecitation`). Never mutates the input.
 * Pure — exported for tests.
 */
export function appendEphemeralActiveSkillRecitation(
  messages: ReadonlyArray<Msg>,
  recitationText: string,
): Msg[] {
  const wrapped = wrapSideChannelBody(
    SIDE_CHANNEL_KIND.genericConvertedSystem,
    recitationText,
  )
  const out = [...messages]
  const last = out[out.length - 1]
  if (last && last.role === 'user') {
    const c = last.content
    if (typeof c === 'string') {
      out[out.length - 1] = { ...last, content: `${c}\n\n${wrapped}` }
      return out
    }
    if (Array.isArray(c)) {
      out[out.length - 1] = {
        ...last,
        content: [
          ...(c as Array<Record<string, unknown>>),
          { type: 'text', text: wrapped },
        ],
      }
      return out
    }
  }
  out.push({ role: 'user', content: wrapped })
  return out
}

/**
 * Production wrapper used by `stream.ts`. Applies all gates and returns
 * the SAME array reference when the recitation does not apply.
 */
export function withEphemeralActiveSkillRecitation(
  messages: Msg[],
  opts: {
    /** `state.activeInlineSkillSession?.skillName` — undefined ⇒ no-op. */
    activeSkillName?: string
  },
): Msg[] {
  if (!isActiveSkillRecitationEnabled()) return messages
  const skillName = opts.activeSkillName?.trim()
  if (!skillName) return messages
  if (messages.length === 0) return messages

  // Skip while the full tool_result is itself still recent.
  const { turnsSinceSkillLoad } = computeSkillTurnCounts(messages)
  if (turnsSinceSkillLoad < RECITATION_MIN_TURNS_SINCE_SKILL_LOAD) return messages

  const agentId = getAgentContext()?.agentId ?? asAgentId('main')
  const record = peekInvokedSkillRecordForAgent(agentId, skillName)
  if (!record) return messages

  const text = buildActiveSkillRecitationText(record)
  if (!text) return messages

  return appendEphemeralActiveSkillRecitation(messages, text)
}
