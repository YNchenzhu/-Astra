import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import {
  canonicaliseSessionMemoryToolInput,
  FILE_MUTATE_PATH_VALIDATION_STEP_IDS,
  FILE_READ_PATH_VALIDATION_STEP_IDS,
  gateFileMutatePath,
  gateFileReadPath,
  gateSessionMemoryInternalAgentToolUse,
  gateWorkspaceBoundary,
  isBlockedBinaryExtensionForRead,
  isBlockedUnixStyleDevicePath,
  isDangerousSensitiveFileBasename,
  isUncOrSmbStylePath,
  pathHasDangerousDirectorySegment,
  rawMutatePathContainsGlobMetachar,
  rawPathContainsSuspiciousExpansion,
} from './fileToolValidation'
import { setWorkspacePath } from './workspaceState'
import { runWithAgentContext } from '../agents/agentContext'
import type { AgentContext } from '../agents/agentContext'

function withSessionMemoryAgent<T>(
  fn: () => T,
  sessionMemoryWritableTargetPath?: string,
): T {
  const ctx = {
    agentId: 'session-memory-test',
    sessionAgentType: 'session-memory-internal',
    messages: [],
    model: '',
    config: {} as AgentContext['config'],
    systemPrompt: '',
    signal: new AbortController().signal,
    ...(sessionMemoryWritableTargetPath ? { sessionMemoryWritableTargetPath } : {}),
  } as unknown as AgentContext
  return runWithAgentContext(ctx, fn)
}

describe('fileToolValidation', () => {
  it('exports stable §5.6 step id lists for acceptance tracing', () => {
    expect([...FILE_READ_PATH_VALIDATION_STEP_IDS]).toEqual([
      'shell_expansion',
      'unc_smb',
      'unix_device',
      'binary_extension',
      'sensitive_basename',
    ])
    expect(FILE_MUTATE_PATH_VALIDATION_STEP_IDS[1]).toBe('glob_metachar')
  })

  it('report §5.6 — read gate fails expansion before UNC when both apply', () => {
    const g = gateFileReadPath('$(x)\\server\\share\\f.txt', 'C:\\y')
    expect(g.ok).toBe(false)
    if (!g.ok) expect(g.error).toMatch(/expansion|substitution|§5\.6/i)
  })

  it('report §5.6 — mutate rejects glob metachars in raw path', () => {
    expect(rawMutatePathContainsGlobMetachar('src/*.ts')).toBe(true)
    expect(rawMutatePathContainsGlobMetachar('src/foo?.ts')).toBe(true)
    const g = gateFileMutatePath('out/*.log', '/p/out/x.log')
    expect(g.ok).toBe(false)
    if (!g.ok) expect(g.error).toMatch(/glob|metachar/i)
  })

  it('report §5.6 — detects shell-like expansion in raw path', () => {
    expect(rawPathContainsSuspiciousExpansion('src/$(whoami).ts')).toBe(true)
    expect(rawPathContainsSuspiciousExpansion('src/${HOME}/x')).toBe(true)
    expect(rawPathContainsSuspiciousExpansion('`id`')).toBe(true)
    expect(rawPathContainsSuspiciousExpansion('%WINDIR%\\x')).toBe(true)
    expect(rawPathContainsSuspiciousExpansion('~+/foo')).toBe(true)
    expect(rawPathContainsSuspiciousExpansion('src/foo.ts')).toBe(false)
  })

  it('gates read when raw path has command substitution', () => {
    const g = gateFileReadPath('$(rm -rf /)/x', '/safe/x')
    expect(g.ok).toBe(false)
    if (!g.ok) expect(g.error).toMatch(/§5\.6|expansion/i)
  })

  it('blocks UNC / SMB-style raw paths', () => {
    expect(isUncOrSmbStylePath('\\\\server\\share\\a.txt', 'C:\\x')).toBe(true)
    expect(isUncOrSmbStylePath('//server/share/a', '/tmp/x')).toBe(true)
    expect(isUncOrSmbStylePath('C:\\foo', 'C:\\foo')).toBe(false)
  })

  it('gates read for UNC', () => {
    const g = gateFileReadPath('\\\\srv\\s\\f.txt', 'C:\\local')
    expect(g.ok).toBe(false)
    if (!g.ok) expect(g.error).toMatch(/UNC/i)
  })

  it('blocks unix device paths', () => {
    expect(isBlockedUnixStyleDevicePath('/dev/zero')).toBe(true)
    expect(isBlockedUnixStyleDevicePath('/dev/random')).toBe(true)
    expect(isBlockedUnixStyleDevicePath('/tmp/file')).toBe(false)
  })

  it('blocks risky binary extensions for read', () => {
    expect(isBlockedBinaryExtensionForRead('/x.exe')).toBe(true)
    expect(isBlockedBinaryExtensionForRead('/a/b.png')).toBe(false)
    expect(isBlockedBinaryExtensionForRead('/d.pdf')).toBe(false)
  })

  it('allows mutate for local path', () => {
    const g = gateFileMutatePath('src/a.ts', '/proj/src/a.ts')
    expect(g.ok).toBe(true)
  })

  describe('report §5.9 dangerous files / directories', () => {
    it('detects dangerous basenames case-insensitively', () => {
      expect(isDangerousSensitiveFileBasename('/home/x/.MCP.JSON')).toBe(true)
      expect(isDangerousSensitiveFileBasename('C:\\u\\.claude.json')).toBe(true)
      expect(isDangerousSensitiveFileBasename('/proj/README.md')).toBe(false)
    })

    it('detects dangerous directory segments', () => {
      expect(pathHasDangerousDirectorySegment('/proj/.git/config')).toBe(true)
      expect(pathHasDangerousDirectorySegment('D:/w/.VSCODE/extensions/x')).toBe(true)
      expect(pathHasDangerousDirectorySegment('/proj/src/not.git/x')).toBe(false)
    })

    it('gates read for dangerous file basenames', () => {
      const g = gateFileReadPath('~/.bashrc', '/home/u/.bashrc')
      expect(g.ok).toBe(false)
      if (!g.ok) expect(g.error).toMatch(/§5\.9|sensitive/i)
    })

    it('gates mutate under protected directory segments', () => {
      const g = gateFileMutatePath('.vscode/settings.json', '/p/.vscode/settings.json')
      expect(g.ok).toBe(false)
      if (!g.ok) expect(g.error).toMatch(/protected directory|\.vscode/i)
    })

    it('allows mutate under ~/.claude/session-memory', () => {
      const memFile = path.join(os.homedir(), '.claude', 'session-memory', 'test-conv.md')
      const g = gateFileMutatePath(memFile, memFile)
      expect(g.ok).toBe(true)
    })

    it('allows read under .vscode (mutate-only directory rule)', () => {
      const g = gateFileReadPath('settings', '/p/.vscode/settings.json')
      expect(g.ok).toBe(true)
    })
  })

  describe('gateSessionMemoryInternalAgentToolUse (audit v3)', () => {
    it('no-op when the current agent is not session-memory-internal', () => {
      const g = gateSessionMemoryInternalAgentToolUse('Write', { filePath: '/etc/hosts' })
      expect(g.ok).toBe(true)
    })

    it('rejects Bash / PowerShell / WebSearch outright', () => {
      withSessionMemoryAgent(() => {
        for (const t of ['Bash', 'PowerShell', 'WebSearch', 'Agent', 'Task']) {
          const g = gateSessionMemoryInternalAgentToolUse(t, { command: 'ls' })
          expect(g.ok).toBe(false)
          if (!g.ok) expect(g.error).toMatch(/not permitted/i)
        }
      })
    })

    it('rejects Write to a workspace path (Bug 1/2/3 escalation)', () => {
      withSessionMemoryAgent(() => {
        const g = gateSessionMemoryInternalAgentToolUse('Write', {
          filePath: path.join(process.cwd(), 'docs', 'evil.md'),
          content: 'x',
        })
        expect(g.ok).toBe(false)
        if (!g.ok) expect(g.error).toMatch(/session-memory/i)
      })
    })

    it('rejects Write to a non-.md file even inside session-memory', () => {
      withSessionMemoryAgent(() => {
        const memFile = path.join(os.homedir(), '.claude', 'session-memory', 'x.ts')
        const g = gateSessionMemoryInternalAgentToolUse('Write', { filePath: memFile })
        expect(g.ok).toBe(false)
        if (!g.ok) expect(g.error).toMatch(/\.md files/i)
      })
    })

    it('allows Write to an .md file under ~/.claude/session-memory', () => {
      withSessionMemoryAgent(() => {
        const memFile = path.join(os.homedir(), '.claude', 'session-memory', 'conv.md')
        const g = gateSessionMemoryInternalAgentToolUse('Write', { filePath: memFile })
        expect(g.ok).toBe(true)
      })
    })

    it('rejects Glob without cwd', () => {
      withSessionMemoryAgent(() => {
        const g = gateSessionMemoryInternalAgentToolUse('Glob', { pattern: '**/*.ts' })
        expect(g.ok).toBe(false)
      })
    })

    it('rejects Glob pointed at the workspace', () => {
      withSessionMemoryAgent(() => {
        const g = gateSessionMemoryInternalAgentToolUse('Glob', {
          pattern: '**/*.md',
          cwd: process.cwd(),
        })
        expect(g.ok).toBe(false)
      })
    })

    it('allows Glob under session-memory', () => {
      withSessionMemoryAgent(() => {
        const root = path.join(os.homedir(), '.claude', 'session-memory')
        const g = gateSessionMemoryInternalAgentToolUse('Glob', {
          pattern: '*.md',
          cwd: root,
        })
        expect(g.ok).toBe(true)
      })
    })

    it('rejects Glob with parent-escape in its pattern', () => {
      withSessionMemoryAgent(() => {
        const root = path.join(os.homedir(), '.claude', 'session-memory')
        const g = gateSessionMemoryInternalAgentToolUse('Glob', {
          pattern: '../../../**/*.md',
          cwd: root,
        })
        expect(g.ok).toBe(false)
        if (!g.ok) expect(g.error).toMatch(/parent-directory|absolute/i)
      })
    })

    it('rejects unknown MCP tools outright (closes mcp__shell__exec / mcp__git__commit fall-through)', () => {
      withSessionMemoryAgent(() => {
        for (const t of [
          'mcp__shell__exec',
          'mcp__git__commit',
          'mcp__sql__execute',
          'mcp__custom__run_script',
        ]) {
          const g = gateSessionMemoryInternalAgentToolUse(t, { args: ['x'] })
          expect(g.ok).toBe(false)
          if (!g.ok) expect(g.error).toMatch(/MCP tool .* is not permitted/i)
        }
      })
    })

    it('still path-gates filesystem-style MCP tools instead of blanket-rejecting them', () => {
      withSessionMemoryAgent(() => {
        const memFile = path.join(os.homedir(), '.claude', 'session-memory', 'notes.md')

        const okRead = gateSessionMemoryInternalAgentToolUse('mcp__fs__read_file', {
          path: memFile,
        })
        expect(okRead.ok).toBe(true)

        const okWrite = gateSessionMemoryInternalAgentToolUse('mcp__fs__write_file', {
          path: memFile,
        })
        expect(okWrite.ok).toBe(true)

        const badWrite = gateSessionMemoryInternalAgentToolUse('mcp__fs__write_file', {
          path: path.join(process.cwd(), 'docs', 'evil.md'),
        })
        expect(badWrite.ok).toBe(false)
      })
    })

    describe('single-target write enforcement (sessionMemoryWritableTargetPath)', () => {
      const memDir = path.join(os.homedir(), '.claude', 'session-memory')
      const target = path.join(memDir, 'conv-target.md')

      it('allows Edit to the designated target path', () => {
        withSessionMemoryAgent(
          () => {
            const g = gateSessionMemoryInternalAgentToolUse('Edit', {
              filePath: target,
              old_string: 'a',
              new_string: 'b',
            })
            expect(g.ok).toBe(true)
          },
          target,
        )
      })

      it('rejects Write to a sibling `*-new.md` even though it is inside the tree', () => {
        withSessionMemoryAgent(
          () => {
            const sibling = path.join(memDir, 'conv-target-new.md')
            const g = gateSessionMemoryInternalAgentToolUse('Write', {
              filePath: sibling,
              content: 'x',
            })
            expect(g.ok).toBe(false)
            if (!g.ok) {
              expect(g.error).toMatch(/designated session-memory file/i)
              expect(g.error).toMatch(/-new\.md/i)
            }
          },
          target,
        )
      })

      it('rejects Write to a `_test.md` probe file in the same directory', () => {
        withSessionMemoryAgent(
          () => {
            const probe = path.join(memDir, '_test.md')
            const g = gateSessionMemoryInternalAgentToolUse('Write', {
              filePath: probe,
              content: 'x',
            })
            expect(g.ok).toBe(false)
            if (!g.ok) expect(g.error).toMatch(/designated session-memory file/i)
          },
          target,
        )
      })

      it('falls back to "any .md under the tree" when no target is set (legacy)', () => {
        withSessionMemoryAgent(() => {
          const g = gateSessionMemoryInternalAgentToolUse('Write', {
            filePath: path.join(memDir, 'conv-other.md'),
            content: 'x',
          })
          expect(g.ok).toBe(true)
        })
      })

      it.runIf(process.platform === 'win32')(
        'treats case-insensitive Windows path differences as the same target',
        () => {
          withSessionMemoryAgent(
            () => {
              const g = gateSessionMemoryInternalAgentToolUse('Edit', {
                filePath: target.toUpperCase(),
                old_string: 'a',
                new_string: 'b',
              })
              expect(g.ok).toBe(true)
            },
            target,
          )
        },
      )
    })

    // Audit v4 / H6 regression: deepseek-v4-pro consistently emitted
    // relative `filePath` values that `path.resolve` then bound to the
    // workspace CWD (meaningless for this agent), making every Read/Edit
    // call land outside the sandbox. `canonicaliseSessionMemoryToolInput`
    // pre-rewrites them to `<targetDir>/<raw>` so the gate AND the
    // downstream tool both see the canonical absolute path.
    describe('canonicaliseSessionMemoryToolInput (audit v4)', () => {
      const memDir = path.join(os.homedir(), '.claude', 'session-memory')
      const target = path.join(memDir, 'conv-target.md')

      it('rewrites a bare basename to <targetDir>/<basename>', () => {
        withSessionMemoryAgent(
          () => {
            const input: Record<string, unknown> = { filePath: 'conv-target.md' }
            canonicaliseSessionMemoryToolInput(input)
            expect(input.filePath).toBe(target)
          },
          target,
        )
      })

      it('rewrites a workspace-rooted relative path predictably', () => {
        withSessionMemoryAgent(
          () => {
            const input: Record<string, unknown> = {
              filePath: '.claude/projects/abc/session-memory/conv-target.md',
            }
            canonicaliseSessionMemoryToolInput(input)
            expect(input.filePath).toBe(
              path.resolve(memDir, '.claude/projects/abc/session-memory/conv-target.md'),
            )
          },
          target,
        )
      })

      it('leaves an absolute path unchanged', () => {
        const absolutePath = path.join(memDir, 'conv-other.md')
        withSessionMemoryAgent(
          () => {
            const input: Record<string, unknown> = { filePath: absolutePath }
            canonicaliseSessionMemoryToolInput(input)
            expect(input.filePath).toBe(absolutePath)
          },
          target,
        )
      })

      it('is a no-op for non-session-memory agents', () => {
        const input: Record<string, unknown> = { filePath: 'foo.md' }
        canonicaliseSessionMemoryToolInput(input)
        expect(input.filePath).toBe('foo.md')
      })

      it('is a no-op when sessionMemoryWritableTargetPath is not set', () => {
        withSessionMemoryAgent(() => {
          const input: Record<string, unknown> = { filePath: 'foo.md' }
          canonicaliseSessionMemoryToolInput(input)
          expect(input.filePath).toBe('foo.md')
        })
      })

      it('after canonicalisation, the gate allows a bare-basename Edit on the target', () => {
        withSessionMemoryAgent(
          () => {
            const input: Record<string, unknown> = {
              filePath: 'conv-target.md',
              old_string: 'a',
              new_string: 'b',
            }
            canonicaliseSessionMemoryToolInput(input)
            const g = gateSessionMemoryInternalAgentToolUse('Edit', input)
            expect(g.ok).toBe(true)
          },
          target,
        )
      })
    })

    it('rejects Grep include with parent-escape but accepts regex-only `..` pattern', () => {
      withSessionMemoryAgent(() => {
        const root = path.join(os.homedir(), '.claude', 'session-memory')
        const bad = gateSessionMemoryInternalAgentToolUse('Grep', {
          pattern: 'foo',
          cwd: root,
          include: '../src/**',
        })
        expect(bad.ok).toBe(false)

        // The Grep `pattern` is a regex; `..` is a valid regex and must not be
        // treated as a path escape.
        const ok = gateSessionMemoryInternalAgentToolUse('Grep', {
          pattern: '..',
          cwd: root,
        })
        expect(ok.ok).toBe(true)
      })
    })
  })

  // Audit fix (2026-06, P0 R4 / P1 R6) — workspace root boundary.
  describe('gateWorkspaceBoundary', () => {
    let workspaceDir: string

    beforeAll(() => {
      workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-boundary-ws-'))
      setWorkspacePath(workspaceDir)
    })

    afterAll(() => {
      setWorkspacePath(null)
      try {
        fs.rmSync(workspaceDir, { recursive: true, force: true })
      } catch {
        /* best effort */
      }
      delete process.env.POLE_ALLOW_OUTSIDE_WORKSPACE_WRITES
      delete process.env.POLE_ALLOW_OUTSIDE_WORKSPACE_SEARCH
    })

    it('allows mutations inside the workspace root', () => {
      const g = gateWorkspaceBoundary(path.join(workspaceDir, 'src', 'new.ts'), 'mutate')
      expect(g.ok).toBe(true)
    })

    it('denies mutations outside the workspace root', () => {
      const outside = path.join(os.homedir(), 'astra-boundary-probe', 'x.txt')
      const g = gateWorkspaceBoundary(outside, 'mutate')
      expect(g.ok).toBe(false)
      if (!g.ok) expect(g.error).toMatch(/outside the workspace root/i)
    })

    it('denies search roots outside the workspace root', () => {
      const outside = path.join(os.homedir(), 'astra-boundary-probe')
      const g = gateWorkspaceBoundary(outside, 'search')
      expect(g.ok).toBe(false)
      if (!g.ok) expect(g.error).toMatch(/search outside the workspace root/i)
    })

    it('carve-out: session-memory tree stays writable', () => {
      const p = path.join(os.homedir(), '.claude', 'session-memory', 'conv.md')
      expect(gateWorkspaceBoundary(p, 'mutate').ok).toBe(true)
    })

    it('carve-out: OS temp directory stays writable', () => {
      const p = path.join(os.tmpdir(), 'astra-scratch', 'tmp.txt')
      expect(gateWorkspaceBoundary(p, 'mutate').ok).toBe(true)
    })

    it('env escape hatch POLE_ALLOW_OUTSIDE_WORKSPACE_WRITES=1 opts out', () => {
      const outside = path.join(os.homedir(), 'astra-boundary-probe', 'x.txt')
      process.env.POLE_ALLOW_OUTSIDE_WORKSPACE_WRITES = '1'
      try {
        expect(gateWorkspaceBoundary(outside, 'mutate').ok).toBe(true)
      } finally {
        delete process.env.POLE_ALLOW_OUTSIDE_WORKSPACE_WRITES
      }
    })

    it('no boundary when no workspace is open', () => {
      setWorkspacePath(null)
      try {
        const outside = path.join(os.homedir(), 'astra-boundary-probe', 'x.txt')
        expect(gateWorkspaceBoundary(outside, 'mutate').ok).toBe(true)
      } finally {
        setWorkspacePath(workspaceDir)
      }
    })

    it('gateFileMutatePath enforces the boundary end-to-end', () => {
      const outside = path.join(os.homedir(), 'astra-boundary-probe', 'x.txt')
      const g = gateFileMutatePath(outside, outside)
      expect(g.ok).toBe(false)
      if (!g.ok) expect(g.error).toMatch(/outside the workspace root/i)

      const inside = path.join(workspaceDir, 'src', 'ok.ts')
      expect(gateFileMutatePath(inside, inside).ok).toBe(true)
    })
  })
})
