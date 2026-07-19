import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { discoverProjectMcpContext } from './mcpProjectDiscovery'
import type { MCPServerConfig } from './transport'

describe('mcpProjectDiscovery', () => {
  it('returns pending when workspace has .mcp.json and saved list empty', () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'pole-mcp-disc-'))
    fs.writeFileSync(
      path.join(ws, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          x: { command: 'node', args: ['-e', '0'] },
        },
      }),
      'utf8',
    )
    const appr = path.join(ws, 'mcp-approvals-test.json')
    const { pending, entries } = discoverProjectMcpContext({
      workspacePath: ws,
      savedConfigs: [] as MCPServerConfig[],
      approvalFilePath: appr,
      userConfig: {},
      processEnv: process.env,
    })
    expect(entries.length).toBeGreaterThanOrEqual(1)
    expect(pending.length).toBe(1)
    expect(pending[0]!.config.name).toBe('x')
  })

  it('does not list pending when identical config already saved', () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'pole-mcp-disc2-'))
    const cfg = { name: 'x', transport: 'stdio' as const, command: 'node', args: ['-e', '0'] }
    fs.writeFileSync(
      path.join(ws, '.mcp.json'),
      JSON.stringify({ mcpServers: { x: { command: 'node', args: ['-e', '0'] } } }),
      'utf8',
    )
    const appr = path.join(ws, 'mcp-approvals-test2.json')
    const { pending } = discoverProjectMcpContext({
      workspacePath: ws,
      savedConfigs: [cfg],
      approvalFilePath: appr,
      userConfig: {},
      processEnv: process.env,
    })
    expect(pending.length).toBe(0)
  })
})
