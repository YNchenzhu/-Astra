/**
 * IPC handlers for the skill system (IDE-compatible).
 *
 * Channels:
 *   skill:list              — List all user-invocable skills (for / and @ popup)
 *   skill:execute           — Execute a skill by name
 *   skill:reload            — Reload skills (e.g. after workspace change)
 *   skill:get-all           — Get all skills including auto-invocation metadata
 *   skill:get-agent-context — Get auto-invocation prompt for Agent system context
 */

import path from 'node:path'
import type { IpcMain, BrowserWindow } from 'electron'
import {
  getSkillInfoList,
  executeSkill,
  initSkills,
  getAllSkills,
  getCompactSkillIndexPrompt,
} from './skillTool'
import { initSkillWatcher } from './loader'
import { reinitializeLspServerManager } from '../lsp/manager'
import { getWorkspacePath } from '../tools/workspaceState'

/**
 * Pure policy used by the `skill:reload` IPC. Exposed so tests can pin
 * the rejection behaviour without spinning up an Electron `ipcMain` —
 * Self-audit fix B3 (2026-05) follow-up to A1 + G12.
 *
 * Resolves the workspace this reload should act on.
 *   - `accepted: true` → pass `effective` (may be undefined for "no
 *     workspace") to `initSkills` / LSP re-init.
 *   - `accepted: false` → handler throws with `reason`. Renderer's
 *     `SkillsApi.reload` rejects.
 */
export type SkillReloadResolution =
  | { accepted: true; effective: string | undefined }
  | { accepted: false; reason: string }

/**
 * Self-audit fix C3 (2026-05) — Windows filesystems are case-insensitive
 * but `path.resolve` preserves the input's case verbatim, so a renderer
 * that sends `c:\Users\Foo\repo` against a trusted `C:\Users\foo\repo`
 * would be rejected even though both paths name the same directory.
 *
 * Mirrors the same recipe `electron/security/workspaceTrust.ts::normalizeRoot`
 * uses: lowercase on Windows, leave alone on POSIX (real case-sensitive
 * filesystems). We compare on the normalized form but the `effective`
 * return value still carries the caller's original casing — downstream
 * `initSkills` and LSP init then see what the renderer actually sent.
 */
function normalizeForPathCompare(p: string): string {
  const resolved = path.resolve(p)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

export function resolveSkillReloadTarget(
  requestedRaw: unknown,
  trustedRaw: unknown,
): SkillReloadResolution {
  const requested = typeof requestedRaw === 'string' ? requestedRaw.trim() : ''
  const trusted = typeof trustedRaw === 'string' ? trustedRaw.trim() : ''
  if (requested) {
    const sameAsTrusted =
      !!trusted && normalizeForPathCompare(requested) === normalizeForPathCompare(trusted)
    if (!sameAsTrusted) {
      return {
        accepted: false,
        reason: `skill:reload denied: untrusted path "${requested}" (trusted=${trusted || '<none>'})`,
      }
    }
  }
  const effective = requested || trusted || undefined
  return { accepted: true, effective }
}

export function registerSkillHandlers(
  ipcMain: IpcMain,
  workspacePath?: string,
  userDataPath?: string,
  getMainWindow?: () => BrowserWindow | null,
): void {
  // Initialize skills on registration
  initSkills(workspacePath, userDataPath)

  // BUG-SK2 fix: wire the skill file watcher so SKILL.md edits trigger
  // a live reload of the registry. Previously the watcher hook existed
  // but was never invoked, and even if it had been, it only cleared the
  // dynamic-skill cache — `loadedSkills` was rebuilt only by an
  // explicit `skill:reload` IPC or a workspace switch.
  if (workspacePath) {
    void initSkillWatcher(workspacePath, () => {
      try {
        initSkills(workspacePath, userDataPath)
        const win = getMainWindow?.()
        if (win && !win.isDestroyed()) {
          win.webContents.send('skill:reloaded', {
            skills: getSkillInfoList(),
          })
        }
      } catch (err) {
        console.warn('[skill-handlers] hot-reload failed:', err)
      }
    })
  }

  // List all user-invocable skills (for slash-command and @ popup)
  ipcMain.handle('skill:list', () => {
    return { skills: getSkillInfoList() }
  })

  // Execute a skill by name
  ipcMain.handle('skill:execute', async (_event, name: string, args?: string) => {
    const result = await executeSkill(name, args, { invoker: 'user' })
    return result
  })

  // Reload skills (e.g. after workspace change).
  //
  // Audit fix G-12 (2026-05) — `newWorkspacePath` comes from the
  // renderer over IPC. Before validation, a malicious / compromised
  // webContents could pass an arbitrary absolute path, which then drove
  // `loadSkillsFromDir` through seven candidate roots under that path
  // (each invoking `readSkillMarkdownFileSync` + sanitize on whatever
  // it found). That's not catastrophic (we already sanitize content),
  // but it lets the renderer cause arbitrary FS reads under directories
  // it should not be naming. We now accept ONLY:
  //   1) the empty / undefined value (means: rescan current workspace)
  //   2) the workspace path that `workspaceState` already trusts
  // Any other value is rejected with an error.
  ipcMain.handle('skill:reload', (_event, newWorkspacePath?: string) => {
    const trusted = getWorkspacePath() ?? workspacePath ?? undefined
    const resolution = resolveSkillReloadTarget(newWorkspacePath, trusted)
    if (!resolution.accepted) {
      // Self-audit fix A1 (2026-05) — previously we returned
      // `{ error, skills }` here, but `SkillsApi.reload` only declares
      // `{ skills }`, so the renderer happily read `result.skills`
      // from the rejection payload and rendered it as a successful
      // reload. Throwing rejects the underlying IPC promise so
      // `SkillsPanel.handleReload`'s catch block actually fires.
      console.warn(`[skill-handlers] ${resolution.reason}`)
      throw new Error(resolution.reason)
    }
    initSkills(resolution.effective, userDataPath)
    reinitializeLspServerManager(resolution.effective, userDataPath, {
      bypassOpenclaudeNotStarted: true,
    })
    return { skills: getSkillInfoList() }
  })

  // Get all skills including non-user-invocable (for tool discovery)
  ipcMain.handle('skill:get-all', () => {
    return {
      skills: getAllSkills().map(s => ({
        name: s.name,
        description: s.description,
        source: s.source,
        context: s.context,
        userInvocable: s.userInvocable,
        disableModelInvocation: s.disableModelInvocation,
      })),
    }
  })

  // Get auto-invocation prompt for Agent system context
  // This returns a formatted string that should be injected into the
  // Agent's system prompt so it can decide when to use skills automatically
  ipcMain.handle('skill:get-agent-context', () => {
    return {
      prompt: getCompactSkillIndexPrompt(),
      skillCount: getAllSkills().filter(s => !s.disableModelInvocation).length,
    }
  })
}
