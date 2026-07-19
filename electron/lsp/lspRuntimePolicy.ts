/**
 * When to start / load workspace-bound LSP — aligns with upstream §4.1–4.2 spirit.
 */

import { isWorkspaceTrusted } from '../security/workspaceTrust'

/** Script / automation: no LSP subprocesses (cf. upstream `isBareMode`). */
export function isLspBareMode(): boolean {
  if (process.env.ASTRA_LSP_BARE === '1' || process.env.ASTRA_BARE === '1') {
    return true
  }
  const a = process.argv
  return a.includes('--bare') || a.includes('--simple')
}

/**
 * Workspace path passed to {@link loadLspConfigs} for project `.lsp.json` / skill `workspaceFolder`.
 * `undefined` when bare, no folder, or folder not yet trusted.
 */
export function resolveTrustedWorkspaceForLspLoad(requestedWorkspace?: string | null): string | undefined {
  if (isLspBareMode()) return undefined
  const w = typeof requestedWorkspace === 'string' ? requestedWorkspace.trim() : ''
  if (!w) return undefined
  if (!isWorkspaceTrusted(w)) return undefined
  return w
}

export function shouldSkipLspInitialization(): boolean {
  return isLspBareMode()
}
