/**
 * Turn consumed registry batches into a compact markdown block for the system prompt.
 */

import { checkForLSPDiagnostics } from './LSPDiagnosticRegistry'
import type { DiagnosticEntry, DiagnosticFile } from './diagnosticTypes'

export type LspPassiveInjectMode = 'off' | 'full' | 'errors-only'

/** Normalize settings / IPC values to inject mode. Default `full` (upstream-style). */
export function parseLspPassiveInjectMode(raw: unknown): LspPassiveInjectMode {
  if (raw === false || raw === 'off') return 'off'
  if (raw === 'errors-only') return 'errors-only'
  if (raw === true || raw === 'full' || raw === undefined || raw === null) return 'full'
  if (typeof raw === 'string' && raw.toLowerCase() === 'off') return 'off'
  return 'full'
}

function filterFilesByMode(
  files: DiagnosticFile[],
  mode: LspPassiveInjectMode,
): DiagnosticFile[] {
  if (mode !== 'errors-only') return files
  return files
    .map((f) => ({
      ...f,
      diagnostics: f.diagnostics.filter((d) => (d.severity ?? 'Error') === 'Error'),
    }))
    .filter((f) => f.diagnostics.length > 0)
}

function formatFile(file: DiagnosticFile): string {
  const lines = file.diagnostics.map((d: DiagnosticEntry) => {
    const sev = d.severity ?? 'Error'
    const r = d.range
    const loc = r
      ? `L${r.start.line + 1}:${r.start.character + 1}`
      : '?'
    const src = d.source ? ` [${d.source}]` : ''
    const code = d.code ? ` (${d.code})` : ''
    return `- (${sev}) ${loc}${src}${code} ${d.message.replace(/\s+/g, ' ').trim()}`
  })
  return `### ${file.uri}\n${lines.join('\n')}`
}

export type ConsumePassiveLspDiagnosticsOptions = {
  /**
   * Whether the current tool listing exposes a shell-execution tool to the
   * model. Originally (upstream §9.3) this had to be `true` to drain — the
   * theory being "no shell ⇒ agent can't verify diagnostics anyway, so don't
   * waste prompt budget".
   *
   * In practice that gate silently strands diagnostics for any agent without
   * shell access (plan mode, file-only sub-agents, the brand-new MCP-only
   * researcher persona, …), so the default behavior is now to drain
   * regardless of this flag. Set {@link requireShellTool} to `true` to
   * restore the legacy gate.
   */
  shellExecutionToolInListing: boolean
  /**
   * When `true`, restore the legacy upstream §9.3 gate: only drain if
   * {@link shellExecutionToolInListing} is also `true`. Default `false`.
   */
  requireShellTool?: boolean
}

/**
 * Drain pending passive LSP diagnostics (one-shot per call, like upstream checkForLSPDiagnostics).
 */
export function consumePassiveLspDiagnosticsForPrompt(
  mode: LspPassiveInjectMode = 'full',
  options?: ConsumePassiveLspDiagnosticsOptions,
): string {
  if (mode === 'off') return ''
  if (options?.requireShellTool === true && options.shellExecutionToolInListing !== true) {
    return ''
  }
  const batches = checkForLSPDiagnostics()
  if (batches.length === 0) return ''

  const parts: string[] = []
  for (const batch of batches) {
    const files = filterFilesByMode(batch.files, mode)
    if (files.length === 0) continue
    parts.push(
      `Language servers: ${batch.serverName}\n\n${files.map(formatFile).join('\n\n')}`,
    )
  }

  return parts.join('\n\n---\n\n').trim()
}

export function formatDiagnosticFilesForContext(files: DiagnosticFile[]): string {
  if (files.length === 0) return ''
  return files.map(formatFile).join('\n\n')
}
