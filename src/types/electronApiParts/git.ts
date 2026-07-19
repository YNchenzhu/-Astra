/**
 * Local Git operations via `simple-git` in the main process.
 * Every method resolves workspaceRoot through the workspace-access
 * guard, so passing a path outside the currently trusted workspace
 * will be rejected with `{ success: false, error }`.
 */
export interface ElectronGitApi {
  status: (
    workspaceRoot: string,
  ) => Promise<{ success: boolean; status?: unknown; error?: string }>
  init: (workspaceRoot: string) => Promise<{ success: boolean; error?: string }>
  add: (
    workspaceRoot: string,
    paths: string[] | 'all' | 'tracked',
  ) => Promise<{ success: boolean; error?: string }>
  unstage: (
    workspaceRoot: string,
    paths: string[],
  ) => Promise<{ success: boolean; error?: string }>
  commit: (
    workspaceRoot: string,
    message: string,
  ) => Promise<{
    success: boolean
    error?: string
    commit?: string
    branch?: string
    changes?: number
    insertions?: number
    deletions?: number
  }>
  commitFiles: (
    workspaceRoot: string,
    hash: string,
  ) => Promise<{ success: boolean; files?: unknown[]; error?: string }>
  log: (
    workspaceRoot: string,
    limit?: number,
  ) => Promise<{ success: boolean; entries?: unknown[]; error?: string }>
  getIdentity: (
    workspaceRoot: string,
  ) => Promise<{
    success: boolean
    globalName?: string
    globalEmail?: string
    localName?: string
    localEmail?: string
    error?: string
  }>
  setIdentity: (
    workspaceRoot: string,
    name: string,
    email: string,
    scope: 'global' | 'local',
  ) => Promise<{ success: boolean; error?: string }>
  restore: (
    workspaceRoot: string,
    paths: string[],
    mode: 'worktree' | 'head' | 'untracked',
  ) => Promise<{ success: boolean; error?: string }>
  checkoutCommitPaths: (
    workspaceRoot: string,
    hash: string,
    paths: string[],
  ) => Promise<{ success: boolean; error?: string }>
}
