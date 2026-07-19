/**
 * IPC for local Git — all paths resolved under the opened workspace.
 */

import type { IpcMain } from 'electron'
import { sanitizeFilePath } from '../ipc/inputSanitizer'
import { resolvePathForWorkspaceAccess } from '../security/workspaceAccess'
import { validatedHandle } from '../ipc/validatedHandle'
import {
  gitAddArgs,
  gitCheckoutCommitPathsArgs,
  gitCommitArgs,
  gitCommitFilesArgs,
  gitGetIdentityArgs,
  gitInitArgs,
  gitLogArgs,
  gitRestoreArgs,
  gitSetIdentityArgs,
  gitStatusArgs,
  gitUnstageArgs,
} from '../ipc/schemas'
import {
  getCommitFiles,
  getGitIdentity,
  getGitStatus,
  gitAdd,
  gitCheckoutPathsFromCommit,
  gitCleanUntrackedPaths,
  gitCommit,
  gitInit,
  gitLog,
  gitRestorePathsToHead,
  gitRestoreWorkingTree,
  gitUnstage,
  safeRelPath,
  setGitIdentity,
  type GitIdentityScope,
} from './gitService'

function resolveWorkspaceRoot(raw: unknown): { ok: true; resolved: string } | { ok: false; reason: string } {
  try {
    const filePath = sanitizeFilePath(raw)
    return resolvePathForWorkspaceAccess(filePath)
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * Resolve `workspaceRoot` + each of `paths` into workspace-relative strings.
 * Returns `{ ok: false, error }` on the first invalid entry; empty result
 * inputs are caller-specific (some handlers treat zero resolved entries as
 * an error, others do not).
 */
function resolveWorkspaceAndPaths(
  workspaceRoot: string,
  paths: string[],
): { ok: true; cwd: string; rel: string[] } | { ok: false; error: string } {
  const r = resolveWorkspaceRoot(workspaceRoot)
  if (!r.ok) return { ok: false, error: r.reason }
  const cwd = r.resolved
  const rel: string[] = []
  for (const p of paths) {
    const sr = safeRelPath(cwd, p)
    if (!sr.ok) return { ok: false, error: sr.error }
    rel.push(sr.path)
  }
  return { ok: true, cwd, rel }
}

// Backwards-compatible `registerGitHandlers(ipcMain)` signature — the
// `validatedHandle` calls ignore the parameter (they use the shared
// singleton), so the existing `registerGitHandlers(ipcMain)` call site in
// main.ts continues to work unchanged.
export function registerGitHandlers(_ipcMain: IpcMain): void {
  validatedHandle('git:status', gitStatusArgs, async (_e, [workspaceRoot]) => {
    const r = resolveWorkspaceRoot(workspaceRoot)
    if (!r.ok) return { success: false, error: r.reason }
    const st = await getGitStatus(r.resolved)
    if (!st.ok) return { success: false, error: st.error }
    return { success: true, status: st }
  })

  validatedHandle('git:init', gitInitArgs, async (_e, [workspaceRoot]) => {
    const r = resolveWorkspaceRoot(workspaceRoot)
    if (!r.ok) return { success: false, error: r.reason }
    const out = await gitInit(r.resolved)
    if (!out.ok) return { success: false, error: out.error }
    return { success: true }
  })

  validatedHandle('git:add', gitAddArgs, async (_e, [workspaceRoot, paths]) => {
    const r = resolveWorkspaceRoot(workspaceRoot)
    if (!r.ok) return { success: false, error: r.reason }
    const cwd = r.resolved
    if (paths === undefined || paths === 'all') {
      const out = await gitAdd(cwd, 'all')
      return out.ok ? { success: true } : { success: false, error: out.error }
    }
    if (paths === 'tracked') {
      const out = await gitAdd(cwd, 'tracked')
      return out.ok ? { success: true } : { success: false, error: out.error }
    }
    // Zod guarantees it's string[] at this point.
    const resolved = resolveWorkspaceAndPaths(workspaceRoot, paths)
    if (!resolved.ok) return { success: false, error: resolved.error }
    const out = await gitAdd(resolved.cwd, resolved.rel)
    return out.ok ? { success: true } : { success: false, error: out.error }
  })

  validatedHandle('git:unstage', gitUnstageArgs, async (_e, [workspaceRoot, paths]) => {
    const resolved = resolveWorkspaceAndPaths(workspaceRoot, paths)
    if (!resolved.ok) return { success: false, error: resolved.error }
    const out = await gitUnstage(resolved.cwd, resolved.rel)
    return out.ok ? { success: true } : { success: false, error: out.error }
  })

  validatedHandle('git:commit', gitCommitArgs, async (_e, [workspaceRoot, message]) => {
    const r = resolveWorkspaceRoot(workspaceRoot)
    if (!r.ok) return { success: false, error: r.reason }
    const out = await gitCommit(r.resolved, message)
    if (!out.ok) return { success: false, error: out.error }
    return {
      success: true,
      commit: out.commit,
      branch: out.branch,
      changes: out.changes,
      insertions: out.insertions,
      deletions: out.deletions,
    }
  })

  validatedHandle('git:commit-files', gitCommitFilesArgs, async (_e, [workspaceRoot, hash]) => {
    const r = resolveWorkspaceRoot(workspaceRoot)
    if (!r.ok) return { success: false, error: r.reason }
    const out = await getCommitFiles(r.resolved, hash)
    if (!out.ok) return { success: false, error: out.error }
    return { success: true, files: out.files }
  })

  validatedHandle('git:log', gitLogArgs, async (_e, [workspaceRoot, limit]) => {
    const r = resolveWorkspaceRoot(workspaceRoot)
    if (!r.ok) return { success: false, error: r.reason }
    const out = await gitLog(r.resolved, limit ?? 15)
    if (!out.ok) return { success: false, error: out.error }
    return { success: true, entries: out.entries }
  })

  validatedHandle('git:get-identity', gitGetIdentityArgs, async (_e, [workspaceRoot]) => {
    const r = resolveWorkspaceRoot(workspaceRoot)
    if (!r.ok) return { success: false, error: r.reason }
    const out = await getGitIdentity(r.resolved)
    if (!out.ok) return { success: false, error: out.error }
    return {
      success: true,
      globalName: out.globalName,
      globalEmail: out.globalEmail,
      localName: out.localName,
      localEmail: out.localEmail,
    }
  })

  validatedHandle(
    'git:set-identity',
    gitSetIdentityArgs,
    async (_e, [workspaceRoot, name, email, scope]) => {
      const r = resolveWorkspaceRoot(workspaceRoot)
      if (!r.ok) return { success: false, error: r.reason }
      const out = await setGitIdentity(r.resolved, name, email, scope as GitIdentityScope)
      return out.ok ? { success: true } : { success: false, error: out.error }
    },
  )

  validatedHandle(
    'git:checkout-commit-paths',
    gitCheckoutCommitPathsArgs,
    async (_e, [workspaceRoot, hash, paths]) => {
      if (paths.length === 0) {
        return { success: false, error: 'paths must be a non-empty array.' }
      }
      const resolved = resolveWorkspaceAndPaths(workspaceRoot, paths)
      if (!resolved.ok) return { success: false, error: resolved.error }
      if (resolved.rel.length === 0) return { success: false, error: 'No valid paths.' }
      const out = await gitCheckoutPathsFromCommit(resolved.cwd, hash, resolved.rel)
      return out.ok ? { success: true } : { success: false, error: out.error }
    },
  )

  validatedHandle('git:restore', gitRestoreArgs, async (_e, [workspaceRoot, paths, mode]) => {
    if (paths.length === 0) {
      return { success: false, error: 'paths must be a non-empty array.' }
    }
    const resolved = resolveWorkspaceAndPaths(workspaceRoot, paths)
    if (!resolved.ok) return { success: false, error: resolved.error }
    if (resolved.rel.length === 0) return { success: false, error: 'No valid paths.' }
    const out =
      mode === 'untracked'
        ? await gitCleanUntrackedPaths(resolved.cwd, resolved.rel)
        : mode === 'head'
          ? await gitRestorePathsToHead(resolved.cwd, resolved.rel)
          : await gitRestoreWorkingTree(resolved.cwd, resolved.rel)
    return out.ok ? { success: true } : { success: false, error: out.error }
  })
}
