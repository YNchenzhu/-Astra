/**
 * Self-audit fix A2 (2026-05) — boundary check tests for
 * `acceptWorkspacePathFromRenderer`.
 *
 * The function is the chokepoint for renderer-supplied workspace
 * paths. Misbehaviour here defeats the G12 fix in
 * `electron/skills/handlers.ts:skill:reload` and lets a compromised
 * webContents rebase the workspace to an attacker path.
 *
 * Coverage:
 *   1. Empty / nullish input passes through with `effective: ''`
 *      (caller decides whether "no workspace" is meaningful).
 *   2. Trusted path → `status: 'trusted'`, no auto-add.
 *   3. Legacy mode + untrusted path → auto-add + `status: 'auto-trusted'`.
 *   4. Strict mode + untrusted path → `ok: false`.
 *   5. Cache HIT on repeated calls with same path (upstream-style memo).
 *   6. Cache invalidation on `addTrustedWorkspaceRoot` (via
 *      `invalidateAcceptCache` from `workspace-trust:add`).
 *   7. Mode change forces re-check (operator flips strict ↔ legacy
 *      mid-session via Settings).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// ──────────────────────────────────────────────────────────────────
// Module mocks — must run before any `import './workspaceAccept'`.
// ──────────────────────────────────────────────────────────────────

let mockUserDataDir = ''
let mockTrustMode: 'legacy' | 'strict' = 'legacy'

vi.mock('electron', () => ({
  app: {
    getPath: (key: string) => {
      if (key === 'userData') return mockUserDataDir
      throw new Error(`unexpected getPath: ${key}`)
    },
  },
}))

vi.mock('../settings/settingsAccess', () => ({
  readDiskSettings: () => ({ workspaceTrustMode: mockTrustMode }),
}))

// ──────────────────────────────────────────────────────────────────

import {
  _resetWorkspaceAcceptCacheForTests,
  _snapshotWorkspaceAcceptCacheForTests,
  acceptWorkspacePathFromRenderer,
  invalidateAcceptCache,
} from './workspaceAccept'
import {
  addTrustedWorkspaceRoot,
  listTrustedWorkspaceRoots,
  removeTrustedWorkspaceRoot,
} from './workspaceTrust'

function makeTempUserData(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pole-a2-'))
  return d
}

describe('acceptWorkspacePathFromRenderer (A2)', () => {
  beforeEach(() => {
    mockUserDataDir = makeTempUserData()
    mockTrustMode = 'legacy'
    _resetWorkspaceAcceptCacheForTests()
  })

  afterEach(() => {
    _resetWorkspaceAcceptCacheForTests()
    try {
      fs.rmSync(mockUserDataDir, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  })

  // ── Input handling ──────────────────────────────────────────────

  it('passes through undefined / null / empty string with effective=""', () => {
    const a = acceptWorkspacePathFromRenderer(undefined)
    expect(a.ok).toBe(true)
    if (a.ok) {
      expect(a.effective).toBe('')
      expect(a.status).toBe('trusted')
    }

    const b = acceptWorkspacePathFromRenderer(null)
    expect(b.ok).toBe(true)

    const c = acceptWorkspacePathFromRenderer('')
    expect(c.ok).toBe(true)

    const d = acceptWorkspacePathFromRenderer('   ')
    expect(d.ok).toBe(true)
  })

  it('treats non-string input (number / object) as empty', () => {
    expect(acceptWorkspacePathFromRenderer(42 as unknown).ok).toBe(true)
    expect(acceptWorkspacePathFromRenderer({ evil: true } as unknown).ok).toBe(true)
  })

  // ── Trusted-path path ──────────────────────────────────────────

  it('returns status="trusted" for an already-trusted root (legacy mode)', () => {
    const ws = path.join(mockUserDataDir, 'my-trusted')
    fs.mkdirSync(ws, { recursive: true })
    addTrustedWorkspaceRoot(ws)
    // Invalidate the cache because `addTrustedWorkspaceRoot` was
    // called directly here (not through the IPC handler which would
    // call `invalidateAcceptCache` for us).
    invalidateAcceptCache('test-setup')

    const outcome = acceptWorkspacePathFromRenderer(ws, { source: 'test' })
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.status).toBe('trusted')
      expect(outcome.effective).toBe(ws)
    }
  })

  // ── Legacy auto-trust ──────────────────────────────────────────

  it('legacy mode + new path → auto-adds to trust list + status="auto-trusted"', () => {
    const ws = path.join(mockUserDataDir, 'fresh-workspace')
    expect(listTrustedWorkspaceRoots()).not.toContain(
      ws.toLowerCase(), // listTrustedWorkspaceRoots returns normalized entries
    )

    // First, seed an empty trust file so isWorkspaceTrusted treats us as
    // "trust-store exists; this path isn't in it" instead of the legacy
    // "no store yet → trust everything" path.
    addTrustedWorkspaceRoot(path.join(mockUserDataDir, 'seed-dummy'))
    invalidateAcceptCache('test-setup')

    const outcome = acceptWorkspacePathFromRenderer(ws, { source: 'test' })
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.status).toBe('auto-trusted')
    }
    // The path is now in the trust list.
    const list = listTrustedWorkspaceRoots()
    const normalized = process.platform === 'win32' ? ws.toLowerCase() : ws
    expect(list.some((e) => e === normalized || e === ws)).toBe(true)
  })

  // ── Strict reject ──────────────────────────────────────────────

  it('strict mode + new path → ok=false with a clear reason', () => {
    mockTrustMode = 'strict'
    // Strict mode + empty trust file → nothing trusted yet.
    // Seed a different path so the trust file exists and the check
    // really walks the list (otherwise the strict branch in
    // isWorkspaceTrusted short-circuits via "file doesn't exist").
    addTrustedWorkspaceRoot(path.join(mockUserDataDir, 'some-other'))
    invalidateAcceptCache('test-setup')

    const evilPath = path.join(mockUserDataDir, 'evil')
    const outcome = acceptWorkspacePathFromRenderer(evilPath, { source: 'test' })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.reason).toContain('not in the trust list')
      expect(outcome.reason).toContain(evilPath)
      expect(outcome.reason).toMatch(/strict mode/i)
    }

    // Rejection MUST NOT poison the cache.
    const snap = _snapshotWorkspaceAcceptCacheForTests()
    expect(snap.find((s) => s.path === evilPath.toLowerCase())).toBeUndefined()
  })

  it('strict mode + already trusted path → ok with status="trusted"', () => {
    mockTrustMode = 'strict'
    const ws = path.join(mockUserDataDir, 'pre-trusted')
    addTrustedWorkspaceRoot(ws)
    invalidateAcceptCache('test-setup')

    const outcome = acceptWorkspacePathFromRenderer(ws, { source: 'test' })
    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.status).toBe('trusted')
  })

  // ── Cache behaviour ────────────────────────────────────────────

  it('returns a cached outcome for repeated calls with the same path', () => {
    const ws = path.join(mockUserDataDir, 'cached-path')
    addTrustedWorkspaceRoot(ws)
    invalidateAcceptCache('test-setup')

    acceptWorkspacePathFromRenderer(ws, { source: 'first' })
    const snap1 = _snapshotWorkspaceAcceptCacheForTests()
    expect(snap1).toHaveLength(1)

    // Subsequent call — should hit the cache (no new entry).
    acceptWorkspacePathFromRenderer(ws, { source: 'second' })
    const snap2 = _snapshotWorkspaceAcceptCacheForTests()
    expect(snap2).toHaveLength(1)
  })

  it('forgets a path after `invalidateAcceptCache` (mirrors workspace-trust:remove)', () => {
    const ws = path.join(mockUserDataDir, 'temporary-trust')
    addTrustedWorkspaceRoot(ws)
    invalidateAcceptCache('test-setup')
    acceptWorkspacePathFromRenderer(ws, { source: 'first' })
    expect(_snapshotWorkspaceAcceptCacheForTests()).toHaveLength(1)

    removeTrustedWorkspaceRoot(ws)
    invalidateAcceptCache('workspace-trust:remove')

    // Cache cleared; the next call must re-check trust.
    expect(_snapshotWorkspaceAcceptCacheForTests()).toHaveLength(0)
  })

  it('rechecks when trust mode flips strict ↔ legacy mid-session', () => {
    const ws = path.join(mockUserDataDir, 'mode-flipper')
    addTrustedWorkspaceRoot(ws)
    invalidateAcceptCache('test-setup')

    // Legacy mode — trusted path → status: 'trusted'
    mockTrustMode = 'legacy'
    const a = acceptWorkspacePathFromRenderer(ws)
    expect(a.ok).toBe(true)
    if (a.ok) expect(a.status).toBe('trusted')

    // Flip to strict. Path is still in the list so still trusted, but
    // the cache entry was tagged with mode=legacy. The new check
    // should not blindly reuse it — it must produce a fresh entry
    // (still status 'trusted', but the mode field is now 'strict').
    mockTrustMode = 'strict'
    const b = acceptWorkspacePathFromRenderer(ws)
    expect(b.ok).toBe(true)
    if (b.ok) expect(b.status).toBe('trusted')

    const snap = _snapshotWorkspaceAcceptCacheForTests()
    const entry = snap.find((s) => s.path === ws.toLowerCase() || s.path === ws)
    expect(entry?.mode).toBe('strict')
  })
})
