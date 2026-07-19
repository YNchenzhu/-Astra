/**
 * upstream SkillTool §9.3 — frontmatter keys that are considered non-elevating metadata.
 * If a skill's SKILL.md declares **only** these keys (plus body), permission path may auto-allow
 * in plan mode after deny/allow rules (see {@link skillUsesOnlySafeFrontmatterKeys}).
 *
 * Count = 38 per strict AC-9.6 / Tool 系统报告 alignment.
 */

const KEYS = [
  'name',
  'description',
  'license',
  'compatibility',
  'metadata',
  'version',
  'user-invocable',
  'disable-model-invocation',
  'context',
  'allowed-tools',
  'model',
  'effort',
  'argument-hint',
  'paths',
  'when_to_use',
  'hooks',
  'arguments',
  'agent',
  'author',
  'keywords',
  'category',
  'title',
  'display-name',
  'triggers',
  'disabled',
  'schema',
  'editor',
  'tools',
  'presence',
  'shell',
  'documentation',
  'repository',
  'homepage',
  'package',
  'os',
  'platform',
  'language',
  'tags',
] as const

export const SAFE_SKILL_PROPERTIES = new Set<string>(KEYS)

export function skillUsesOnlySafeFrontmatterKeys(keys: string[] | undefined): boolean {
  if (!keys || keys.length === 0) return false
  return keys.every((k) => SAFE_SKILL_PROPERTIES.has(k))
}

/** SkillDefinition subset for plan-mode gate (avoids circular imports with skillTool). */
export type SkillFrontmatterLookup = { frontmatterKeys?: string[] } | undefined

/**
 * upstream SkillTool §9.6 — plan-mode permission UI may be skipped for read-only Skill
 * when rules did not already resolve and frontmatter uses only {@link SAFE_SKILL_PROPERTIES}.
 */
export function shouldSkipPlanModeAskForSafeSkill(params: {
  toolName: string
  skillInvocationName?: string
  currentMode: string
  requiresAsk: boolean
  findSkill: (name: string) => SkillFrontmatterLookup
}): boolean {
  if (
    params.toolName !== 'Skill' ||
    !params.skillInvocationName ||
    params.currentMode !== 'plan' ||
    !params.requiresAsk
  ) {
    return false
  }
  const sk = params.findSkill(params.skillInvocationName)
  return !!(sk?.frontmatterKeys && skillUsesOnlySafeFrontmatterKeys(sk.frontmatterKeys))
}
