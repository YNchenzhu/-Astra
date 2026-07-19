/**
 * Local Git operations for the workspace (via `simple-git` → system `git`).
 */

import simpleGit from 'simple-git'
import fs from 'node:fs'
import path from 'node:path'

export type GitFileUiStatus =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'untracked'
  | 'renamed'
  | 'unknown'

export type GitStatusFile = {
  path: string
  fromPath?: string
  status: GitFileUiStatus
}

export type GitStatusResult =
  | {
      ok: true
      isRepo: true
      branch: string
      detached: boolean
      ahead: number
      behind: number
      tracking: string | null
      staged: GitStatusFile[]
      unstaged: GitStatusFile[]
      /** Total entries before any truncation (staged + unstaged + untracked). */
      totalCount: number
      /** True when the returned arrays were truncated to keep IPC + render cost bounded. */
      truncated: boolean
    }
  | { ok: true; isRepo: false }
  | { ok: false; error: string }

/** Hard cap to keep IPC payload + DOM cost bounded after `git init` on big directories. */
const MAX_STATUS_ENTRIES_PER_LIST = 1000

function mapIndexCode(c: string): GitFileUiStatus {
  switch (c) {
    case 'A':
      return 'added'
    case 'M':
      return 'modified'
    case 'D':
      return 'deleted'
    case 'R':
      return 'renamed'
    case '?':
      return 'untracked'
    default:
      return 'unknown'
  }
}

function pushFromFileStatus(
  f: { path: string; index: string; working_dir: string; from?: string },
  which: 'index' | 'working_dir',
): GitStatusFile | null {
  if (which === 'index') {
    if (f.index === ' ' || f.index === '' || f.index === '?') return null
    return { path: f.path, fromPath: f.from, status: mapIndexCode(f.index) }
  }
  if (f.index === '?' && f.working_dir === '?') {
    return { path: f.path, status: 'untracked' }
  }
  if (f.working_dir === ' ' || f.working_dir === '') return null
  return { path: f.path, fromPath: f.from, status: mapIndexCode(f.working_dir) }
}

export async function getGitStatus(cwd: string): Promise<GitStatusResult> {
  try {
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
      return { ok: false, error: 'Workspace path is not a directory.' }
    }
    const git = simpleGit(cwd)
    const isRepo = await git.checkIsRepo()
    if (!isRepo) {
      return { ok: true, isRepo: false }
    }

    const s = await git.status()
    const staged: GitStatusFile[] = []
    const unstaged: GitStatusFile[] = []

    for (const f of s.files) {
      const st = pushFromFileStatus(f, 'index')
      if (st) staged.push(st)
      const u = pushFromFileStatus(f, 'working_dir')
      if (u) unstaged.push(u)
    }

    const unstagedSet = new Set(unstaged.map((x) => x.path))
    for (const p of s.not_added) {
      if (!unstagedSet.has(p)) {
        unstaged.push({ path: p, status: 'untracked' })
        unstagedSet.add(p)
      }
    }

    const totalCount = staged.length + unstaged.length
    const truncatedStaged = staged.length > MAX_STATUS_ENTRIES_PER_LIST
    const truncatedUnstaged = unstaged.length > MAX_STATUS_ENTRIES_PER_LIST
    const truncated = truncatedStaged || truncatedUnstaged
    const stagedOut = truncatedStaged ? staged.slice(0, MAX_STATUS_ENTRIES_PER_LIST) : staged
    const unstagedOut = truncatedUnstaged
      ? unstaged.slice(0, MAX_STATUS_ENTRIES_PER_LIST)
      : unstaged

    return {
      ok: true,
      isRepo: true,
      branch: s.current || '(unknown)',
      detached: Boolean(s.detached),
      ahead: s.ahead,
      behind: s.behind,
      tracking: s.tracking,
      staged: stagedOut,
      unstaged: unstagedOut,
      totalCount,
      truncated,
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (/not a git repository/i.test(msg)) {
      return { ok: true, isRepo: false }
    }
    return { ok: false, error: msg }
  }
}

export async function gitInit(cwd: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const git = simpleGit(cwd)
    try {
      await git.raw(['init', '--initial-branch=main'])
    } catch {
      await git.init()
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export type GitAddAllMode = 'all' | 'tracked'

export async function gitAdd(
  cwd: string,
  paths: string[] | GitAddAllMode,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const git = simpleGit(cwd)
    if (paths === 'all') {
      // `-A` stages everything: modified, deleted, AND new untracked files.
      await git.add(['-A'])
    } else if (paths === 'tracked') {
      // `-u` stages modifications + deletions for *already tracked* files,
      // but deliberately excludes untracked ones. Useful when you have a
      // noisy untracked file (log, build artifact) you haven't .gitignored
      // yet and still want a quick "stage everything else" path.
      await git.add(['-u'])
    } else if (paths.length === 0) {
      await git.add(['-A'])
    } else {
      await git.add(paths)
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * Restore one or more paths from a specific commit into the working tree
 * (leaves the index untouched), i.e. `git checkout <hash> -- <paths>`.
 *
 * Used by the history browser's "将此版本恢复到工作区" action. The hash is
 * validated to prevent injection via the commit-id argument; paths have
 * already been resolved by `safeRelPath` at the handler layer.
 */
export async function gitCheckoutPathsFromCommit(
  cwd: string,
  hash: string,
  paths: string[],
): Promise<{ ok: true } | { ok: false; error: string }> {
  const h = typeof hash === 'string' ? hash.trim() : ''
  if (!/^[0-9a-fA-F]{4,40}$/.test(h)) {
    return { ok: false, error: 'Invalid commit hash.' }
  }
  if (paths.length === 0) {
    return { ok: false, error: 'No paths.' }
  }
  try {
    const git = simpleGit(cwd)
    await git.raw(['checkout', h, '--', ...paths])
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function gitUnstage(
  cwd: string,
  paths: string[],
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const git = simpleGit(cwd)
    if (paths.length === 0) {
      return { ok: false, error: 'No paths to unstage.' }
    }
    await git.reset(['HEAD', '--', ...paths])
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export type GitCommitOk = {
  ok: true
  commit: string
  branch: string
  changes: number
  insertions: number
  deletions: number
}

export async function gitCommit(
  cwd: string,
  message: string,
): Promise<GitCommitOk | { ok: false; error: string }> {
  const msg = typeof message === 'string' ? message.trim() : ''
  if (!msg) {
    return { ok: false, error: 'Commit message is empty.' }
  }
  try {
    const git = simpleGit(cwd)
    const result = await git.commit(msg)
    const summary = (result as { summary?: { changes?: number; insertions?: number; deletions?: number } }).summary
    return {
      ok: true,
      commit: String(result.commit ?? ''),
      branch: String((result as { branch?: string }).branch ?? ''),
      changes: Number(summary?.changes ?? 0),
      insertions: Number(summary?.insertions ?? 0),
      deletions: Number(summary?.deletions ?? 0),
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export type GitLogEntry = { hash: string; date: string; message: string; author: string }

/**
 * Discard unstaged edits in the working tree (tracked paths). Same as `git restore -- <paths>`.
 */
export async function gitRestoreWorkingTree(
  cwd: string,
  paths: string[],
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (paths.length === 0) return { ok: false, error: 'No paths.' }
  try {
    const git = simpleGit(cwd)
    await git.raw(['restore', '--', ...paths])
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * Restore index + working tree to HEAD for the given paths (`git restore --source=HEAD --staged --worktree`).
 */
export async function gitRestorePathsToHead(
  cwd: string,
  paths: string[],
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (paths.length === 0) return { ok: false, error: 'No paths.' }
  try {
    const git = simpleGit(cwd)
    await git.raw(['restore', '--source=HEAD', '--staged', '--worktree', '--', ...paths])
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * Remove untracked files / directories (`git clean -fd -- <paths>`).
 * `-d` so untracked directories are also removed; `-f` because `clean.requireForce`
 * defaults to true. Explicit `paths` means we never wipe the whole workspace.
 */
export async function gitCleanUntrackedPaths(
  cwd: string,
  paths: string[],
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (paths.length === 0) return { ok: false, error: 'No paths.' }
  try {
    const git = simpleGit(cwd)
    await git.raw(['clean', '-fd', '--', ...paths])
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function gitLog(
  cwd: string,
  limit: number = 20,
): Promise<{ ok: true; entries: GitLogEntry[] } | { ok: false; error: string }> {
  try {
    const git = simpleGit(cwd)
    const log = await git.log({ maxCount: Math.min(100, Math.max(1, limit)) })
    const entries: GitLogEntry[] = log.all.map((c) => {
      const row = c as unknown as Record<string, unknown>
      const author =
        (typeof row.author_name === 'string' ? row.author_name : null) ||
        (typeof row.author === 'string' ? row.author : '') ||
        ''
      return {
        hash: String((row.hash as string) ?? ''),
        date: String((row.date as string) ?? ''),
        message: String((row.message as string) ?? ''),
        author,
      }
    })
    return { ok: true, entries }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * List files changed by a single commit (porcelain name-status, handles renames).
 * Uses `git show --name-status --format= <hash>` so it works for the **initial**
 * commit too (which has no parent).
 */
export async function getCommitFiles(
  cwd: string,
  hash: string,
): Promise<
  | { ok: true; files: Array<{ status: GitFileUiStatus; path: string; fromPath?: string }> }
  | { ok: false; error: string }
> {
  const h = typeof hash === 'string' ? hash.trim() : ''
  if (!/^[0-9a-fA-F]{4,40}$/.test(h)) {
    return { ok: false, error: 'Invalid commit hash.' }
  }
  try {
    const git = simpleGit(cwd)
    const out = await git.raw(['show', '--name-status', '--format=', '-z', h])
    const text = typeof out === 'string' ? out : ''
    const files: Array<{ status: GitFileUiStatus; path: string; fromPath?: string }> = []
    const parts = text.split('\0')
    let i = 0
    while (i < parts.length) {
      const code = (parts[i] ?? '').trim()
      if (!code) {
        i++
        continue
      }
      const head = code[0]
      if (head === 'R' || head === 'C') {
        const from = parts[i + 1] ?? ''
        const to = parts[i + 2] ?? ''
        if (to) {
          files.push({ status: 'renamed', path: to, fromPath: from || undefined })
        }
        i += 3
        continue
      }
      const p = parts[i + 1] ?? ''
      if (p) {
        files.push({
          status:
            head === 'A'
              ? 'added'
              : head === 'D'
                ? 'deleted'
                : head === 'M' || head === 'T'
                  ? 'modified'
                  : 'unknown',
          path: p,
        })
      }
      i += 2
    }
    return { ok: true, files }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** Git identity scope. `local` writes to `.git/config`; `global` to `~/.gitconfig`. */
export type GitIdentityScope = 'local' | 'global'

async function readConfigValue(
  cwd: string,
  key: string,
  scope: GitIdentityScope,
): Promise<string> {
  try {
    const git = simpleGit(cwd)
    const out = await git.raw(['config', `--${scope}`, '--get', key])
    return typeof out === 'string' ? out.trim() : ''
  } catch {
    return ''
  }
}

export async function getGitIdentity(cwd: string): Promise<{
  ok: true
  globalName: string
  globalEmail: string
  localName: string
  localEmail: string
} | { ok: false; error: string }> {
  try {
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
      return { ok: false, error: 'Workspace path is not a directory.' }
    }
    const [globalName, globalEmail] = await Promise.all([
      readConfigValue(cwd, 'user.name', 'global'),
      readConfigValue(cwd, 'user.email', 'global'),
    ])
    let localName = ''
    let localEmail = ''
    try {
      const git = simpleGit(cwd)
      if (await git.checkIsRepo()) {
        ;[localName, localEmail] = await Promise.all([
          readConfigValue(cwd, 'user.name', 'local'),
          readConfigValue(cwd, 'user.email', 'local'),
        ])
      }
    } catch {
      /* not a repo — leave local blank */
    }
    return { ok: true, globalName, globalEmail, localName, localEmail }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * Write `user.name` + `user.email` into global (`~/.gitconfig`) or local (`.git/config`).
 * For local scope we require a git repo. Global scope does not.
 */
export async function setGitIdentity(
  cwd: string,
  name: string,
  email: string,
  scope: GitIdentityScope,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const n = typeof name === 'string' ? name.trim() : ''
  const e = typeof email === 'string' ? email.trim() : ''
  if (!n || !e) {
    return { ok: false, error: 'Both name and email are required.' }
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
    return { ok: false, error: 'Invalid email format.' }
  }
  try {
    const git = simpleGit(cwd)
    if (scope === 'local') {
      const isRepo = await git.checkIsRepo()
      if (!isRepo) {
        return { ok: false, error: 'Current folder is not a git repository. Initialize or use Global scope.' }
      }
    }
    await git.raw(['config', `--${scope}`, 'user.name', n])
    await git.raw(['config', `--${scope}`, 'user.email', e])
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export function safeRelPath(
  cwd: string,
  rel: string,
): { ok: true; path: string } | { ok: false; error: string } {
  const trimmed = String(rel).trim().replace(/\\/g, '/')
  if (!trimmed || trimmed.includes('\0')) {
    return { ok: false, error: 'Invalid path.' }
  }
  const resolved = path.resolve(cwd, trimmed)
  const normCwd = path.resolve(cwd).toLowerCase()
  const normRes = path.resolve(resolved).toLowerCase()
  const prefix = normCwd.endsWith(path.sep) ? normCwd : normCwd + path.sep
  if (normRes !== normCwd && !normRes.startsWith(prefix)) {
    return { ok: false, error: 'Path escapes workspace.' }
  }
  return { ok: true, path: path.relative(cwd, resolved).replace(/\\/g, '/') }
}
