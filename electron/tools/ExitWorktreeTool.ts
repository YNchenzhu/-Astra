/**
 * ExitWorktreeTool — Exit a worktree session and return to the original workspace.
 *
 * Simplified port from upstream's ExitWorktreeTool, adapted for cursor-ui-clone.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import fs from 'node:fs'
import { exitWorktreeInputZod } from './toolInputZod'
import { buildTool } from './buildTool'
import {
  getCurrentWorktreeSession,
  saveWorktreeState,
} from './EnterWorktreeTool'
import { setWorkspacePath } from './workspaceState'
import { fireCwdChangedHooks, fireWorktreeRemoveHooks } from './hooks/runtimeHookBridges'

const execFileAsync = promisify(execFile)

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf-8' })
  return stdout
}

// ========== Helper: count uncommitted changes ==========
//
// `baselineCommit` is the main repo HEAD captured at EnterWorktree time. New
// commits are counted as `baseline..HEAD` — counting only commits made INSIDE
// the worktree. The previous `HEAD~10..HEAD` form counted up to 10 pre-existing
// shared-history commits, which falsely flagged pristine worktrees as having
// "10 commits" and made `action: "remove"` impossible without `discard_changes`.
async function countWorktreeChanges(
  worktreePath: string,
  baselineCommit: string | undefined,
): Promise<{ changedFiles: number; commits: number }> {
  let changedFiles = 0
  let commits = 0

  try {
    const status = await git(['status', '--porcelain'], worktreePath)
    changedFiles = status.split('\n').filter((l) => l.trim() !== '').length
  } catch {
    // git status failed — assume unsafe
    return { changedFiles: -1, commits: -1 }
  }

  if (baselineCommit) {
    try {
      const revList = await git(['rev-list', '--count', `${baselineCommit}..HEAD`], worktreePath)
      commits = parseInt(revList.trim(), 10) || 0
    } catch {
      // ignore — baseline may be unreachable from the worktree HEAD
    }
  }

  return { changedFiles, commits }
}

// ========== Helper: remove a node_modules link before deleting the worktree ==========
//
// EnterWorktree may create `<worktree>/node_modules` as a junction (Windows)
// or symlink (Unix) pointing at the MAIN repo's node_modules. A naive recursive
// delete that follows the reparse point would wipe the real dependency tree.
// Unlinking the link first (lstat → isSymbolicLink → unlink) removes only the
// pointer, never the target.
async function unlinkNodeModulesLink(worktreePath: string): Promise<void> {
  const nm = path.join(worktreePath, 'node_modules')
  try {
    const st = await fs.promises.lstat(nm)
    if (st.isSymbolicLink()) {
      await fs.promises.unlink(nm)
    }
  } catch {
    // not present / not a link — nothing to unlink
  }
}

// ========== Tool definition ==========

export const exitWorktreeTool = buildTool({
  name: 'ExitWorktree',
  zInputSchema: exitWorktreeInputZod,
  description:
    'Exits a worktree session created by EnterWorktree and restores the original working directory. Only operates on worktrees created by EnterWorktree in this session.',
  inputSchema: [
    {
      name: 'action',
      type: 'string',
      description: '"keep" leaves the worktree and branch on disk; "remove" deletes both.',
      required: true,
    },
    {
      name: 'discard_changes',
      type: 'boolean',
      description: 'Set to true when action is "remove" and the worktree has uncommitted files. Without this, the tool refuses to remove.',
      required: false,
    },
  ],
  isReadOnly: false,
  isConcurrencySafe: false,

  async call({ action, discard_changes }) {
    const session = getCurrentWorktreeSession()
    if (!session) {
      return {
        success: true,
        output: 'No-op: there is no active EnterWorktree session to exit. This tool only operates on worktrees created by EnterWorktree in the current session. No filesystem changes were made.',
      }
    }

    if (action !== 'keep' && action !== 'remove') {
      return {
        success: false,
        error: 'action must be "keep" or "remove"',
      }
    }

    const {
      worktreePath,
      worktreeBranch,
      mainRepoRoot,
      originalWorkspacePath,
      originalHeadCommit,
    } = session
    const restoreDisplay = originalWorkspacePath ?? mainRepoRoot

    // Safety check for remove
    if (action === 'remove' && !discard_changes) {
      const { changedFiles, commits } = await countWorktreeChanges(worktreePath, originalHeadCommit)
      if (changedFiles === -1) {
        return {
          success: false,
          error: `Could not verify worktree state at ${worktreePath}. Re-invoke with discard_changes: true to proceed — or use action: "keep" to preserve the worktree.`,
        }
      }
      if (changedFiles > 0 || commits > 0) {
        const parts: string[] = []
        if (changedFiles > 0) parts.push(`${changedFiles} uncommitted ${changedFiles === 1 ? 'file' : 'files'}`)
        if (commits > 0) parts.push(`${commits} ${commits === 1 ? 'commit' : 'commits'}`)
        return {
          success: false,
          error: `Worktree has ${parts.join(' and ')}. Removing will discard this work permanently. Confirm with the user, then re-invoke with discard_changes: true — or use action: "keep" to preserve the worktree.`,
        }
      }
    }

    try {
      if (action === 'keep') {
        // Just clear session state, leave worktree on disk, restore workspace.
        saveWorktreeState(null)
        setWorkspacePath(originalWorkspacePath)
        fireCwdChangedHooks({
          previous_cwd: worktreePath,
          cwd: restoreDisplay,
          worktree_path: worktreePath,
          action: 'keep',
        })

        return {
          success: true,
          output: `Exited worktree. Your work is preserved at ${worktreePath} on branch ${worktreeBranch}. Session is now back in ${restoreDisplay}.`,
        }
      }

      // action === 'remove'
      const { changedFiles, commits } = await countWorktreeChanges(worktreePath, originalHeadCommit)

      // Remove a node_modules junction/symlink first so the recursive fallback
      // can never follow it into the main repo's dependency tree.
      await unlinkNodeModulesLink(worktreePath)

      // Remove the worktree via git
      try {
        await git(['worktree', 'remove', worktreePath, '--force'], mainRepoRoot)
      } catch {
        // If git worktree remove fails, try manual cleanup
        try {
          await fs.promises.rm(worktreePath, { recursive: true, force: true })
        } catch {
          // ignore
        }
      }

      // Delete the branch
      try {
        await git(['branch', '-D', worktreeBranch], mainRepoRoot)
      } catch {
        // Branch might not exist or have merged commits — ignore
      }

      // Drop any stale worktree registration left behind (e.g. a prior crash
      // or a manual-fs fallback that bypassed `git worktree remove`).
      try {
        await git(['worktree', 'prune'], mainRepoRoot)
      } catch {
        // best-effort
      }

      // Restore session + workspace path.
      saveWorktreeState(null)
      setWorkspacePath(originalWorkspacePath)
      fireCwdChangedHooks({
        previous_cwd: worktreePath,
        cwd: restoreDisplay,
        worktree_path: worktreePath,
        action: 'remove',
      })

      fireWorktreeRemoveHooks({
        worktree_path: worktreePath,
        worktree_branch: worktreeBranch,
        original_cwd: restoreDisplay,
        action: 'remove',
      })

      const discardParts: string[] = []
      if (commits > 0) discardParts.push(`${commits} ${commits === 1 ? 'commit' : 'commits'}`)
      if (changedFiles > 0) discardParts.push(`${changedFiles} uncommitted ${changedFiles === 1 ? 'file' : 'files'}`)
      const discardNote = discardParts.length > 0 ? ` Discarded ${discardParts.join(' and ')}.` : ''

      return {
        success: true,
        output: `Exited and removed worktree at ${worktreePath}.${discardNote} Session is now back in ${restoreDisplay}.`,
      }
    } catch (e) {
      return {
        success: false,
        error: `Failed to exit worktree: ${(e as Error).message}`,
      }
    }
  },
})
