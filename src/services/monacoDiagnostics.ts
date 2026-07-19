/**
 * Monaco → Hub diagnostics bridge.
 *
 * Responsibilities:
 *   1. Push Monaco editor markers (non-TS/JS: JSON schema, CSS, HTML, …) to
 *      the main-process DiagnosticsHub via `lsp:sync-diagnostics`. The Hub
 *      is the single source of truth; this module no longer writes the
 *      renderer `useDiagnosticStore` directly (that store is a mirror
 *      populated by `diagnosticsSync.ts`).
 *   2. Notify the subprocess LSP of model open/change via `lspDocumentSync`.
 *   3. **Permanently disable** Monaco's built-in TypeScript/JavaScript
 *      semantic + suggestion diagnostics. Monaco's TS worker runs entirely
 *      in-memory and has no knowledge of the workspace on disk, so on any
 *      non-trivial project it produces waves of false "Cannot find module"
 *      / "Cannot find name" errors for imports whose target files aren't
 *      currently open as Monaco models. Cross-file TS/JS diagnostics are
 *      the job of the subprocess `typescript-language-server`; Monaco's
 *      worker is kept for syntax highlighting, in-tab autocomplete, hover,
 *      go-to-def, etc.
 *
 * Earlier versions of this module tried to toggle Monaco's semantic flag
 * based on `providerHealth`, but the toggle raced with
 * `applyWorkspaceTsConfigToMonaco` (which also called
 * `setDiagnosticsOptions`) and frequently ended up re-enabling Monaco's
 * false positives mid-session. We intentionally removed that coupling;
 * `applyWorkspaceTsConfigToMonaco` no longer touches diagnostics options.
 */

import type * as Monaco from 'monaco-editor'
import {
  MONACO_MARKER_POLL_FALLBACK_MS,
  MONACO_MODEL_CONTENT_DEBOUNCE_MS,
  MONACO_NEW_MODEL_MARKER_DELAY_MS,
} from '../constants/appTiming'
import { useWorkspaceStore } from '../stores/useWorkspaceStore'
import { applyWorkspaceTsConfigToMonaco } from './monacoWorkspaceTsConfig'
import { notifyLspDocumentOpen, scheduleLspDocumentChange } from './lspDocumentSync'
import {
  initMonacoMarkerPainter,
  disposeMonacoMarkerPainter,
} from './monacoMarkerPainter'

let monacoInstance: typeof Monaco | null = null
let initialized = false
let _pollingTimer: ReturnType<typeof setInterval> | null = null
// Disposables / unsubscribes accumulated by initMonacoDiagnostics. Reset by
// disposeMonacoDiagnostics so re-initialization (HMR or settings reload) does
// not pile up duplicate listeners on the workspace store and Monaco editor.
let _workspaceStoreUnsub: (() => void) | null = null
let _onDidCreateModelDisposable: Monaco.IDisposable | null = null
let _onDidChangeMarkersDisposable: Monaco.IDisposable | null = null

/**
 * Monaco marker owners (`m.owner`) we actively IGNORE when forwarding to the
 * Hub. These correspond to Monaco's in-memory TS/JS worker, whose diagnostics
 * we have disabled anyway — but the worker occasionally still emits transient
 * markers during model setup (e.g. while the new `setDiagnosticsOptions` is
 * propagating). Filtering by owner prevents those from leaking into the
 * Problems panel.
 */
const IGNORED_MARKER_OWNERS = new Set<string>([
  'typescript',
  'javascript',
])

function modelFileAbsolutePath(model: Monaco.editor.ITextModel): string | null {
  if (model.uri.scheme !== 'file') return null
  try {
    const fp = model.uri.fsPath
    return fp && fp.length > 0 ? fp : null
  } catch {
    return null
  }
}

function monacoSeverityToLsp(monacoSev: number): number {
  // Monaco: 1=Hint, 2=Info, 4=Warning, 8=Error
  // LSP:    1=Error, 2=Warning, 3=Information, 4=Hint
  switch (monacoSev) {
    case 8: return 1
    case 4: return 2
    case 2: return 3
    case 1: return 4
    default: return 1
  }
}

/**
 * Lock Monaco's TS/JS worker into "no semantic, no suggestion, syntax only"
 * mode. Called once at init time AND from any subsequent workspace reload
 * (e.g. after `applyWorkspaceTsConfigToMonaco`), so there is no window in
 * which Monaco can slip bogus semantic errors into the Problems panel.
 */
function lockdownMonacoTsDiagnostics(monacoApi: typeof Monaco): void {
  const tsDefaults = (
    monacoApi.languages as {
      typescript?: { typescriptDefaults?: unknown; javascriptDefaults?: unknown }
    }
  ).typescript
  const tsD = tsDefaults?.typescriptDefaults as
    | { setDiagnosticsOptions: (o: Monaco.languages.typescript.DiagnosticsOptions) => void }
    | undefined
  const jsD = tsDefaults?.javascriptDefaults as
    | { setDiagnosticsOptions: (o: Monaco.languages.typescript.DiagnosticsOptions) => void }
    | undefined
  const opts: Monaco.languages.typescript.DiagnosticsOptions = {
    noSemanticValidation: true,
    noSuggestionDiagnostics: true,
    noSyntaxValidation: false,
    // Belt-and-suspenders: explicitly silence the usual suspects — missing
    // module, import-is-not-a-module, JSX-not-in-a-module-context — so even
    // if a future Monaco version flips the default back on, these stay off.
    diagnosticCodesToIgnore: [
      2307, // Cannot find module '…' or its corresponding type declarations
      2304, // Cannot find name '…'
      2305, // Module '…' has no exported member '…'
      2613, // Module '…' has no default export
      2614, // Module '…' has no exported member '…'; did you mean …
      2792, // Cannot find module '…'. Did you mean to set the 'moduleResolution' option to 'node'?
      7016, // Could not find a declaration file for module '…'
      6142, // Module '…' was resolved to '…', but '--jsx' is not set
      6133, // '…' is declared but its value is never read
    ],
  }
  tsD?.setDiagnosticsOptions(opts)
  jsD?.setDiagnosticsOptions(opts)
}

/**
 * Apply the workspace tsconfig (project-references-aware) to Monaco's TS/JS
 * worker, then re-lock diagnostics options so the tsconfig loader's internal
 * state changes cannot accidentally re-enable semantic validation.
 */
async function applyTsConfigAndRelock(monacoApi: typeof Monaco, rootPath: string | null | undefined): Promise<void> {
  try {
    await applyWorkspaceTsConfigToMonaco(monacoApi, rootPath ?? null)
  } catch (err) {
    console.warn('[monacoDiagnostics] tsconfig apply failed:', (err as Error).message)
  }
  lockdownMonacoTsDiagnostics(monacoApi)
}

export function initMonacoDiagnostics(monacoApi: typeof Monaco): void {
  if (initialized) return
  initialized = true
  monacoInstance = monacoApi

  // Lock down BEFORE applying tsconfig, BEFORE creating any model listeners,
  // and BEFORE any markers can be painted. Then re-lock after the async
  // tsconfig apply resolves — this is the belt-and-suspenders that used to
  // be missing.
  lockdownMonacoTsDiagnostics(monacoApi)
  void applyTsConfigAndRelock(monacoApi, useWorkspaceStore.getState().rootPath ?? null)

  // Paint LSP-sourced diagnostics as in-editor squigglies (P5). Owner string
  // per server means we never clash with Monaco's built-in workers
  // (owner='typescript' / 'javascript' / 'css' / …).
  initMonacoMarkerPainter(monacoApi)

  // Re-apply tsconfig + lockdown whenever the workspace root changes. The
  // workspace store is the canonical source of "which repo is loaded".
  // Save the unsubscribe handle so disposeMonacoDiagnostics can release it;
  // otherwise re-init (HMR / settings reload) accumulates duplicate
  // subscriptions and every workspace switch triggers N callbacks.
  let lastRoot = useWorkspaceStore.getState().rootPath ?? null
  _workspaceStoreUnsub = useWorkspaceStore.subscribe((state) => {
    const next = state.rootPath ?? null
    if (next === lastRoot) return
    lastRoot = next
    void applyTsConfigAndRelock(monacoApi, next)
  })

  _onDidCreateModelDisposable = monacoApi.editor.onDidCreateModel((model: Monaco.editor.ITextModel) => {
    // Track BOTH timers (initial + debounce) so onWillDispose can cancel
    // them. If we don't, a fast file-close → file-open sequence fires the
    // setTimeout against an already-disposed model and Monaco throws
    // `BugIndicatingError: Model is disposed!` from inside getVersionId() /
    // getValue().
    let initialTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      initialTimer = null
      if (model.isDisposed()) return
      processMarkers(model)
      const abs = modelFileAbsolutePath(model)
      if (abs) notifyLspDocumentOpen(abs, model.getValue())
    }, MONACO_NEW_MODEL_MARKER_DELAY_MS)

    let debounceTimer: ReturnType<typeof setTimeout> | null = null
    const changeSub = model.onDidChangeContent(() => {
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        debounceTimer = null
        if (model.isDisposed()) return
        processMarkers(model)
        const abs = modelFileAbsolutePath(model)
        if (abs) scheduleLspDocumentChange(abs, model.getValue())
      }, MONACO_MODEL_CONTENT_DEBOUNCE_MS)
    })
    // When the model is disposed, clear the pending timers (whose closures
    // pin this model in memory until they fire) and explicitly dispose the
    // change subscription. Monaco does internally release the subscription
    // on dispose, but the timers are owned by setTimeout — not by Monaco —
    // and would otherwise fire `processMarkers(model)` / `model.getValue()`
    // on a disposed model and throw.
    model.onWillDispose(() => {
      if (initialTimer) {
        clearTimeout(initialTimer)
        initialTimer = null
      }
      if (debounceTimer) {
        clearTimeout(debounceTimer)
        debounceTimer = null
      }
      try { changeSub.dispose() } catch { /* noop */ }
    })
  })

  if (typeof monacoApi.editor.onDidChangeMarkers === 'function') {
    _onDidChangeMarkersDisposable = monacoApi.editor.onDidChangeMarkers((changedUris) => {
      for (const uri of changedUris) {
        const model = monacoApi.editor.getModel(uri)
        if (model) processMarkers(model)
      }
    })
  } else {
    _pollingTimer = setInterval(() => {
      for (const model of monacoApi.editor.getModels()) {
        processMarkers(model)
      }
    }, MONACO_MARKER_POLL_FALLBACK_MS)
  }
}

function processMarkers(model: Monaco.editor.ITextModel): void {
  const monaco = monacoInstance
  if (!monaco) return
  // Defensive: getVersionId / getModelMarkers throw `BugIndicatingError:
  // Model is disposed!` if the model has been torn down between the caller
  // capturing the reference and this function running (timers, async
  // marker-change events, polling fallback, etc.).
  if (model.isDisposed()) return

  const markers = monaco.editor.getModelMarkers({ resource: model.uri })
  const uri = model.uri.toString()
  const documentVersion = model.getVersionId()

  // Drop TS/JS-worker markers. Monaco's semantic engine is locked down but
  // syntax errors it emits have owner 'typescript' / 'javascript' as well;
  // those overlap 100% with what the subprocess tsserver reports. Keeping
  // only non-TS/JS markers means JSON-schema, CSS, HTML — Monaco's strengths
  // — still flow through.
  const forwarded = markers.filter((m) => {
    const owner = typeof m.source === 'string' ? m.source : ''
    return !IGNORED_MARKER_OWNERS.has(owner)
  })

  if (forwarded.length === 0) {
    syncDiagnosticsToMain(uri, [], documentVersion)
    return
  }

  const lspDiagnostics = forwarded.map((m) => ({
    range: {
      start: { line: m.startLineNumber - 1, character: m.startColumn - 1 },
      end: { line: m.endLineNumber - 1, character: m.endColumn - 1 },
    },
    severity: monacoSeverityToLsp(m.severity),
    message: m.message,
    source: typeof m.source === 'string' && m.source ? m.source : 'monaco',
    code: typeof m.code === 'string' || typeof m.code === 'number' ? m.code : undefined,
  }))

  syncDiagnosticsToMain(uri, lspDiagnostics, documentVersion)
}

function syncDiagnosticsToMain(
  uri: string,
  diagnostics: Array<{
    range: { start: { line: number; character: number }; end: { line: number; character: number } }
    severity?: number
    message: string
    source?: string
    code?: string | number
  }>,
  documentVersion?: number,
): void {
  if (!window.electronAPI?.lsp?.syncDiagnostics) return

  window.electronAPI.lsp
    .syncDiagnostics({ uri, diagnostics, documentVersion })
    .then(() => {})
    .catch(() => {
      // Ignore sync failures; mirror subscription will catch up on next snapshot.
    })
}

export function refreshMarkersForModelPath(filePath: string): void {
  const monacoApi = monacoInstance
  if (!monacoApi) return

  const normalizedTarget = filePath.replace(/\\/g, '/').toLowerCase()
  const allModels = monacoApi.editor.getModels()
  const model = allModels.find((candidate) => {
    const modelPath = candidate.uri.path.replace(/\\/g, '/').toLowerCase()
    return modelPath === normalizedTarget || modelPath.endsWith(`/${normalizedTarget}`)
  })

  if (model) processMarkers(model)
}

export function disposeMonacoDiagnostics(): void {
  if (_pollingTimer) {
    clearInterval(_pollingTimer)
    _pollingTimer = null
  }
  if (_workspaceStoreUnsub) {
    try { _workspaceStoreUnsub() } catch { /* noop */ }
    _workspaceStoreUnsub = null
  }
  if (_onDidCreateModelDisposable) {
    try { _onDidCreateModelDisposable.dispose() } catch { /* noop */ }
    _onDidCreateModelDisposable = null
  }
  if (_onDidChangeMarkersDisposable) {
    try { _onDidChangeMarkersDisposable.dispose() } catch { /* noop */ }
    _onDidChangeMarkersDisposable = null
  }
  disposeMonacoMarkerPainter()
  initialized = false
  monacoInstance = null
}
