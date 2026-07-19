/**
 * Memory system prompt builder — adapted from upstream §7.1.
 *
 * Builds the static "how the memory subsystem works" tutorial that
 * ships once at first turn (see `memoryCapabilitiesSection` in the
 * prompt registry). The actual recalled facts ride a separate channel
 * (`buildRecalledMemoryPrompt` below → `<project-memory>` user-meta).
 *
 * Sections currently emitted:
 *   - 4-type taxonomy (`TYPES_SECTION_INDIVIDUAL`)
 *   - Memory file format (`MEMORY_FRONTMATTER_EXAMPLE`)
 *   - What NOT to save (`WHAT_NOT_TO_SAVE_SECTION`)
 *   - When to access memory (`WHEN_TO_ACCESS_SECTION`)
 *   - Trusting recall caveat (`TRUSTING_RECALL_SECTION`)
 *   - Optional: past-context search hint, extra guidelines, kairos daily log tail
 *
 * Removed in the 2026-05 cleanup: the "## Current memory index"
 * section that inlined up to 25KB of MEMORY.md per scope on the FIRST
 * turn. Neither upstream nor the IDE inline an index this
 * aggressively; the model still surfaces relevant memories via
 * `recallForPrompt` / embedding retrieval per turn.
 */

import { SIDE_CHANNEL_KIND, wrapSideChannelBody } from '../constants/sideChannelKinds'
import {
  TYPES_SECTION_INDIVIDUAL,
  WHAT_NOT_TO_SAVE_SECTION,
  WHEN_TO_ACCESS_SECTION,
  TRUSTING_RECALL_SECTION,
  MEMORY_FRONTMATTER_EXAMPLE,
} from '../memdir/memoryTypes'
import { getMemoryFeatureFlags } from './memoryFeatureFlags'
import { readKairosDailyLogTail } from './kairosDailyLog'

export interface MemoryPromptOptions {
  workspacePath?: string | null
  includeTypeGuidance?: boolean
  includeWhatNotToSave?: boolean
  includeRecallGuidance?: boolean
  teamMemoryEnabled?: boolean
  autoMemoryEnabled?: boolean
}

/**
 * Build the complete memory section for the system prompt.
 * This is injected into the system prompt so the model knows about memory capabilities.
 */
export function buildMemorySystemPrompt(options: MemoryPromptOptions): string {
  const {
    workspacePath,
    includeTypeGuidance = true,
    includeWhatNotToSave = true,
    includeRecallGuidance = true,
    autoMemoryEnabled = true,
  } = options

  if (!autoMemoryEnabled) return ''

  const flags = getMemoryFeatureFlags()

  const sections: string[] = []

  sections.push('# Memory System')
  sections.push('')
  sections.push('You have access to a persistent memory system that stores information across sessions.')
  sections.push('')

  if (includeTypeGuidance) {
    sections.push(...TYPES_SECTION_INDIVIDUAL)
  }

  sections.push('## Memory file format')
  sections.push('')
  sections.push(...MEMORY_FRONTMATTER_EXAMPLE)
  sections.push('')

  if (includeWhatNotToSave) {
    sections.push(...WHAT_NOT_TO_SAVE_SECTION)
  }

  if (includeRecallGuidance) {
    sections.push(...WHEN_TO_ACCESS_SECTION)
    sections.push('')
    sections.push(...TRUSTING_RECALL_SECTION)
  }

  if (flags.pastContextSearchPromptEnabled) {
    sections.push('')
    sections.push('## Historical and past context (tengu_coral_fern)')
    sections.push('')
    sections.push(
      'When the user asks about earlier work, past decisions, or “what we did before”, **do not guess**. Prefer:',
    )
    sections.push('')
    sections.push(
      '- **Repository tools** (Grep / Glob / Read) on the current workspace for code and docs;',
    )
    sections.push(
      '- **Persisted memory** (this memory system and any recalled snippets injected into context);',
    )
    sections.push(
      '- **Session notes** (session-memory / structured summaries) when available in context.',
    )
    sections.push('')
    sections.push(
      'Treat chat history as fallible; reconcile claims against files and stored memory when stakes are high.',
    )
  }

  if (flags.extraGuidelines?.trim()) {
    sections.push('')
    sections.push('## Additional memory guidelines')
    sections.push('')
    sections.push(flags.extraGuidelines.trim())
  }

  if (flags.kairosDailyLogEnabled && workspacePath) {
    sections.push('')
    sections.push('## KAIROS-style daily log')
    sections.push('')
    sections.push(
      'Structured long-term index may be distilled separately. Ephemeral notes append under `.claude/memory/logs/YYYY/MM/`.',
    )
    const tail = readKairosDailyLogTail(workspacePath)
    if (tail.trim()) {
      sections.push('')
      sections.push('### Today (tail)')
      sections.push('')
      sections.push(tail)
    }
  }

  // NOTE (2026-05 cleanup): the "## Current memory index" block — which
  // inlined up to 25KB of MEMORY.md content per scope (user / project / team)
  // on the FIRST conversation turn — has been removed. Industry comparison:
  //   - upstream's CLAUDE.md is loaded once via `settingSources: ['project']`
  //     when the user opts in; no automatic dump.
  //   - the IDE's `.cursor/rules/*.mdc` files surface via the rules system on
  //     demand; no first-turn index dump.
  // The model still learns "memory exists, here is the schema" from the
  // capability tutorial above; recall via `recallForPrompt` / embedding-driven
  // retrieval keeps actually-relevant memories surfacing per turn. The
  // helpers that read MEMORY.md / count files were also dropped — bring
  // them back from git history if a future feature needs them, but do not
  // re-attach them to the first-turn prompt.

  return sections.join('\n')
}

/**
 * P1-39 / Stage 11: cap on the recalled-memory body. Keep recall concise:
 * enough to carry the top few durable facts, but not enough to dominate
 * simple user questions or trigger long "read all context first" thinking.
 * Long individual memories are individually truncated; if too many memories
 * try to fit, later ones are dropped (they ranked lower) and a single line
 * announces how many.
 */
/**
 * Total character budget the recalled-memory body may occupy. Exported as
 * the single source of truth so tests can lock the production budget
 * without re-grepping for the literal.
 */
export const MAX_RECALL_PROMPT_CHARS = 6_000
/**
 * Per-memory body truncation cap. Same single-source-of-truth rationale
 * as {@link MAX_RECALL_PROMPT_CHARS}.
 */
export const MAX_PER_MEMORY_CHARS = 1_200

function truncateMemoryContent(content: string, limit: number): { text: string; truncated: boolean } {
  if (content.length <= limit) return { text: content, truncated: false }
  return { text: `${content.slice(0, limit)}\n…[truncated to keep prompt within budget]`, truncated: true }
}

/**
 * Build a concise memory prompt for recalled memories.
 * Used when injecting recalled memories into the user context.
 */
export function buildRecalledMemoryPrompt(
  memories: Array<{
    name: string
    type: string
    content: string
    ageDays: number
    isStale: boolean
  }>,
): string {
  if (memories.length === 0) return ''

  const lines: string[] = ['# Recalled Memories', '']
  const staleNames: string[] = []
  const agedNames: string[] = [] // memories with ageDays > 1 — surfaced in a single top-level reminder
  let runningChars = lines.join('\n').length
  let droppedMemories = 0
  let truncatedAny = false

  for (const mem of memories) {
    const { text: trimmedContent, truncated } = truncateMemoryContent(mem.content, MAX_PER_MEMORY_CHARS)
    if (truncated) truncatedAny = true
    const memBlock = [
      `## ${mem.name} [${mem.type}]`,
      `Updated: ${formatAge(mem.ageDays)}`,
      '',
      trimmedContent,
      '',
    ].join('\n')
    if (runningChars + memBlock.length + 1 > MAX_RECALL_PROMPT_CHARS) {
      droppedMemories++
      continue
    }
    if (mem.ageDays > 1) agedNames.push(mem.name)
    if (mem.isStale) staleNames.push(mem.name)
    lines.push(`## ${mem.name} [${mem.type}]`)
    lines.push(`Updated: ${formatAge(mem.ageDays)}`)
    lines.push('')
    lines.push(trimmedContent)
    lines.push('')
    runningChars += memBlock.length + 1
  }

  // Single top-level `<system-reminder>` covering EVERY aged memory in this
  // recall batch, rather than one wrap per memory. Pre-2026-05 each
  // memory > 1 day old got its own inline reminder — when 5 memories
  // recalled, the model saw 5 nearly-identical "verify before asserting"
  // imperatives stacked together (literal noise). One reminder naming
  // all aged entries by name keeps the staleness signal without the
  // repetition. Suppressed when no memory is aged.
  //
  // Insertion target is index 1 (the blank line right after the
  // `# Recalled Memories` heading); the existing blank is preserved
  // as the single separator between the reminder and the first
  // `## <name>` block. Do NOT also append a second `''` here — that
  // produced a double blank line in the rendered output.
  if (agedNames.length > 0) {
    const consolidated = consolidatedMemoryAgeReminder(agedNames)
    lines.splice(1, 0, consolidated)
  }

  if (staleNames.length > 0) {
    lines.push('---')
    lines.push('')
    lines.push(
      `> **Staleness warning**: The following memories may be outdated and should be verified against current code: ${staleNames.join(', ')}`,
    )
    lines.push('')
    lines.push(
      '> Memory records are point-in-time observations. Before acting on them, verify against the current project state.',
    )
  }

  if (droppedMemories > 0 || truncatedAny) {
    lines.push('---')
    lines.push('')
    if (droppedMemories > 0) {
      lines.push(
        `> Note: ${droppedMemories} additional memory record(s) were omitted to stay within the recall prompt budget.`,
      )
    }
    if (truncatedAny) {
      lines.push(
        `> Note: Some memory bodies were truncated; ask for a specific memory by name to read it in full.`,
      )
    }
    lines.push('')
  }

  return lines.join('\n')
}

function formatAge(ageDays: number): string {
  if (ageDays === 0) return 'today'
  if (ageDays === 1) return 'yesterday'
  return `${ageDays} days ago`
}

/**
 * Single consolidated staleness reminder covering every memory > 1 day
 * old in this recall batch. Replaces the pre-2026-05 per-memory wrap
 * pattern: when 5 memories were recalled, each producing its own
 * `<system-reminder>` with nearly-identical "verify before asserting"
 * text, the stacked reminders read as repetitive noise. One reminder
 * naming all aged entries by name keeps the staleness signal intact
 * (the `<system-reminder>` tag is still load-bearing for treating this
 * as a behavioural directive, not commentary) while removing the
 * duplication.
 */
export function consolidatedMemoryAgeReminder(agedNames: string[]): string {
  const body =
    `The following recalled memories are more than a day old and may be outdated: ${agedNames.join(', ')}. ` +
    `Memories are point-in-time observations, not live state — ` +
    `claims about code behavior or file:line citations may be stale. ` +
    `Verify against current code before asserting as fact.`
  return wrapSideChannelBody(SIDE_CHANNEL_KIND.memoryAgeNote, body)
}
