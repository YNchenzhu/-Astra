/**
 * Tests for the main-process DiffTransactionStore.
 *
 * Focus: the store's responsibility as the event bus + registry. FSM semantics are
 * already covered in `diffTransactionFsm.test.ts` — here we verify:
 *   • create / dispatch / drop lifecycle
 *   • broadcast event shapes (what renderer subscribers will see)
 *   • defensive cloning (external mutation cannot corrupt the store)
 *   • listener isolation (one throwing listener does not break others)
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { DiffTransactionStore } from './DiffTransactionStore'
import type { DtBroadcast } from './DiffTransactionTypes'

let store: DiffTransactionStore

function newStore(): DiffTransactionStore {
  return new DiffTransactionStore()
}

function baseParams() {
  return {
    filePath: '/w/a.ts',
    baseSnapshot: {
      content: 'a',
      contentHash: 'sha256:a',
      mtimeMs: 10,
      fileExisted: true,
      readId: 'r1',
    },
    proposed: { content: 'b', toolName: 'edit_file', toolUseId: 't1' },
  }
}

describe('DiffTransactionStore — lifecycle', () => {
  beforeEach(() => {
    store = newStore()
  })

  it('create() inserts a DT and emits Created', () => {
    const events: DtBroadcast[] = []
    store.addListener((e) => events.push(e))
    const dt = store.create(baseParams())
    expect(store.size()).toBe(1)
    expect(store.get(dt.id)).toBeDefined()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'Created' })
    if (events[0].type === 'Created') {
      expect(events[0].transaction.id).toBe(dt.id)
      expect(events[0].transaction.state).toBe('Pending')
    }
  })

  it('dispatch() emits Transitioned; Closed follows terminal', () => {
    const events: DtBroadcast[] = []
    store.addListener((e) => events.push(e))
    const dt = store.create(baseParams())
    events.length = 0
    const r1 = store.dispatch({ type: 'PermissionRejected', id: dt.id })
    expect(r1.ok).toBe(true)
    // Expect Transitioned + Closed (in that order) because Rejected is terminal.
    expect(events.map((e) => e.type)).toEqual(['Transitioned', 'Closed'])
  })

  it('dispatch() Rebased emits Rebased (not Transitioned)', () => {
    const events: DtBroadcast[] = []
    const dt = store.create(baseParams())
    store.dispatch({ type: 'MarkStale', id: dt.id })
    events.length = 0
    store.addListener((e) => events.push(e))
    store.dispatch({
      type: 'Rebase',
      id: dt.id,
      newBaseSnapshot: { content: 'a2', contentHash: 'sha256:a2', mtimeMs: 11, fileExisted: true, readId: 'r2' },
      newProposedContent: 'b2',
    })
    // Rebase goes Stale → Pending which is a real transition; the store emits BOTH
    // `Transitioned` (so UI updates state) AND `Rebased` (so UI can flash a banner). We
    // keep the ordering stable so renderers can rely on it.
    expect(events.map((e) => e.type)).toEqual(['Transitioned', 'Rebased'])
  })

  it('returned DTs are defensive clones (external mutation does not leak back)', () => {
    const dt = store.create(baseParams())
    dt.proposed.content = 'HAHA'
    const fetched = store.get(dt.id)
    expect(fetched?.proposed.content).toBe('b')
  })

  it('drop() removes and emits Dropped', () => {
    const dt = store.create(baseParams())
    const events: DtBroadcast[] = []
    store.addListener((e) => events.push(e))
    store.drop(dt.id)
    expect(store.get(dt.id)).toBeUndefined()
    expect(store.size()).toBe(0)
    expect(events).toEqual([{ type: 'Dropped', id: dt.id }])
  })

  it('getActiveForFile excludes terminal DTs', () => {
    const a = store.create(baseParams())
    const b = store.create({ ...baseParams(), filePath: '/w/a.ts' })
    store.dispatch({ type: 'PermissionRejected', id: a.id })
    const active = store.getActiveForFile('/w/a.ts')
    expect(active.map((d) => d.id)).toEqual([b.id])
  })

  it('sendSnapshotTo delivers a single Snapshot payload', () => {
    store.create(baseParams())
    store.create({ ...baseParams(), filePath: '/w/b.ts' })
    const received: DtBroadcast[] = []
    store.sendSnapshotTo((e) => received.push(e))
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({ type: 'Snapshot' })
    if (received[0].type === 'Snapshot') {
      expect(received[0].transactions).toHaveLength(2)
    }
  })

  it('a throwing listener does not block other listeners', () => {
    let bGotCalled = false
    store.addListener(() => {
      throw new Error('listener A blew up')
    })
    store.addListener(() => {
      bGotCalled = true
    })
    store.create(baseParams())
    expect(bGotCalled).toBe(true)
  })

  it('dispatch() against unknown id returns ok:false without throwing', () => {
    const r = store.dispatch({ type: 'PermissionApproved', id: 'dt-nonexistent' as never })
    expect(r.ok).toBe(false)
  })

  it('id collision on create() throws (caller-expected strong uniqueness)', () => {
    const dt = store.create(baseParams())
    expect(() => store.create({ ...baseParams(), id: dt.id })).toThrow(/id collision/)
  })
})
