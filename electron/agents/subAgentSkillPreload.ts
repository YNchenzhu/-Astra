/**
 * upstream report §3.1 step 5 — preload skill bodies into the sub-agent system prompt.
 */

import { buildSkillResourceManifest, findSkill } from '../skills/skillTool'
import { PRELOADED_SKILL_BODY_MAX_CHARS } from '../skills/discoveryBudget'

/**
 * Returns markdown-ish text to append to the sub-agent system prompt, or empty string.
 */
export function buildPreloadedSkillsPromptAppend(skillNames: string[] | undefined): string {
  if (!skillNames?.length) {
    return ''
  }
  const sections: string[] = []
  for (const raw of skillNames) {
    const key = typeof raw === 'string' ? raw.trim() : ''
    if (!key) continue
    const skill = findSkill(key)
    if (!skill) {
      sections.push(`### Skill: ${key}\n_(not found in registry — skipped)_\n`)
      continue
    }
    let body = skill.promptContent?.trim() ?? ''
    if (body.length > PRELOADED_SKILL_BODY_MAX_CHARS) {
      // Skill-resource attention uplift (2026-07) — a bare "[…truncated…]"
      // left the sub-agent with no recovery path; name the on-disk source
      // so it re-reads instead of improvising the missing tail.
      const base = skill.resolvedPath?.trim()
      const skillMd = base
        ? `${process.platform === 'win32' ? base.replace(/\\/g, '/') : base}/SKILL.md`
        : undefined
      body = `${body.slice(0, PRELOADED_SKILL_BODY_MAX_CHARS)}\n\n[…skill body truncated${skillMd ? ` — read_file ${skillMd} for the complete instructions; do not act on rules you cannot see above` : '…'}]`
    }
    // Skill-resource attention uplift (2026-07) — sub-agents got the body
    // but NO pointer to references/scripts/assets, so a preloaded skill
    // whose steps depend on a reference doc saw the sub-agent invent the
    // content. Same manifest as the inline Skill-tool path.
    const manifest = buildSkillResourceManifest(skill)
    sections.push(
      `### Preloaded skill: ${skill.name}\n${skill.description ? `${skill.description}\n\n` : ''}${body}${manifest ? `\n\n${manifest}` : ''}`,
    )
  }
  if (sections.length === 0) {
    return ''
  }
  return `## Preloaded skills (agent definition)\nThe following skills were attached to this agent type; treat them as authoritative context.\n\n${sections.join('\n\n')}\n`
}
