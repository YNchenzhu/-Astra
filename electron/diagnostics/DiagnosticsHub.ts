/**
 * Diagnostics Hub — single source of truth for all diagnostics in the app.
 *
 * Inputs (main-process):
 *   - LSP publishDiagnostics (via {@link ../lsp/passiveFeedback.ts})
 *   - Monaco marker syncs from renderer (via `lsp:sync-diagnostics` IPC)
 *   - Future: external linters, AI-generated lints, etc.
 *
 * Outputs:
 *   - Snapshot + revision (full state at a point in time) for subscribers
 *   - Patches (per-URI diffs with monotonically increasing revision) pushed to
 *     the renderer; the renderer mirrors state into `useDiagnosticStore`.
 *   - `getAuthoritativeForFile(path)` for AI tools and context builders.
 *
 * Arbitration (== "one URI has only one authoritative voice at a time"):
 *   If a URI has at least one healthy `lsp:<server>` provider with rows,
 *   drop `monaco` rows for that URI when computing the authoritative view.
 *   Otherwise keep every provider's rows.
 */

import { diagnosticKeyFromUri, toCanonicalUri } from './uriNormalize'

/** LSP DiagnosticSeverity (1=Error..4=Hint). */
export type HubSeverity = 1 | 2 | 3 | 4

export interface HubPosition {
  line: number
  character: number
}

export interface HubRange {
  start: HubPosition
  end: HubPosition
}

export interface HubRelatedInformation {
  message: string
  location: { uri: string; range: HubRange }
}

export interface HubDiagnostic {
  range: HubRange
  severity: HubSeverity
  message: string
  /** Provider-provided source (e.g. 'ts', 'eslint', 'pyright'). */
  source?: string
  code?: string | number
  /** LSP DiagnosticTag values; 1 = Unnecessary, 2 = Deprecated. */
  tags?: number[]
  codeDescription?: { href: string }
  relatedInformation?: HubRelatedInformation[]
  /** Provider bucket key, e.g. 'monaco' or 'lsp:typescript'. Assigned by the Hub. */
  providerKey: string
}

export interface HubFileSnapshot {
  /** Canonical `file://` URI (consistent across providers for the same file). */
  uri: string
  diagnostics: HubDiagnostic[]
}

export interface HubSnapshot {
  revision: number
  files: HubFileSnapshot[]
  /** `providerKey` → health (true = authoritative; false = stale/unhealthy). */
  providerHealth: Record<string, boolean>
}

export interface HubPatch {
  revision: number
  /** Empty `diagnostics` means "this URI has no more diagnostics" (clear). */
  updates: HubFileSnapshot[]
  /** Only present when provider health changed. */
  providerHealth?: Record<string, boolean>
}

export type HubListener = (patch: HubPatch) => void

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

interface StoredRow extends HubDiagnostic {
  ingestedAt: number
}

interface ProviderBucket {
  /** LSP textDocument/didOpen version used for the last replace (if any). */
  version: number | undefined
  rows: StoredRow[]
}

interface FileEntry {
  /** Original display URI (first-seen). */
  canonicalUri: string
  /** providerKey → bucket. */
  providers: Map<string, ProviderBucket>
}

export interface DiagnosticsHubOptions {
  /** Debounce in milliseconds before flushing a patch to subscribers. */
  patchDebounceMs?: number
  /** Hard cap on retained URIs (oldest evicted when exceeded). */
  maxTrackedUris?: number
  /** Hard cap per URI for any single provider bucket. */
  maxRowsPerProviderPerUri?: number
  /** Truncate messages above this length. */
  maxMessageChars?: number
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

export interface DiagnosticsHub {
  ingestFromLsp(args: {
    serverName: string
    uri: string
    version?: number
    diagnostics: HubDiagnostic[] | RawLspDiagnostic[]
    healthy?: boolean
  }): void
  ingestFromMonaco(args: {
    uri: string
    version?: number
    diagnostics: HubDiagnostic[] | RawLspDiagnostic[]
  }): void
  /** Mark a provider (e.g. an LSP server) healthy/unhealthy. Triggers a patch. */
  setProviderHealth(providerKey: string, healthy: boolean): void
  /**
   * Declare which file extensions an LSP server covers. Used for global
   * "Monaco vs LSP" arbitration: when a URI's extension is covered by any
   * healthy LSP, Monaco rows for that URI are suppressed — even if the LSP
   * has never per-URI-published `[]` for this file. Without this, Monaco's
   * built-in TS/JS worker (no FS access) floods the Problems panel with
   * bogus "Cannot find module" on imports whose target isn't open as a tab.
   */
  registerLspCoverage(serverName: string, extensions: Iterable<string>): void
  /** Inverse of {@link registerLspCoverage}; called on LSP server shutdown. */
  unregisterLspCoverage(serverName: string): void
  /** Drop every provider's rows for a URI (e.g. file deleted on disk). */
  clearUri(uri: string): void
  /** Drop every URI's rows for a provider (e.g. LSP server shutdown). */
  clearProvider(providerKey: string): void
  /** Full reset — used on workspace switch. */
  clearAll(): void

  getSnapshot(): HubSnapshot
  getAuthoritativeForFile(uriOrPath: string): HubFileSnapshot | undefined
  getAllAuthoritative(): HubFileSnapshot[]
  getProviderHealth(): Record<string, boolean>
  /** Current LSP extension coverage map (providerKey → sorted extension list). */
  getLspCoverage(): Record<string, string[]>

  subscribe(listener: HubListener): () => void
}

type RawLspDiagnostic = {
  range?: { start?: Partial<HubPosition>; end?: Partial<HubPosition> }
  severity?: number
  message?: string
  source?: string
  code?: string | number
  tags?: number[]
  codeDescription?: { href: string }
  relatedInformation?: Array<{
    message: string
    location?: { uri: string; range?: { start?: Partial<HubPosition>; end?: Partial<HubPosition> } }
  }>
}

export function createDiagnosticsHub(options: DiagnosticsHubOptions = {}): DiagnosticsHub {
  const patchDebounceMs = options.patchDebounceMs ?? 50
  const maxTrackedUris = options.maxTrackedUris ?? 10_000
  const maxRowsPerProviderPerUri = options.maxRowsPerProviderPerUri ?? 500
  const maxMessageChars = options.maxMessageChars ?? 8_192

  /** Canonical key → FileEntry. */
  const files = new Map<string, FileEntry>()
  /** LRU ordering for URIs. Key order in Map is insertion order; we refresh via delete+set. */
  const providerHealth = new Map<string, boolean>()
  const listeners = new Set<HubListener>()
  /** URIs changed since last patch flush. */
  const dirty = new Set<string>()
  let revision = 0
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  let providerHealthDirty = false

  const MONACO_PROVIDER_KEY = 'monaco'

  /**
   * LSP extension coverage: providerKey ('lsp:<server>') → set of lower-cased
   * extensions (with leading dot, e.g. '.ts'). Managed via
   * {@link registerLspCoverage} / {@link unregisterLspCoverage} so the
   * arbitration layer knows which URIs fall under a given LSP's purview
   * WITHOUT having to wait for the server's first publishDiagnostics.
   */
  const lspExtensionCoverage = new Map<string, Set<string>>()

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  function touchLru(key: string, entry: FileEntry): void {
    files.delete(key)
    files.set(key, entry)
  }

  function evictIfNeeded(): void {
    while (files.size > maxTrackedUris) {
      const first = files.keys().next().value
      if (!first) break
      files.delete(first)
      dirty.add(first)
    }
  }

  function toHubDiagnostic(
    raw: HubDiagnostic | RawLspDiagnostic,
    providerKey: string,
  ): HubDiagnostic | undefined {
    if (!raw || typeof raw !== 'object') return undefined
    const r = raw as RawLspDiagnostic & Partial<HubDiagnostic>
    const start = r.range?.start
    const end = r.range?.end ?? start
    if (!start || typeof start.line !== 'number' || typeof start.character !== 'number') {
      return undefined
    }
    if (!end || typeof end.line !== 'number' || typeof end.character !== 'number') {
      return undefined
    }
    const sev = typeof r.severity === 'number' ? r.severity : 1
    const clampedSev: HubSeverity = sev >= 1 && sev <= 4 ? (sev as HubSeverity) : 1
    const rawMsg = typeof r.message === 'string' ? r.message : ''
    const message =
      rawMsg.length > maxMessageChars ? `${rawMsg.slice(0, maxMessageChars)}…[truncated]` : rawMsg
    return {
      range: {
        start: { line: start.line, character: start.character },
        end: { line: end.line, character: end.character },
      },
      severity: clampedSev,
      message,
      source: typeof r.source === 'string' ? r.source : undefined,
      code: typeof r.code === 'string' || typeof r.code === 'number' ? r.code : undefined,
      tags: Array.isArray(r.tags) ? r.tags.filter((t): t is number => typeof t === 'number') : undefined,
      codeDescription:
        r.codeDescription && typeof r.codeDescription.href === 'string'
          ? { href: r.codeDescription.href }
          : undefined,
      relatedInformation: Array.isArray(r.relatedInformation)
        ? r.relatedInformation
            .map((info) => {
              const loc = info?.location
              const rs = loc?.range?.start
              const re = loc?.range?.end ?? rs
              if (
                typeof info?.message !== 'string' ||
                typeof loc?.uri !== 'string' ||
                !rs ||
                typeof rs.line !== 'number' ||
                typeof rs.character !== 'number' ||
                !re ||
                typeof re.line !== 'number' ||
                typeof re.character !== 'number'
              ) {
                return undefined
              }
              return {
                message: info.message,
                location: {
                  uri: loc.uri,
                  range: {
                    start: { line: rs.line, character: rs.character },
                    end: { line: re.line, character: re.character },
                  },
                },
              }
            })
            .filter((x): x is HubRelatedInformation => !!x)
        : undefined,
      providerKey,
    }
  }

  function scheduleFlush(): void {
    if (flushTimer) return
    flushTimer = setTimeout(flush, patchDebounceMs)
  }

  function flush(): void {
    flushTimer = null
    if (dirty.size === 0 && !providerHealthDirty) return

    revision++
    const updates: HubFileSnapshot[] = []
    for (const key of dirty) {
      const entry = files.get(key)
      if (!entry) {
        updates.push({ uri: reconstructUriFromKey(key), diagnostics: [] })
        continue
      }
      updates.push(buildAuthoritativeSnapshot(entry))
    }
    dirty.clear()

    const patch: HubPatch = { revision, updates }
    if (providerHealthDirty) {
      patch.providerHealth = Object.fromEntries(providerHealth.entries())
      providerHealthDirty = false
    }

    for (const listener of listeners) {
      try {
        listener(patch)
      } catch (err) {
        console.error('[DiagnosticsHub] subscriber threw:', err)
      }
    }
  }

  /**
   * Best-effort: when a key was dropped (file evicted / cleared), we still
   * need to produce a display URI for subscribers. Reverse-normalization is
   * lossy (lower-cased, slashes) but good enough for UI keying because the
   * renderer also normalizes before comparing.
   */
  function reconstructUriFromKey(key: string): string {
    return toCanonicalUri(key)
  }

  /**
   * Extract the file extension (including leading dot, lower-cased) from any
   * input that might be a URI, canonical key, or raw path. Empty string when
   * absent — matching the behaviour of Node's `path.extname`.
   */
  function extensionFromUriOrKey(input: string): string {
    if (!input) return ''
    const trimmed = input.trim()
    if (!trimmed) return ''
    // Strip query/fragment on file:// URIs (very rare but cheap to handle).
    const q = trimmed.search(/[?#]/)
    const stem = q >= 0 ? trimmed.slice(0, q) : trimmed
    const lastSlash = Math.max(
      stem.lastIndexOf('/'),
      stem.lastIndexOf('\\'),
    )
    const basename = lastSlash >= 0 ? stem.slice(lastSlash + 1) : stem
    const dot = basename.lastIndexOf('.')
    if (dot <= 0) return '' // leading-dot filenames (e.g. '.gitignore') have no ext
    return basename.slice(dot).toLowerCase()
  }

  /**
   * Does any healthy LSP provider claim coverage for this URI?
   *
   *   1. Per-URI: an LSP bucket already exists on the entry (healthy).
   *      Captures the case where the server has published — with or without
   *      rows — for this exact URI.
   *   2. Global: the URI's extension is in the coverage map of any healthy
   *      `lsp:<server>`. Captures the (very common) case where tsserver /
   *      pyright have been started for the workspace but haven't yet sent a
   *      per-file publishDiagnostics for a clean file — LSP spec does NOT
   *      require servers to proactively emit `[]` for clean files, so we
   *      cannot rely on per-URI state alone.
   */
  function hasHealthyLspCoverage(uri: string, entry?: FileEntry): boolean {
    if (entry) {
      for (const [providerKey] of entry.providers) {
        if (providerKey === MONACO_PROVIDER_KEY) continue
        if (providerHealth.get(providerKey) !== false) return true
      }
    }
    if (lspExtensionCoverage.size === 0) return false
    const ext = extensionFromUriOrKey(uri)
    if (!ext) return false
    for (const [providerKey, exts] of lspExtensionCoverage) {
      if (!exts.has(ext)) continue
      if (providerHealth.get(providerKey) === false) continue
      return true
    }
    return false
  }

  function buildAuthoritativeSnapshot(entry: FileEntry): HubFileSnapshot {
    const hasHealthyLsp = hasHealthyLspCoverage(entry.canonicalUri, entry)
    const merged: HubDiagnostic[] = []
    const seen = new Set<string>()
    for (const [providerKey, bucket] of entry.providers) {
      if (hasHealthyLsp && providerKey === MONACO_PROVIDER_KEY) continue
      if (providerHealth.get(providerKey) === false) continue
      for (const row of bucket.rows) {
        const dedupKey = buildDedupKey(row)
        if (seen.has(dedupKey)) continue
        seen.add(dedupKey)
        merged.push(row)
      }
    }
    merged.sort(compareDiagnosticsForDisplay)
    return { uri: entry.canonicalUri, diagnostics: merged }
  }

  function buildDedupKey(d: HubDiagnostic): string {
    return [
      d.severity,
      d.range.start.line,
      d.range.start.character,
      d.range.end.line,
      d.range.end.character,
      d.source ?? '',
      d.code ?? '',
      d.message,
    ].join('\u0000')
  }

  function compareDiagnosticsForDisplay(a: HubDiagnostic, b: HubDiagnostic): number {
    if (a.severity !== b.severity) return a.severity - b.severity
    if (a.range.start.line !== b.range.start.line) return a.range.start.line - b.range.start.line
    if (a.range.start.character !== b.range.start.character) {
      return a.range.start.character - b.range.start.character
    }
    const aSrc = a.source ?? ''
    const bSrc = b.source ?? ''
    if (aSrc !== bSrc) return aSrc < bSrc ? -1 : 1
    const aCode = String(a.code ?? '')
    const bCode = String(b.code ?? '')
    if (aCode !== bCode) return aCode < bCode ? -1 : 1
    return 0
  }

  function ensureEntry(uri: string): { key: string; entry: FileEntry } {
    const key = diagnosticKeyFromUri(uri)
    let entry = files.get(key)
    if (!entry) {
      entry = { canonicalUri: toCanonicalUri(uri), providers: new Map() }
      files.set(key, entry)
    } else {
      touchLru(key, entry)
    }
    return { key, entry }
  }

  function replaceBucket(
    uri: string,
    providerKey: string,
    version: number | undefined,
    rawDiagnostics: Array<HubDiagnostic | RawLspDiagnostic>,
  ): void {
    if (!uri) return

    const isLsp = providerKey !== MONACO_PROVIDER_KEY
    const empty = !rawDiagnostics || rawDiagnostics.length === 0

    // Memory-hygiene short-circuit: Monaco "empty" on a URI we've never seen
    // is a no-op. We only create a file entry when there's state worth
    // keeping (LSP empty → "coverage acknowledged" counts, see below).
    if (empty && !isLsp && !files.has(diagnosticKeyFromUri(uri))) {
      return
    }

    const { key, entry } = ensureEntry(uri)

    // Version guard: drop stale writes for the same bucket.
    const existingBucket = entry.providers.get(providerKey)
    if (
      existingBucket &&
      typeof version === 'number' &&
      typeof existingBucket.version === 'number' &&
      version < existingBucket.version
    ) {
      return
    }

    if (empty) {
      // Previously we deleted the bucket here. That broke arbitration: when
      // tsserver reported a clean file (diagnostics: []) after Monaco had
      // already posted bogus "Cannot find module" rows, we lost the LSP
      // "coverage" signal and Monaco's false positives became authoritative.
      //
      // Now:
      //   - For LSP providers we RETAIN the bucket with rows=[]. It carries
      //     the "LSP has seen this URI and it's clean" signal, which
      //     `buildAuthoritativeSnapshot` needs to keep suppressing Monaco.
      //   - For Monaco we still drop the bucket, because Monaco is never the
      //     authoritative voice we want to preserve coverage for.
      //   - The file entry is fully removed only when every bucket is empty
      //     AND the Monaco bucket is gone — preventing unbounded growth.
      const had = entry.providers.has(providerKey)
      let changed = had
      if (isLsp) {
        entry.providers.set(providerKey, { version, rows: [] })
        changed = true
      } else {
        entry.providers.delete(providerKey)
      }

      const everyBucketEmpty = (() => {
        for (const b of entry.providers.values()) {
          if (b.rows.length > 0) return false
        }
        return true
      })()
      // If Monaco is gone AND every remaining bucket is empty, we can drop
      // the entry entirely — the renderer will receive an empty-updates
      // patch that clears its mirror for this URI.
      if (everyBucketEmpty && !entry.providers.has(MONACO_PROVIDER_KEY)) {
        files.delete(key)
      }
      if (changed) {
        dirty.add(key)
        scheduleFlush()
      }
      return
    }

    const rows: StoredRow[] = []
    const now = Date.now()
    for (const raw of rawDiagnostics.slice(0, maxRowsPerProviderPerUri)) {
      const shaped = toHubDiagnostic(raw, providerKey)
      if (!shaped) continue
      rows.push({ ...shaped, ingestedAt: now })
    }
    entry.providers.set(providerKey, { version, rows })
    dirty.add(key)
    evictIfNeeded()
    scheduleFlush()
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  function ingestFromLsp(args: {
    serverName: string
    uri: string
    version?: number
    diagnostics: HubDiagnostic[] | RawLspDiagnostic[]
    healthy?: boolean
  }): void {
    const providerKey = `lsp:${args.serverName}`
    if (typeof args.healthy === 'boolean') {
      setProviderHealthInternal(providerKey, args.healthy, /*flush*/ false)
    } else if (!providerHealth.has(providerKey)) {
      providerHealth.set(providerKey, true)
      providerHealthDirty = true
    }
    replaceBucket(args.uri, providerKey, args.version, args.diagnostics)
  }

  function ingestFromMonaco(args: {
    uri: string
    version?: number
    diagnostics: HubDiagnostic[] | RawLspDiagnostic[]
  }): void {
    if (!providerHealth.has(MONACO_PROVIDER_KEY)) {
      providerHealth.set(MONACO_PROVIDER_KEY, true)
      providerHealthDirty = true
    }
    replaceBucket(args.uri, MONACO_PROVIDER_KEY, args.version, args.diagnostics)
  }

  function setProviderHealthInternal(
    providerKey: string,
    healthy: boolean,
    andFlush: boolean,
  ): void {
    const prev = providerHealth.get(providerKey)
    if (prev === healthy) return
    providerHealth.set(providerKey, healthy)
    providerHealthDirty = true
    for (const [key] of files) {
      dirty.add(key)
    }
    if (andFlush) scheduleFlush()
  }

  function setProviderHealth(providerKey: string, healthy: boolean): void {
    setProviderHealthInternal(providerKey, healthy, true)
  }

  function registerLspCoverage(
    serverName: string,
    extensions: Iterable<string>,
  ): void {
    if (!serverName || typeof serverName !== 'string') return
    const providerKey = `lsp:${serverName}`
    const normalized = new Set<string>()
    for (const raw of extensions) {
      if (typeof raw !== 'string') continue
      const trimmed = raw.trim().toLowerCase()
      if (!trimmed) continue
      normalized.add(trimmed.startsWith('.') ? trimmed : `.${trimmed}`)
    }
    const existing = lspExtensionCoverage.get(providerKey)
    if (existing && existing.size === normalized.size) {
      let same = true
      for (const ext of normalized) {
        if (!existing.has(ext)) {
          same = false
          break
        }
      }
      if (same) return
    }
    lspExtensionCoverage.set(providerKey, normalized)
    // Coverage change can flip arbitration for every currently-tracked URI
    // whose extension lives in this set — mark them dirty so the next flush
    // re-evaluates `hasHealthyLspCoverage`.
    if (normalized.size > 0) {
      for (const [key, entry] of files) {
        const ext = extensionFromUriOrKey(entry.canonicalUri)
        if (ext && normalized.has(ext)) dirty.add(key)
      }
      scheduleFlush()
    }
  }

  function unregisterLspCoverage(serverName: string): void {
    if (!serverName || typeof serverName !== 'string') return
    const providerKey = `lsp:${serverName}`
    const existing = lspExtensionCoverage.get(providerKey)
    if (!existing) return
    lspExtensionCoverage.delete(providerKey)
    // Same reason as in `registerLspCoverage`: URIs under the removed
    // coverage may now need to fall back to Monaco rows, so flag them dirty.
    for (const [key, entry] of files) {
      const ext = extensionFromUriOrKey(entry.canonicalUri)
      if (ext && existing.has(ext)) dirty.add(key)
    }
    scheduleFlush()
  }

  function getLspCoverage(): Record<string, string[]> {
    const out: Record<string, string[]> = {}
    for (const [key, exts] of lspExtensionCoverage) {
      out[key] = Array.from(exts).sort()
    }
    return out
  }

  function clearUri(uri: string): void {
    const key = diagnosticKeyFromUri(uri)
    if (!files.delete(key)) return
    dirty.add(key)
    scheduleFlush()
  }

  function clearProvider(providerKey: string): void {
    let touched = false
    for (const [key, entry] of files) {
      if (entry.providers.delete(providerKey)) {
        dirty.add(key)
        touched = true
        if (entry.providers.size === 0) files.delete(key)
      }
    }
    if (providerHealth.delete(providerKey)) {
      providerHealthDirty = true
      touched = true
    }
    // Purge any LSP extension coverage for this provider — otherwise
    // arbitration would keep suppressing Monaco on the covered extensions
    // even though the server is gone.
    if (lspExtensionCoverage.delete(providerKey)) {
      for (const [key] of files) dirty.add(key)
      touched = true
    }
    if (touched) scheduleFlush()
  }

  function clearAll(): void {
    if (
      files.size === 0 &&
      providerHealth.size === 0 &&
      lspExtensionCoverage.size === 0
    ) {
      return
    }
    for (const [key] of files) dirty.add(key)
    files.clear()
    providerHealth.clear()
    lspExtensionCoverage.clear()
    providerHealthDirty = true
    scheduleFlush()
  }

  function getSnapshot(): HubSnapshot {
    const out: HubFileSnapshot[] = []
    for (const entry of files.values()) {
      const merged = buildAuthoritativeSnapshot(entry)
      if (merged.diagnostics.length === 0) continue
      out.push(merged)
    }
    return {
      revision,
      files: out,
      providerHealth: Object.fromEntries(providerHealth.entries()),
    }
  }

  function getAuthoritativeForFile(uriOrPath: string): HubFileSnapshot | undefined {
    const key = diagnosticKeyFromUri(uriOrPath)
    const entry = files.get(key)
    if (!entry) return undefined
    return buildAuthoritativeSnapshot(entry)
  }

  function getAllAuthoritative(): HubFileSnapshot[] {
    const out: HubFileSnapshot[] = []
    for (const entry of files.values()) {
      const snap = buildAuthoritativeSnapshot(entry)
      if (snap.diagnostics.length > 0) out.push(snap)
    }
    return out
  }

  function getProviderHealth(): Record<string, boolean> {
    return Object.fromEntries(providerHealth.entries())
  }

  function subscribe(listener: HubListener): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  return {
    ingestFromLsp,
    ingestFromMonaco,
    setProviderHealth,
    registerLspCoverage,
    unregisterLspCoverage,
    clearUri,
    clearProvider,
    clearAll,
    getSnapshot,
    getAuthoritativeForFile,
    getAllAuthoritative,
    getProviderHealth,
    getLspCoverage,
    subscribe,
  }
}

// ---------------------------------------------------------------------------
// Process-wide singleton
// ---------------------------------------------------------------------------

let singleton: DiagnosticsHub | undefined

export function getDiagnosticsHub(): DiagnosticsHub {
  if (!singleton) {
    singleton = createDiagnosticsHub()
  }
  return singleton
}

/** Internal test-only: replace the singleton (not exported from barrel). */
export function __setDiagnosticsHubForTests(hub: DiagnosticsHub | undefined): void {
  singleton = hub
}
