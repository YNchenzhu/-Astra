/**
 * Tests for renderer → main intents (P3b).
 *
 * We test the three pure functions (`intentRetry`, `intentAbort`, `intentRebase`)
 * against the global DT store. IPC plumbing is NOT tested here — that's an integration
 * concern covered by the e2e test once the preload bridge is in place.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { __resetDiffTxStoreForTests, getDiffTxStore } from './index'
import { hashFileContent } from '../tools/readFileState'
import { intentAbort, intentRebase, intentRetry } from './diffTxIntents'

let tmpdir: string

beforeEach(() => {
  __resetDiffTxStoreForTests()
  tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'cui-intents-'))
})

afterEach(() => {
  try {
    fs.rmSync(tmpdir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

function seedDt(opts: { filePath: string; base: string; proposed: string }) {
  const store = getDiffTxStore()
  return store.create({
    filePath: opts.filePath,
    baseSnapshot: {
      content: opts.base,
      contentHash: hashFileContent(opts.base),
      mtimeMs: 1,
      fileExisted: true,
      readId: null,
    },
    proposed: { content: opts.proposed, toolName: 'edit_file', toolUseId: 't-1' },
  })
}

describe('intentRetry', () => {
  it('transitions Failed → Writing', () => {
    const dt = seedDt({ filePath: '/x/a.ts', base: 'a', proposed: 'b' })
    const store = getDiffTxStore()
    store.dispatch({ type: 'PermissionApproved', id: dt.id })
    store.dispatch({ type: 'WriteStart', id: dt.id })
    store.dispatch({
      type: 'WriteFailed',
      id: dt.id,
      error: { code: 'DISK_IO', message: 'no disk', recoverable: true },
    })
    expect(store.get(dt.id)?.state).toBe('Failed')

    const r = intentRetry(dt.id)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.state).toBe('Writing')
  })

  it('refuses when DT is not in Failed', () => {
    const dt = seedDt({ filePath: '/x/b.ts', base: 'a', proposed: 'b' })
    const r = intentRetry(dt.id)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/'Pending'/)
  })

  it('refuses for unknown id', () => {
    const r = intentRetry('dt-does-not-exist' as never)
    expect(r.ok).toBe(false)
  })
})

describe('intentAbort', () => {
  it('transitions non-terminal DT to Rejected', () => {
    const dt = seedDt({ filePath: '/x/c.ts', base: 'a', proposed: 'b' })
    const r = intentAbort(dt.id)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.state).toBe('Rejected')
  })

  it('is idempotent on already-terminal DTs (reports current state)', () => {
    const dt = seedDt({ filePath: '/x/d.ts', base: 'a', proposed: 'b' })
    const store = getDiffTxStore()
    store.dispatch({ type: 'PermissionRejected', id: dt.id })
    expect(store.get(dt.id)?.state).toBe('Rejected')

    const r = intentAbort(dt.id)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.state).toBe('Rejected')
  })

  it('refuses for unknown id', () => {
    expect(intentAbort('ghost' as never).ok).toBe(false)
  })
})

describe('intentRebase', () => {
  it('Stale → Pending with a fresh baseSnapshot derived from current disk', () => {
    const f = path.join(tmpdir, 'rebase.ts')
    fs.writeFileSync(f, 'old-base', 'utf-8')
    const dt = seedDt({ filePath: f, base: 'old-base', proposed: 'new' })
    const store = getDiffTxStore()
    // External modification moves us to Stale.
    fs.writeFileSync(f, 'someone-else-wrote-this', 'utf-8')
    store.dispatch({ type: 'MarkStale', id: dt.id })
    expect(store.get(dt.id)?.state).toBe('Stale')

    const r = intentRebase(dt.id)
    expect(r.ok).toBe(true)
    const after = store.get(dt.id)!
    expect(after.state).toBe('Pending')
    expect(after.baseSnapshot.content).toBe('someone-else-wrote-this')
    expect(after.baseSnapshot.contentHash).toBe(hashFileContent('someone-else-wrote-this'))
    // Proposed content is carried forward (P4 may re-compute).
    expect(after.proposed.content).toBe('new')
  })

  it('refuses rebase when file was deleted (cannot re-anchor)', () => {
    const f = path.join(tmpdir, 'gone.ts')
    fs.writeFileSync(f, 'old-base', 'utf-8')
    const dt = seedDt({ filePath: f, base: 'old-base', proposed: 'new' })
    const store = getDiffTxStore()
    fs.unlinkSync(f)
    store.dispatch({ type: 'MarkStale', id: dt.id, reason: 'unlink' })

    const r = intentRebase(dt.id)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/failed to read|Abort this DT/i)
  })

  it('refuses when DT is not in Stale', () => {
    const dt = seedDt({ filePath: '/x/e.ts', base: 'a', proposed: 'b' })
    const r = intentRebase(dt.id)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/'Pending'/)
  })
})
