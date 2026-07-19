/**
 * IPC: workspace trust for LSP / project-scoped servers (upstream §4.1 parity).
 */

import type { IpcMain } from 'electron'
import { app } from 'electron'
import {
  addTrustedWorkspaceRoot,
  isWorkspaceTrusted,
  listTrustedWorkspaceRoots,
  removeTrustedWorkspaceRoot,
} from './workspaceTrust'
import { invalidateAcceptCache } from './workspaceAccept'
import { reinitializeLspServerManager } from '../lsp/manager'
import { getWorkspacePath } from '../tools/workspaceState'

export function registerWorkspaceTrustHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('workspace-trust:check', (_e, payload: { path: string }) => {
    const p = typeof payload?.path === 'string' ? payload.path.trim() : ''
    if (!p) return { trusted: false }
    return { trusted: isWorkspaceTrusted(p) }
  })

  ipcMain.handle('workspace-trust:list', () => ({
    roots: listTrustedWorkspaceRoots(),
  }))

  ipcMain.handle('workspace-trust:add', (_e, payload: { path: string }) => {
    const p = typeof payload?.path === 'string' ? payload.path.trim() : ''
    if (!p) return { success: false, error: 'path required' }
    addTrustedWorkspaceRoot(p)
    // Audit fix A2 (2026-05) — invalidate the boundary check cache so
    // the next acceptance call re-reads the trust list (instead of
    // returning a stale "untrusted" from before this add).
    invalidateAcceptCache('workspace-trust:add')
    const userData = app.getPath('userData')
    const current = getWorkspacePath()
    reinitializeLspServerManager(current ?? undefined, userData, {
      bypassOpenclaudeNotStarted: true,
    })
    return { success: true }
  })

  ipcMain.handle('workspace-trust:remove', (_e, payload: { path: string }) => {
    const p = typeof payload?.path === 'string' ? payload.path.trim() : ''
    if (!p) return { success: false, error: 'path required' }
    removeTrustedWorkspaceRoot(p)
    invalidateAcceptCache('workspace-trust:remove')
    const userData = app.getPath('userData')
    const current = getWorkspacePath()
    reinitializeLspServerManager(current ?? undefined, userData, {
      bypassOpenclaudeNotStarted: true,
    })
    return { success: true }
  })
}
