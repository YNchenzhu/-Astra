/**
 * Normalized diagnostic shapes for LSP registry and AI context (upstream-aligned).
 */

export interface DiagnosticRange {
  start: { line: number; character: number }
  end: { line: number; character: number }
}

export interface DiagnosticEntry {
  message: string
  severity?: string
  range?: DiagnosticRange
  source?: string
  code?: string
}

export interface DiagnosticFile {
  /** Workspace file path (normalized, not necessarily file://) */
  uri: string
  diagnostics: DiagnosticEntry[]
}
