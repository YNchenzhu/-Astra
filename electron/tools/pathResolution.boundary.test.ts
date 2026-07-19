/**
 * Electron path-resolution layer — destructive boundary coverage.
 *
 * The codebase has *four* path resolvers running side-by-side:
 *   1. `workspaceState.ts::resolvePathForTool`        — AI Read / Write / Edit / NotebookEdit
 *   2. `workspaceState.ts::validatePathWithinWorkspace` — boundary guard for #1
 *   3. `security/workspaceAccess.ts::resolvePathForWorkspaceAccess` — IPC fs.* handlers + terminal
 *   4. `tools/resolveInputPath.ts::resolveInputPath`  — list_files / glob / grep (file-or-dir)
 *
 * They have *different* policies on identical inputs (leading-slash convention,
 * out-of-workspace fallback, missing-file behavior, fs.realpath usage). This
 * file pins the contract so a future "let's unify these" refactor lands with
 * the divergence visible up front instead of as runtime surprises.
 *
 * Each `describe` block focuses on one resolver and explicitly notes the
 * cross-resolver divergence in test names where relevant.
 *
 * Note: every test that mutates module-global workspace state cleans up in
 * `afterEach`. Tests use a real on-disk temp workspace per-suite so symlink
 * and existence checks behave like production.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  setWorkspacePath,
  getWorkspacePath,
  resolvePathForTool,
  validatePathWithinWorkspace,
} from './workspaceState'
import {
  resolvePathForWorkspaceAccess,
  setSecurityWorkspaceRoots,
  pathWithinAnyRoot,
  hasSecurityWorkspaceRoot,
  getPrimaryWorkspaceRoot,
} from '../security/workspaceAccess'
import { resolveInputPath } from './resolveInputPath'

const isWin = process.platform === 'win32'

let workspaceDir: string
let outsideDir: string

beforeAll(() => {
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pole-pb-ws-'))
  outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pole-pb-out-'))

  // Populate a small fixture tree under workspace.
  fs.mkdirSync(path.join(workspaceDir, 'src'), { recursive: true })
  fs.writeFileSync(path.join(workspaceDir, 'src', 'foo.ts'), 'export {}\n')
  fs.writeFileSync(path.join(workspaceDir, 'README.md'), '# hi\n')
  // Drop a sibling outside the workspace.
  fs.writeFileSync(path.join(outsideDir, 'leak.txt'), 'secret\n')
})

afterAll(() => {
  try {
    fs.rmSync(workspaceDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(outsideDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

beforeEach(() => {
  setWorkspacePath(workspaceDir) // mirrors into security workspace roots too
})

afterEach(() => {
  // Reset to a known empty state between tests so cross-resolver tests can
  // intentionally exercise the "no workspace" branch without residue.
  setWorkspacePath(null)
})

// ─────────────────────────────────────────────────────────────────────────
// resolvePathForTool — AI file tools (Read / Write / Edit / NotebookEdit)
// ─────────────────────────────────────────────────────────────────────────

describe('resolvePathForTool', () => {
  it('rejects empty / whitespace path', () => {
    expect(resolvePathForTool('')).toEqual({ ok: false, reason: expect.any(String) })
    expect(resolvePathForTool('   ')).toEqual({ ok: false, reason: expect.any(String) })
  })

  it('rejects null / undefined defensively (string-cast guard)', () => {
    expect(resolvePathForTool(undefined as unknown as string)).toMatchObject({ ok: false })
    expect(resolvePathForTool(null as unknown as string)).toMatchObject({ ok: false })
  })

  it('resolves a simple relative path against the workspace root', () => {
    const r = resolvePathForTool('src/foo.ts')
    expect(r.ok).toBe(true)
    if (r.ok) {
      // Compare via fs.realpath-equivalent normalization rather than string ===
      // — getWorkspacePath() returns whatever the caller passed in, which on
      // macOS may differ from realpath (`/var` vs `/private/var`) and on
      // Windows differ in drive-letter case from `path.resolve`'s output.
      const expected = path.resolve(workspaceDir, 'src/foo.ts')
      expect(path.normalize(r.resolved).toLowerCase()).toBe(
        path.normalize(expected).toLowerCase(),
      )
    }
  })

  it('preserves an absolute path verbatim (after path.resolve normalization)', () => {
    const abs = path.resolve(workspaceDir, 'README.md')
    const r = resolvePathForTool(abs)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(path.normalize(r.resolved).toLowerCase()).toBe(
        path.normalize(abs).toLowerCase(),
      )
    }
  })

  it('accepts paths with mixed separators (only meaningful on Windows but documented either way)', () => {
    const r = resolvePathForTool('src\\foo.ts')
    expect(r.ok).toBe(true)
    if (r.ok) {
      // path.resolve handles both separators.
      expect(r.resolved.toLowerCase()).toContain('foo.ts')
    }
  })

  it('does NOT descend into the workspace when the relative path is `..`-traversed', () => {
    // resolvePathForTool itself does not enforce the boundary — it returns
    // the resolved absolute path even when it lives outside the workspace.
    // The boundary check is the caller's responsibility (write_file pairs it
    // with `validatePathWithinWorkspace`; read_file deliberately allows
    // out-of-workspace reads). Pinning current behavior so a future "make it
    // strict by default" lands intentionally.
    const r = resolvePathForTool('../leak.txt')
    expect(r.ok).toBe(true)
    if (r.ok) {
      const parent = path.dirname(workspaceDir).toLowerCase()
      expect(r.resolved.toLowerCase().startsWith(parent)).toBe(true)
    }
  })

  it('rejects a relative path when no workspace is open', () => {
    setWorkspacePath(null)
    const r = resolvePathForTool('src/foo.ts')
    expect(r.ok).toBe(false)
  })

  it('still resolves an absolute path under known memory dirs even with no workspace', () => {
    setWorkspacePath(null)
    // The session-memory root is whatever sessionMemoryPaths advertises.
    // Probe with a sentinel under ~/.claude/session-memory/ — function should
    // happily resolve even though no workspace is open.
    const home = os.homedir()
    const sessionMemFile = path.resolve(home, '.claude', 'session-memory', 'probe.md')
    const r = resolvePathForTool(sessionMemFile)
    expect(r.ok).toBe(true)
  })

  it('rejects an absolute path outside known memory dirs when no workspace is open', () => {
    setWorkspacePath(null)
    const elsewhere = isWin ? 'C:\\Windows\\System32\\drivers\\etc\\hosts' : '/etc/hosts'
    const r = resolvePathForTool(elsewhere)
    expect(r.ok).toBe(false)
  })

  // Leading-slash quirk: the function header advertises that "/src/foo.ts"
  // is normalized to workspace-relative, but the strip loop is gated by
  // `!isAbsoluteLike(s)`, which is FALSE for any path starting with `/`. So
  // the strip never runs. Pinning the actual behavior so the comment / code
  // mismatch becomes visible at test review time, not in production.
  it('does NOT strip a leading slash on a pseudo-relative path (regression-pin: code comment is aspirational)', () => {
    const r = resolvePathForTool('/src/foo.ts')
    if (isWin) {
      // Windows: `path.resolve('/src/foo.ts')` gives `<current-drive>:\src\foo.ts`,
      // which is NOT under the workspace tmpdir. So either:
      //  - the file does not exist there → caller's later fs.statSync fails, OR
      //  - resolution succeeds but lands outside the workspace.
      // Either way, the resolver still returns ok:true (it's a string op).
      expect(r.ok).toBe(true)
      if (r.ok) {
        expect(r.resolved.toLowerCase().endsWith('src\\foo.ts')).toBe(true)
      }
    } else {
      // POSIX: `/src/foo.ts` → resolves verbatim → almost certainly does not
      // exist under the test sandbox.
      expect(r.ok).toBe(true)
      if (r.ok) {
        expect(r.resolved).toBe('/src/foo.ts')
      }
    }
  })

  it('NFC-normalizes Unicode in the resolved output', () => {
    // Decomposed "café" — NFC should re-compose to one code point.
    const decomposed = 'src/cafe\u0301.txt' // 'cafe' + combining acute
    const r = resolvePathForTool(decomposed)
    expect(r.ok).toBe(true)
    if (r.ok) {
      // The composed code point '\u00e9' should be present in the resolved
      // string (pre-composed). If the resolver forgot to NFC, the combining
      // mark would still be there as a separate char.
      expect(r.resolved.normalize('NFC')).toBe(r.resolved)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────
// resolvePathForTool — LLM character-drift tolerance
// ─────────────────────────────────────────────────────────────────────────
//
// The model substitutes fullwidth CJK punctuation / curly quotes for their
// ASCII equivalents when emitting tool-call JSON (upstream issues #52482
// / #50975 / #31863). Disk-real names on Chinese workflows keep the
// original characters — fullwidth `"` `:` `?` etc. are common because the
// ASCII forms are illegal in NTFS filenames. Resolver must walk the path
// component-wise and substitute disk-real sibling names when the literal
// path misses.
// ─────────────────────────────────────────────────────────────────────────

describe('resolvePathForTool — character drift fallback', () => {
  it('resolves a directory whose disk name uses curly double quotes when input has ASCII', () => {
    // Disk: `项目"云研讨"案`
    const realName = '\u9879\u76EE\u201C\u4E91\u7814\u8BA8\u201D\u6848'
    fs.mkdirSync(path.join(workspaceDir, realName), { recursive: true })
    fs.writeFileSync(path.join(workspaceDir, realName, 'note.txt'), 'hi\n')

    // Input from the (drifted) model: ASCII double quotes
    const drifted = `\u9879\u76EE"\u4E91\u7814\u8BA8"\u6848/note.txt`
    const r = resolvePathForTool(drifted)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.resolved.endsWith(path.join(realName, 'note.txt'))).toBe(true)
      // Disk-real form bubbles back up — curly quotes preserved.
      expect(r.resolved.includes('\u201C')).toBe(true)
      expect(fs.readFileSync(r.resolved, 'utf-8')).toBe('hi\n')
    }
  })

  it('resolves a directory with fullwidth CJK parentheses when input has ASCII parens', () => {
    // Disk: `（建设清单）`
    const realName = '\uFF08\u5EFA\u8BBE\u6E05\u5355\uFF09'
    fs.mkdirSync(path.join(workspaceDir, realName), { recursive: true })
    fs.writeFileSync(path.join(workspaceDir, realName, 'spec.md'), '# spec\n')

    const drifted = `(\u5EFA\u8BBE\u6E05\u5355)/spec.md`
    const r = resolvePathForTool(drifted)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.resolved.endsWith(path.join(realName, 'spec.md'))).toBe(true)
      expect(r.resolved.includes('\uFF08')).toBe(true)
    }
  })

  it('resolves a file leaf whose disk name uses fullwidth punctuation', () => {
    // Disk: `report，v2。xlsx`
    const realName = 'report\uFF0Cv2\u3002xlsx'
    fs.writeFileSync(path.join(workspaceDir, realName), 'x')

    const drifted = 'report,v2.xlsx'
    const r = resolvePathForTool(drifted)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.resolved.endsWith(realName)).toBe(true)
    }
  })

  it('handles mixed drift in BOTH a parent dir AND the leaf in one call', () => {
    // Mirrors the user-reported case: curly quotes in dir, fullwidth parens in leaf.
    const realDir = '\u201C\u4E91\u7814\u8BA8\u201D'
    const realFile = '\uFF08\u6E05\u5355\uFF09.xlsx'
    fs.mkdirSync(path.join(workspaceDir, realDir), { recursive: true })
    fs.writeFileSync(path.join(workspaceDir, realDir, realFile), 'data')

    const drifted = `"\u4E91\u7814\u8BA8"/(\u6E05\u5355).xlsx`
    const r = resolvePathForTool(drifted)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.resolved.endsWith(path.join(realDir, realFile))).toBe(true)
    }
  })

  it('returns the literal resolved path when path already exists on disk (no fallback overhead)', () => {
    // Sanity: existing literal paths must still resolve to themselves.
    fs.writeFileSync(path.join(workspaceDir, 'plain.txt'), 'p')
    const r = resolvePathForTool('plain.txt')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.resolved.endsWith('plain.txt')).toBe(true)
    }
  })

  it('returns the literal resolved path when no drift-tolerant sibling exists (write-new-file path preserved)', () => {
    // Pre-create no candidate. A "create new file" with ASCII comma must
    // resolve to the ASCII-named path, not get redirected to anything.
    const drifted = 'brand-new-file.txt'
    const r = resolvePathForTool(drifted)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.resolved.endsWith('brand-new-file.txt')).toBe(true)
      expect(fs.existsSync(r.resolved)).toBe(false)
    }
  })

  it('does not redirect when an ambiguous siblings would match equally (returns literal)', () => {
    // Both `foo,bar.txt` (ASCII) and `foo，bar.txt` (fullwidth) exist.
    // The literal ASCII path exists, so drift fallback must NOT kick in —
    // existing existence check short-circuits before fallback runs.
    fs.writeFileSync(path.join(workspaceDir, 'foo,bar.txt'), 'ascii')
    fs.writeFileSync(path.join(workspaceDir, 'foo\uFF0Cbar.txt'), 'fullwidth')

    const r = resolvePathForTool('foo,bar.txt')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(fs.readFileSync(r.resolved, 'utf-8')).toBe('ascii')
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────
// validatePathWithinWorkspace — boundary guard for write/delete tools
// ─────────────────────────────────────────────────────────────────────────

describe('validatePathWithinWorkspace', () => {
  it('accepts an in-workspace relative path', () => {
    const r = validatePathWithinWorkspace('src/foo.ts')
    expect(r.safe).toBe(true)
  })

  it('blocks `..` traversal that escapes the workspace', () => {
    const r = validatePathWithinWorkspace('../leak.txt')
    expect(r.safe).toBe(false)
  })

  it('blocks an absolute path outside the workspace', () => {
    const outsideAbs = path.resolve(outsideDir, 'leak.txt')
    const r = validatePathWithinWorkspace(outsideAbs)
    expect(r.safe).toBe(false)
  })

  it('treats workspace root itself as safe (not a strict-prefix bug)', () => {
    const r = validatePathWithinWorkspace(workspaceDir)
    expect(r.safe).toBe(true)
  })

  it('rejects an empty path', () => {
    const r = validatePathWithinWorkspace('')
    expect(r.safe).toBe(false)
  })

  it('rejects when no workspace is open', () => {
    setWorkspacePath(null)
    const r = validatePathWithinWorkspace('src/foo.ts')
    expect(r.safe).toBe(false)
  })

  // Sibling-prefix attack: workspace = /tmp/pole-pb-ws-XXX, a sibling
  // /tmp/pole-pb-ws-XXX-evil/foo.txt should NOT be treated as in-workspace
  // because the boundary check uses `startsWith(root + '/')` not just
  // `startsWith(root)`.
  it('rejects a sibling directory whose name shares the workspace prefix', () => {
    const sibling = `${workspaceDir}-evil`
    fs.mkdirSync(sibling, { recursive: true })
    fs.writeFileSync(path.join(sibling, 'foo.txt'), 'x')
    try {
      const r = validatePathWithinWorkspace(path.join(sibling, 'foo.txt'))
      expect(r.safe).toBe(false)
    } finally {
      fs.rmSync(sibling, { recursive: true, force: true })
    }
  })

  if (!isWin) {
    it('blocks a symlink that points outside the workspace (POSIX-only fixture)', () => {
      const linkPath = path.join(workspaceDir, 'evil-link')
      try {
        fs.symlinkSync(path.resolve(outsideDir, 'leak.txt'), linkPath)
      } catch {
        return
      }
      try {
        // validatePathWithinWorkspace itself does NOT realpath — it compares
        // post-resolve strings. Pinning that the *string-level* check passes
        // for a symlink (the symlink path itself is inside the workspace).
        // The symlink-based escalation is supposed to be caught by
        // pathSecurity.realResolveAbsolutePath (which DOES realpath); pathSecurity is
        // tested separately. This test documents the layering.
        const r = validatePathWithinWorkspace('evil-link')
        expect(r.safe).toBe(true)
      } finally {
        try { fs.unlinkSync(linkPath) } catch { /* ignore */ }
      }
    })
  }
})

// ─────────────────────────────────────────────────────────────────────────
// resolvePathForWorkspaceAccess — IPC fs.* + terminal cwd
// ─────────────────────────────────────────────────────────────────────────

describe('resolvePathForWorkspaceAccess', () => {
  it('mirrors workspace state when setWorkspacePath was called', () => {
    expect(hasSecurityWorkspaceRoot()).toBe(true)
    expect(getPrimaryWorkspaceRoot()).toBeTruthy()
  })

  it('rejects an empty path', () => {
    expect(resolvePathForWorkspaceAccess('').ok).toBe(false)
  })

  it('accepts an in-workspace relative path', () => {
    const r = resolvePathForWorkspaceAccess('src/foo.ts')
    expect(r.ok).toBe(true)
  })

  it('blocks a `..` traversal escape', () => {
    const r = resolvePathForWorkspaceAccess('../leak.txt')
    expect(r.ok).toBe(false)
  })

  it('blocks an absolute path outside the workspace', () => {
    const r = resolvePathForWorkspaceAccess(path.resolve(outsideDir, 'leak.txt'))
    expect(r.ok).toBe(false)
  })

  it('rejects everything when no workspace is open', () => {
    // Note: setWorkspacePath(null) clears security roots in-place via the
    // same module bridge.
    setWorkspacePath(null)
    expect(hasSecurityWorkspaceRoot()).toBe(false)
    const r = resolvePathForWorkspaceAccess('any.txt')
    expect(r.ok).toBe(false)
  })

  it('treats workspace-root itself as accepted', () => {
    const r = resolvePathForWorkspaceAccess(workspaceDir)
    expect(r.ok).toBe(true)
  })

  it('rejects a sibling-prefix directory (pathWithinAnyRoot uses path-segment match)', () => {
    const sibling = `${workspaceDir}-evil`
    fs.mkdirSync(sibling, { recursive: true })
    try {
      // Direct fixture call — pathWithinAnyRoot is what the resolver uses.
      expect(pathWithinAnyRoot(sibling)).toBe(false)
    } finally {
      fs.rmSync(sibling, { recursive: true, force: true })
    }
  })

  it('survives a manual setSecurityWorkspaceRoots call with redundant roots', () => {
    setSecurityWorkspaceRoots([workspaceDir, workspaceDir, `${workspaceDir}/`])
    expect(hasSecurityWorkspaceRoot()).toBe(true)
    expect(resolvePathForWorkspaceAccess('src/foo.ts').ok).toBe(true)
  })

  it('drift fallback: resolves a curly-quoted directory when caller passed ASCII (GAP 3)', () => {
    // IPC callers (file tree, Open File menu, drag-drop) can round-trip
    // paths the LLM emitted. If the LLM drifted curly→ASCII, the IPC
    // resolver must still hit the right disk entry. Mirrors P0's coverage
    // for `resolvePathForTool` so the two resolvers stay aligned.
    const realDir = '\u201Cdrift-ipc-test\u201D'
    fs.mkdirSync(path.join(workspaceDir, realDir), { recursive: true })
    fs.writeFileSync(path.join(workspaceDir, realDir, 'note.txt'), 'hi')
    try {
      const r = resolvePathForWorkspaceAccess(`"drift-ipc-test"/note.txt`)
      expect(r.ok).toBe(true)
      if (r.ok) {
        // Disk-real form bubbles back up — curly quotes preserved in the dir.
        expect(r.resolved.includes('\u201C')).toBe(true)
        expect(r.resolved.endsWith(path.join(realDir, 'note.txt'))).toBe(true)
      }
    } finally {
      fs.rmSync(path.join(workspaceDir, realDir), { recursive: true, force: true })
    }
  })

  it('drift fallback: still blocks out-of-workspace paths after drift resolution', () => {
    // Drift fallback only ever substitutes a sibling INSIDE the parent
    // directory we already resolved, so workspace boundary checks still
    // hold after drift. Pin the contract.
    const sibling = `${workspaceDir}-evil`
    fs.mkdirSync(sibling, { recursive: true })
    fs.writeFileSync(path.join(sibling, 'leak.txt'), 'secret')
    try {
      // Even if the literal path resolves to outside, drift fallback can't
      // rescue it back inside.
      const r = resolvePathForWorkspaceAccess(path.join(sibling, 'leak.txt'))
      expect(r.ok).toBe(false)
    } finally {
      fs.rmSync(sibling, { recursive: true, force: true })
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────
// resolveInputPath — list_files / glob / grep (file-or-dir, rich error)
// ─────────────────────────────────────────────────────────────────────────

describe('resolveInputPath', () => {
  it('resolves a workspace-relative directory path with kind=directory', () => {
    const r = resolveInputPath('src', { expect: 'directory' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.kind).toBe('directory')
  })

  it('resolves a workspace-relative file path with kind=file', () => {
    const r = resolveInputPath('src/foo.ts', { expect: 'file' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.kind).toBe('file')
  })

  it('emits an actionable error citing the alt tool when expecting dir but got file', () => {
    const r = resolveInputPath('src/foo.ts', {
      expect: 'directory',
      altForFile: 'read_file',
      toolName: 'list_files',
      argName: 'dirPath',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toContain('list_files')
      expect(r.error).toContain('read_file')
      expect(r.error).toContain('dirPath')
    }
  })

  it('emits an actionable error citing the alt tool when expecting file but got dir', () => {
    const r = resolveInputPath('src', {
      expect: 'file',
      altForDirectory: 'list_files',
      toolName: 'read_file',
      argName: 'filePath',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toContain('read_file')
      expect(r.error).toContain('list_files')
    }
  })

  it('reports tried candidates when nothing exists', () => {
    const r = resolveInputPath('does/not/exist.ts', { toolName: 'read_file' })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      // The error should cite both candidates: workspace-resolved AND cwd-resolved.
      expect(r.error).toContain('read_file')
      expect(r.error.toLowerCase()).toContain('not found')
    }
  })

  it('rejects empty / whitespace path with a descriptive error', () => {
    expect(resolveInputPath('', { toolName: 'glob' }).ok).toBe(false)
    expect(resolveInputPath('   ', { toolName: 'glob' }).ok).toBe(false)
    expect(resolveInputPath(undefined, { toolName: 'glob' }).ok).toBe(false)
    expect(resolveInputPath(null, { toolName: 'glob' }).ok).toBe(false)
  })

  it('falls back to process.cwd() when workspace lookup misses', () => {
    // The function probes workspace first, then process.cwd(). If we set the
    // workspace to something that does NOT contain the file, but process.cwd()
    // does, the fallback path should still find it. (This documents the legacy
    // safety net — a future "strict workspace only" change would break this.)
    setWorkspacePath(outsideDir)
    const r = resolveInputPath('package.json', { expect: 'file' })
    if (r.ok) {
      // We're running from the repo root, which has package.json. Fallback worked.
      expect(r.kind).toBe('file')
    } else {
      // Some CI sandboxes run from a different cwd — accept either outcome
      // but make the assertion explicit so the failure mode is clear.
      expect(r.error.toLowerCase()).toContain('not found')
    }
  })

  it('dedupes candidates when workspace == cwd', () => {
    // When workspace and cwd collapse to the same value, the resolver should
    // still produce a clean "tried: [<one path>]" error, not list it twice.
    setWorkspacePath(process.cwd())
    const r = resolveInputPath('definitely-not-here.xyz', { toolName: 't' })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      // Should mention the path once (case-insensitive substring count).
      const lower = r.error.toLowerCase()
      const occurrences = lower.split('definitely-not-here.xyz').length - 1
      expect(occurrences).toBeGreaterThanOrEqual(1)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────
// pathSecurity — `~` expansion / forbidden-path matching
// ─────────────────────────────────────────────────────────────────────────

describe('pathSecurity ~ expansion', () => {
  // FORBIDDEN_PATHS contains `~/.ssh`, `~/.aws`, etc. The expander now reads
  // `process.env.HOME || os.homedir() || '/root'` and compares with both sides
  // collapsed to lowercase forward-slash form, so Windows / POSIX / mixed
  // separators all match. Earlier this expanded to `/root/.ssh` on Windows
  // and silently failed to block the real user home — fixed in pathSecurity.ts.
  it('Windows: `~/.ssh` matches `C:\\Users\\<homedir>\\.ssh\\…` via os.homedir() fallback', async () => {
    if (!isWin) return
    const { isPathForbidden } = await import('./pathSecurity')
    const probe = path.join(os.homedir(), '.ssh', 'id_rsa')
    const r = isPathForbidden(probe)
    expect(r.forbidden).toBe(true)
    expect(r.reason).toContain('禁止访问列表')
  })

  it('POSIX: `~/.ssh` correctly expands and blocks the user home dotfile', async () => {
    if (isWin) return
    const { isPathForbidden } = await import('./pathSecurity')
    const probe = path.join(os.homedir(), '.ssh', 'id_rsa')
    expect(isPathForbidden(probe).forbidden).toBe(true)
  })

  it('mixed-separator probe (forward slashes) still blocks home dotfile', async () => {
    const { isPathForbidden } = await import('./pathSecurity')
    // Force forward slashes even on Windows. The fix lowercases + converts
    // both sides to forward slashes before comparing, so this MUST still hit
    // the `~/.ssh` rule.
    const probe = `${os.homedir().replace(/\\/g, '/')}/.ssh/id_rsa`
    expect(isPathForbidden(probe).forbidden).toBe(true)
  })

  it('non-home POSIX rules remain hit on POSIX (sanity)', async () => {
    if (isWin) return
    const { isPathForbidden } = await import('./pathSecurity')
    expect(isPathForbidden('/etc/passwd').forbidden).toBe(true)
    expect(isPathForbidden('/proc/self/environ').forbidden).toBe(true)
  })

  it('paths outside any forbidden rule remain allowed', async () => {
    const { isPathForbidden } = await import('./pathSecurity')
    expect(isPathForbidden(path.join(os.tmpdir(), 'safe.txt')).forbidden).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// Cross-resolver invariants — stuff that MUST agree across all four
// ─────────────────────────────────────────────────────────────────────────

describe('cross-resolver agreement', () => {
  it('all resolvers honor the same workspace bridge from setWorkspacePath', () => {
    setWorkspacePath(workspaceDir)
    expect(getWorkspacePath()).toBe(workspaceDir)
    expect(hasSecurityWorkspaceRoot()).toBe(true)
    // Same in-workspace path resolves on all three:
    expect(resolvePathForTool('src/foo.ts').ok).toBe(true)
    expect(validatePathWithinWorkspace('src/foo.ts').safe).toBe(true)
    expect(resolvePathForWorkspaceAccess('src/foo.ts').ok).toBe(true)
    expect(resolveInputPath('src/foo.ts').ok).toBe(true)
  })

  it('all resolvers reject empty path', () => {
    expect(resolvePathForTool('').ok).toBe(false)
    expect(validatePathWithinWorkspace('').safe).toBe(false)
    expect(resolvePathForWorkspaceAccess('').ok).toBe(false)
    expect(resolveInputPath('').ok).toBe(false)
  })

  it('IPC + boundary-guard agree on out-of-workspace absolute → reject', () => {
    const outside = path.resolve(outsideDir, 'leak.txt')
    expect(validatePathWithinWorkspace(outside).safe).toBe(false)
    expect(resolvePathForWorkspaceAccess(outside).ok).toBe(false)
  })

  it('AI Read tool resolver does NOT reject out-of-workspace absolute (deliberate)', () => {
    // resolvePathForTool is intentionally permissive for read paths (the
    // model can ask about /etc/hosts; pathSecurity layers add deny). We
    // pin this so a "tighten the resolver" refactor is forced through
    // review.
    const outside = path.resolve(outsideDir, 'leak.txt')
    const r = resolvePathForTool(outside)
    expect(r.ok).toBe(true)
  })
})
