/**
 * Tests for UndoQueue (P4c).
 *
 * Covers:
 *   • Applied DT transition auto-enqueues (live-store integration).
 *   • enqueue / peek / list / size bookkeeping.
 *   • undo writes baseSnapshot back to disk atomically.
 *   • undo refuses (EXTERNAL_DRIFT) when file has been modified since Applied.
 *   • undo refuses (UNDO_ENTRY_NOT_FOUND) for unknown ids or after a successful undo.
 *   • undo refuses (EXPIRED) when the retention window has passed.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { UndoQueue } from './undoQueue'
import { __resetDiffTxStoreForTests, getDiffTxStore } from './DiffTransactionStore'
import { hashFileContent } from '../tools/readFileState'
import type { DiffTxId } from './DiffTransactionTypes'

let tmpdir: string

beforeEach(() => {
  __resetDiffTxStoreForTests()
  tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'cui-undo-'))
})

afterEach(() => {
  try {
    fs.rmSync(tmpdir, { recursive: true, force: true })
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

describe('UndoQueue — auto-enqueue on Applied', () => {
  it('captures a DT entry when the store transitions it to Applied', () => {
    const q = new UndoQueue()
    q.start()
    const f = path.join(tmpdir, 'a.ts')
    fs.writeFileSync(f, 'orig', 'utf-8')
    const dt = getDiffTxStore().create({
      filePath: f,
      baseSnapshot: mkBase('orig'),
      proposed: { content: 'next', toolName: 'edit_file', toolUseId: 't1' },
    })
    getDiffTxStore().dispatch({ type: 'PermissionApproved', id: dt.id })
    getDiffTxStore().dispatch({ type: 'WriteStart', id: dt.id })
    getDiffTxStore().dispatch({
      type: 'WriteApplied',
      id: dt.id,
      appliedContentHash: hashFileContent('next'),
      appliedReadId: null,
    })

    const entry = q.peek(dt.id)
    expect(entry).toBeDefined()
    expect(entry?.baseContent).toBe('orig')
    expect(entry?.appliedContentHash).toBe(hashFileContent('next'))
    q.stop()
  })
})

describe('UndoQueue — undo write path', () => {
  it('undo restores the baseSnapshot when disk still matches appliedContentHash', () => {
    const q = new UndoQueue()
    const f = path.join(tmpdir, 'b.ts')
    fs.writeFileSync(f, 'applied content', 'utf-8')
    const dtId = 'dt-manual' as DiffTxId
    q.enqueue(dtId, {
      filePath: f,
      baseContent: 'original',
      appliedContentHash: hashFileContent('applied content'),
    })
    const r = q.undo(dtId)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.restoredBytes).toBe(Buffer.byteLength('original'))
    expect(fs.readFileSync(f, 'utf-8')).toBe('original')
  })

  it('undo refuses (EXTERNAL_DRIFT) if disk content no longer matches appliedContentHash', () => {
    const q = new UndoQueue()
    const f = path.join(tmpdir, 'c.ts')
    fs.writeFileSync(f, 'someone-else-touched-this', 'utf-8')
    const dtId = 'dt-drift' as DiffTxId
    q.enqueue(dtId, {
      filePath: f,
      baseContent: 'original',
      appliedContentHash: hashFileContent('applied content'), // doesn't match disk
    })
    const r = q.undo(dtId)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('EXTERNAL_DRIFT')
    // Disk untouched.
    expect(fs.readFileSync(f, 'utf-8')).toBe('someone-else-touched-this')
  })

  it('undo refuses (UNDO_ENTRY_NOT_FOUND) for unknown ids', () => {
    const q = new UndoQueue()
    const r = q.undo('ghost' as DiffTxId)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('UNDO_ENTRY_NOT_FOUND')
  })

  it('undo is one-shot: a second undo on the same id returns UNDO_ENTRY_NOT_FOUND', () => {
    const q = new UndoQueue()
    const f = path.join(tmpdir, 'd.ts')
    fs.writeFileSync(f, 'applied', 'utf-8')
    const dtId = 'dt-once' as DiffTxId
    q.enqueue(dtId, {
      filePath: f,
      baseContent: 'base',
      appliedContentHash: hashFileContent('applied'),
    })
    const first = q.undo(dtId)
    expect(first.ok).toBe(true)
    const second = q.undo(dtId)
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.code).toBe('UNDO_ENTRY_NOT_FOUND')
  })

  it('undo refuses (EXPIRED) when the retention window has passed', () => {
    const q = new UndoQueue({ retentionMs: 10 })
    const f = path.join(tmpdir, 'e.ts')
    fs.writeFileSync(f, 'applied', 'utf-8')
    const dtId = 'dt-expire' as DiffTxId
    // Force an entry whose expiresAt is already in the past — simpler than racing setTimeout.
    q.enqueue(dtId, {
      filePath: f,
      baseContent: 'base',
      appliedContentHash: hashFileContent('applied'),
    })
    const entry = q.peek(dtId)!
    // Mutate-by-hand the expiry. This is a test-only trick; production code uses the timer.
    ;(entry as unknown as { expiresAt: number }).expiresAt = Date.now() - 1000
    // Re-inject: since peek() returned a clone we need to reach into the queue. Easier: bypass.
    ;(q as unknown as { entries: Map<string, typeof entry> }).entries.set(dtId, entry)
    const r = q.undo(dtId)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('EXPIRED')
  })
})

describe('UndoQueue — bookkeeping', () => {
  it('list() returns entries sorted newest first', () => {
    const q = new UndoQueue()
    q.enqueue('dt-a' as DiffTxId, {
      filePath: '/a',
      baseContent: 'a',
      appliedContentHash: 'h',
    }, 1000)
    q.enqueue('dt-b' as DiffTxId, {
      filePath: '/b',
      baseContent: 'b',
      appliedContentHash: 'h',
    }, 2000)
    const ids = q.list().map((e) => e.dtId)
    expect(ids).toEqual(['dt-b', 'dt-a'])
  })

  it('size() tracks the number of retained entries', () => {
    const q = new UndoQueue()
    expect(q.size()).toBe(0)
    q.enqueue('x' as DiffTxId, { filePath: '/x', baseContent: 'x', appliedContentHash: 'h' })
    expect(q.size()).toBe(1)
    q.enqueue('y' as DiffTxId, { filePath: '/y', baseContent: 'y', appliedContentHash: 'h' })
    expect(q.size()).toBe(2)
  })

  it('stop() drops all entries and cancels timers', () => {
    const q = new UndoQueue()
    q.enqueue('z' as DiffTxId, { filePath: '/z', baseContent: 'z', appliedContentHash: 'h' })
    expect(q.size()).toBe(1)
    q.stop()
    expect(q.size()).toBe(0)
  })
})

describe('UndoQueue — memory caps', () => {
  it('evicts the oldest entry once maxEntries is exceeded (LRU)', () => {
    const q = new UndoQueue({ maxEntries: 2 })
    q.enqueue('a' as DiffTxId, { filePath: '/a', baseContent: 'a', appliedContentHash: 'h' }, 1000)
    q.enqueue('b' as DiffTxId, { filePath: '/b', baseContent: 'b', appliedContentHash: 'h' }, 2000)
    q.enqueue('c' as DiffTxId, { filePath: '/c', baseContent: 'c', appliedContentHash: 'h' }, 3000)
    expect(q.size()).toBe(2)
    // Oldest ('a') evicted; newest two survive.
    expect(q.peek('a' as DiffTxId)).toBeUndefined()
    expect(q.peek('b' as DiffTxId)).toBeDefined()
    expect(q.peek('c' as DiffTxId)).toBeDefined()
  })

  it('evicts oldest entries until under maxTotalBytes', () => {
    const q = new UndoQueue({ maxTotalBytes: 10 })
    q.enqueue('a' as DiffTxId, { filePath: '/a', baseContent: 'x'.repeat(6), appliedContentHash: 'h' }, 1000)
    q.enqueue('b' as DiffTxId, { filePath: '/b', baseContent: 'y'.repeat(6), appliedContentHash: 'h' }, 2000)
    // 12 bytes > 10 cap → oldest ('a') evicted, leaving 6 bytes.
    expect(q.size()).toBe(1)
    expect(q.peek('a' as DiffTxId)).toBeUndefined()
    expect(q.peek('b' as DiffTxId)).toBeDefined()
    expect(q.totalBytesUsed()).toBe(6)
  })

  it('keeps a single oversized entry rather than evicting it to nothing', () => {
    const q = new UndoQueue({ maxTotalBytes: 4 })
    q.enqueue('big' as DiffTxId, { filePath: '/big', baseContent: 'z'.repeat(100), appliedContentHash: 'h' })
    expect(q.size()).toBe(1)
    expect(q.peek('big' as DiffTxId)).toBeDefined()
  })

  it('keeps byte accounting in sync across re-enqueue and undo', () => {
    const q = new UndoQueue()
    q.enqueue('a' as DiffTxId, { filePath: '/a', baseContent: 'aaaa', appliedContentHash: 'h' })
    expect(q.totalBytesUsed()).toBe(4)
    // Re-enqueue same id with different content → no double counting.
    q.enqueue('a' as DiffTxId, { filePath: '/a', baseContent: 'bb', appliedContentHash: 'h' })
    expect(q.totalBytesUsed()).toBe(2)
    expect(q.size()).toBe(1)
  })
})
