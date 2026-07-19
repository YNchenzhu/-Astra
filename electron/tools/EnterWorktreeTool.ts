/**
 * EnterWorktreeTool — Create an isolated git worktree and switch the session into it.
 *
 * Simplified port from upstream's EnterWorktreeTool, adapted for cursor-ui-clone.
 * Uses git worktree add under the hood, stores session state in memory.
 *
 * Isolation model: the main chat session owns the single global workspace path
 * (`workspaceState`). Entering a worktree redirects that global path to the
 * worktree directory so subsequent file tools (read/write/edit) actually land
 * inside the worktree; ExitWorktree restores the original path. Because the
 * workspace path is process-global, only ONE worktree session can be active at
 * a time — a synchronous in-flight guard closes the create race.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { enterWorktreeInputZod } from './toolInputZod'
import { fireWorktreeCreateHooks } from './hooks/runtimeHookBridges'
import { buildTool } from './buildTool'
import { getWorkspacePath, setWorkspacePath } from './workspaceState'

const execFileAsync = promisify(execFile)

// ========== Session state (module-level, per-process) ==========

interface WorktreeSession {
  sessionId: string
  worktreePath: string
  worktreeBranch: string
  /** git toplevel of the main repo — used as cwd for ExitWorktree git ops. */
  mainRepoRoot: string
  /** Global workspace path before entering — restored on exit. */
  originalWorkspacePath: string | null
  /** HEAD commit of the main repo at creation — baseline for new-commit count. */
  originalHeadCommit: string | undefined
  createdAt: number
}

let currentWorktreeSession: WorktreeSession | null = null
/**
 * Synchronous reservation flag. Set BEFORE the first await in `call` so two
 * concurrent EnterWorktree invocations can't both pass the `currentWorktreeSession`
 * guard, each `git worktree add`, and leak the loser's worktree (TOCTOU).
 */
let worktreeOperationInFlight = false

export function getCurrentWorktreeSession(): WorktreeSession | null {
  return currentWorktreeSession
}

export function saveWorktreeState(session: WorktreeSession | null): void {
  currentWorktreeSession = session
}

// ========== Helper: run git with array args (no shell interpolation) ==========

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf-8' })
  return stdout
}

// ========== Helper: find git root ==========

async function findGitRoot(cwd: string): Promise<string | null> {
  try {
    return (await git(['rev-parse', '--show-toplevel'], cwd)).trim()
  } catch {
    return null
  }
}

// ========== Helper: get current HEAD commit ==========

async function getHeadCommit(cwd: string): Promise<string | undefined> {
  try {
    return (await git(['rev-parse', 'HEAD'], cwd)).trim()
  } catch {
    return undefined
  }
}

// ========== Helper: validate worktree slug ==========

function validateWorktreeSlug(slug: string): void {
  if (slug.length > 64) throw new Error('Worktree name must be at most 64 characters')
  if (path.isAbsolute(slug)) {
    throw new Error('Worktree name must be a relative name, not an absolute path')
  }
  const segments = slug.split('/')
  for (const segment of segments) {
    if (!/^[a-zA-Z0-9._-]+$/.test(segment)) {
      throw new Error('Each segment of worktree name may only contain letters, digits, dots, underscores, and dashes')
    }
    // Reject path-traversal segments. The character class above allows dots,
    // so "." and ".." would otherwise slip through and let a crafted name
    // escape `.claude/worktrees/` (e.g. "../../evil").
    if (segment === '.' || segment === '..') {
      throw new Error('Worktree name segments may not be "." or ".."')
    }
  }
}

// ========== Helper: generate random slug ==========

function generateSlug(): string {
  return `wt-${crypto.randomBytes(4).toString('hex')}`
}

// ========== Helper: does a local branch already exist? ==========

async function branchExists(mainRepoRoot: string, branch: string): Promise<boolean> {
  try {
    await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], mainRepoRoot)
    return true
  } catch {
    return false
  }
}

// ========== Helper: resolve a unique (dir, branch) pair ==========
//
// Aligns with `worktreeAllocator.uniqueWorktreeRecord`: a user-supplied (or
// generated) slug may collide with a leftover worktree from a prior
// `action: "keep"`. Append -1, -2, … until both the directory and the branch
// are free so `git worktree add` doesn't fail on a name clash.
async function resolveUniqueWorktree(
  mainRepoRoot: string,
  baseSlug: string,
): Promise<{ dir: string; branch: string; slug: string }> {
  const baseDir = path.join(mainRepoRoot, '.claude', 'worktrees')
  for (let i = 0; i < 1000; i++) {
    const suffix = i === 0 ? '' : `-${i}`
    const slug = `${baseSlug}${suffix}`
    const dir = path.join(baseDir, slug)
    const branch = `worktree/${slug}`
    if (!fs.existsSync(dir) && !(await branchExists(mainRepoRoot, branch))) {
      return { dir, branch, slug }
    }
  }
  const fallback = `${baseSlug}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`
  return {
    dir: path.join(baseDir, fallback),
    branch: `worktree/${fallback}`,
    slug: fallback,
  }
}

// ========== Tool definition ==========

export const enterWorktreeTool = buildTool({
  name: 'EnterWorktree',
  zInputSchema: enterWorktreeInputZod,
  description:
    'Creates an isolated git worktree inside .claude/worktrees/ with a new branch and switches the working session into it. Use ExitWorktree to leave. Only use when the user explicitly mentions "worktree".',
  inputSchema: [
    {
      name: 'name',
      type: 'string',
      description: 'Optional name for the worktree. Each "/"-separated segment may contain only letters, digits, dots, underscores, and dashes; max 64 chars total. A random name is generated if not provided.',
      required: false,
    },
    {
      name: 'link_node_modules',
      type: 'boolean',
      description:
        'When true and the main repo has `node_modules`, create a directory junction (Windows) or symlink (Unix) at `<worktree>/node_modules` pointing at the main repo `node_modules` (OpenClaude §10.5-style dev install parity).',
      required: false,
    },
  ],
  isReadOnly: false,
  isConcurrencySafe: false,

  async call({ name, link_node_modules }) {
    // Guard: not already in a worktree, and no concurrent create in flight.
    // Both checks run synchronously before any await to close the TOCTOU race.
    if (currentWorktreeSession || worktreeOperationInFlight) {
      return {
        success: false,
        error: 'Already in a worktree session (or one is being created). Use ExitWorktree to leave first.',
      }
    }
    worktreeOperationInFlight = true

    try {
      const cwd = getWorkspacePath() ?? process.cwd()
      const gitRoot = await findGitRoot(cwd)
      if (!gitRoot) {
        return {
          success: false,
          error: 'Not inside a git repository. Worktree mode requires a git repository.',
        }
      }

      // Resolve to main repo root
      const mainRepoRoot = gitRoot

      // Validate or generate slug
      const baseSlug = name ?? generateSlug()
      try {
        validateWorktreeSlug(baseSlug)
      } catch (e) {
        return {
          success: false,
          error: `Invalid worktree name: ${(e as Error).message}`,
        }
      }

      const { dir: worktreeDir, branch: branchName } = await resolveUniqueWorktree(
        mainRepoRoot,
        baseSlug,
      )
      const originalHeadCommit = await getHeadCommit(mainRepoRoot)
      const originalWorkspacePath = getWorkspacePath()

      try {
        // Create worktree directory
        await fs.promises.mkdir(path.join(mainRepoRoot, '.claude', 'worktrees'), { recursive: true })

        // Create git worktree with new branch
        await git(['worktree', 'add', '-b', branchName, worktreeDir, 'HEAD'], mainRepoRoot)

        // Redirect the global workspace path so subsequent file tools operate
        // INSIDE the worktree. This is what makes the isolation real.
        setWorkspacePath(worktreeDir)

        // Save session state
        const session: WorktreeSession = {
          sessionId: crypto.randomUUID(),
          worktreePath: worktreeDir,
          worktreeBranch: branchName,
          mainRepoRoot,
          originalWorkspacePath,
          originalHeadCommit,
          createdAt: Date.now(),
        }
        currentWorktreeSession = session

        fireWorktreeCreateHooks({
          worktree_path: worktreeDir,
          worktree_branch: branchName,
          main_repo_root: mainRepoRoot,
          original_cwd: originalWorkspacePath ?? cwd,
        })

        let nmNote = ''
        if (link_node_modules === true) {
          const mainNm = path.join(mainRepoRoot, 'node_modules')
          const wtNm = path.join(worktreeDir, 'node_modules')
          if (fs.existsSync(mainNm)) {
            try {
              if (process.platform === 'win32') {
                await execFileAsync('cmd', ['/c', 'mklink', '/J', wtNm, mainNm], {
                  cwd: worktreeDir,
                  encoding: 'utf-8',
                })
                nmNote = `\nLinked node_modules: junction ${wtNm} -> ${mainNm}`
              } else {
                const rel = path.relative(worktreeDir, mainNm)
                await fs.promises.symlink(rel, wtNm, 'dir')
                nmNote = `\nLinked node_modules: symlink ${wtNm} -> ${rel}`
              }
            } catch (e) {
              nmNote = `\n(node_modules link skipped: ${(e as Error).message})`
            }
          } else {
            nmNote = '\n(link_node_modules requested but main repo has no node_modules directory)'
          }
        }

        return {
          success: true,
          output: `Created worktree at ${worktreeDir} on branch ${branchName}. The session is now working in the worktree. Use ExitWorktree to leave mid-session, or exit the session to be prompted.${nmNote}`,
        }
      } catch (e) {
        // Clean up partial worktree on failure, and make sure we did not leave
        // the global workspace path pointing at a half-created worktree.
        setWorkspacePath(originalWorkspacePath)
        currentWorktreeSession = null
        try {
          await git(['worktree', 'remove', worktreeDir, '--force'], mainRepoRoot)
        } catch {
          // ignore cleanup failure
        }
        return {
          success: false,
          error: `Failed to create worktree: ${(e as Error).message}`,
        }
      }
    } finally {
      worktreeOperationInFlight = false
    }
  },
})
