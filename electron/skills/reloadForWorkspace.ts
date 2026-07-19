/**
 * Keeps filesystem skills in sync with the opened workspace (project-level SKILL.md trees).
 * Dedupes reloads when the path is unchanged.
 */

import { app } from 'electron'
import { initSkills } from './skillTool'

let lastSkillsWorkspaceKey: string | null | undefined

function normalizeKey(workspacePath: string | null | undefined): string | null {
  if (typeof workspacePath !== 'string') return null
  const t = workspacePath.trim()
  return t.length > 0 ? t : null
}

/**
 * Reload bundled + user + project skills when the workspace root changes.
 *
 * NOTE: this intentionally does NOT touch the LSP server manager. The only
 * caller (`memory:set-workspace` in `electron/memory/handlers.ts`) already
 * performs its own deduplicated `reinitializeLspServerManager` right after
 * this call — having a second reinit here meant every real workspace switch
 * spawned the language servers twice and aborted/re-ran the pre-warm scan.
 */
export function reloadSkillsForWorkspace(workspacePath: string | null | undefined): void {
  const key = normalizeKey(workspacePath)
  if (key === lastSkillsWorkspaceKey) return
  lastSkillsWorkspaceKey = key
  const userData = app.getPath('userData')
  initSkills(key ?? undefined, userData)
}

/** @internal Tests */
export function resetSkillsWorkspaceSyncStateForTests(): void {
  lastSkillsWorkspaceKey = undefined
}
