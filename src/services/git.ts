/**
 * Renderer bridge for local Git (IPC → main `simple-git`).
 */

export type GitStatusPayload =
  | {
      ok: true
      isRepo: true
      branch: string
      detached: boolean
      ahead: number
      behind: number
      tracking: string | null
      staged: Array<{ path: string; fromPath?: string; status: string }>
      unstaged: Array<{ path: string; fromPath?: string; status: string }>
      totalCount: number
      truncated: boolean
    }
  | { ok: true; isRepo: false }
  | { ok: false; error: string }

function getApi() {
  return typeof window !== 'undefined' ? window.electronAPI?.git : undefined
}

export async function gitStatus(workspaceRoot: string): Promise<GitStatusPayload> {
  const git = getApi()
  if (!git) return { ok: false, error: 'Git API unavailable (not in Electron).' }
  const r = await git.status(workspaceRoot)
  if (!r.success) return { ok: false, error: r.error || 'Unknown error' }
  const s = r.status as
    | {
        ok: true
        isRepo: false
      }
    | {
        ok: true
        isRepo: true
        branch: string
        detached: boolean
        ahead: number
        behind: number
        tracking: string | null
        staged: Array<{ path: string; fromPath?: string; status: string }>
        unstaged: Array<{ path: string; fromPath?: string; status: string }>
        totalCount?: number
        truncated?: boolean
      }
    | { ok: false; error: string }
  if (!s || typeof s !== 'object') return { ok: false, error: 'Invalid status response' }
  if (!('ok' in s) || !s.ok) {
    return { ok: false, error: 'error' in s ? (s as { error: string }).error : 'Invalid status' }
  }
  if (!s.isRepo) return { ok: true, isRepo: false }
  const full = s as Extract<typeof s, { isRepo: true }>
  return {
    ok: true,
    isRepo: true,
    branch: full.branch ?? '',
    detached: Boolean(full.detached),
    ahead: full.ahead ?? 0,
    behind: full.behind ?? 0,
    tracking: full.tracking ?? null,
    staged: full.staged ?? [],
    unstaged: full.unstaged ?? [],
    totalCount:
      typeof full.totalCount === 'number'
        ? full.totalCount
        : (full.staged?.length ?? 0) + (full.unstaged?.length ?? 0),
    truncated: full.truncated === true,
  }
}

export async function gitInit(workspaceRoot: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const git = getApi()
  if (!git) return { ok: false, error: 'Git API unavailable.' }
  const r = await git.init(workspaceRoot)
  return r.success ? { ok: true } : { ok: false, error: r.error || 'init failed' }
}

export type GitAddAllMode = 'all' | 'tracked'

export async function gitAdd(
  workspaceRoot: string,
  paths: string[] | GitAddAllMode,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const git = getApi()
  if (!git) return { ok: false, error: 'Git API unavailable.' }
  const r = await git.add(workspaceRoot, paths)
  return r.success ? { ok: true } : { ok: false, error: r.error || 'add failed' }
}

export async function gitCheckoutCommitPaths(
  workspaceRoot: string,
  hash: string,
  paths: string[],
): Promise<{ ok: true } | { ok: false; error: string }> {
  const git = getApi()
  if (!git?.checkoutCommitPaths) {
    return { ok: false, error: 'checkoutCommitPaths API unavailable.' }
  }
  const r = await git.checkoutCommitPaths(workspaceRoot, hash, paths)
  return r.success ? { ok: true } : { ok: false, error: r.error || 'checkout failed' }
}

export async function gitUnstage(
  workspaceRoot: string,
  paths: string[],
): Promise<{ ok: true } | { ok: false; error: string }> {
  const git = getApi()
  if (!git) return { ok: false, error: 'Git API unavailable.' }
  const r = await git.unstage(workspaceRoot, paths)
  return r.success ? { ok: true } : { ok: false, error: r.error || 'unstage failed' }
}

export type GitCommitResult = {
  ok: true
  commit: string
  branch: string
  changes: number
  insertions: number
  deletions: number
}

export async function gitCommit(
  workspaceRoot: string,
  message: string,
): Promise<GitCommitResult | { ok: false; error: string }> {
  const git = getApi()
  if (!git) return { ok: false, error: 'Git API unavailable.' }
  const r = await git.commit(workspaceRoot, message)
  if (!r.success) return { ok: false, error: r.error || 'commit failed' }
  return {
    ok: true,
    commit: String(r.commit ?? ''),
    branch: String(r.branch ?? ''),
    changes: Number(r.changes ?? 0),
    insertions: Number(r.insertions ?? 0),
    deletions: Number(r.deletions ?? 0),
  }
}

export type GitLogEntry = { hash: string; date: string; message: string; author: string }

export type GitCommitFile = { status: string; path: string; fromPath?: string }

export async function gitCommitFiles(
  workspaceRoot: string,
  hash: string,
): Promise<{ ok: true; files: GitCommitFile[] } | { ok: false; error: string }> {
  const git = getApi()
  if (!git?.commitFiles) return { ok: false, error: 'commitFiles API unavailable.' }
  const r = await git.commitFiles(workspaceRoot, hash)
  if (!r.success) return { ok: false, error: r.error || 'commit-files failed' }
  return { ok: true, files: (r.files as GitCommitFile[]) ?? [] }
}

export type GitRestoreMode = 'worktree' | 'head' | 'untracked'

export async function gitRestorePaths(
  workspaceRoot: string,
  paths: string[],
  mode: GitRestoreMode,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const git = getApi()
  if (!git?.restore) return { ok: false, error: 'Git restore API unavailable.' }
  const r = await git.restore(workspaceRoot, paths, mode)
  return r.success ? { ok: true } : { ok: false, error: r.error || 'restore failed' }
}

export type GitIdentityScope = 'global' | 'local'

export type GitIdentity = {
  globalName: string
  globalEmail: string
  localName: string
  localEmail: string
}

export async function gitGetIdentity(
  workspaceRoot: string,
): Promise<{ ok: true; identity: GitIdentity } | { ok: false; error: string }> {
  const git = getApi()
  if (!git?.getIdentity) return { ok: false, error: 'Git identity API unavailable.' }
  const r = await git.getIdentity(workspaceRoot)
  if (!r.success) return { ok: false, error: r.error || 'get-identity failed' }
  return {
    ok: true,
    identity: {
      globalName: r.globalName ?? '',
      globalEmail: r.globalEmail ?? '',
      localName: r.localName ?? '',
      localEmail: r.localEmail ?? '',
    },
  }
}

export async function gitSetIdentity(
  workspaceRoot: string,
  name: string,
  email: string,
  scope: GitIdentityScope,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const git = getApi()
  if (!git?.setIdentity) return { ok: false, error: 'Git identity API unavailable.' }
  const r = await git.setIdentity(workspaceRoot, name, email, scope)
  return r.success ? { ok: true } : { ok: false, error: r.error || 'set-identity failed' }
}

export function isGitIdentityMissingError(errorMsg: string | null | undefined): boolean {
  if (!errorMsg) return false
  const m = errorMsg.toLowerCase()
  return (
    m.includes('author identity unknown') ||
    m.includes('please tell me who you are') ||
    m.includes('empty ident name') ||
    (m.includes('user.name') && m.includes('user.email'))
  )
}

export async function gitLog(
  workspaceRoot: string,
  limit?: number,
): Promise<{ ok: true; entries: GitLogEntry[] } | { ok: false; error: string }> {
  const git = getApi()
  if (!git) return { ok: false, error: 'Git API unavailable.' }
  const r = await git.log(workspaceRoot, limit)
  if (!r.success) return { ok: false, error: r.error || 'log failed' }
  return { ok: true, entries: (r.entries as GitLogEntry[]) ?? [] }
}
