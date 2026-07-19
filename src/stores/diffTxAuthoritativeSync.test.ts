/**
 * Tests for the DT-mode authoritative sync (P2).
 *
 * Goals:
 *   1. `legacy` mode is a strict no-op — the bridge must not touch pendingChanges/tab.content.
 *   2. `dt` mode applies each DT state to UI exactly as the design doc says:
 *        Applied   → drop pending
 *        Rejected  → drop pending
 *        Failed    → keep pending + record failure annotation
 *        Stale     → record external-mod annotation (P3 placeholder)
 *        Pending/Approved/Writing → no-op (keep diff visible)
 *   3. Failure annotations round-trip via `getDtFailureAnnotation` / `clearDtFailureAnnotation`.
 *
 * We drive the bridge directly via `applyDtToRendererState` to keep tests deterministic
 * (no React hooks / timers). The hook `useDiffTxAuthoritativeSync` is a thin wrapper
 * around `applyDtToRendererState`; its scheduling behaviour is tested implicitly by the
 * unit tests of the function.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  __resetDiffTxAuthoritativeSyncForTests,
  applyDtToRendererState,
  clearDtFailureAnnotation,
  getDtFailureAnnotation,
} from './diffTxAuthoritativeSync'
import { useFileStore, type PendingChange } from './useFileStore'
import type { RendererDiffTransaction } from './useDiffTransactionStore'

function tx(overrides: Partial<RendererDiffTransaction> & Pick<RendererDiffTransaction, 'state' | 'filePath'>): RendererDiffTransaction {
  return {
    id: overrides.id ?? 'dt-test-id',
    filePath: overrides.filePath,
    state: overrides.state,
    baseSnapshot: overrides.baseSnapshot ?? {
      content: 'orig',
      contentHash: 'sha256:a',
      mtimeMs: 1,
      fileExisted: true,
      readId: 'read-1',
    },
    proposed: overrides.proposed ?? {
      content: 'next',
      toolName: 'edit_file',
      toolUseId: 'tool-1',
    },
    permissionRequestId: overrides.permissionRequestId ?? 'req-1',
    appliedContentHash: overrides.appliedContentHash ?? null,
    appliedReadId: overrides.appliedReadId ?? null,
    stateHistory: overrides.stateHistory ?? [],
    error: overrides.error ?? null,
    riskWarnings: overrides.riskWarnings,
    createdAt: overrides.createdAt ?? 1000,
    updatedAt: overrides.updatedAt ?? 2000,
  }
}

function seedPending(filePath: string, extras: Partial<PendingChange> = {}): void {
  const change: PendingChange = {
    id: 'pc-1',
    filePath,
    originalContent: 'orig',
    modifiedContent: 'next',
    toolUseId: 'tool-1',
    toolName: 'edit_file',
    timestamp: 1000,
    requestId: 'req-1',
    ...extras,
  }
  const fs = useFileStore.getState()
  const next = new Map(fs.pendingChanges)
  next.set(filePath, change)
  fs.setPendingChanges(next)
}

function pendingCount(): number {
  return useFileStore.getState().pendingChanges.size
}

function hasPending(filePath: string): boolean {
  return useFileStore.getState().pendingChanges.has(filePath)
}

describe('applyDtToRendererState — legacy mode is inert', () => {
  beforeEach(() => {
    __resetDiffTxAuthoritativeSyncForTests()
    useFileStore.setState({ pendingChanges: new Map() })
  })

  it.each(['Pending', 'Approved', 'Writing', 'Applied', 'Failed', 'Rejected', 'Stale'] as const)(
    'state %s: pending stays untouched, no annotation',
    (state) => {
      seedPending('/w/a.ts')
      applyDtToRendererState(
        tx({ filePath: '/w/a.ts', state, error: state === 'Failed' ? { code: 'X', message: 'err', recoverable: false } : null }),
        { mode: 'legacy' },
      )
      expect(hasPending('/w/a.ts')).toBe(true)
      expect(getDtFailureAnnotation('/w/a.ts')).toBeUndefined()
    },
  )
})

describe('applyDtToRendererState — dt mode', () => {
  beforeEach(() => {
    __resetDiffTxAuthoritativeSyncForTests()
    useFileStore.setState({ pendingChanges: new Map() })
  })

  it('Pending / Approved / Writing keep the diff visible and clear any stale annotation', () => {
    seedPending('/w/a.ts')
    // Pre-seed an annotation as if a previous attempt had failed.
    applyDtToRendererState(
      tx({
        filePath: '/w/a.ts',
        state: 'Failed',
        error: { code: 'E', message: 'earlier', recoverable: true },
      }),
      { mode: 'dt' },
    )
    expect(getDtFailureAnnotation('/w/a.ts')).toBeDefined()

    // Transition to Pending → annotation must clear.
    applyDtToRendererState(tx({ filePath: '/w/a.ts', state: 'Pending' }), { mode: 'dt' })
    expect(getDtFailureAnnotation('/w/a.ts')).toBeUndefined()
    expect(hasPending('/w/a.ts')).toBe(true)
  })

  it('Applied removes pending and clears any annotation', () => {
    seedPending('/w/a.ts')
    applyDtToRendererState(tx({ filePath: '/w/a.ts', state: 'Applied' }), { mode: 'dt' })
    expect(hasPending('/w/a.ts')).toBe(false)
    expect(getDtFailureAnnotation('/w/a.ts')).toBeUndefined()
  })

  it('Rejected removes pending (disk never changed) and clears annotation', () => {
    seedPending('/w/b.ts')
    applyDtToRendererState(tx({ filePath: '/w/b.ts', state: 'Rejected' }), { mode: 'dt' })
    expect(hasPending('/w/b.ts')).toBe(false)
    expect(getDtFailureAnnotation('/w/b.ts')).toBeUndefined()
  })

  it('Failed keeps pending AND records a structured annotation for the UI banner', () => {
    seedPending('/w/c.ts')
    applyDtToRendererState(
      tx({
        filePath: '/w/c.ts',
        state: 'Failed',
        error: {
          code: 'HASH_MISMATCH_PRE_WRITE',
          message: 'file changed on disk since approval',
          recoverable: true,
        },
      }),
      { mode: 'dt' },
    )
    expect(hasPending('/w/c.ts')).toBe(true)
    const ann = getDtFailureAnnotation('/w/c.ts')
    expect(ann).toBeDefined()
    expect(ann?.errorCode).toBe('HASH_MISMATCH_PRE_WRITE')
    expect(ann?.errorMessage).toMatch(/file changed on disk/)
  })

  it('Stale records an external-modification annotation (P3 placeholder)', () => {
    seedPending('/w/d.ts')
    applyDtToRendererState(tx({ filePath: '/w/d.ts', state: 'Stale' }), { mode: 'dt' })
    expect(hasPending('/w/d.ts')).toBe(true)
    const ann = getDtFailureAnnotation('/w/d.ts')
    expect(ann?.errorCode).toBe('EXTERNAL_MODIFICATION')
  })

  it('normalises path case / slashes when looking up annotations', () => {
    seedPending('/W/Mixed\\Case.ts')
    applyDtToRendererState(
      tx({
        filePath: '/W/Mixed\\Case.ts',
        state: 'Failed',
        error: { code: 'E', message: 'e', recoverable: true },
      }),
      { mode: 'dt' },
    )
    // Same file, different case / slash style → same annotation.
    expect(getDtFailureAnnotation('/w/mixed/case.ts')).toBeDefined()
  })

  it('clearDtFailureAnnotation drops the banner', () => {
    seedPending('/w/e.ts')
    applyDtToRendererState(
      tx({
        filePath: '/w/e.ts',
        state: 'Failed',
        error: { code: 'E', message: 'e', recoverable: true },
      }),
      { mode: 'dt' },
    )
    expect(getDtFailureAnnotation('/w/e.ts')).toBeDefined()
    clearDtFailureAnnotation('/w/e.ts')
    expect(getDtFailureAnnotation('/w/e.ts')).toBeUndefined()
  })

  it('Failed with no corresponding pending is a no-op (no ghost pending created)', () => {
    applyDtToRendererState(
      tx({
        filePath: '/w/nobody.ts',
        state: 'Failed',
        error: { code: 'E', message: 'e', recoverable: true },
      }),
      { mode: 'dt' },
    )
    expect(pendingCount()).toBe(0)
    // Annotation is still recorded — the DT itself is the source of truth. If a pending
    // materialises later the banner will appear; otherwise it stays memory-only until
    // clearDtFailureAnnotation is called.
    expect(getDtFailureAnnotation('/w/nobody.ts')).toBeDefined()
  })
})
