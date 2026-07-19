/**
 * Language-server + Diagnostics-Hub bridges.
 *
 *   - `lsp:*`               per-server admin, document sync, code actions
 *   - `diagnostics:*`       snapshot + incremental patch stream from the
 *                           central Diagnostics Hub (merges LSP, workspace
 *                           walker, model self-reports, …)
 */
import { ipcRenderer, type IpcRendererEvent } from 'electron'

export interface LspApi {
  syncDiagnostics: (params: {
    uri: string
    documentVersion?: number
    diagnostics: Array<{
      range: { start: { line: number; character: number }; end: { line: number; character: number } }
      severity?: number
      message: string
      source?: string
      code?: string | number
    }>
  }) => Promise<{ success: boolean }>
  clearDiagnostics: () => Promise<unknown>
  syncDocument: (params: {
    filePath: string
    action: 'open' | 'change' | 'close' | 'save'
    content?: string
  }) => Promise<{ success: boolean; skipped?: boolean; error?: string }>
  restartTypeScriptServer: () => Promise<unknown>
  /**
   * LSP Admin (Settings → 语言服务器 panel). Returns live inventory
   * including `providerHealth` + quarantine + trace state so the UI can
   * render per-server dots and admin badges.
   */
  listServers: () => Promise<{
    servers: Array<{
      name: string
      state: 'stopped' | 'starting' | 'running' | 'stopping' | 'error'
      disabled: boolean
      quarantined: boolean
      traceEnabled: boolean
      tracePath?: string
      extensions: string[]
      command: string
      lastError?: string
      docCount: number
      crashCount: number
      lastPublishAt?: number
      diagnosticCount: number
      positionEncoding?: 'utf-8' | 'utf-16' | 'utf-32'
    }>
    providerHealth: Record<string, boolean>
    workspacePath: string | null
  }>
  restartServer: (name: string) => Promise<{ success: boolean; error?: string }>
  resumeServer: (name: string) => Promise<{ success: boolean; error?: string; quarantined?: boolean }>
  setServerEnabled: (name: string, enabled: boolean) => Promise<{ success: boolean; error?: string }>
  setServerTrace: (name: string, enabled: boolean) => Promise<{ success: boolean; logPath?: string; error?: string }>
  getStderrTail: (name: string, maxBytes?: number) => Promise<{ success: boolean; text?: string; error?: string }>
  onServerStateChanged: (
    callback: (payload: { name: string; state: string; error?: string }) => void,
  ) => () => void
  /** textDocument/codeAction (Quick Fix) */
  getCodeActions: (params: {
    filePath: string
    range: { start: { line: number; character: number }; end: { line: number; character: number } }
    context?: { diagnostics?: unknown[]; only?: string[] }
  }) => Promise<{
    success: boolean
    skipped?: boolean
    serverName?: string
    error?: string
    actions: Array<Record<string, unknown>>
  }>
  resolveCodeAction: (params: {
    filePath: string
    action: Record<string, unknown>
  }) => Promise<{
    success: boolean
    error?: string
    action?: Record<string, unknown>
  }>
  executeCommand: (params: {
    filePath: string
    command: { command: string; arguments?: unknown[] }
  }) => Promise<{ success: boolean; error?: string; result?: unknown }>
  applyWorkspaceEdit: (params: { edit: Record<string, unknown> }) => Promise<{
    success: boolean
    error?: string
    result?: {
      applied: boolean
      filesChanged: string[]
      filesCreated: string[]
      filesRenamed: Array<{ from: string; to: string }>
      filesDeleted: string[]
      skippedFileOps: Array<{ kind: string; uri?: string; reason?: string }>
      failedPaths: Array<{ uri: string; reason: string }>
    }
  }>
}

export function buildLspApi(): LspApi {
  return {
    syncDiagnostics: (params) => ipcRenderer.invoke('lsp:sync-diagnostics', params),
    syncDocument: (params) => ipcRenderer.invoke('lsp:sync-document', params),
    clearDiagnostics: () => ipcRenderer.invoke('lsp:clear-diagnostics'),
    restartTypeScriptServer: () => ipcRenderer.invoke('lsp:restart-typescript-server'),
    listServers: () => ipcRenderer.invoke('lsp:list-servers'),
    restartServer: (name) => ipcRenderer.invoke('lsp:restart-server', name),
    resumeServer: (name) => ipcRenderer.invoke('lsp:resume-server', name),
    setServerEnabled: (name, enabled) =>
      ipcRenderer.invoke('lsp:set-server-enabled', { name, enabled }),
    setServerTrace: (name, enabled) =>
      ipcRenderer.invoke('lsp:set-server-trace', { name, enabled }),
    getStderrTail: (name, maxBytes) =>
      ipcRenderer.invoke('lsp:get-stderr-tail', { name, maxBytes }),
    onServerStateChanged: (callback) => {
      const handler = (
        _event: IpcRendererEvent,
        payload: { name: string; state: string; error?: string },
      ) => callback(payload)
      ipcRenderer.on('lsp:server-state', handler)
      return () => ipcRenderer.removeListener('lsp:server-state', handler)
    },
    getCodeActions: (params) => ipcRenderer.invoke('lsp:code-action', params),
    resolveCodeAction: (params) => ipcRenderer.invoke('lsp:resolve-code-action', params),
    executeCommand: (params) => ipcRenderer.invoke('lsp:execute-command', params),
    applyWorkspaceEdit: (params) => ipcRenderer.invoke('lsp:apply-workspace-edit', params),
  }
}

export interface DiagnosticsApi {
  getSnapshot: () => Promise<unknown>
  onPatch: (callback: (patch: unknown) => void) => () => void
}

export function buildDiagnosticsApi(): DiagnosticsApi {
  return {
    getSnapshot: () => ipcRenderer.invoke('diagnostics:get-snapshot'),
    onPatch: (callback) => {
      const handler = (_event: IpcRendererEvent, patch: unknown) => callback(patch)
      ipcRenderer.on('diagnostics:patch', handler)
      return () => ipcRenderer.removeListener('diagnostics:patch', handler)
    },
  }
}
