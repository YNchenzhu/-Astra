import { describe, it, expect, beforeEach, vi } from 'vitest'
import path from 'node:path'

// Hoist mocks so the modules under test see them at import time.
vi.mock('../tools/workspaceState', () => ({
  getWorkspacePath: () => '/ws',
  resolvePathForTool: (p: string) => ({
    ok: true,
    resolved: path.isAbsolute(p) ? p : path.join('/ws', p),
  }),
}))

vi.mock('../tools/DiagnosticsStore', () => {
  const rows: Array<unknown> = []
  return {
    diagnosticsStore: {
      getForFile: (_: string) => rows,
      __push: (entry: unknown) => rows.push(entry),
      __reset: () => {
        rows.length = 0
      },
    },
  }
})

import { buildLspDiagnosticsTrailer } from './lspDiagnosticsTrailer'
import { diagnosticsStore } from '../tools/DiagnosticsStore'

const store = diagnosticsStore as unknown as {
  __push: (e: unknown) => void
  __reset: () => void
}

describe('buildLspDiagnosticsTrailer', () => {
  beforeEach(() => {
    store.__reset()
  })

  it('returns empty string in await mode when no LSP applies and store is empty', () => {
    const out = buildLspDiagnosticsTrailer('/ws/foo.unknown', {
      lspApplicable: false,
      diagnosticsArrived: false,
      timeoutMs: 1500,
      mode: 'await',
    })
    expect(out).toBe('')
  })

  it('returns empty string in snapshot mode when store is empty', () => {
    const out = buildLspDiagnosticsTrailer('/ws/foo.ts', {
      lspApplicable: true,
      diagnosticsArrived: false,
      timeoutMs: 0,
      mode: 'snapshot',
    })
    expect(out).toBe('')
  })

  it('await mode: clean signal when LSP applied and store is empty after publish', () => {
    const out = buildLspDiagnosticsTrailer('/ws/foo.ts', {
      lspApplicable: true,
      diagnosticsArrived: true,
      timeoutMs: 1500,
      mode: 'await',
    })
    expect(out).toContain('clean (no diagnostics)')
    expect(out).toContain('foo.ts')
  })

  it('await mode: reports no fresh snapshot on timeout without asking the agent to call a tool', () => {
    const out = buildLspDiagnosticsTrailer('/ws/foo.ts', {
      lspApplicable: true,
      diagnosticsArrived: false,
      timeoutMs: 3000,
      mode: 'await',
    })
    expect(out).toContain('no fresh diagnostics arrived after 3000ms')
    expect(out).not.toContain('ReadDiagnostics')
  })

  it('formats severity, location, source, code, and message', () => {
    store.__push({
      file: '/ws/foo.ts',
      fileName: 'foo.ts',
      line: 42,
      column: 5,
      endLine: 42,
      endColumn: 6,
      severity: 'error',
      message: 'Variable "x"\nis possibly\tunbound',
      source: 'lsp:pyright',
      code: 'reportPossiblyUnbound',
    })

    const out = buildLspDiagnosticsTrailer('/ws/foo.ts', {
      lspApplicable: true,
      diagnosticsArrived: true,
      timeoutMs: 1500,
      mode: 'await',
    })
    expect(out).toContain('1 error')
    expect(out).toContain('(Error) L42:5')
    expect(out).toContain('[lsp:pyright]')
    expect(out).toContain('(reportPossiblyUnbound)')
    // Whitespace in message must be collapsed.
    expect(out).toContain('Variable "x" is possibly unbound')
  })

  it('sorts by severity rank then line then column', () => {
    store.__push({ file: '/ws/foo.ts', fileName: 'foo.ts', line: 5, column: 1, endLine: 5, endColumn: 2, severity: 'warning', message: 'w', source: 'lsp:pyright' })
    store.__push({ file: '/ws/foo.ts', fileName: 'foo.ts', line: 99, column: 1, endLine: 99, endColumn: 2, severity: 'error', message: 'late err', source: 'lsp:pyright' })
    store.__push({ file: '/ws/foo.ts', fileName: 'foo.ts', line: 1, column: 1, endLine: 1, endColumn: 2, severity: 'error', message: 'early err', source: 'lsp:pyright' })

    const out = buildLspDiagnosticsTrailer('/ws/foo.ts', {
      lspApplicable: true,
      diagnosticsArrived: true,
      timeoutMs: 1500,
      mode: 'await',
    })

    const earlyIdx = out.indexOf('early err')
    const lateIdx = out.indexOf('late err')
    const warnIdx = out.indexOf('(Warning)')
    expect(earlyIdx).toBeGreaterThan(-1)
    expect(lateIdx).toBeGreaterThan(earlyIdx) // line 1 before line 99
    expect(warnIdx).toBeGreaterThan(lateIdx) // errors before warnings
  })

  it('truncates beyond MAX_TRAILER_DIAGNOSTICS', () => {
    for (let i = 0; i < 15; i++) {
      store.__push({
        file: '/ws/foo.ts', fileName: 'foo.ts',
        line: i + 1, column: 1, endLine: i + 1, endColumn: 2,
        severity: 'error', message: `err${i}`, source: 'lsp:pyright',
      })
    }
    const out = buildLspDiagnosticsTrailer('/ws/foo.ts', {
      lspApplicable: true,
      diagnosticsArrived: true,
      timeoutMs: 1500,
      mode: 'await',
    })
    expect(out).toContain('15 errors')
    expect(out).toContain('... 5 more')
    expect(out).toContain('err0')
    expect(out).toContain('err9')
    expect(out).not.toContain('err10')
  })

  it('marks staleness in await mode when diagnostics arrived was false but store has rows', () => {
    store.__push({
      file: '/ws/foo.ts', fileName: 'foo.ts',
      line: 1, column: 1, endLine: 1, endColumn: 2,
      severity: 'error', message: 'old', source: 'lsp:pyright',
    })
    const out = buildLspDiagnosticsTrailer('/ws/foo.ts', {
      lspApplicable: true,
      diagnosticsArrived: false,
      timeoutMs: 1500,
      mode: 'await',
    })
    expect(out).toContain('[stale: LSP did not respond within timeout')
  })

  it('does NOT mark staleness in snapshot mode (no await happened)', () => {
    store.__push({
      file: '/ws/foo.ts', fileName: 'foo.ts',
      line: 1, column: 1, endLine: 1, endColumn: 2,
      severity: 'error', message: 'snapshot err', source: 'lsp:pyright',
    })
    const out = buildLspDiagnosticsTrailer('/ws/foo.ts', {
      lspApplicable: false,
      diagnosticsArrived: false,
      timeoutMs: 0,
      mode: 'snapshot',
    })
    expect(out).not.toContain('[stale')
    expect(out).toContain('1 error')
    expect(out).toContain('snapshot err')
  })
})
