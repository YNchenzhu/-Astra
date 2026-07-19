import { describe, it, expect, beforeEach } from 'vitest'
import { consumePassiveLspDiagnosticsForPrompt } from './formatDiagnosticsForPrompt'
import {
  registerPendingLSPDiagnostic,
  resetAllLSPDiagnosticState,
  getPendingLSPDiagnosticCount,
} from './LSPDiagnosticRegistry'

describe('consumePassiveLspDiagnosticsForPrompt', () => {
  beforeEach(() => {
    resetAllLSPDiagnosticState()
  })

  // Legacy upstream §9.3 behaviour — opt-in via `requireShellTool: true`.
  it('does not drain when requireShellTool=true and shell is unavailable', () => {
    registerPendingLSPDiagnostic({
      serverName: 'tsserver',
      files: [
        {
          uri: '/tmp/x.ts',
          diagnostics: [{ message: 'syntax error', severity: 'Error' }],
        },
      ],
    })
    expect(
      consumePassiveLspDiagnosticsForPrompt('full', {
        shellExecutionToolInListing: false,
        requireShellTool: true,
      }),
    ).toBe('')
    expect(getPendingLSPDiagnosticCount()).toBe(1)
  })

  it('drains when shellExecutionToolInListing=true (legacy + default both pass)', () => {
    registerPendingLSPDiagnostic({
      serverName: 'tsserver',
      files: [
        {
          uri: '/tmp/y.ts',
          diagnostics: [{ message: 'bad', severity: 'Error' }],
        },
      ],
    })
    const out = consumePassiveLspDiagnosticsForPrompt('full', {
      shellExecutionToolInListing: true,
      requireShellTool: true,
    })
    expect(out).toContain('Language servers')
    expect(out).toContain('/tmp/y.ts')
    expect(getPendingLSPDiagnosticCount()).toBe(0)
  })

  // method C — default behaviour: drain regardless of shell availability so
  // plan-mode and file-only sub-agents still receive diagnostics.
  it('drains when shell is unavailable and requireShellTool is unset (method C default)', () => {
    registerPendingLSPDiagnostic({
      serverName: 'tsserver',
      files: [
        {
          uri: '/tmp/z.ts',
          diagnostics: [{ message: 'warn', severity: 'Warning' }],
        },
      ],
    })
    const out = consumePassiveLspDiagnosticsForPrompt('full', {
      shellExecutionToolInListing: false,
    })
    expect(out).toContain('/tmp/z.ts')
    expect(getPendingLSPDiagnosticCount()).toBe(0)
  })

  it('drains when options omitted entirely (method C default)', () => {
    registerPendingLSPDiagnostic({
      serverName: 'tsserver',
      files: [
        {
          uri: '/tmp/w.ts',
          diagnostics: [{ message: 'warn', severity: 'Warning' }],
        },
      ],
    })
    const out = consumePassiveLspDiagnosticsForPrompt('full')
    expect(out).toContain('/tmp/w.ts')
    expect(getPendingLSPDiagnosticCount()).toBe(0)
  })

  it('returns empty when mode is off', () => {
    registerPendingLSPDiagnostic({
      serverName: 'tsserver',
      files: [
        {
          uri: '/tmp/v.ts',
          diagnostics: [{ message: 'warn', severity: 'Warning' }],
        },
      ],
    })
    expect(consumePassiveLspDiagnosticsForPrompt('off')).toBe('')
    // Pending registry is NOT drained when mode=off — preserves the volume
    // limit semantics (registry can accumulate; we just don't surface).
    expect(getPendingLSPDiagnosticCount()).toBe(1)
  })
})
