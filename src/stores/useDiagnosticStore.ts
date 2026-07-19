import { create } from 'zustand'
import { useWorkspaceStore } from './useWorkspaceStore'
import { diagnosticMapKey, uriToAbsoluteFilePath } from '../services/pathUtils'
import type {
  DiagnosticsHubSnapshot,
  DiagnosticsHubPatch,
  DiagnosticsHubDiagnostic,
} from '../types'

export type DiagnosticSeverity = 'error' | 'warning' | 'information' | 'hint'

export interface DiagnosticRelatedLocation {
  message: string
  file: string
  line: number
  column: number
}

export interface Diagnostic {
  file: string
  fileName: string
  line: number
  column: number
  endLine: number
  endColumn: number
  severity: DiagnosticSeverity
  message: string
  source: string
  code?: string | number
  tags?: number[]
  codeDescriptionHref?: string
  providerKey: string
  relatedInformation?: DiagnosticRelatedLocation[]
}

const severityMap: Record<number, DiagnosticSeverity> = {
  1: 'error',
  2: 'warning',
  3: 'information',
  4: 'hint',
}

interface DiagnosticState {
  /** All diagnostics (flat). Derived from `diagnosticsByFile`. */
  diagnostics: Diagnostic[]
  /** URI-key → diagnostics. Map key is `diagnosticMapKey(uri)`. */
  diagnosticsByFile: Map<string, Diagnostic[]>
  /** Pre-computed error total — kept in sync with `diagnostics` so per-render
   *  subscribers (StatusBar) don't re-filter the whole flat array. */
  errorCount: number
  /** Pre-computed warning total (see {@link errorCount}). */
  warningCount: number
  /** Last revision applied from the Hub. `-1` means "no snapshot yet". */
  revision: number
  /** Provider identifier → healthy flag (true/false). */
  providerHealth: Record<string, boolean>
  /** Replace the entire mirror with a Hub snapshot. */
  applySnapshot: (snapshot: DiagnosticsHubSnapshot) => void
  /** Apply an incremental patch (per-URI full replace). */
  applyPatch: (patch: DiagnosticsHubPatch) => 'applied' | 'gap'
  /**
   * Apply a whole batch of patches with ONE map copy + ONE flatten + ONE
   * store update. During LSP pre-warm of a large workspace the Hub emits a
   * burst of patches; applying them one-by-one cost O(total diagnostics) per
   * patch and made the renderer visibly jank right after opening a folder.
   * `diagnosticsSync.ts` coalesces incoming patches and flushes through here.
   */
  applyPatches: (patches: readonly DiagnosticsHubPatch[]) => 'applied' | 'gap'
  /** Clear mirror (no-op if already empty). Does NOT push back to main. */
  clearAllDiagnostics: () => void
  findDiagnosticsForPath: (filePath: string) => Diagnostic[]
  getErrorCount: () => number
  getWarningCount: () => number
  isProviderHealthy: (providerKey: string) => boolean
}

function isInCurrentWorkspace(filePath: string): boolean {
  const rootPath = useWorkspaceStore.getState().rootPath
  if (!rootPath) return false

  const normalizedFilePath = filePath.replace(/\\/g, '/').toLowerCase()
  const normalizedRootPath = rootPath.replace(/\\/g, '/').toLowerCase()

  return (
    normalizedFilePath === normalizedRootPath ||
    normalizedFilePath.startsWith(`${normalizedRootPath}/`)
  )
}

function fileNameFromPath(filePath: string): string {
  return filePath.split(/[\\/]/).pop() || filePath
}

function hubDiagnosticToDiagnostic(
  uri: string,
  hubDiag: DiagnosticsHubDiagnostic,
): Diagnostic {
  const filePath = uriToAbsoluteFilePath(uri)
  const fileName = fileNameFromPath(filePath)
  const sev = severityMap[hubDiag.severity] ?? 'error'
  const related = hubDiag.relatedInformation?.map((r) => ({
    message: r.message,
    file: uriToAbsoluteFilePath(r.location.uri),
    line: r.location.range.start.line + 1,
    column: r.location.range.start.character + 1,
  }))
  return {
    file: filePath,
    fileName,
    line: hubDiag.range.start.line + 1,
    column: hubDiag.range.start.character + 1,
    endLine: hubDiag.range.end.line + 1,
    endColumn: hubDiag.range.end.character + 1,
    severity: sev,
    message: hubDiag.message,
    source: hubDiag.source ?? hubDiag.providerKey,
    code: hubDiag.code,
    tags: hubDiag.tags,
    codeDescriptionHref: hubDiag.codeDescription?.href,
    providerKey: hubDiag.providerKey,
    relatedInformation: related && related.length > 0 ? related : undefined,
  }
}

/** One pass over the map producing the flat array + severity totals. */
function flattenWithCounts(map: Map<string, Diagnostic[]>): {
  diagnostics: Diagnostic[]
  errorCount: number
  warningCount: number
} {
  const out: Diagnostic[] = []
  let errorCount = 0
  let warningCount = 0
  for (const diags of map.values()) {
    for (const d of diags) {
      out.push(d)
      if (d.severity === 'error') errorCount++
      else if (d.severity === 'warning') warningCount++
    }
  }
  return { diagnostics: out, errorCount, warningCount }
}

export const useDiagnosticStore = create<DiagnosticState>((set, get) => ({
  diagnostics: [],
  diagnosticsByFile: new Map(),
  errorCount: 0,
  warningCount: 0,
  revision: -1,
  providerHealth: {},

  applySnapshot: (snapshot) => {
    const byFile = new Map<string, Diagnostic[]>()
    for (const file of snapshot.files) {
      const filePath = uriToAbsoluteFilePath(file.uri)
      if (!isInCurrentWorkspace(filePath)) continue
      const rows = file.diagnostics.map((d) => hubDiagnosticToDiagnostic(file.uri, d))
      if (rows.length === 0) continue
      byFile.set(diagnosticMapKey(file.uri), rows)
    }
    set({
      diagnosticsByFile: byFile,
      ...flattenWithCounts(byFile),
      revision: snapshot.revision,
      providerHealth: { ...snapshot.providerHealth },
    })
  },

  applyPatch: (patch) => {
    return get().applyPatches([patch])
  },

  applyPatches: (patches) => {
    if (patches.length === 0) return 'applied'
    const { revision } = get()

    // Revision monotonicity is checked over the whole batch (patches arrive
    // in IPC order, so in-batch order == emission order). Any stale/reordered
    // revision signals a gap so the subscriber requests a full resync —
    // identical semantics to the previous per-patch check. (Equal revisions
    // are idempotent drops; strictly smaller means a reordered stale event.)
    let lastRevision = revision
    for (const patch of patches) {
      if (lastRevision >= 0 && patch.revision <= lastRevision) {
        return 'gap'
      }
      lastRevision = patch.revision
    }

    const byFile = new Map(get().diagnosticsByFile)
    let providerHealth = get().providerHealth
    for (const patch of patches) {
      for (const update of patch.updates) {
        const filePath = uriToAbsoluteFilePath(update.uri)
        const key = diagnosticMapKey(update.uri)
        if (!isInCurrentWorkspace(filePath)) {
          byFile.delete(key)
          continue
        }
        if (update.diagnostics.length === 0) {
          byFile.delete(key)
          continue
        }
        byFile.set(
          key,
          update.diagnostics.map((d) => hubDiagnosticToDiagnostic(update.uri, d)),
        )
      }
      if (patch.providerHealth) {
        providerHealth = { ...providerHealth, ...patch.providerHealth }
      }
    }

    set({
      diagnosticsByFile: byFile,
      ...flattenWithCounts(byFile),
      revision: lastRevision,
      providerHealth,
    })
    return 'applied'
  },

  clearAllDiagnostics: () => {
    set({
      diagnostics: [],
      diagnosticsByFile: new Map(),
      errorCount: 0,
      warningCount: 0,
      revision: -1,
      providerHealth: {},
    })
  },

  findDiagnosticsForPath: (filePath) => {
    return get().diagnosticsByFile.get(diagnosticMapKey(filePath)) || []
  },

  getErrorCount: () => {
    return get().errorCount
  },

  getWarningCount: () => {
    return get().warningCount
  },

  isProviderHealthy: (providerKey) => {
    const val = get().providerHealth[providerKey]
    return val !== false
  },
}))
