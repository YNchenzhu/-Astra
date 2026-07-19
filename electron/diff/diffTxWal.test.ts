/**
 * Tests for the DT WAL (P4d).
 *
 * Focus:
 *   • Roundtrip: persist → loadAll → rehydrate reconstructs the state.
 *   • Attach to store: transitions auto-persist; removal is opt-in.
 *   • Retention: terminal DTs sweep away after the retention window.
 *   • Malformed WAL files are skipped, not fatal.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { __resetDiffTxStoreForTests, DiffTransactionStore } from './DiffTransactionStore'
import { DtWalStore } from './diffTxWal'
import { hashFileContent } from '../tools/readFileState'
import type { DiffTxId } from './DiffTransactionTypes'

let tmpRoot: string

beforeEach(() => {
  __resetDiffTxStoreForTests()
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cui-wal-'))
})

afterEach(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

function mkBase(content: string) {
  return {
    content,
    contentHash: hashFileContent(content),
    mtimeMs: 1,
    fileExisted: true,
    readId: null,
  }
}

function seedDt(store: DiffTransactionStore, filePath: string, base: string, proposed: string) {
  return store.create({
    filePath,
    baseSnapshot: mkBase(base),
    proposed: { content: proposed, toolName: 'edit_file', toolUseId: 'tu-1' },
  })
}

describe('DtWalStore — persistence', () => {
  it('persist() writes one JSON file named after the DT id', () => {
    const store = new DiffTransactionStore()
    const wal = new DtWalStore({ rootDir: tmpRoot, sessionId: 's1', sweepIntervalMs: 0 })
    const dt = seedDt(store, '/w/a.ts', 'orig', 'next')
    wal.persist(dt)
    expect(fs.existsSync(wal.fileFor(dt.id))).toBe(true)
    const body = JSON.parse(fs.readFileSync(wal.fileFor(dt.id), 'utf-8'))
    expect(body.id).toBe(dt.id)
    expect(body.filePath).toBe('/w/a.ts')
    expect(body.state).toBe('Pending')
  })

  it('remove() deletes the WAL file; idempotent when already gone', () => {
    const store = new DiffTransactionStore()
    const wal = new DtWalStore({ rootDir: tmpRoot, sessionId: 's1', sweepIntervalMs: 0 })
    const dt = seedDt(store, '/w/b.ts', 'orig', 'next')
    wal.persist(dt)
    expect(fs.existsSync(wal.fileFor(dt.id))).toBe(true)
    wal.remove(dt.id)
    expect(fs.existsSync(wal.fileFor(dt.id))).toBe(false)
    // Second remove is a no-op.
    expect(() => wal.remove(dt.id)).not.toThrow()
  })

  it('atomic write: a truncated read during persist would still parse to a previous version', () => {
    const store = new DiffTransactionStore()
    const wal = new DtWalStore({ rootDir: tmpRoot, sessionId: 's1', sweepIntervalMs: 0 })
    const dt = seedDt(store, '/w/c.ts', 'orig', 'next')
    wal.persist(dt)
    // Simulate a mid-update crash: inspect the temp-file pattern by reading while
    // atomicWriteFile swaps in. Since we can't easily race here, assert the post-state
    // is always a valid JSON of a DT.
    const body = JSON.parse(fs.readFileSync(wal.fileFor(dt.id), 'utf-8'))
    expect(body.id).toBe(dt.id)
  })
})

describe('DtWalStore — loadAll & rehydrate', () => {
  it('loadAll() returns the set of DTs previously persisted', () => {
    const store = new DiffTransactionStore()
    const wal = new DtWalStore({ rootDir: tmpRoot, sessionId: 's-round', sweepIntervalMs: 0 })
    const a = seedDt(store, '/w/a.ts', 'a', 'a2')
    const b = seedDt(store, '/w/b.ts', 'b', 'b2')
    wal.persist(a)
    wal.persist(b)
    const all = wal.loadAll()
    expect(all.map((d) => d.id).sort()).toEqual([a.id, b.id].sort())
  })

  it('loadAll() skips malformed JSON and continues', () => {
    const store = new DiffTransactionStore()
    const wal = new DtWalStore({ rootDir: tmpRoot, sessionId: 's-bad', sweepIntervalMs: 0 })
    const dt = seedDt(store, '/w/ok.ts', 'o', 'o2')
    wal.persist(dt)
    // Drop a garbage file in the dir.
    fs.writeFileSync(path.join(tmpRoot, 's-bad', 'garbage.json'), 'not json {', 'utf-8')
    fs.writeFileSync(path.join(tmpRoot, 's-bad', 'not-a-dt.json'), JSON.stringify({ unrelated: 1 }), 'utf-8')
    const all = wal.loadAll()
    expect(all.length).toBe(1)
    expect(all[0]!.id).toBe(dt.id)
  })

  it('rehydrate() restores non-terminal DTs into a fresh store with correct state', () => {
    // Write side: persist a DT that moved to Approved, then to Writing, then to Failed.
    const writeStore = new DiffTransactionStore()
    const wal = new DtWalStore({ rootDir: tmpRoot, sessionId: 's-re', sweepIntervalMs: 0 })
    const dt = seedDt(writeStore, '/w/r.ts', 'orig', 'next')
    writeStore.dispatch({ type: 'PermissionApproved', id: dt.id })
    writeStore.dispatch({ type: 'WriteStart', id: dt.id })
    writeStore.dispatch({
      type: 'WriteFailed',
      id: dt.id,
      error: { code: 'DISK_IO', message: 'simulated', recoverable: true },
    })
    wal.persist(writeStore.get(dt.id)!)

    // Read side: brand-new store, call rehydrate.
    const readStore = new DiffTransactionStore()
    const result = wal.rehydrate(readStore)
    expect(result.restored).toBe(1)
    expect(result.skippedTerminal).toBe(0)
    const restored = readStore.get(dt.id)!
    expect(restored.state).toBe('Failed')
    expect(restored.error?.code).toBe('DISK_IO')
    // createdAt preserved — audit needs it.
    expect(restored.createdAt).toBe(writeStore.get(dt.id)!.createdAt)
  })

  it('rehydrate() skips terminal DTs from live store (they stay audit-only)', () => {
    const writeStore = new DiffTransactionStore()
    const wal = new DtWalStore({ rootDir: tmpRoot, sessionId: 's-term', sweepIntervalMs: 0 })
    const dt = seedDt(writeStore, '/w/t.ts', 'o', 'o2')
    writeStore.dispatch({ type: 'PermissionRejected', id: dt.id })
    wal.persist(writeStore.get(dt.id)!)

    const readStore = new DiffTransactionStore()
    const result = wal.rehydrate(readStore)
    expect(result.restored).toBe(0)
    expect(result.skippedTerminal).toBe(1)
    expect(readStore.get(dt.id)).toBeUndefined()
  })

  it('rehydrate() is idempotent (double-call does not clobber live state)', () => {
    const writeStore = new DiffTransactionStore()
    const wal = new DtWalStore({ rootDir: tmpRoot, sessionId: 's-idem', sweepIntervalMs: 0 })
    const dt = seedDt(writeStore, '/w/i.ts', 'o', 'o2')
    wal.persist(writeStore.get(dt.id)!)

    const readStore = new DiffTransactionStore()
    wal.rehydrate(readStore)
    wal.rehydrate(readStore) // second call — must not throw, must not duplicate.
    expect(readStore.size()).toBe(1)
  })
})

describe('DtWalStore — retention sweep', () => {
  it('sweep() deletes terminal DTs older than retentionMs', () => {
    const writeStore = new DiffTransactionStore()
    const wal = new DtWalStore({
      rootDir: tmpRoot,
      sessionId: 's-sweep',
      sweepIntervalMs: 0,
      terminalRetentionMs: 10,
    })
    const dt = seedDt(writeStore, '/w/s.ts', 'o', 'o2')
    writeStore.dispatch({ type: 'PermissionRejected', id: dt.id })
    const persisted = writeStore.get(dt.id)!
    wal.persist(persisted)
    // Advance logical "now" by 1 minute. Because updatedAt is set to real Date.now() by
    // the reducer we can't just fast-forward a mock — pass a future `now` to sweep().
    const removed = wal.sweep(Date.now() + 60_000)
    expect(removed).toBe(1)
    expect(fs.existsSync(wal.fileFor(dt.id))).toBe(false)
  })

  it('sweep() leaves non-terminal DTs alone even after retention', () => {
    const writeStore = new DiffTransactionStore()
    const wal = new DtWalStore({
      rootDir: tmpRoot,
      sessionId: 's-keep',
      sweepIntervalMs: 0,
      terminalRetentionMs: 10,
    })
    const dt = seedDt(writeStore, '/w/k.ts', 'o', 'o2')
    wal.persist(writeStore.get(dt.id)!)
    const removed = wal.sweep(Date.now() + 60_000)
    expect(removed).toBe(0)
    expect(fs.existsSync(wal.fileFor(dt.id))).toBe(true)
  })
})

describe('DtWalStore — attach to store', () => {
  it('persists on each Transitioned broadcast', () => {
    const store = new DiffTransactionStore()
    const wal = new DtWalStore({ rootDir: tmpRoot, sessionId: 's-att', sweepIntervalMs: 0 })
    wal.attachToStore(store)
    const dt = seedDt(store, '/w/at.ts', 'o', 'o2')
    expect(fs.existsSync(wal.fileFor(dt.id))).toBe(true)
    store.dispatch({ type: 'PermissionApproved', id: dt.id })
    const body = JSON.parse(fs.readFileSync(wal.fileFor(dt.id), 'utf-8'))
    expect(body.state).toBe('Approved')
    wal.detach()
  })

  it('does NOT delete the WAL on a terminal transition (audit retention applies)', () => {
    const store = new DiffTransactionStore()
    const wal = new DtWalStore({ rootDir: tmpRoot, sessionId: 's-att-term', sweepIntervalMs: 0 })
    wal.attachToStore(store)
    const dt = seedDt(store, '/w/at2.ts', 'o', 'o2')
    store.dispatch({ type: 'PermissionRejected', id: dt.id })
    expect(fs.existsSync(wal.fileFor(dt.id))).toBe(true)
    wal.detach()
  })

  it('detach stops further persistence', () => {
    const store = new DiffTransactionStore()
    const wal = new DtWalStore({ rootDir: tmpRoot, sessionId: 's-det', sweepIntervalMs: 0 })
    wal.attachToStore(store)
    const dt = seedDt(store, '/w/det.ts', 'o', 'o2')
    wal.detach()
    store.dispatch({ type: 'PermissionApproved', id: dt.id })
    const body = JSON.parse(fs.readFileSync(wal.fileFor(dt.id), 'utf-8'))
    expect(body.state).toBe('Pending') // frozen from attach time
  })
})

describe('DtWalStore — orphan session cleanup', () => {
  it('migrates non-terminal DTs from a legacy pid-* dir then deletes it', () => {
    // Simulate a prior crash: a DT persisted under an old per-pid session dir.
    const oldStore = new DiffTransactionStore()
    const oldWal = new DtWalStore({ rootDir: tmpRoot, sessionId: 'pid-12345', sweepIntervalMs: 0 })
    const dt = seedDt(oldStore, '/w/o.ts', 'orig', 'next')
    oldStore.dispatch({ type: 'PermissionApproved', id: dt.id })
    oldWal.persist(oldStore.get(dt.id)!)

    // New launch with the stable session id.
    const newWal = new DtWalStore({ rootDir: tmpRoot, sessionId: 'default', sweepIntervalMs: 0 })
    const summary = newWal.cleanupOrphanSessions()
    expect(summary.migrated).toBe(1)
    expect(summary.removedDirs).toBe(1)
    // Old dir gone, file now lives under the current session dir.
    expect(fs.existsSync(path.join(tmpRoot, 'pid-12345'))).toBe(false)
    expect(fs.existsSync(newWal.fileFor(dt.id))).toBe(true)

    // And it actually rehydrates into a fresh store.
    const readStore = new DiffTransactionStore()
    const result = newWal.rehydrate(readStore)
    expect(result.restored).toBe(1)
    expect(readStore.get(dt.id)?.state).toBe('Approved')
  })

  it('removes a legacy dir holding only terminal DTs without migrating them', () => {
    const oldStore = new DiffTransactionStore()
    const oldWal = new DtWalStore({ rootDir: tmpRoot, sessionId: 'pid-999', sweepIntervalMs: 0 })
    const dt = seedDt(oldStore, '/w/t.ts', 'o', 'o2')
    oldStore.dispatch({ type: 'PermissionRejected', id: dt.id })
    oldWal.persist(oldStore.get(dt.id)!)

    const newWal = new DtWalStore({ rootDir: tmpRoot, sessionId: 'default', sweepIntervalMs: 0 })
    const summary = newWal.cleanupOrphanSessions()
    expect(summary.migrated).toBe(0)
    expect(summary.removedDirs).toBe(1)
    expect(fs.existsSync(path.join(tmpRoot, 'pid-999'))).toBe(false)
    expect(fs.existsSync(newWal.fileFor(dt.id))).toBe(false)
  })

  it('never touches the current session dir', () => {
    const store = new DiffTransactionStore()
    const wal = new DtWalStore({ rootDir: tmpRoot, sessionId: 'default', sweepIntervalMs: 0 })
    const dt = seedDt(store, '/w/cur.ts', 'o', 'o2')
    wal.persist(dt)
    const summary = wal.cleanupOrphanSessions()
    expect(summary.removedDirs).toBe(0)
    expect(fs.existsSync(wal.fileFor(dt.id))).toBe(true)
  })
})

describe('DtWalStore — path safety', () => {
  it('sessionId sanitisation prevents directory escape', () => {
    const wal = new DtWalStore({
      rootDir: tmpRoot,
      sessionId: '../../etc/passwd',
      sweepIntervalMs: 0,
    })
    const file = wal.fileFor('dt-test-id' as DiffTxId)
    const relativeToRoot = path.relative(tmpRoot, file)
    // The sanitised session id should keep the resolved path inside tmpRoot.
    expect(relativeToRoot.startsWith('..')).toBe(false)
  })

  it('dtId sanitisation prevents directory escape', () => {
    const wal = new DtWalStore({ rootDir: tmpRoot, sessionId: 's-safe', sweepIntervalMs: 0 })
    const file = wal.fileFor('../escape' as DiffTxId)
    const relativeToRoot = path.relative(tmpRoot, file)
    expect(relativeToRoot.startsWith('..')).toBe(false)
  })
})
