export interface ElectronLspApi {
  syncDiagnostics: (payload: {
    uri: string
    diagnostics: unknown[]
    documentVersion?: number
  }) => Promise<{ success: boolean; error?: string }>
  syncDocument: (payload: {
    filePath: string
    action: 'open' | 'change' | 'close' | 'save'
    content?: string
  }) => Promise<{ success: boolean; skipped?: boolean; error?: string }>
  /** Not exposed in preload; optional for forward compatibility / optional chaining in workspace code. */
  clearDiagnostics?: () => Promise<{ success: boolean; error?: string }>
  restartTypeScriptServer?: () => Promise<{ success: boolean; error?: string }>
  /**
   * LSP Admin (Settings → 语言服务器 panel). Returns the live inventory
   * including `providerHealth` so the UI can show per-server dots,
   * quarantine badges, crash counts and stderr tails.
   */
  listServers?: () => Promise<{
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
  restartServer?: (name: string) => Promise<{ success: boolean; error?: string }>
  resumeServer?: (name: string) => Promise<{ success: boolean; error?: string; quarantined?: boolean }>
  setServerEnabled?: (
    name: string,
    enabled: boolean,
  ) => Promise<{ success: boolean; error?: string }>
  setServerTrace?: (
    name: string,
    enabled: boolean,
  ) => Promise<{ success: boolean; logPath?: string; error?: string }>
  getStderrTail?: (
    name: string,
    maxBytes?: number,
  ) => Promise<{ success: boolean; text?: string; error?: string }>
  onServerStateChanged?: (
    callback: (payload: { name: string; state: string; error?: string }) => void,
  ) => () => void
  /** Quick Fix chain — P3 (code-action / resolve / execute / apply). */
  getCodeActions?: (params: {
    filePath: string
    range: {
      start: { line: number; character: number }
      end: { line: number; character: number }
    }
    context?: { diagnostics?: unknown[]; only?: string[] }
  }) => Promise<{
    success: boolean
    skipped?: boolean
    serverName?: string
    error?: string
    actions: Array<Record<string, unknown>>
  }>
  resolveCodeAction?: (params: {
    filePath: string
    action: Record<string, unknown>
  }) => Promise<{
    success: boolean
    error?: string
    action?: Record<string, unknown>
  }>
  executeCommand?: (params: {
    filePath: string
    command: { command: string; arguments?: unknown[] }
  }) => Promise<{ success: boolean; error?: string; result?: unknown }>
  applyWorkspaceEdit?: (params: { edit: Record<string, unknown> }) => Promise<{
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
