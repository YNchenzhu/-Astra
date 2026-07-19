/**
 * Concrete {@link WorktreeAllocator} implementation for
 * {@link MultiAgentOrchestrator}.
 *
 * Strategy:
 *   1. When the current workspace is inside a git repo, create a real
 *      `git worktree` under `.claude/worktrees/` so file writes are
 *      isolated and the user can later inspect / cherry-pick changes.
 *   2. When not in a git repo, fall back to `fs.mkdtempSync` under the
 *      system temp directory (still isolated, but no VCS tracking).
 *
 * Allocation path (`allocate`):
 *   - Git case: `git worktree add -b <branch> <path> HEAD`
 *   - No-git case: `fs.mkdtempSync(os.tmpdir() + '/pole-wt-XXXXXX')`
 *
 * Release path (`release`):
 *   - Git case: `git worktree remove --force <path>` + `git branch -D <branch>`
 *   - No-git case: `fs.rmSync(<path>, { recursive: true })`
 *
 * Both paths are defensive: failures are logged but never thrown, so an
 * orchestrator cleanup cascade cannot be blocked by a stale worktree.
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { WorktreeAllocator } from './multiAgent'
import { getWorkspacePath } from '../tools/workspaceState'

interface AllocatedWorktree {
  path: string
  branch?: string
  gitRoot?: string
}

const allocatedWorktrees = new Map<string, AllocatedWorktree>()

function findGitRoot(cwd: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
  } catch {
    return null
  }
}

function slugFor(params: {
  parentConversationId?: string
  childKernelId: string
  agentType: string
}): string {
  const parts = [
    params.agentType.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 32),
    params.childKernelId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 32),
  ]
  return parts.join('-')
}

function uniqueWorktreeRecord(gitRoot: string, slug: string): { dir: string; branch: string } {
  const baseDir = path.join(gitRoot, '.claude', 'worktrees')
  for (let i = 0; i < 1000; i++) {
    const suffix = i === 0 ? '' : `-${i}`
    const dir = path.join(baseDir, `${slug}${suffix}`)
    const branch = `worktree/${slug}${suffix}`
    if (!fs.existsSync(dir) && !allocatedWorktrees.has(dir)) {
      return { dir, branch }
    }
  }
  const fallback = `${slug}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  return {
    dir: path.join(baseDir, fallback),
    branch: `worktree/${fallback}`,
  }
}

export const concreteWorktreeAllocator: WorktreeAllocator = {
  allocate(params): string {
    // Prefer the trusted workspace root over `process.cwd()`. `process.cwd()`
    // is process-global and historically perturbed by `process.chdir`; the
    // workspace path is the authoritative root the file tools resolve against.
    const cwd = getWorkspacePath() ?? process.cwd()
    const gitRoot = findGitRoot(cwd)

    if (gitRoot) {
      const slug = slugFor(params)
      const { dir: worktreeDir, branch: branchName } = uniqueWorktreeRecord(gitRoot, slug)

      fs.mkdirSync(path.join(gitRoot, '.claude', 'worktrees'), { recursive: true })
      execFileSync('git', ['worktree', 'add', '-b', branchName, worktreeDir, 'HEAD'], {
        cwd: gitRoot,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      allocatedWorktrees.set(worktreeDir, { path: worktreeDir, branch: branchName, gitRoot })
      return worktreeDir
    }

    // Fallback: temp directory outside any git repo
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pole-wt-'))
    allocatedWorktrees.set(tmpDir, { path: tmpDir })
    return tmpDir
  },

  release(worktreePath): void {
    const rec = allocatedWorktrees.get(worktreePath)
    allocatedWorktrees.delete(worktreePath)

    if (!rec) {
      // We didn't allocate this path (e.g. the in-memory map was lost across a
      // restart). Best-effort cleanup: derive the git root from the path BEFORE
      // deleting so we can prune the dangling registration afterwards.
      const derivedGitRoot = findGitRoot(path.dirname(worktreePath))
      try {
        fs.rmSync(worktreePath, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
      if (derivedGitRoot) {
        try {
          execFileSync('git', ['worktree', 'prune'], {
            cwd: derivedGitRoot,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
          })
        } catch {
          /* best-effort */
        }
      }
      return
    }

    if (rec.gitRoot && rec.branch) {
      // Git worktree path
      try {
        execFileSync('git', ['worktree', 'remove', worktreePath, '--force'], {
          cwd: rec.gitRoot,
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        })
      } catch (e) {
        console.warn('[WorktreeAllocator] git worktree remove failed:', e)
        // Best-effort manual cleanup
        try {
          fs.rmSync(worktreePath, { recursive: true, force: true })
        } catch {
          /* ignore */
        }
      }
      try {
        execFileSync('git', ['branch', '-D', rec.branch], {
          cwd: rec.gitRoot,
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        })
      } catch {
        // Branch might not exist or have merged commits — ignore
      }
      // Drop any stale worktree registration so `.git/worktrees` doesn't
      // accumulate dangling entries (e.g. when the manual-fs fallback above
      // bypassed `git worktree remove`, or after an unclean prior shutdown).
      try {
        execFileSync('git', ['worktree', 'prune'], {
          cwd: rec.gitRoot,
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        })
      } catch {
        // best-effort
      }
      return
    }

    // Fallback temp directory
    try {
      fs.rmSync(worktreePath, { recursive: true, force: true })
    } catch (e) {
      console.warn('[WorktreeAllocator] temp dir cleanup failed:', e)
    }
  },
}
