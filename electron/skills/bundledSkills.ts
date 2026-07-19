/**
 * Bundled skills — built-in skills that used to ship with the application.
 *
 * The previously shipped built-in skill set (hardcoded prompts + the
 * `electron/skills/ecc/` directory) was removed because always-on bundled
 * skills diluted the agent's attention. Skills are now sourced exclusively
 * from user/project directories at runtime (see `loader.ts`).
 *
 * The function is intentionally kept (returning an empty set) so callers in
 * `skillTool.ts` don't need to branch on whether bundled skills exist.
 */

import type { SkillDefinition } from './types'

export function getBundledSkills(): SkillDefinition[] {
  return []
}
