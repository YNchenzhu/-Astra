/**
 * Main-process IPC for renderer LSP integration (preload: lsp.syncDocument / lsp.syncDiagnostics).
 */

import type { IpcMain } from 'electron'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import type {
  Command,
  CodeAction,
  Range,
  WorkspaceEdit,
} from 'vscode-languageserver-protocol'
import { diagnosticsStore } from '../tools/DiagnosticsStore'
import { handleRendererDocumentSync } from './rendererDocumentSync'
import { getDiagnosticsHub } from '../diagnostics/DiagnosticsHub'
import { getLspServerManager } from './manager'
import { applyWorkspaceEdit } from './applyWorkspaceEdit'

export function registerLspIpcHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(
    'lsp:sync-document',
    async (_event, params: { filePath: string; action: string; content?: string }) => {
      return handleRendererDocumentSync({
        filePath: params.filePath,
        action: params.action as 'open' | 'change' | 'close' | 'save',
        content: params.content,
      })
    },
  )

  ipcMain.handle(
    'lsp:sync-diagnostics',
    async (
      _event,
      params: { uri: string; diagnostics: unknown[]; documentVersion?: number },
    ) => {
      try {
        if (!params?.uri || typeof params.uri !== 'string') {
          return { success: false, error: 'uri required' }
        }
        const list = Array.isArray(params.diagnostics) ? params.diagnostics : []
        diagnosticsStore.setFromRenderer(params.uri, list)
        getDiagnosticsHub().ingestFromMonaco({
          uri: params.uri,
          version: params.documentVersion,
          diagnostics: list as never[],
        })
        return { success: true }
      } catch (e) {
        return { success: false, error: (e as Error).message }
      }
    },
  )

  ipcMain.handle('lsp:clear-diagnostics', () => {
    diagnosticsStore.clearAll()
    getDiagnosticsHub().clearAll()
    return { success: true }
  })

  ipcMain.handle('lsp:restart-typescript-server', async () => {
    try {
      const {
        shutdownLspServerManager,
        initializeLspServerManager,
        waitForInitialization,
        getLastInitPaths,
      } = await import('./manager')
      // Audit P1-5 (2026-05): capture the paths the manager was last booted
      // with BEFORE shutdown clears them. The previous body invoked
      // `initializeLspServerManager(undefined, undefined)` and lost the
      // userDataPath root, which breaks settings-resolved LSP config
      // overrides (e.g. `~/.config/.../lsp.json`). Workspace path is
      // similarly preserved so a TS restart does not silently degrade the
      // server to "no workspace" mode.
      const { workspacePath, userDataPath } = getLastInitPaths()
      await shutdownLspServerManager()
      // `initializeLspServerManager` is synchronous (fire-and-forget); the
      // renderer expects the restart to actually be ready before it resolves,
      // so explicitly await the internal init promise afterwards.
      initializeLspServerManager(workspacePath, userDataPath)
      await waitForInitialization()
      return { success: true }
    } catch (e) {
      return { success: false, error: (e as Error).message }
    }
  })

  // -------------------------------------------------------------------------
  // Quick Fix / Code Action chain
  //
  //   lsp:code-action         -> textDocument/codeAction
  //   lsp:resolve-code-action -> codeAction/resolve (lazy-loaded edits)
  //   lsp:execute-command     -> workspace/executeCommand (server commands)
  //   lsp:apply-workspace-edit -> apply a standalone WorkspaceEdit from UI
  //
  // All four are thin wrappers around the running LSPServerManager; the
  // actual logic (path resolution, workspace safety, atomic writes) lives in
  // `applyWorkspaceEdit.ts` so the renderer stays dumb.
  // -------------------------------------------------------------------------

  ipcMain.handle(
    'lsp:code-action',
    async (
      _event,
      params: {
        filePath: string
        range: Range
        context?: { diagnostics?: unknown[]; only?: string[] }
      },
    ) => {
      try {
        const mgr = getLspServerManager()
        if (!mgr) return { success: false, error: 'LSP manager not initialized', actions: [] }
        const filePath = typeof params?.filePath === 'string' ? params.filePath.trim() : ''
        if (!filePath) return { success: false, error: 'filePath required', actions: [] }
        if (!params?.range) return { success: false, error: 'range required', actions: [] }

        const server = mgr.getServerForFile(filePath)
        if (!server) return { success: true, actions: [], skipped: true }

        const uri = pathToFileURL(path.resolve(filePath)).href
        const result = await mgr.sendRequest<(Command | CodeAction)[] | null>(
          filePath,
          'textDocument/codeAction',
          {
            textDocument: { uri },
            range: params.range,
            context: {
              diagnostics: Array.isArray(params.context?.diagnostics)
                ? params.context!.diagnostics
                : [],
              only: params.context?.only,
            },
          },
        )
        const actions: Array<Command | CodeAction> = Array.isArray(result) ? result : []
        return {
          success: true,
          serverName: server.name,
          actions,
        }
      } catch (err) {
        return { success: false, error: (err as Error).message, actions: [] }
      }
    },
  )

  ipcMain.handle(
    'lsp:resolve-code-action',
    async (
      _event,
      params: { filePath: string; action: CodeAction },
    ) => {
      try {
        const mgr = getLspServerManager()
        if (!mgr) return { success: false, error: 'LSP manager not initialized' }
        const filePath = typeof params?.filePath === 'string' ? params.filePath.trim() : ''
        if (!filePath) return { success: false, error: 'filePath required' }
        const server = mgr.getServerForFile(filePath)
        if (!server) return { success: false, error: 'no LSP server for file' }

        // Not every server registers codeAction/resolve. If the server rejects
        // the method we surface that upstream so the caller can fall back to
        // the already-populated `edit` / `command` fields (which the server
        // *should* have returned inline instead).
        const resolved = await mgr.sendRequest<CodeAction>(
          filePath,
          'codeAction/resolve',
          params.action,
        )
        return { success: true, action: resolved ?? params.action }
      } catch (err) {
        return { success: false, error: (err as Error).message }
      }
    },
  )

  ipcMain.handle(
    'lsp:execute-command',
    async (
      _event,
      params: { filePath: string; command: Command },
    ) => {
      try {
        const mgr = getLspServerManager()
        if (!mgr) return { success: false, error: 'LSP manager not initialized' }
        const filePath = typeof params?.filePath === 'string' ? params.filePath.trim() : ''
        if (!filePath) return { success: false, error: 'filePath required' }
        if (!params?.command?.command) {
          return { success: false, error: 'command.command required' }
        }
        const result = await mgr.sendRequest<unknown>(filePath, 'workspace/executeCommand', {
          command: params.command.command,
          arguments: params.command.arguments,
        })
        return { success: true, result }
      } catch (err) {
        return { success: false, error: (err as Error).message }
      }
    },
  )

  ipcMain.handle(
    'lsp:apply-workspace-edit',
    async (_event, params: { edit: WorkspaceEdit }) => {
      try {
        if (!params?.edit) return { success: false, error: 'edit required' }
        const result = await applyWorkspaceEdit(params.edit)
        return { success: true, result }
      } catch (err) {
        return { success: false, error: (err as Error).message }
      }
    },
  )
}
