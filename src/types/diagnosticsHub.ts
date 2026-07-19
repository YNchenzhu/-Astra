// ---------------------------------------------------------------------------
// Diagnostics Hub (shared between main & renderer over IPC).
// Keep in lock-step with electron/diagnostics/DiagnosticsHub.ts.
// ---------------------------------------------------------------------------

export interface DiagnosticsHubPosition {
  line: number
  character: number
}

export interface DiagnosticsHubRange {
  start: DiagnosticsHubPosition
  end: DiagnosticsHubPosition
}

export interface DiagnosticsHubRelatedInformation {
  message: string
  location: { uri: string; range: DiagnosticsHubRange }
}

export interface DiagnosticsHubDiagnostic {
  range: DiagnosticsHubRange
  /** LSP severity: 1=Error, 2=Warning, 3=Information, 4=Hint. */
  severity: 1 | 2 | 3 | 4
  message: string
  source?: string
  code?: string | number
  /** LSP DiagnosticTag (1 = Unnecessary, 2 = Deprecated). */
  tags?: number[]
  codeDescription?: { href: string }
  relatedInformation?: DiagnosticsHubRelatedInformation[]
  /** Provider identity, e.g. 'monaco' or 'lsp:typescript'. */
  providerKey: string
}

export interface DiagnosticsHubFileSnapshot {
  uri: string
  diagnostics: DiagnosticsHubDiagnostic[]
}

export interface DiagnosticsHubSnapshot {
  revision: number
  files: DiagnosticsHubFileSnapshot[]
  providerHealth: Record<string, boolean>
}

export interface DiagnosticsHubPatch {
  revision: number
  updates: DiagnosticsHubFileSnapshot[]
  providerHealth?: Record<string, boolean>
}
