/**
 * Core Hub invariants — kept deliberately small and synchronous so CI can run
 * them without spinning up Electron. The debounced flush is exercised by
 * manually advancing fake timers.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createDiagnosticsHub, type HubDiagnostic, type HubPatch } from './DiagnosticsHub'

function sampleDiag(line: number, message: string, extras: Partial<HubDiagnostic> = {}): HubDiagnostic {
  return {
    range: { start: { line, character: 0 }, end: { line, character: 4 } },
    severity: 1,
    message,
    providerKey: '',
    ...extras,
  }
}

describe('DiagnosticsHub', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('ingests LSP diagnostics and emits a patch with authoritative view', () => {
    const hub = createDiagnosticsHub({ patchDebounceMs: 10 })
    const patches: HubPatch[] = []
    hub.subscribe((p) => patches.push(p))

    hub.ingestFromLsp({
      serverName: 'typescript',
      uri: 'file:///C:/ws/a.ts',
      version: 1,
      diagnostics: [sampleDiag(0, 'type error')],
    })

    vi.advanceTimersByTime(20)

    expect(patches).toHaveLength(1)
    expect(patches[0].updates[0].diagnostics).toHaveLength(1)
    expect(patches[0].updates[0].diagnostics[0].providerKey).toBe('lsp:typescript')
    expect(patches[0].providerHealth?.['lsp:typescript']).toBe(true)
  })

  it('suppresses Monaco rows when an LSP provider is healthy for the same URI', () => {
    const hub = createDiagnosticsHub({ patchDebounceMs: 5 })
    const patches: HubPatch[] = []
    hub.subscribe((p) => patches.push(p))

    hub.ingestFromMonaco({
      uri: 'file:///C:/ws/a.ts',
      diagnostics: [sampleDiag(0, 'monaco says boom')],
    })
    hub.ingestFromLsp({
      serverName: 'typescript',
      uri: 'file:///C:/ws/a.ts',
      diagnostics: [sampleDiag(0, 'tsserver says boom')],
    })
    vi.advanceTimersByTime(20)

    const snap = hub.getSnapshot()
    expect(snap.files).toHaveLength(1)
    expect(snap.files[0].diagnostics).toHaveLength(1)
    expect(snap.files[0].diagnostics[0].providerKey).toBe('lsp:typescript')
  })

  it('falls back to Monaco when the LSP provider becomes unhealthy', () => {
    const hub = createDiagnosticsHub({ patchDebounceMs: 5 })

    hub.ingestFromMonaco({
      uri: 'file:///C:/ws/a.ts',
      diagnostics: [sampleDiag(0, 'monaco')],
    })
    hub.ingestFromLsp({
      serverName: 'typescript',
      uri: 'file:///C:/ws/a.ts',
      diagnostics: [sampleDiag(0, 'tsserver')],
    })
    vi.advanceTimersByTime(20)

    hub.setProviderHealth('lsp:typescript', false)
    vi.advanceTimersByTime(20)

    const snap = hub.getSnapshot()
    // unhealthy LSP rows are filtered too; only monaco remains
    expect(snap.files[0].diagnostics).toHaveLength(1)
    expect(snap.files[0].diagnostics[0].providerKey).toBe('monaco')
  })

  it('drops stale version writes for the same provider+URI', () => {
    const hub = createDiagnosticsHub({ patchDebounceMs: 5 })

    hub.ingestFromLsp({
      serverName: 'typescript',
      uri: 'file:///C:/ws/a.ts',
      version: 2,
      diagnostics: [sampleDiag(0, 'v2')],
    })
    vi.advanceTimersByTime(20)

    hub.ingestFromLsp({
      serverName: 'typescript',
      uri: 'file:///C:/ws/a.ts',
      version: 1, // stale
      diagnostics: [sampleDiag(0, 'v1')],
    })
    vi.advanceTimersByTime(20)

    const snap = hub.getSnapshot()
    expect(snap.files[0].diagnostics[0].message).toBe('v2')
  })

  it('clearProvider removes that provider across all files and updates health', () => {
    const hub = createDiagnosticsHub({ patchDebounceMs: 5 })
    hub.ingestFromLsp({
      serverName: 'pyright',
      uri: 'file:///C:/ws/a.py',
      diagnostics: [sampleDiag(0, 'py err')],
    })
    hub.ingestFromLsp({
      serverName: 'typescript',
      uri: 'file:///C:/ws/a.ts',
      diagnostics: [sampleDiag(0, 'ts err')],
    })
    vi.advanceTimersByTime(20)

    hub.clearProvider('lsp:typescript')
    vi.advanceTimersByTime(20)

    const snap = hub.getSnapshot()
    const uris = snap.files.map((f) => f.uri)
    expect(uris.some((u) => u.endsWith('a.ts'))).toBe(false)
    expect(uris.some((u) => u.endsWith('a.py'))).toBe(true)
    expect(snap.providerHealth['lsp:typescript']).toBeUndefined()
  })

  it('deduplicates identical diagnostics across providers', () => {
    const hub = createDiagnosticsHub({ patchDebounceMs: 5 })
    const sameShape = sampleDiag(0, 'dup', { source: 'ts', code: 2322 })

    hub.ingestFromMonaco({
      uri: 'file:///C:/ws/a.ts',
      diagnostics: [sameShape],
    })
    hub.ingestFromLsp({
      serverName: 'typescript',
      uri: 'file:///C:/ws/a.ts',
      diagnostics: [sameShape],
    })
    vi.advanceTimersByTime(20)

    const snap = hub.getSnapshot()
    // LSP wins (Monaco suppressed) — only one row.
    expect(snap.files[0].diagnostics).toHaveLength(1)
  })

  it('clearAll emits a patch that empties the mirror and bumps revision', () => {
    const hub = createDiagnosticsHub({ patchDebounceMs: 5 })
    const patches: HubPatch[] = []
    hub.subscribe((p) => patches.push(p))

    hub.ingestFromLsp({
      serverName: 'typescript',
      uri: 'file:///C:/ws/a.ts',
      diagnostics: [sampleDiag(0, 'err')],
    })
    vi.advanceTimersByTime(20)

    hub.clearAll()
    vi.advanceTimersByTime(20)

    expect(patches.length).toBeGreaterThanOrEqual(2)
    expect(hub.getSnapshot().files).toHaveLength(0)
    const last = patches[patches.length - 1]
    // Last patch either reports empty updates for the gone URI or a health reset
    expect(last.revision).toBeGreaterThan(patches[0].revision)
  })

  // ---------------------------------------------------------------------
  // Regression tests for the "Monaco vs LSP" arbitration gap that caused
  // bogus import/export errors to leak into the Problems panel whenever
  // tsserver considered a file clean.
  // ---------------------------------------------------------------------

  it('preserves empty LSP buckets so Monaco stays suppressed when LSP reports clean', () => {
    const hub = createDiagnosticsHub({ patchDebounceMs: 5 })

    hub.ingestFromMonaco({
      uri: 'file:///C:/ws/a.ts',
      diagnostics: [sampleDiag(0, 'monaco says Cannot find module')],
    })
    // tsserver says the file is clean — historically we deleted the LSP
    // bucket here and Monaco rows became authoritative.
    hub.ingestFromLsp({
      serverName: 'typescript',
      uri: 'file:///C:/ws/a.ts',
      diagnostics: [],
    })
    vi.advanceTimersByTime(20)

    const snap = hub.getSnapshot()
    // Monaco's row must be suppressed even though LSP reported zero rows.
    expect(snap.files).toHaveLength(0)
  })

  it('suppresses Monaco via global extension coverage before LSP publishes', () => {
    const hub = createDiagnosticsHub({ patchDebounceMs: 5 })

    // Simulate LSPServerManager.initialize() announcing that the TS server
    // is now up and covers .ts / .tsx — without having sent any
    // publishDiagnostics yet.
    hub.registerLspCoverage('typescript', ['.ts', '.tsx'])

    hub.ingestFromMonaco({
      uri: 'file:///C:/ws/a.tsx',
      diagnostics: [sampleDiag(0, 'Cannot find name document')],
    })
    vi.advanceTimersByTime(20)

    const snap = hub.getSnapshot()
    expect(snap.files).toHaveLength(0)
  })

  it('keeps Monaco rows visible for extensions the LSP does NOT cover', () => {
    const hub = createDiagnosticsHub({ patchDebounceMs: 5 })

    hub.registerLspCoverage('typescript', ['.ts', '.tsx'])

    hub.ingestFromMonaco({
      uri: 'file:///C:/ws/styles.css',
      diagnostics: [sampleDiag(0, 'unknown css property')],
    })
    vi.advanceTimersByTime(20)

    const snap = hub.getSnapshot()
    expect(snap.files).toHaveLength(1)
    expect(snap.files[0].diagnostics[0].providerKey).toBe('monaco')
  })

  it('restores Monaco rows when LSP coverage is unregistered (server shutdown)', () => {
    const hub = createDiagnosticsHub({ patchDebounceMs: 5 })

    hub.registerLspCoverage('typescript', ['.ts', '.tsx'])
    hub.ingestFromMonaco({
      uri: 'file:///C:/ws/a.ts',
      diagnostics: [sampleDiag(0, 'monaco error')],
    })
    vi.advanceTimersByTime(20)

    // Suppressed.
    expect(hub.getSnapshot().files).toHaveLength(0)

    // LSP server shuts down. Monaco becomes the only voice again.
    hub.unregisterLspCoverage('typescript')
    vi.advanceTimersByTime(20)

    const snap = hub.getSnapshot()
    expect(snap.files).toHaveLength(1)
    expect(snap.files[0].diagnostics[0].providerKey).toBe('monaco')
  })

  it('treats unhealthy LSP as "no coverage" even when extensions are registered', () => {
    const hub = createDiagnosticsHub({ patchDebounceMs: 5 })

    hub.registerLspCoverage('typescript', ['.ts'])
    hub.setProviderHealth('lsp:typescript', false)

    hub.ingestFromMonaco({
      uri: 'file:///C:/ws/a.ts',
      diagnostics: [sampleDiag(0, 'monaco error')],
    })
    vi.advanceTimersByTime(20)

    const snap = hub.getSnapshot()
    expect(snap.files).toHaveLength(1)
    expect(snap.files[0].diagnostics[0].providerKey).toBe('monaco')
  })

  it('ignores Monaco empty-on-unknown-uri (no entry creation, no patch)', () => {
    const hub = createDiagnosticsHub({ patchDebounceMs: 5 })
    const patches: HubPatch[] = []
    hub.subscribe((p) => patches.push(p))

    hub.ingestFromMonaco({
      uri: 'file:///C:/ws/never-seen.ts',
      diagnostics: [],
    })
    vi.advanceTimersByTime(20)

    // No entry was created, no patch was emitted — otherwise every Monaco
    // model creation (potentially thousands on pre-warm) would trigger a
    // patch fan-out.
    expect(patches).toHaveLength(0)
    expect(hub.getSnapshot().files).toHaveLength(0)
  })

  it('drops the file entry when LSP empty + Monaco absent (memory hygiene)', () => {
    const hub = createDiagnosticsHub({ patchDebounceMs: 5 })

    hub.ingestFromLsp({
      serverName: 'typescript',
      uri: 'file:///C:/ws/a.ts',
      diagnostics: [sampleDiag(0, 'err')],
    })
    vi.advanceTimersByTime(20)
    expect(hub.getSnapshot().files).toHaveLength(1)

    hub.ingestFromLsp({
      serverName: 'typescript',
      uri: 'file:///C:/ws/a.ts',
      diagnostics: [],
    })
    vi.advanceTimersByTime(20)

    // With no Monaco rows to suppress, the entry is dropped entirely so
    // pre-warm over 10k files doesn't leave 10k empty shells in memory.
    expect(hub.getSnapshot().files).toHaveLength(0)
  })

  it('getLspCoverage surfaces currently-registered extensions', () => {
    const hub = createDiagnosticsHub({ patchDebounceMs: 5 })

    hub.registerLspCoverage('typescript', ['.TS', '.tsx', 'js'])
    hub.registerLspCoverage('pyright', ['.py'])

    const coverage = hub.getLspCoverage()
    // Extensions are lower-cased and gain a leading dot.
    expect(coverage['lsp:typescript']).toEqual(['.js', '.ts', '.tsx'])
    expect(coverage['lsp:pyright']).toEqual(['.py'])

    hub.unregisterLspCoverage('typescript')
    expect(hub.getLspCoverage()['lsp:typescript']).toBeUndefined()
    expect(hub.getLspCoverage()['lsp:pyright']).toEqual(['.py'])
  })
})
