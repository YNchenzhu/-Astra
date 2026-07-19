import { describe, it, expect, beforeEach } from 'vitest'
import path from 'node:path'
import {
  awaitNextPublishDiagnostics,
  __emitPublishForPathForTests,
  __resetPublishDiagnosticsWaitersForTests,
} from './passiveFeedback'

describe('awaitNextPublishDiagnostics', () => {
  beforeEach(() => {
    __resetPublishDiagnosticsWaitersForTests()
  })

  it('resolves true when an emit lands within the window', async () => {
    const fp = path.resolve('/tmp/test-await-resolve.ts')
    const promise = awaitNextPublishDiagnostics(fp, 500)
    setTimeout(() => __emitPublishForPathForTests(fp), 10)
    await expect(promise).resolves.toBe(true)
  })

  it('resolves false on timeout', async () => {
    const fp = path.resolve('/tmp/test-await-timeout.ts')
    const promise = awaitNextPublishDiagnostics(fp, 50)
    await expect(promise).resolves.toBe(false)
  })

  it('resolves false when timeoutMs is 0 or negative', async () => {
    const fp = path.resolve('/tmp/test-await-zero.ts')
    await expect(awaitNextPublishDiagnostics(fp, 0)).resolves.toBe(false)
    await expect(awaitNextPublishDiagnostics(fp, -100)).resolves.toBe(false)
  })

  it('matches case-insensitively on Windows path keys', async () => {
    const upper = path.resolve('/tmp/Foo.TS')
    const lower = path.resolve('/tmp/foo.ts')
    if (process.platform !== 'win32') {
      // POSIX: path.resolve preserves case → these are different files;
      // the test only validates the canonicalization path runs without
      // throwing. Matching is exact in this case.
      const p = awaitNextPublishDiagnostics(upper, 50)
      __emitPublishForPathForTests(upper)
      await expect(p).resolves.toBe(true)
      return
    }
    const p = awaitNextPublishDiagnostics(upper, 500)
    setTimeout(() => __emitPublishForPathForTests(lower), 5)
    await expect(p).resolves.toBe(true)
  })

  it('multiple waiters on the same path all resolve from one emit', async () => {
    const fp = path.resolve('/tmp/test-await-multi.ts')
    const a = awaitNextPublishDiagnostics(fp, 500)
    const b = awaitNextPublishDiagnostics(fp, 500)
    setTimeout(() => __emitPublishForPathForTests(fp), 5)
    const [ra, rb] = await Promise.all([a, b])
    expect(ra).toBe(true)
    expect(rb).toBe(true)
  })

  it('a stale emit (no waiter) does not throw or leak state', () => {
    expect(() =>
      __emitPublishForPathForTests(path.resolve('/tmp/never-awaited.ts')),
    ).not.toThrow()
  })

  // -------------------------------------------------------------------------
  // Version-aware waiter — added 2026-05 to fix the "verification loop" bug
  // where a publishDiagnostics for the PRIOR document version (e.g. V4) would
  // prematurely satisfy a wait that's actually expecting V5.
  // -------------------------------------------------------------------------

  it('version waiter ignores a stale publish (V4) and resolves on the fresh one (V5)', async () => {
    const fp = path.resolve('/tmp/test-await-version-stale-then-fresh.ts')
    const promise = awaitNextPublishDiagnostics(fp, 500, 5)
    // V4 lands first — this is the "stale in-flight publish for the prior
    // analysis" scenario. The waiter must NOT resolve here.
    setTimeout(() => __emitPublishForPathForTests(fp, 4), 5)
    // V5 lands shortly after — this is the publish that corresponds to our
    // just-sent didChange. The waiter MUST resolve here.
    setTimeout(() => __emitPublishForPathForTests(fp, 5), 30)
    await expect(promise).resolves.toBe(true)
  })

  it('version waiter resolves on a publish whose version exceeds minVersion', async () => {
    const fp = path.resolve('/tmp/test-await-version-newer.ts')
    const promise = awaitNextPublishDiagnostics(fp, 500, 5)
    setTimeout(() => __emitPublishForPathForTests(fp, 7), 5)
    await expect(promise).resolves.toBe(true)
  })

  it('version waiter times out when only stale publishes arrive', async () => {
    const fp = path.resolve('/tmp/test-await-version-only-stale.ts')
    const promise = awaitNextPublishDiagnostics(fp, 80, 10)
    setTimeout(() => __emitPublishForPathForTests(fp, 3), 5)
    setTimeout(() => __emitPublishForPathForTests(fp, 9), 20)
    await expect(promise).resolves.toBe(false)
  })

  it('falls back to accept when an LSP omits the version field', async () => {
    // Some niche language servers send publishDiagnostics without a version
    // field. Rather than block forever, the waiter treats undefined as a
    // match — we accept losing strict freshness on those servers in exchange
    // for the major-LSP-correct path actually working.
    const fp = path.resolve('/tmp/test-await-version-unversioned.ts')
    const promise = awaitNextPublishDiagnostics(fp, 500, 5)
    setTimeout(() => __emitPublishForPathForTests(fp, undefined), 5)
    await expect(promise).resolves.toBe(true)
  })

  it('mixed waiters: a versioned waiter waits while an unversioned one is satisfied by V4', async () => {
    const fp = path.resolve('/tmp/test-await-version-mixed.ts')
    const unversioned = awaitNextPublishDiagnostics(fp, 500)
    const versioned = awaitNextPublishDiagnostics(fp, 200, 5)
    // V4 arrives — unversioned (legacy) waiter should resolve, versioned
    // should stay pending and eventually time out.
    setTimeout(() => __emitPublishForPathForTests(fp, 4), 5)
    await expect(unversioned).resolves.toBe(true)
    await expect(versioned).resolves.toBe(false)
  })
})
