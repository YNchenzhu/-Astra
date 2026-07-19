/**
 * Destructive boundary tests for `electron/memory/pathSafety.ts`.
 *
 * Memory paths are higher-trust than tool paths — a bad rule here can
 * silently write notes into `/etc` or `\\server\share`. We pin the strict
 * rejection rules here so loosening them is always intentional.
 */

import { describe, it, expect } from 'vitest'
import path from 'node:path'
import os from 'node:os'

import {
  validateMemoryPath,
  isAutoMemPath,
  isKnownMemoryPath,
  isUserSuppliedMirrorPathSafe,
} from './pathSafety'

const isWin = process.platform === 'win32'

// ──────────────────────────────────────────────────────────────────────────
// validateMemoryPath
// ──────────────────────────────────────────────────────────────────────────
describe('validateMemoryPath', () => {
  it('accepts a normal absolute path under the user home', () => {
    const r = validateMemoryPath(path.join(os.homedir(), '.cz-ui-clone', 'memory'))
    expect(r.valid).toBe(true)
  })

  it('rejects empty / undefined / non-string', () => {
    expect(validateMemoryPath('').valid).toBe(false)
    expect(validateMemoryPath(undefined as unknown as string).valid).toBe(false)
    expect(validateMemoryPath(null as unknown as string).valid).toBe(false)
    expect(validateMemoryPath(123 as unknown as string).valid).toBe(false)
  })

  it('rejects null-byte injection', () => {
    const r = validateMemoryPath(path.join(os.homedir(), 'mem\0/etc/passwd'))
    expect(r.valid).toBe(false)
    expect(r.reason).toMatch(/null byte/i)
  })

  it('rejects paths containing a literal `..` segment even if it would resolve safely', () => {
    // The check is a string `.includes('..')` BEFORE any normalization, so a
    // literal `..` in the input is always rejected. (Note: passing such a
    // path through path.join collapses it before the call, so use a literal
    // string here.)
    const probe = isWin
      ? `${os.homedir()}\\safe\\..\\safe`
      : `${os.homedir()}/safe/../safe`
    const r = validateMemoryPath(probe)
    expect(r.valid).toBe(false)
    expect(r.reason).toMatch(/\.\.|traversal/i)
  })

  it('rejects relative paths', () => {
    expect(validateMemoryPath('memory/user').valid).toBe(false)
    expect(validateMemoryPath('./memory').valid).toBe(false)
    if (!isWin) {
      // On POSIX a Windows-style "C:\foo" is not absolute; on Windows it is.
      const r = validateMemoryPath('C:\\foo\\bar')
      expect(r.valid).toBe(false)
    }
  })

  it('rejects filesystem root (POSIX `/`)', () => {
    if (isWin) return
    const r = validateMemoryPath('/')
    expect(r.valid).toBe(false)
    expect(r.reason).toMatch(/root/i)
  })

  it('rejects Windows drive root (`C:\\`)', () => {
    if (!isWin) return
    expect(validateMemoryPath('C:\\').valid).toBe(false)
    expect(validateMemoryPath('D:\\').valid).toBe(false)
    expect(validateMemoryPath('C:').valid).toBe(false)
  })

  it('rejects UNC paths (`\\\\server\\share`)', () => {
    const r = validateMemoryPath('\\\\fileserver\\public\\memory')
    expect(r.valid).toBe(false)
    expect(r.reason).toMatch(/UNC/i)
  })

  it('rejects too-short normalized paths', () => {
    // path.normalize('/a') = '/a' (length 2). Anything <3 chars is rejected.
    if (!isWin) {
      expect(validateMemoryPath('/a').valid).toBe(false)
    }
  })

  it('accepts a deeply nested but well-formed memory directory', () => {
    const deep = path.join(os.homedir(), '.cz-ui-clone', 'memory', 'user', 'notes', 'sub')
    expect(validateMemoryPath(deep).valid).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// isAutoMemPath
// ──────────────────────────────────────────────────────────────────────────
describe('isAutoMemPath', () => {
  const dir = path.join(os.tmpdir(), 'mem-test')

  it('matches a file inside the dir', () => {
    expect(isAutoMemPath(path.join(dir, 'a.md'), dir)).toBe(true)
  })

  it('matches a nested file', () => {
    expect(isAutoMemPath(path.join(dir, 'sub', 'a.md'), dir)).toBe(true)
  })

  it('matches the dir itself', () => {
    expect(isAutoMemPath(dir, dir)).toBe(true)
  })

  it('rejects a sibling-prefix dir (no false positive on path-string prefix)', () => {
    expect(isAutoMemPath(path.join(os.tmpdir(), 'mem-test-2', 'a.md'), dir)).toBe(false)
  })

  it('rejects when either argument is empty', () => {
    expect(isAutoMemPath('', dir)).toBe(false)
    expect(isAutoMemPath(path.join(dir, 'a.md'), '')).toBe(false)
  })

  it('rejects a `..` traversal that escapes the dir even though the raw string starts with it', () => {
    // Raw string equality fooled by the path.normalize() inside isAutoMemPath:
    // `dir/../outside` normalizes to `path.dirname(dir)/outside` which is not
    // inside `dir`. Pin the safe behavior.
    const escape = path.join(dir, '..', 'outside', 'a.md')
    expect(isAutoMemPath(escape, dir)).toBe(false)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// isKnownMemoryPath — multi-scope fan-in
// ──────────────────────────────────────────────────────────────────────────
describe('isKnownMemoryPath', () => {
  const userDir = path.join(os.tmpdir(), 'mem', 'user')
  const wsDir = path.join(os.tmpdir(), 'mem', 'workspace')
  const teamDir = path.join(os.tmpdir(), 'mem', 'team')
  const sessDir = path.join(os.tmpdir(), 'mem', 'session')

  it('matches a file under any one of the configured scopes', () => {
    expect(
      isKnownMemoryPath(path.join(userDir, 'a.md'), {
        userMemoryDir: userDir,
        workspaceMemoryDir: wsDir,
        teamMemoryDir: teamDir,
        sessionMemoryDir: sessDir,
      }),
    ).toBe(true)
    expect(
      isKnownMemoryPath(path.join(teamDir, 'b.md'), {
        userMemoryDir: userDir,
        workspaceMemoryDir: wsDir,
        teamMemoryDir: teamDir,
      }),
    ).toBe(true)
  })

  it('returns false when ALL configured scopes are undefined', () => {
    expect(isKnownMemoryPath(path.join(userDir, 'a.md'), {})).toBe(false)
  })

  it('skips undefined scopes without throwing', () => {
    expect(
      isKnownMemoryPath(path.join(userDir, 'a.md'), {
        userMemoryDir: userDir,
        // teamMemoryDir / sessionMemoryDir intentionally omitted
      }),
    ).toBe(true)
  })

  it('does not match a sibling that shares a prefix with a memory scope', () => {
    expect(
      isKnownMemoryPath(path.join(os.tmpdir(), 'mem', 'user-other', 'a.md'), {
        userMemoryDir: userDir,
      }),
    ).toBe(false)
  })

  it('matches the directory itself, not just files inside', () => {
    expect(isKnownMemoryPath(userDir, { userMemoryDir: userDir })).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// isUserSuppliedMirrorPathSafe (#4 — credential-tree blacklist)
// ──────────────────────────────────────────────────────────────────────────
describe('isUserSuppliedMirrorPathSafe', () => {
  const sep = path.sep

  it('accepts an ordinary home-relative memory directory', () => {
    const ok = path.join(os.homedir(), 'memory-mirror', 'project')
    expect(isUserSuppliedMirrorPathSafe(ok).valid).toBe(true)
  })

  it('rejects ~/.ssh', () => {
    const bad = `${os.homedir()}${sep}.ssh${sep}memories`
    const r = isUserSuppliedMirrorPathSafe(bad)
    expect(r.valid).toBe(false)
    expect(r.reason).toMatch(/\.ssh/i)
  })

  it('rejects ~/.aws (case-insensitive, deeper segment)', () => {
    const bad = `${os.homedir()}${sep}backups${sep}.AWS${sep}leak`
    expect(isUserSuppliedMirrorPathSafe(bad).valid).toBe(false)
  })

  it('rejects .gnupg / .docker / .kube / .gcloud / .azure / .netrc', () => {
    for (const seg of ['.gnupg', '.docker', '.kube', '.gcloud', '.azure', '.netrc']) {
      const p = `${os.homedir()}${sep}${seg}${sep}leak`
      expect(isUserSuppliedMirrorPathSafe(p).valid).toBe(false)
    }
  })

  it('does NOT reject a path that merely shares a prefix with a sensitive segment', () => {
    // ".sshbackup" is not the ".ssh" segment — only exact segment matches.
    const ok = `${os.homedir()}${sep}.sshbackup${sep}memories`
    expect(isUserSuppliedMirrorPathSafe(ok).valid).toBe(true)
  })

  it('A5: normalises before the segment scan so `..` smuggling is caught', () => {
    // `~/foo/../.ssh/x` normalises to `~/.ssh/x` and MUST be rejected even
    // though the raw input has `foo` + `..` segments preceding `.ssh`.
    const sneaky = `${os.homedir()}${sep}foo${sep}..${sep}.ssh${sep}x`
    expect(isUserSuppliedMirrorPathSafe(sneaky).valid).toBe(false)
  })

  it('A5: handles double-separators after normalise', () => {
    const sneaky = `${os.homedir()}${sep}${sep}${sep}.aws${sep}leak`
    expect(isUserSuppliedMirrorPathSafe(sneaky).valid).toBe(false)
  })
})
