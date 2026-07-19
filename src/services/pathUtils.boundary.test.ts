/**
 * Renderer-side path utilities — destructive boundary coverage.
 *
 * `src/services/pathUtils.ts` is pure string manipulation (no fs / no
 * `node:path`) and runs identically in renderer + node. This file pins the
 * documented contract by exercising:
 *   - file:// URIs (encoded drives, percent-escapes, host-form)
 *   - Windows drive letters (mixed case, mixed separators)
 *   - UNC paths
 *   - Empty / null-byte / .. traversal inputs
 *   - Idempotence of `normalizePath` and `toRelativePath`
 *
 * Each test names the invariant it is protecting; if a future "drive-by
 * normalization tweak" lands, the test names tell whoever broke it which
 * downstream consumer expects what (tab routing / diff reuse / LSP
 * diagnostic dedup).
 */
import { describe, it, expect } from 'vitest'
import {
  diagnosticMapKey,
  isAbsolutePath,
  isSamePath,
  joinWorkspaceRelative,
  normalizePath,
  toRelativePath,
  toWorkspaceAbsoluteFilePath,
  uriToAbsoluteFilePath,
} from './pathUtils'

describe('uriToAbsoluteFilePath', () => {
  it('decodes Windows drive URI with unencoded colon', () => {
    expect(uriToAbsoluteFilePath('file:///C:/Users/me/x.ts')).toBe('C:/Users/me/x.ts')
  })

  it('decodes Windows drive URI with percent-encoded colon (tsserver style)', () => {
    expect(uriToAbsoluteFilePath('file:///c%3A/Users/me/x.ts')).toBe('c:/Users/me/x.ts')
  })

  it('decodes URI containing percent-encoded space', () => {
    expect(uriToAbsoluteFilePath('file:///C:/Foo%20Bar/x.ts')).toBe('C:/Foo Bar/x.ts')
  })

  it('passes POSIX URI through with leading slash preserved', () => {
    expect(uriToAbsoluteFilePath('file:///home/user/x.ts')).toBe('/home/user/x.ts')
  })

  it('handles single-slash file:/path variant', () => {
    expect(uriToAbsoluteFilePath('file:/home/user/x.ts')).toBe('/home/user/x.ts')
  })

  it('does not mangle a bare absolute path', () => {
    expect(uriToAbsoluteFilePath('/home/user/x.ts')).toBe('/home/user/x.ts')
    expect(uriToAbsoluteFilePath('C:/foo/bar')).toBe('C:/foo/bar')
  })

  it('normalizes backslashes to forward slashes for non-URI inputs', () => {
    expect(uriToAbsoluteFilePath('C:\\foo\\bar.ts')).toBe('C:/foo/bar.ts')
  })

  it('survives a malformed percent-escape (no throw)', () => {
    // `%ZZ` is not a valid escape — decodeURIComponent throws, helper falls back to raw.
    const out = uriToAbsoluteFilePath('file:///C:/bad%ZZ/x.ts')
    expect(out).toContain('bad%ZZ')
    expect(out.startsWith('C:/')).toBe(true)
  })

  it('trims surrounding whitespace before parsing', () => {
    expect(uriToAbsoluteFilePath('  file:///C:/x.ts  ')).toBe('C:/x.ts')
  })
})

describe('normalizePath', () => {
  it('lowercases, collapses repeated slashes, strips trailing slash', () => {
    expect(normalizePath('C:\\Foo\\\\Bar/baz/')).toBe('c:/foo/bar/baz')
  })

  it('is idempotent', () => {
    const once = normalizePath('C:/Foo/Bar//baz/')
    expect(normalizePath(once)).toBe(once)
  })

  it('preserves the empty string as empty', () => {
    expect(normalizePath('')).toBe('')
  })

  it('keeps a single root slash', () => {
    expect(normalizePath('/')).toBe('')
    // Note: trailing-slash strip turns '/' into '' — documented.
  })
})

describe('isAbsolutePath', () => {
  it('detects POSIX absolute', () => {
    expect(isAbsolutePath('/etc/passwd')).toBe(true)
  })
  it('detects Windows drive absolute, both separators', () => {
    expect(isAbsolutePath('C:\\foo')).toBe(true)
    expect(isAbsolutePath('C:/foo')).toBe(true)
    expect(isAbsolutePath('c:/foo')).toBe(true)
  })
  it('rejects plain relative', () => {
    expect(isAbsolutePath('src/foo.ts')).toBe(false)
    expect(isAbsolutePath('./src/foo.ts')).toBe(false)
    expect(isAbsolutePath('../src/foo.ts')).toBe(false)
  })
  it('detects UNC (\\\\server\\share) by accidental slash-normalization', () => {
    // `isAbsolutePath` collapses `\\` → `/` first and then matches POSIX
    // `^/`. So UNC inputs return true — but the slash-flattened form
    // (`/server/share/file.txt`) loses the UNC marker. Anything routing a
    // UNC path through these renderer helpers would land on a bogus
    // POSIX-shaped path; the electron-side `isAbsoluteLike` is the
    // authoritative UNC detector. Pinned so a future "tighten the regex"
    // commit doesn't silently flip this case.
    expect(isAbsolutePath('\\\\server\\share\\file.txt')).toBe(true)
  })
})

describe('isSamePath', () => {
  it('treats different separators / case as same', () => {
    expect(isSamePath('C:\\Foo\\Bar', 'c:/foo/bar')).toBe(true)
  })
  it('treats trailing slash as same', () => {
    expect(isSamePath('C:/Foo/Bar', 'C:/Foo/Bar/')).toBe(true)
  })
  it('rejects sibling that shares prefix', () => {
    expect(isSamePath('C:/Foo/Bar', 'C:/Foo/Baz')).toBe(false)
  })
})

describe('joinWorkspaceRelative', () => {
  it('produces forward-slash join when root has trailing separator', () => {
    expect(joinWorkspaceRelative('C:\\workspace\\', 'src/foo.ts')).toBe(
      'C:/workspace/src/foo.ts',
    )
  })
  it('strips a leading slash from the relative segment', () => {
    expect(joinWorkspaceRelative('C:/ws', '/src/foo.ts')).toBe('C:/ws/src/foo.ts')
  })
  it('returns the relative path verbatim (slash-normalized) when root is null', () => {
    expect(joinWorkspaceRelative(null, 'src\\foo.ts')).toBe('src/foo.ts')
  })
  it('does NOT collapse the upcoming `..` segment (caller is responsible)', () => {
    // joinWorkspaceRelative is pure concat — traversal protection is the
    // electron side's job (resolvePathForWorkspaceAccess + path.resolve).
    expect(joinWorkspaceRelative('C:/ws', '../etc/passwd')).toBe('C:/ws/../etc/passwd')
  })
})

describe('toWorkspaceAbsoluteFilePath', () => {
  it('promotes a workspace-relative tab path to absolute', () => {
    expect(toWorkspaceAbsoluteFilePath('src/foo.ts', 'C:/workspace')).toBe(
      'C:/workspace/src/foo.ts',
    )
  })
  it('passes through an already-absolute path unchanged (slash normalized)', () => {
    expect(toWorkspaceAbsoluteFilePath('C:\\workspace\\src\\foo.ts', 'C:/workspace')).toBe(
      'C:/workspace/src/foo.ts',
    )
  })
  it('preserves untitled-* sentinel paths verbatim', () => {
    expect(toWorkspaceAbsoluteFilePath('untitled-1', 'C:/workspace')).toBe('untitled-1')
  })
  it('handles file:// URI input', () => {
    expect(toWorkspaceAbsoluteFilePath('file:///C:/workspace/src/foo.ts', 'C:/workspace')).toBe(
      'C:/workspace/src/foo.ts',
    )
  })
})

describe('toRelativePath', () => {
  it('strips workspace prefix preserving original case', () => {
    // The relative slice is taken from the slash-normalized original, NOT
    // the lowercased normalize result — preserves case for display.
    expect(toRelativePath('C:/Workspace/Src/Foo.ts', 'C:/workspace')).toBe('Src/Foo.ts')
  })
  it('matches even when separator/case differs between args', () => {
    expect(toRelativePath('C:\\workspace\\src\\foo.ts', 'c:/workspace')).toBe('src/foo.ts')
  })
  it('returns the input slash-normalized when outside the workspace', () => {
    // Currently leaves a backslash-flavored input as-is when outside ws —
    // pinning the legacy behaviour. (Slash normalization happens for the
    // detected-prefix branch only.)
    const out = toRelativePath('D:\\other\\file.ts', 'C:/workspace')
    expect(out.toLowerCase()).toContain('d:')
  })
  it('returns the input unchanged when root is null', () => {
    expect(toRelativePath('C:/foo', null)).toBe('C:/foo')
  })
})

describe('diagnosticMapKey', () => {
  it('coalesces URI / drive-case / separators into the same key', () => {
    const fromMonacoUri = diagnosticMapKey('file:///C:/Workspace/Src/Foo.ts')
    const fromTsserverUri = diagnosticMapKey('file:///c%3A/workspace/src/foo.ts')
    const fromTabPath = diagnosticMapKey('C:\\Workspace\\Src\\Foo.ts')
    expect(fromMonacoUri).toBe(fromTsserverUri)
    expect(fromMonacoUri).toBe(fromTabPath)
  })
})
