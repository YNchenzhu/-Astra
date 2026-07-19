import { describe, it, expect, vi, beforeEach } from 'vitest'

const getWorkspacePath = vi.fn((): string | null => null)

vi.mock('../tools/workspaceState', () => ({
  getWorkspacePath: () => getWorkspacePath(),
}))

vi.mock('electron', () => ({
  app: { isPackaged: false },
}))

import { applyFilesystemMcpWorkspaceRoot, isFilesystemMcpPackageName } from './filesystemWorkspaceArgs'

describe('isFilesystemMcpPackageName', () => {
  it('detects official package', () => {
    expect(isFilesystemMcpPackageName('@modelcontextprotocol/server-filesystem')).toBe(true)
  })
  it('rejects other packages', () => {
    expect(isFilesystemMcpPackageName('@modelcontextprotocol/server-memory')).toBe(false)
  })
})

describe('applyFilesystemMcpWorkspaceRoot', () => {
  beforeEach(() => {
    getWorkspacePath.mockReturnValue('G:\\workspace-code\\projects\\cursor-ui-clone')
  })

  it('replaces forwarded path with resolved workspace', () => {
    const cfg = {
      name: 'filesystem',
      transport: 'stdio' as const,
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', 'G:\\workspace-code\\projects\\DIY-IDE'],
    }
    const out = applyFilesystemMcpWorkspaceRoot(cfg)
    expect(out.args[out.args.length - 1]).toMatch(/cursor-ui-clone/i)
    expect(out.args.slice(0, -1)).toEqual(['-y', '@modelcontextprotocol/server-filesystem'])
  })

  it('leaves non-filesystem servers unchanged', () => {
    const cfg = {
      name: 'mem',
      transport: 'stdio' as const,
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-memory'],
    }
    expect(applyFilesystemMcpWorkspaceRoot(cfg)).toEqual(cfg)
  })

  it('preserves saved root when main workspace is unset (startup before UI sync)', () => {
    getWorkspacePath.mockReturnValue(null)
    const cfg = {
      name: 'filesystem',
      transport: 'stdio' as const,
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', 'G:\\old'],
    }
    const out = applyFilesystemMcpWorkspaceRoot(cfg)
    expect(out.args[out.args.length - 1]).toMatch(/old/i)
  })

  it('uses renderer hint when main workspace is still null', () => {
    getWorkspacePath.mockReturnValue(null)
    const cfg = {
      name: 'filesystem',
      transport: 'stdio' as const,
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', 'G:\\stale'],
    }
    const out = applyFilesystemMcpWorkspaceRoot(cfg, 'G:\\from-renderer')
    expect(out.args[out.args.length - 1]).toMatch(/from-renderer/i)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// Boundary cases — argv shape, multiple roots, transport gating, hint sanity
// ──────────────────────────────────────────────────────────────────────────
describe('applyFilesystemMcpWorkspaceRoot — boundary', () => {
  beforeEach(() => {
    getWorkspacePath.mockReturnValue('G:\\workspace-code\\projects\\cursor-ui-clone')
  })

  it('treats whitespace-only hint as absent (falls through to main workspace)', () => {
    const cfg = {
      name: 'filesystem',
      transport: 'stdio' as const,
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', 'G:\\stale'],
    }
    const out = applyFilesystemMcpWorkspaceRoot(cfg, '   ')
    expect(out.args[out.args.length - 1]).toMatch(/cursor-ui-clone/i)
  })

  it('collapses MULTIPLE forwarded roots into the single resolved workspace', () => {
    // server-filesystem itself supports multiple allowed roots in argv,
    // but we deliberately replace ALL forwarded args with a single resolved
    // root so AI sandboxing is anchored to ONE workspace. Pin the behavior.
    const cfg = {
      name: 'filesystem',
      transport: 'stdio' as const,
      command: 'npx',
      args: [
        '-y',
        '@modelcontextprotocol/server-filesystem',
        'G:\\old-a',
        'G:\\old-b',
        'G:\\old-c',
      ],
    }
    const out = applyFilesystemMcpWorkspaceRoot(cfg)
    expect(out.args.length).toBe(3) // -y + pkg + ONE root
    expect(out.args[0]).toBe('-y')
    expect(out.args[1]).toBe('@modelcontextprotocol/server-filesystem')
    expect(out.args[2]).toMatch(/cursor-ui-clone/i)
  })

  it('appends a root even when args carry zero forwarded directories', () => {
    const cfg = {
      name: 'filesystem',
      transport: 'stdio' as const,
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem'],
    }
    const out = applyFilesystemMcpWorkspaceRoot(cfg)
    expect(out.args.length).toBe(3)
    expect(out.args[2]).toMatch(/cursor-ui-clone/i)
  })

  it('passes through HTTP transport unchanged', () => {
    const cfg = {
      name: 'filesystem',
      transport: 'streamableHttp' as const,
      url: 'https://example/sse',
      command: '',
      args: ['-y', '@modelcontextprotocol/server-filesystem', 'G:\\old'],
    }
    expect(applyFilesystemMcpWorkspaceRoot(cfg)).toBe(cfg)
  })

  it('passes through stdio configs whose npx parse fails (non-positional pkg)', () => {
    const cfg = {
      name: 'filesystem',
      transport: 'stdio' as const,
      command: 'npx',
      // No package name in argv, just flags → parseNpxMcpArgs returns null.
      args: ['-y', '--quiet'],
    }
    expect(applyFilesystemMcpWorkspaceRoot(cfg)).toBe(cfg)
  })

  it('passes through stdio configs that target a NON-filesystem package', () => {
    const cfg = {
      name: 'memory',
      transport: 'stdio' as const,
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-memory', '/some/dir'],
    }
    expect(applyFilesystemMcpWorkspaceRoot(cfg)).toBe(cfg)
  })

  it('honors `-p package@1.2.3` flag form (parses correctly)', () => {
    const cfg = {
      name: 'filesystem',
      transport: 'stdio' as const,
      command: 'npx',
      args: ['-p', 'whatever@1.0.0', '@modelcontextprotocol/server-filesystem', 'G:\\old'],
    }
    const out = applyFilesystemMcpWorkspaceRoot(cfg)
    expect(out.args[out.args.length - 1]).toMatch(/cursor-ui-clone/i)
  })

  it('resolves a hint that contains `..` to its canonical form', () => {
    getWorkspacePath.mockReturnValue(null)
    const cfg = {
      name: 'filesystem',
      transport: 'stdio' as const,
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem'],
    }
    const out = applyFilesystemMcpWorkspaceRoot(cfg, 'G:\\workspace-code\\foo\\..\\bar')
    const last = String(out.args[out.args.length - 1])
    expect(last).not.toMatch(/\.\./)
    expect(last).toMatch(/bar/i)
  })

  it('an empty-string hint is treated as absent', () => {
    const cfg = {
      name: 'filesystem',
      transport: 'stdio' as const,
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', 'G:\\saved'],
    }
    const out = applyFilesystemMcpWorkspaceRoot(cfg, '')
    expect(out.args[out.args.length - 1]).toMatch(/cursor-ui-clone/i)
  })
})
