/**
 * Tool-result trailer that surfaces fresh LSP diagnostics for a just-written
 * file. Used by edit_file / write_file / NotebookEdit so the agent SEES the
 * language-server's reaction in the same tool_result, instead of waiting for
 * the next-turn passive injection.
 *
 * Reads the authoritative {@link diagnosticsStore}; the awaitable
 * {@link awaitDiskWriteAndFreshDiagnostics} in `diskMutationSync.ts` is
 * responsible for ensuring the store has been refreshed before this is called.
 */

import path from 'node:path'
import { diagnosticsStore } from '../tools/DiagnosticsStore'
import { getWorkspacePath } from '../tools/workspaceState'

const SEVERITY_RANK: Record<string, number> = {
  error: 1,
  warning: 2,
  information: 3,
  hint: 4,
}

const SEVERITY_LABEL: Record<string, string> = {
  error: 'Error',
  warning: 'Warning',
  information: 'Info',
  hint: 'Hint',
}

/**
 * Maximum diagnostics to surface inline. Beyond this we summarise — the agent
 * can call ReadDiagnostics for the full list. Aligned with
 * {@link MAX_DIAGNOSTICS_PER_FILE} in LSPDiagnosticRegistry to keep behaviour
 * consistent across the two surfacing paths.
 */
const MAX_TRAILER_DIAGNOSTICS = 10

export type DiagnosticsTrailerOptions = {
  /** Result from `awaitDiskWriteAndFreshDiagnostics`. */
  lspApplicable: boolean
  diagnosticsArrived: boolean
  /** Per-call timeout (for the "still pending" message). */
  timeoutMs: number
  /**
   * `await` (default): the caller awaited a publishDiagnostics for the bytes
   *   it just wrote, so a no-arrival means the LSP truly did not respond and
   *   we should warn about staleness.
   *
   * `snapshot`: the caller did NOT await — it just wants whatever is in the
   *   diagnostics store right now. No staleness warnings; an empty store is
   *   reported as "no diagnostics" without any "still pending" framing.
   *
   * The agentic-loop fallback (runAgenticToolUseBody, method B) uses
   *   `snapshot` for non-builtin file mutation tools (MCP filesystem etc.),
   *   while edit_file / write_file / NotebookEdit use `await`.
   */
  mode?: 'await' | 'snapshot'
}

function relativeDisplayPath(absPath: string): string {
  const ws = getWorkspacePath()
  if (ws) {
    try {
      return path.relative(ws, absPath).replace(/\\/g, '/') || absPath
    } catch {
      return absPath.replace(/\\/g, '/')
    }
  }
  return absPath.replace(/\\/g, '/')
}

/**
 * Build a trailer string for the given resolved file path. Returns an empty
 * string when there is nothing useful to say (e.g. no LSP applies and no
 * cached diagnostics from a prior session).
 *
 * Trailer shapes:
 *   - "(LSP: foo.py — clean.)"
 *   - "(LSP: foo.py — 2 error, 1 warning):
 *      - (Error) L42:5 [pyright] Variable "x" is possibly unbound
 *      - ..."
 *   - "(LSP: foo.py — no fresh diagnostics arrived after 3000ms; no snapshot available yet)"
 *   - "" when no LSP covers this path AND store has no rows.
 */
export function buildLspDiagnosticsTrailer(
  resolvedPath: string,
  options: DiagnosticsTrailerOptions,
): string {
  const display = relativeDisplayPath(resolvedPath)
  const rows = diagnosticsStore.getForFile(resolvedPath)

  // Stable severity ordering, then line number, then column.
  const sorted = [...rows].sort((a, b) => {
    const sa = SEVERITY_RANK[a.severity] ?? 4
    const sb = SEVERITY_RANK[b.severity] ?? 4
    if (sa !== sb) return sa - sb
    if (a.line !== b.line) return a.line - b.line
    return a.column - b.column
  })

  const mode = options.mode ?? 'await'

  // Snapshot mode never warns about staleness; an empty store means "nothing
  // to add". This is the right call for the loop-level fallback decorator
  // which has not asked the LSP to produce anything.
  if (mode === 'snapshot') {
    if (sorted.length === 0) return ''
  } else {
    if (!options.lspApplicable && sorted.length === 0) {
      return ''
    }

    if (options.lspApplicable && !options.diagnosticsArrived && sorted.length === 0) {
      return (
        `\n\n--- LSP: ${display} — no fresh diagnostics arrived after ${options.timeoutMs}ms; ` +
        `no diagnostics snapshot is available yet. ---`
      )
    }

    if (sorted.length === 0) {
      return `\n\n--- LSP: ${display} — clean (no diagnostics). ---`
    }
  }

  const errorCount = sorted.filter((d) => d.severity === 'error').length
  const warningCount = sorted.filter((d) => d.severity === 'warning').length
  const infoCount = sorted.filter((d) => d.severity === 'information').length
  const hintCount = sorted.filter((d) => d.severity === 'hint').length

  const summaryParts: string[] = []
  if (errorCount > 0) summaryParts.push(`${errorCount} error${errorCount === 1 ? '' : 's'}`)
  if (warningCount > 0) summaryParts.push(`${warningCount} warning${warningCount === 1 ? '' : 's'}`)
  if (infoCount > 0) summaryParts.push(`${infoCount} info`)
  if (hintCount > 0) summaryParts.push(`${hintCount} hint${hintCount === 1 ? '' : 's'}`)
  const summary = summaryParts.join(', ')

  const truncated = sorted.length > MAX_TRAILER_DIAGNOSTICS
  const top = sorted.slice(0, MAX_TRAILER_DIAGNOSTICS)
  const lines = top.map((d) => {
    const label = SEVERITY_LABEL[d.severity] ?? 'Error'
    const src = d.source ? ` [${d.source}]` : ''
    const code = d.code !== undefined && d.code !== '' ? ` (${d.code})` : ''
    const msg = d.message.replace(/\s+/g, ' ').trim()
    return `  - (${label}) L${d.line}:${d.column}${src}${code} ${msg}`
  })

  const tail = truncated
    ? `\n  ... ${sorted.length - MAX_TRAILER_DIAGNOSTICS} more (call ReadDiagnostics for the full list).`
    : ''
  const freshness = mode === 'await' && options.lspApplicable && !options.diagnosticsArrived
    ? ' [stale: LSP did not respond within timeout, store may be outdated]'
    : ''

  return `\n\n--- LSP: ${display} — ${summary}${freshness} ---\n${lines.join('\n')}${tail}`
}
