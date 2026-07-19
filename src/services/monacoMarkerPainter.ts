/**
 * Monaco marker painter — closes the loop from Hub → editor squigglies.
 *
 * Before this module: LSP diagnostics reached the Problems panel only. The
 * editor itself (Monaco) still painted squigglies solely from its own TS/JS
 * worker, and for Python / Go / Rust / any non-TS language the editor showed
 * NO in-place diagnostics even though Problems was populated.
 *
 * Design:
 *   - Subscribe to the renderer's mirror (`useDiagnosticStore`).
 *   - For each (file, LSP-sourced diagnostic set) emit a marker collection
 *     scoped to its own owner string (`lsp:<serverName>`), so these coexist
 *     with Monaco's built-in workers (owner = 'typescript' / 'css' / …).
 *   - Arbitration: if the Hub already suppressed `monaco` rows for a URI
 *     (i.e. an LSP is healthy for it), we rely on the Hub's output and leave
 *     Monaco's own markers alone; they are already silent anyway because
 *     `monacoDiagnostics.ts` disables semantic validation for healthy TS LSP.
 *   - When a file's LSP diagnostics change, we `setModelMarkers(model, owner,
 *     markers)` with an empty array first (wipes stale rows) and then set
 *     the new ones. Monaco deduplicates internally by `(owner, resource)`.
 *
 * Disposal: `disposeMonacoMarkerPainter()` is called from the workspace-reset
 * path so a workspace switch never leaves stale owners behind.
 */

import type * as Monaco from 'monaco-editor'
import { useDiagnosticStore, type Diagnostic } from '../stores/useDiagnosticStore'

/** Map our string severity back to Monaco MarkerSeverity. */
type MonacoSeverity = 1 | 2 | 4 | 8
const SEVERITY: Record<Diagnostic['severity'], MonacoSeverity> = {
  hint: 1,
  information: 2,
  warning: 4,
  error: 8,
}

let monacoRef: typeof Monaco | null = null
let unsubscribe: (() => void) | undefined
// Saved disposable for the global `onDidCreateModel` listener. Without
// tracking it `disposeMonacoMarkerPainter()` left the listener attached to
// Monaco, and a subsequent re-init (HMR / workspace switch) layered a
// duplicate that paints markers twice on every newly opened file.
let onDidCreateModelDisposable: Monaco.IDisposable | null = null

/**
 * `(ownerKey, modelUriKey)` tuples we've painted into Monaco so we can wipe
 * them when the owner disappears (server removed / provider went dark).
 */
interface PaintedOwner {
  /** Last known marker count — 0 means the owner has been cleared. */
  count: number
}
const painted = new Map<string /* ownerKey */, Map<string /* uriKey */, PaintedOwner>>()

function findModel(uri: string): Monaco.editor.ITextModel | undefined {
  const monaco = monacoRef
  if (!monaco) return undefined
  // Try exact Monaco URI first (fast path for Monaco-created models).
  const all = monaco.editor.getModels()
  for (const model of all) {
    if (model.uri.toString() === uri) return model
  }
  // Fallback: compare fsPath lowercased (handles Windows drive casing).
  const wantLower = uri.replace(/\\/g, '/').toLowerCase()
  for (const model of all) {
    const modelLower = model.uri.toString().replace(/\\/g, '/').toLowerCase()
    if (modelLower === wantLower) return model
    try {
      if (model.uri.scheme === 'file') {
        const fsp = model.uri.fsPath.replace(/\\/g, '/').toLowerCase()
        if (wantLower.endsWith(fsp) || fsp.endsWith(wantLower.replace(/^file:\/+/, ''))) {
          return model
        }
      }
    } catch {
      /* ignore */
    }
  }
  return undefined
}

function toMonacoMarker(d: Diagnostic): Monaco.editor.IMarkerData {
  return {
    severity: SEVERITY[d.severity] ?? 8,
    message: d.message,
    startLineNumber: Math.max(1, d.line),
    startColumn: Math.max(1, d.column),
    endLineNumber: Math.max(1, d.endLine ?? d.line),
    endColumn: Math.max(1, d.endColumn ?? d.column + 1),
    source: d.source,
    code: d.code !== undefined ? String(d.code) : undefined,
    tags: Array.isArray(d.tags) ? (d.tags as Monaco.MarkerTag[]) : undefined,
    relatedInformation: d.relatedInformation?.map((r) => ({
      resource: (monacoRef as typeof Monaco).Uri.parse(
        r.file.startsWith('file:') ? r.file : `file://${r.file.replace(/\\/g, '/')}`,
      ),
      startLineNumber: Math.max(1, r.line),
      startColumn: Math.max(1, r.column),
      endLineNumber: Math.max(1, r.line),
      endColumn: Math.max(1, r.column + 1),
      message: r.message,
    })),
  }
}

/**
 * Collapse the Diagnostic[] mirror into `{ owner -> uri -> marker[] }`.
 * Monaco-owned rows are ignored entirely — the existing `monacoDiagnostics`
 * bridge already keeps those in sync inside the editor.
 */
function collectByOwner(
  map: Map<string, Diagnostic[]>,
): Map<string, Map<string, Diagnostic[]>> {
  const out = new Map<string, Map<string, Diagnostic[]>>()
  for (const [, rows] of map) {
    for (const row of rows) {
      if (row.providerKey === 'monaco') continue
      if (!row.providerKey) continue
      const owner = row.providerKey
      let perOwner = out.get(owner)
      if (!perOwner) {
        perOwner = new Map()
        out.set(owner, perOwner)
      }
      const uri = row.file // absolute path; findModel can handle it
      let list = perOwner.get(uri)
      if (!list) {
        list = []
        perOwner.set(uri, list)
      }
      list.push(row)
    }
  }
  return out
}

function applySnapshot(byFile: Map<string, Diagnostic[]>): void {
  const monaco = monacoRef
  if (!monaco) return

  const nextOwnerMap = collectByOwner(byFile)

  // Pass 1: clear owners that no longer have any rows anywhere.
  for (const [ownerKey, uriMap] of painted) {
    const incoming = nextOwnerMap.get(ownerKey)
    if (!incoming) {
      for (const uri of uriMap.keys()) {
        const model = findModel(uri)
        if (model) monaco.editor.setModelMarkers(model, ownerKey, [])
      }
      painted.delete(ownerKey)
    }
  }

  // Pass 2: for every owner in the incoming set, write or wipe per URI.
  for (const [ownerKey, uriMap] of nextOwnerMap) {
    let paintedUris = painted.get(ownerKey)
    if (!paintedUris) {
      paintedUris = new Map()
      painted.set(ownerKey, paintedUris)
    }

    const stillHave = new Set<string>()
    for (const [uri, diags] of uriMap) {
      stillHave.add(uri)
      const model = findModel(uri)
      if (!model) continue
      const markers = diags.map(toMonacoMarker)
      monaco.editor.setModelMarkers(model, ownerKey, markers)
      paintedUris.set(uri, { count: markers.length })
    }

    // Wipe URIs this owner no longer reports.
    for (const prevUri of Array.from(paintedUris.keys())) {
      if (stillHave.has(prevUri)) continue
      const model = findModel(prevUri)
      if (model) monaco.editor.setModelMarkers(model, ownerKey, [])
      paintedUris.delete(prevUri)
    }
  }
}

/** Initialize. Idempotent — safe to call after `initMonacoDiagnostics`. */
export function initMonacoMarkerPainter(monacoApi: typeof Monaco): void {
  if (unsubscribe) return
  monacoRef = monacoApi

  // Prime with the current mirror state so freshly-opened files see markers
  // even if no Hub patch has arrived yet.
  applySnapshot(useDiagnosticStore.getState().diagnosticsByFile)

  unsubscribe = useDiagnosticStore.subscribe((state, prev) => {
    if (state.diagnosticsByFile === prev.diagnosticsByFile) return
    applySnapshot(state.diagnosticsByFile)
  })

  // When a new editor model is created (user opens a file) paint its markers
  // immediately instead of waiting for the next store update.
  onDidCreateModelDisposable = monacoApi.editor.onDidCreateModel((model) => {
    const filePath = (() => {
      try {
        return model.uri.scheme === 'file' ? model.uri.fsPath : model.uri.toString()
      } catch {
        return model.uri.toString()
      }
    })()
    const state = useDiagnosticStore.getState()
    for (const [, diags] of state.diagnosticsByFile) {
      if (diags.length === 0) continue
      const first = diags[0]
      if (!first) continue
      const normalizedStore = first.file.replace(/\\/g, '/').toLowerCase()
      const normalizedModel = filePath.replace(/\\/g, '/').toLowerCase()
      if (normalizedStore !== normalizedModel) continue
      const byOwner = new Map<string, Diagnostic[]>()
      for (const d of diags) {
        if (d.providerKey === 'monaco' || !d.providerKey) continue
        const list = byOwner.get(d.providerKey) ?? []
        list.push(d)
        byOwner.set(d.providerKey, list)
      }
      for (const [owner, list] of byOwner) {
        monacoApi.editor.setModelMarkers(model, owner, list.map(toMonacoMarker))
      }
    }
  })
}

/** Teardown — called from the workspace switch path. */
export function disposeMonacoMarkerPainter(): void {
  if (unsubscribe) {
    unsubscribe()
    unsubscribe = undefined
  }
  if (onDidCreateModelDisposable) {
    try { onDidCreateModelDisposable.dispose() } catch { /* noop */ }
    onDidCreateModelDisposable = null
  }
  if (monacoRef) {
    for (const [ownerKey, uriMap] of painted) {
      for (const uri of uriMap.keys()) {
        const model = findModel(uri)
        if (model) monacoRef.editor.setModelMarkers(model, ownerKey, [])
      }
    }
  }
  painted.clear()
  monacoRef = null
}
