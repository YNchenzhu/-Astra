/**
 * Tests for the DiffTransaction FSM reducer.
 *
 * These tests treat the reducer as a pure function. Every legal transition is covered, plus
 * a representative sample of illegal ones. The goal: if someone touches the state table in
 * `LEGAL_TRANSITIONS`, at least one of these tests breaks first.
 */

import { describe, it, expect } from 'vitest'
import {
  canTransition,
  createDiffTransaction,
  isDtClosed,
  LEGAL_TRANSITIONS,
  reduce,
} from './diffTransactionFsm'
import type { DtState, DiffTransaction, DiffTxId } from './DiffTransactionTypes'

function freshDt(partial?: Partial<DiffTransaction>): DiffTransaction {
  return createDiffTransaction({
    id: ('dt-test-' + Math.random().toString(16).slice(2)) as DiffTxId,
    filePath: '/tmp/x.ts',
    baseSnapshot: {
      content: 'orig',
      contentHash: 'sha256:abc',
      mtimeMs: 1,
      fileExisted: true,
      readId: 'read-1',
    },
    proposed: {
      content: 'next',
      toolName: 'edit_file',
      toolUseId: 'tool-1',
    },
    at: 1000,
    ...partial,
  })
}

describe('createDiffTransaction', () => {
  it('starts in Pending with a synthetic self-transition in history', () => {
    const dt = freshDt()
    expect(dt.state).toBe('Pending')
    expect(dt.stateHistory).toHaveLength(1)
    expect(dt.stateHistory[0]).toEqual({ from: 'Pending', to: 'Pending', at: 1000, reason: 'created' })
    expect(dt.permissionRequestId).toBeNull()
    expect(dt.appliedContentHash).toBeNull()
    expect(dt.error).toBeNull()
  })

  it('omits riskWarnings when empty', () => {
    const dt = freshDt()
    expect(dt.riskWarnings).toBeUndefined()
  })
})

describe('canTransition / LEGAL_TRANSITIONS sanity', () => {
  it('Applied and Rejected are terminal', () => {
    expect(LEGAL_TRANSITIONS.Applied).toEqual([])
    expect(LEGAL_TRANSITIONS.Rejected).toEqual([])
  })

  it('every state listed in LEGAL_TRANSITIONS exists', () => {
    const allStates: DtState[] = [
      'Pending',
      'Approved',
      'Writing',
      'Applied',
      'Rejected',
      'Failed',
      'Stale',
    ]
    for (const s of allStates) {
      expect(LEGAL_TRANSITIONS[s]).toBeDefined()
    }
  })

  it('canTransition agrees with the table', () => {
    expect(canTransition('Pending', 'Approved')).toBe(true)
    expect(canTransition('Pending', 'Writing')).toBe(false)
    expect(canTransition('Writing', 'Applied')).toBe(true)
    expect(canTransition('Applied', 'Pending')).toBe(false)
  })
})

describe('reduce — happy paths', () => {
  it('Pending → Approved', () => {
    const dt = freshDt()
    const r = reduce(dt, { type: 'PermissionApproved', id: dt.id, at: 2000, reason: 'user ok' })
    if (!r.ok) throw new Error('expected ok')
    expect(r.next.state).toBe('Approved')
    expect(r.transition).toEqual({ from: 'Pending', to: 'Approved' })
    expect(r.next.stateHistory.at(-1)).toMatchObject({ from: 'Pending', to: 'Approved', reason: 'user ok' })
  })

  it('Approved → Writing → Applied carries hash + readId', () => {
    let dt = freshDt()
    let r = reduce(dt, { type: 'PermissionApproved', id: dt.id, at: 1001 })
    if (!r.ok) throw new Error()
    dt = r.next
    r = reduce(dt, { type: 'WriteStart', id: dt.id, at: 1002 })
    if (!r.ok) throw new Error()
    dt = r.next
    r = reduce(dt, {
      type: 'WriteApplied',
      id: dt.id,
      at: 1003,
      appliedContentHash: 'sha256:def',
      appliedReadId: 'read-2',
    })
    if (!r.ok) throw new Error()
    expect(r.next.state).toBe('Applied')
    expect(r.next.appliedContentHash).toBe('sha256:def')
    expect(r.next.appliedReadId).toBe('read-2')
    expect(isDtClosed(r.next)).toBe(true)
  })

  it('Pending → Rejected short-circuits', () => {
    const dt = freshDt()
    const r = reduce(dt, { type: 'PermissionRejected', id: dt.id })
    if (!r.ok) throw new Error()
    expect(r.next.state).toBe('Rejected')
    expect(isDtClosed(r.next)).toBe(true)
  })

  it('Writing → Failed records the structured error', () => {
    let dt = freshDt()
    dt = (reduce(dt, { type: 'PermissionApproved', id: dt.id }) as { next: DiffTransaction }).next
    dt = (reduce(dt, { type: 'WriteStart', id: dt.id }) as { next: DiffTransaction }).next
    const r = reduce(dt, {
      type: 'WriteFailed',
      id: dt.id,
      error: { code: 'HASH_MISMATCH_PRE_WRITE', message: 'content changed', recoverable: true },
    })
    if (!r.ok) throw new Error()
    expect(r.next.state).toBe('Failed')
    expect(r.next.error).toEqual({ code: 'HASH_MISMATCH_PRE_WRITE', message: 'content changed', recoverable: true })
    expect(r.next.stateHistory.at(-1)).toMatchObject({ errorCode: 'HASH_MISMATCH_PRE_WRITE' })
  })

  it('Failed → Writing via Retry clears the error', () => {
    let dt = freshDt()
    dt = (reduce(dt, { type: 'PermissionApproved', id: dt.id }) as { next: DiffTransaction }).next
    dt = (reduce(dt, { type: 'WriteStart', id: dt.id }) as { next: DiffTransaction }).next
    dt = (reduce(dt, {
      type: 'WriteFailed',
      id: dt.id,
      error: { code: 'DISK_IO', message: 'oops', recoverable: true },
    }) as { next: DiffTransaction }).next
    const r = reduce(dt, { type: 'Retry', id: dt.id })
    if (!r.ok) throw new Error()
    expect(r.next.state).toBe('Writing')
    expect(r.next.error).toBeNull()
  })

  it('Rebase from Stale replaces baseSnapshot and proposed content; returns to Pending', () => {
    let dt = freshDt()
    dt = (reduce(dt, { type: 'MarkStale', id: dt.id, reason: 'external mod' }) as { next: DiffTransaction }).next
    expect(dt.state).toBe('Stale')
    const r = reduce(dt, {
      type: 'Rebase',
      id: dt.id,
      newBaseSnapshot: {
        content: 'orig-v2',
        contentHash: 'sha256:xyz',
        mtimeMs: 2,
        fileExisted: true,
        readId: 'read-3',
      },
      newProposedContent: 'next-v2',
    })
    if (!r.ok) throw new Error()
    expect(r.next.state).toBe('Pending')
    expect(r.next.baseSnapshot.content).toBe('orig-v2')
    expect(r.next.baseSnapshot.contentHash).toBe('sha256:xyz')
    expect(r.next.proposed.content).toBe('next-v2')
    // Tool metadata preserved.
    expect(r.next.proposed.toolName).toBe('edit_file')
    expect(r.next.proposed.toolUseId).toBe('tool-1')
  })

  it('LinkPermissionRequest attaches metadata without transitioning', () => {
    const dt = freshDt()
    const r = reduce(dt, { type: 'LinkPermissionRequest', id: dt.id, permissionRequestId: 'req-42' })
    if (!r.ok) throw new Error()
    expect(r.transition).toBeUndefined()
    expect(r.next.state).toBe('Pending')
    expect(r.next.permissionRequestId).toBe('req-42')
  })
})

describe('reduce — illegal transitions', () => {
  it('rejects Create via reduce (creation is store-side only)', () => {
    const dt = freshDt()
    const r = reduce(dt, {
      type: 'Create',
      id: dt.id,
      filePath: '/tmp/y.ts',
      baseSnapshot: dt.baseSnapshot,
      proposed: dt.proposed,
    })
    expect(r.ok).toBe(false)
  })

  it('refuses PermissionApproved from Applied', () => {
    let dt = freshDt()
    dt = (reduce(dt, { type: 'PermissionApproved', id: dt.id }) as { next: DiffTransaction }).next
    dt = (reduce(dt, { type: 'WriteStart', id: dt.id }) as { next: DiffTransaction }).next
    dt = (reduce(dt, {
      type: 'WriteApplied',
      id: dt.id,
      appliedContentHash: 'sha256:def',
      appliedReadId: null,
    }) as { next: DiffTransaction }).next
    const r = reduce(dt, { type: 'PermissionApproved', id: dt.id })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error()
    expect(r.reason).toMatch(/Illegal transition/)
  })

  it('refuses WriteStart from Pending (must go through Approved)', () => {
    const dt = freshDt()
    const r = reduce(dt, { type: 'WriteStart', id: dt.id })
    expect(r.ok).toBe(false)
  })

  it('refuses Retry from any state except Failed', () => {
    const dt = freshDt()
    const r = reduce(dt, { type: 'Retry', id: dt.id })
    expect(r.ok).toBe(false)
  })

  it('refuses Rebase from Applied (terminal)', () => {
    let dt = freshDt()
    dt = (reduce(dt, { type: 'PermissionApproved', id: dt.id }) as { next: DiffTransaction }).next
    dt = (reduce(dt, { type: 'WriteStart', id: dt.id }) as { next: DiffTransaction }).next
    dt = (reduce(dt, {
      type: 'WriteApplied',
      id: dt.id,
      appliedContentHash: 'h',
      appliedReadId: null,
    }) as { next: DiffTransaction }).next
    const r = reduce(dt, {
      type: 'Rebase',
      id: dt.id,
      newBaseSnapshot: dt.baseSnapshot,
      newProposedContent: 'whatever',
    })
    expect(r.ok).toBe(false)
  })
})
