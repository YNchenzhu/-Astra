/**
 * upstream report §16.6 — track skills invoked per agent scope; key `${agentId}:${skillName}` avoids cross-agent clobber.
 */

import { asAgentId, type AgentId } from '../tools/ids'
import { SIDE_CHANNEL_KIND, wrapSideChannelBody } from '../constants/sideChannelKinds'
import { INVOKED_SKILL_CONTENT_MAX_CHARS } from './discoveryBudget'

export type InvokedSkillRecord = {
  skillName: string
  skillPath: string
  content: string
  invokedAt: number
  agentId: AgentId
}

const invokedSkills = new Map<string, InvokedSkillRecord>()

/**
 * Per-agent entry cap (2026-06 leak fix). The registry keys by
 * `${agentId}:${skillName}`, so repeat invocations of the same skill are
 * naturally bounded (overwrite), but a stream of DISTINCT skill names grows
 * the agent's slice without limit. The main chat never runs
 * `finalizeSubAgentLifecycle`, so its slice was only ever drained by a
 * post-compact `take` — leaving a gap on long sessions. This LRU cap (evict
 * oldest by insertion/recency) bounds the slice; reinjection only needs the
 * most recently invoked skills, so dropping the oldest is harmless.
 */
const MAX_INVOKED_SKILLS_PER_AGENT = 128

export function invokedSkillMapKey(agentId: AgentId | undefined, skillName: string): string {
  const aid = (agentId ?? '').trim()
  const sn = skillName.trim().toLowerCase()
  return `${aid}:${sn}`
}

function enforceInvokedSkillCapForAgent(agentId: AgentId | undefined): void {
  const prefix = `${(agentId ?? '').trim()}:`
  const keys: string[] = []
  for (const k of invokedSkills.keys()) {
    if (k.startsWith(prefix)) keys.push(k)
  }
  // keys are in insertion order; delete-before-set in recordInvokedSkill keeps
  // that aligned with recency, so the front is the least-recently invoked.
  let over = keys.length - MAX_INVOKED_SKILLS_PER_AGENT
  for (let i = 0; over > 0 && i < keys.length; i++, over--) {
    invokedSkills.delete(keys[i])
  }
}

export function recordInvokedSkill(record: Omit<InvokedSkillRecord, 'invokedAt'> & { invokedAt?: number }): void {
  const key = invokedSkillMapKey(record.agentId, record.skillName)
  // Delete-before-set so a re-invoked skill moves to the Map tail (recency).
  invokedSkills.delete(key)
  invokedSkills.set(key, {
    ...record,
    skillName: record.skillName.trim(),
    skillPath: record.skillPath.trim(),
    // Audit fix S-4 (2026-05) — single budget source.
    content: record.content.slice(0, INVOKED_SKILL_CONTENT_MAX_CHARS),
    invokedAt: record.invokedAt ?? Date.now(),
    agentId: asAgentId((record.agentId ?? '').trim()),
  })
  enforceInvokedSkillCapForAgent(record.agentId)
}

/**
 * Continuation directive appended to every reinjection fragment
 * (skill-adherence audit, 2026-06). The previous fragment only said
 * "these skills were invoked" — after compaction the model read that as
 * historical metadata and resumed its DEFAULT workflow, dropping the
 * skill's implement-then-verify cadence. This line makes the contract
 * explicit: invocation history implies the workflow is still binding for
 * unfinished work, and the recovery path is re-reading SKILL.md, not
 * reconstructing the steps from memory.
 */
export const INVOKED_SKILLS_CONTINUATION_DIRECTIVE =
  'These skills\' workflow instructions remain IN FORCE for any task that is still in progress. ' +
  'If a skill\'s instructions are no longer visible in context (truncated or compacted away), ' +
  're-read its SKILL.md from the path listed above BEFORE continuing that task — do not proceed from memory.'

function renderInvokedSkillsFragment(lines: string[]): string {
  if (!lines.length) return ''
  return [
    '<invoked-skills>',
    'Skills invoked in this agent scope (re-attached after context compaction):',
    ...lines,
    INVOKED_SKILLS_CONTINUATION_DIRECTIVE,
    '</invoked-skills>',
  ].join('\n')
}

/**
 * Build the prompt fragment WITHOUT consuming entries. Used by callers that
 * may run repeatedly within the same compaction cycle (e.g. soft_clear +
 * micro_compact + auto_compact in the same iteration), where consuming on
 * the first call would silently strip skills before the canonical
 * `auto_compact` path can attach them to the post-compact message.
 */
export function peekInvokedSkillsPromptFragmentForAgent(agentId: AgentId | undefined): string {
  const aid = (agentId ?? '').trim()
  const prefix = `${aid}:`
  const lines: string[] = []
  for (const [k, v] of invokedSkills) {
    if (!k.startsWith(prefix)) continue
    lines.push(
      `- **${v.skillName}** (\`${v.skillPath}\`) — invoked ${new Date(v.invokedAt).toISOString()}`,
    )
  }
  return renderInvokedSkillsFragment(lines)
}

/**
 * Build a short reinjection block for prompts after compaction, and remove consumed keys for `agentId`.
 *
 * `opts.keepSkillNames` (2026-07, Codex-parity post-compact prefix rebuild):
 * entries named here are still LISTED in the fragment but NOT consumed —
 * used for the ACTIVE inline-skill session, whose verbatim body must be
 * re-attachable on EVERY subsequent auto-compact while the session lasts.
 * Consuming it on the first compact left later compacts with nothing to
 * rebuild even though the skill was still binding.
 */
export function takeInvokedSkillsPromptFragmentForAgent(
  agentId: AgentId | undefined,
  opts?: { keepSkillNames?: ReadonlyArray<string> },
): string {
  const aid = (agentId ?? '').trim()
  const prefix = `${aid}:`
  const keepKeys = new Set(
    (opts?.keepSkillNames ?? []).map((n) => invokedSkillMapKey(agentId, n)),
  )
  const lines: string[] = []
  const keysToDelete: string[] = []
  for (const [k, v] of invokedSkills) {
    if (!k.startsWith(prefix)) continue
    if (!keepKeys.has(k)) keysToDelete.push(k)
    lines.push(
      `- **${v.skillName}** (\`${v.skillPath}\`) — invoked ${new Date(v.invokedAt).toISOString()}`,
    )
  }
  for (const k of keysToDelete) invokedSkills.delete(k)
  return renderInvokedSkillsFragment(lines)
}

/** Look up a single invoked-skill record (with its recorded body) without consuming it. */
export function peekInvokedSkillRecordForAgent(
  agentId: AgentId | undefined,
  skillName: string,
): InvokedSkillRecord | undefined {
  if (!skillName.trim()) return undefined
  return invokedSkills.get(invokedSkillMapKey(agentId, skillName))
}

/**
 * Render the ACTIVE skill's recorded body as a verbatim post-compact rebuild
 * block (Codex parity: after compaction the instruction prefix is rebuilt
 * from the ORIGINAL text, not from a metadata pointer). The metadata-only
 * `<invoked-skills>` fragment tells the model to re-read SKILL.md, but in a
 * compacted context the model routinely "continues from memory" instead —
 * exactly the drift this block removes by putting the full text back.
 *
 * The recorded content is capped at {@link INVOKED_SKILL_CONTENT_MAX_CHARS};
 * when the cap was hit, the body is a silently-truncated HEAD — dangerous to
 * present as complete (a partially-visible spec is the classic misreading
 * trap), so an explicit truncation notice with the re-read path is appended.
 */
export function renderActiveSkillRebuildBlock(record: InvokedSkillRecord): string {
  const body = record.content
  if (!body.trim()) return ''
  const truncated = body.length >= INVOKED_SKILL_CONTENT_MAX_CHARS
  // Forward slashes on Windows — same normalization as
  // `activeSkillReminder.resolveSkillMarkdownPath`, so every host-authored
  // SKILL.md re-read hint renders the path in one canonical shape.
  const dir =
    process.platform === 'win32'
      ? record.skillPath.replace(/\\/g, '/')
      : record.skillPath
  const skillMdPath = dir ? `${dir}/SKILL.md` : undefined
  const lines = [
    '[Post-compact — active skill workflow, rebuilt verbatim]',
    `<skill-instructions skill="${record.skillName}"${skillMdPath ? ` source="${skillMdPath}"` : ''}>`,
    body,
    '</skill-instructions>',
  ]
  if (truncated) {
    lines.push(
      `[NOTE: the text above is a truncated HEAD of the skill. Do NOT rely on rules beyond this point from memory — re-read ${skillMdPath ?? 'the skill\'s SKILL.md'} before applying anything not visible above.]`,
    )
  }
  lines.push(
    'The <skill-instructions> block above remains the ACTIVE workflow directive for the current task. Follow it strictly and in order; do not fall back to your default workflow while this skill session is active.',
  )
  return lines.join('\n')
}

export function resetInvokedSkillsRegistryForTests(): void {
  invokedSkills.clear()
}

/** §16.6 — append reinjection fragment to the last user turn after compaction.
 *
 * Uses {@link peekInvokedSkillsPromptFragmentForAgent} (non-consuming) because
 * this function may run multiple times per iteration (e.g. soft_clear, then
 * a later auto_compact). The canonical consume site is the auto_compact post-
 * compact attachments path; consumption is also safe at end-of-task via
 * {@link clearInvokedSkillsForAgent}.
 *
 * The fragment is wrapped in `<system-reminder>` here (the system prompt only
 * teaches the model to treat `<system-reminder>` content as side-channel; a
 * bare `<invoked-skills>` envelope can otherwise read like the user themselves
 * dictating a skill list). Wrapping happens at the call site rather than
 * inside `peek/take` so the post-compact attachment path
 * (`postCompactAttachments.createSkillAttachment`), which intentionally relies
 * on the `_convertedFromSystem` metadata flag instead of an inline reminder
 * envelope, is left untouched. Idempotent: re-wrapping is skipped if the
 * fragment is already wrapped.
 *
 * Note on `_convertedFromSystem` propagation: we deliberately do NOT set the
 * flag on the merged message. The destination is the existing last user turn
 * (after compaction this is the synthetic `[Previous conversation was
 * compacted…]` placeholder, which already carries the flag — preserved via
 * the spread); in any other context the destination is a real user request,
 * which downstream consumers must continue to treat as such.
 */
export function injectInvokedSkillsIntoLastUserMessage(
  messages: Array<Record<string, unknown>>,
  agentId: AgentId | undefined,
): Array<Record<string, unknown>> {
  const frag = peekInvokedSkillsPromptFragmentForAgent(agentId)
  if (!frag) return messages
  // wrapSideChannelBody handles the "already wrapped" idempotency case
  // (frag may start with `<system-reminder>` if the producer pre-wrapped).
  const wrapped = wrapSideChannelBody(SIDE_CHANNEL_KIND.invokedSkills, frag)
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== 'user') continue
    const m = { ...messages[i] }
    const c = m.content
    if (typeof c === 'string') {
      m.content = `${c}\n\n${wrapped}`
    } else if (Array.isArray(c)) {
      m.content = [...c, { type: 'text', text: wrapped }]
    } else {
      m.content = wrapped
    }
    const out = messages.slice()
    out[i] = m
    return out
  }
  return messages
}

/** Drop all invoked-skill entries belonging to `agentId` (e.g. on agent end). */
export function clearInvokedSkillsForAgent(agentId: AgentId | undefined): void {
  const aid = (agentId ?? '').trim()
  const prefix = `${aid}:`
  for (const k of Array.from(invokedSkills.keys())) {
    if (k.startsWith(prefix)) invokedSkills.delete(k)
  }
}
