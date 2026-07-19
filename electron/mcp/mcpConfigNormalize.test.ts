import { describe, it, expect } from 'vitest'
import { normalizeStdioNpxMcpConfig } from './mcpConfigNormalize'

describe('normalizeStdioNpxMcpConfig', () => {
  it('rewrites package-as-command to npx -y pkg + args', () => {
    const out = normalizeStdioNpxMcpConfig({
      name: 'fs',
      transport: 'stdio',
      command: '@modelcontextprotocol/server-filesystem',
      args: ['G:\\workspace-code\\projects\\DIY-IDE'],
    })
    expect(out.command).toBe('npx')
    expect(out.args).toEqual([
      '-y',
      '@modelcontextprotocol/server-filesystem',
      'G:\\workspace-code\\projects\\DIY-IDE',
    ])
  })

  it('leaves normal npx rows unchanged', () => {
    const cfg = {
      name: 'fs',
      transport: 'stdio' as const,
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', 'G:\\x'],
    }
    expect(normalizeStdioNpxMcpConfig(cfg)).toEqual(cfg)
  })

  it('does not touch SSE transports', () => {
    const cfg = {
      name: 'remote',
      transport: 'sse' as const,
      command: '',
      args: [] as string[],
      url: 'http://example/mcp',
    }
    expect(normalizeStdioNpxMcpConfig(cfg)).toEqual(cfg)
  })
})
