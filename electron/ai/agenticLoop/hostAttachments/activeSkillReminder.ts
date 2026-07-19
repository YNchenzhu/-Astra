/**
 * Active-skill reminder collector — skill-adherence audit (2026-06).
 *
 * ## What it does
 *
 * While an inline skill session is active (`state.activeInlineSkillSession`
 * is set by a successful `Skill` tool call and persists until
 * `end_inline_skill_session`), periodically re-surface a short
 * `<system-reminder>` telling the model that the loaded
 * `<skill-instructions>` workflow is STILL the binding directive for the
 * current task — implement each step, verify it, then move on.
 *
 * ## Why it exists
 *
 * The inline session machinery only persists `allowedTools` / `model` /
 * `effort` across iterations (`phases/iteration.ts`); the skill's workflow
 * text itself is delivered ONCE as a tool_result and then scrolls deep
 * into history (or is clamped away by the tool-result budget). The
 * observable failure mode: the model follows the skill for 2-3 turns,
 * then reverts to its default behaviour and the user has to manually
 * remind it every few turns. TodoWrite already has `staleTodoNudge` for
 * the same class of drift; this is the skill-session counterpart.
 *
 * ## Gating contract (mirrors staleTodoNudge's double cadence)
 *
 *   1. `POLE_ACTIVE_SKILL_REMINDER=0` disables the collector.
 *   2. An inline skill session must be active with a non-empty skillName.
 *   3. ≥ {@link TURNS_SINCE_SKILL_LOAD} assistant turns since the last
 *      assistant message containing a `Skill` tool_use (the turn that
 *      loaded the instructions counts as 0 — the model has just read them).
 *   4. ≥ {@link TURNS_BETWEEN_REMINDERS} assistant turns since the last
 *      reminder of this same kind, so one quiet stretch fires once, not
 *      on every subsequent iteration.
 *
 * Both windows count non-thinking assistant turns only.
 *
 * ## Call site
 *
 * `post_tool` — the model perceives the reminder as a system observation
 * attached to the just-finished tool batch (same rationale as the other
 * behavioural reminders).
 */

import type { Collector } from '../hostAttachments'
import {
  SIDE_CHANNEL_KIND,
  makeSideChannelUserMessage,
  readSideChannelKind,
} from '../../../constants/sideChannelKinds'
import { findSkill } from '../../../skills/skillTool'
import { isThinkingOnlyAssistantMessage } from './messageHistoryQueries'

const SKILL_TOOL_NAME = 'Skill'

/** Assistant turns the model may run after loading a skill before the first reminder. */
export const TURNS_SINCE_SKILL_LOAD = 6
/** Minimum assistant turns between two reminders of this kind. */
export const TURNS_BETWEEN_REMINDERS = 6

function isActiveSkillReminderEnabled(): boolean {
  const raw = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process?.env?.POLE_ACTIVE_SKILL_REMINDER?.trim().toLowerCase()
  return !(raw === '0' || raw === 'false' || raw === 'no')
}

function hasSkillToolUse(msg: Record<string, unknown>): boolean {
  const content = msg.content
  if (!Array.isArray(content)) return false
  for (const block of content as Array<Record<string, unknown>>) {
    if (block?.type === 'tool_use' && block.name === SKILL_TOOL_NAME) return true
  }
  return false
}

export interface SkillTurnCounts {
  /** Non-thinking assistant turns since the most-recent `Skill` tool_use (total if never). */
  turnsSinceSkillLoad: number
  /** Non-thinking assistant turns since the most-recent reminder of this kind (total if never). */
  turnsSinceLastReminder: number
}

/**
 * Walk `messages` backwards, accumulating assistant-turn counts for the
 * two cadence gates. Same invariants as staleTodoNudge's
 * `computeTurnCounts`: the assistant turn containing the `Skill` call
 * itself counts as "0 turns since load", thinking-only frames are
 * skipped, and the reminder lookup matches on the side-channel kind
 * (typed flag first, body marker fallback via `readSideChannelKind`).
 */
export function computeSkillTurnCounts(
  messages: ReadonlyArray<Record<string, unknown>>,
): SkillTurnCounts {
  let skillLoadFound = false
  let reminderFound = false
  let turnsSinceSkillLoad = 0
  let turnsSinceLastReminder = 0

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (!msg) continue
    const role = msg.role

    if (role === 'assistant') {
      if (isThinkingOnlyAssistantMessage(msg)) continue
      if (!skillLoadFound && hasSkillToolUse(msg)) {
        skillLoadFound = true
      }
      if (!skillLoadFound) turnsSinceSkillLoad++
      if (!reminderFound) turnsSinceLastReminder++
    } else if (role === 'user' && !reminderFound) {
      if (readSideChannelKind(msg) === SIDE_CHANNEL_KIND.activeSkillReminder) {
        reminderFound = true
      }
    }

    if (skillLoadFound && reminderFound) break
  }

  return { turnsSinceSkillLoad, turnsSinceLastReminder }
}

/**
 * Render the reminder body. First line is the kind's bracket marker —
 * required for disk-resume detection (see the spec in
 * `sideChannelKinds.ts`). The SKILL.md re-read hint is included only
 * when the skill is still resolvable in the registry, because the
 * tool-result budget may have physically clamped the original
 * instructions out of context.
 */
export function renderActiveSkillReminderBody(
  skillName: string,
  skillMarkdownPath: string | null,
  resources?: {
    referenceCount: number
    scriptCount: number
    /** Modular-router docs in non-standard subdirs (common/, modules/, …). */
    instructionDocCount?: number
  },
): string {
  const lines = [
    '[Active skill reminder]',
    `The skill "${skillName}" is still ACTIVE for the current task. Its workflow was loaded earlier in a tool_result wrapped in <skill-instructions skill="${skillName}"> — those instructions remain the binding directive: implement each step, verify it against the skill's criteria, then move to the next. Do not fall back to your default workflow while this session is active.`,
  ]
  if (skillMarkdownPath) {
    lines.push(
      `If the <skill-instructions> block is no longer visible in context (truncated or compacted), re-read it with read_file: ${skillMarkdownPath} — do NOT continue from memory.`,
    )
  }
  // Skill-resource attention uplift (2026-07) — the workflow text is
  // covered by the re-read hint above, but bundled resources drift the
  // same way: after enough turns the model "remembers" what a reference
  // said or re-implements a script from prose. One bounded line keeps the
  // on-disk pointer in recent attention.
  const docCount = resources?.instructionDocCount ?? 0
  if (
    resources &&
    (resources.referenceCount > 0 || resources.scriptCount > 0 || docCount > 0)
  ) {
    const parts: string[] = []
    if (resources.referenceCount > 0) {
      parts.push(`${resources.referenceCount} reference doc(s) under references/`)
    }
    if (docCount > 0) {
      parts.push(`${docCount} instruction document(s) in its module subdirectories`)
    }
    if (resources.scriptCount > 0) {
      parts.push(`${resources.scriptCount} script(s) under scripts/`)
    }
    lines.push(
      `The skill also ships ${parts.join(' and ')} in its base directory (see the <skill-resources> manifest in the original tool_result). When a step depends on one, read_file / run the ON-DISK file — do not reconstruct its content from memory.`,
    )
  }
  lines.push(
    'If the skill\'s workflow is genuinely complete, call Skill with end_inline_skill_session=true to clear this session.',
  )
  return lines.join('\n')
}

/** Resolve the on-disk SKILL.md path + bundled-resource counts for the
 *  re-read hints (nulls when the skill is no longer in the registry). */
function resolveSkillReminderFacts(skillName: string): {
  skillMarkdownPath: string | null
  resources: {
    referenceCount: number
    scriptCount: number
    instructionDocCount: number
  } | null
} {
  try {
    const skill = findSkill(skillName)
    if (!skill) return { skillMarkdownPath: null, resources: null }
    const base = skill.resolvedPath?.trim()
    const normalized = base
      ? process.platform === 'win32'
        ? base.replace(/\\/g, '/')
        : base
      : null
    return {
      skillMarkdownPath: normalized ? `${normalized}/SKILL.md` : null,
      resources: {
        referenceCount: skill.references?.length ?? 0,
        scriptCount: skill.scripts?.length ?? 0,
        instructionDocCount: skill.resourceDocs?.length ?? 0,
      },
    }
  } catch {
    return { skillMarkdownPath: null, resources: null }
  }
}

export const activeSkillReminderCollector: Collector = {
  name: 'active_skill_reminder',
  callSites: ['post_tool'],

  async run(ctx) {
    if (!isActiveSkillReminderEnabled()) return null

    const { state } = ctx
    const skillName = state.activeInlineSkillSession?.skillName?.trim()
    if (!skillName) return null

    const { turnsSinceSkillLoad, turnsSinceLastReminder } = computeSkillTurnCounts(
      state.apiMessages,
    )
    if (turnsSinceSkillLoad < TURNS_SINCE_SKILL_LOAD) return null
    if (turnsSinceLastReminder < TURNS_BETWEEN_REMINDERS) return null

    // Same stage id as the other behavioural reminders (staleTodoNudge
    // precedent) — the `kind` field disambiguates in telemetry.
    state.appendixReport('P2_Q_compaction_reminder', {
      iteration: state.iteration,
      kind: 'active_skill_reminder',
      skillName,
      turnsSinceSkillLoad,
      turnsSinceLastReminder,
    })

    const facts = resolveSkillReminderFacts(skillName)
    return {
      kind: 'push_message',
      sideChannelKind: SIDE_CHANNEL_KIND.activeSkillReminder,
      message: makeSideChannelUserMessage(
        SIDE_CHANNEL_KIND.activeSkillReminder,
        renderActiveSkillReminderBody(
          skillName,
          facts.skillMarkdownPath,
          facts.resources ?? undefined,
        ),
      ),
    }
  },
}
