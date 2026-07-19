/**
 * ListMcpResourcesTool / ReadMcpResourceTool are registered via ensureMcpResourceToolsRegistered
 * (same path as production MCP handlers).
 */

import { describe, it, expect, afterEach, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: (k: string) => (k === 'temp' ? '/tmp/mcp-resource-tool-test' : '/tmp'),
  },
}))

import type { MCPClientManager } from './client'
import { toolRegistry } from '../tools/registry'
import { getToolDefinitions, resetToolDefinitionsSessionCacheForTests } from '../tools/schema'
import { ensureMcpResourceToolsRegistered } from './mcpResourceToolRegistration'

afterEach(() => {
  toolRegistry.unregister('ListMcpResourcesTool')
  toolRegistry.unregister('ReadMcpResourceTool')
  resetToolDefinitionsSessionCacheForTests()
})

function mockManager(): MCPClientManager {
  return {
    listServers: () => [
      { name: 'srv', transport: 'stdio', connected: true, toolCount: 1 },
    ],
    listResourcesForServer: async () => [
      {
        uri: 'test://doc/1',
        name: 'Doc1',
        description: 'A resource',
        mimeType: 'text/plain',
      },
    ],
    readResourceForServer: async (_server: string, _uri: string, _tmp: string) => [
      { uri: 'test://doc/1', mimeType: 'text/plain', text: 'body' },
    ],
    getAllTools: () => [],
  } as unknown as MCPClientManager
}

describe('ensureMcpResourceToolsRegistered', () => {
  it('registers tools and exposes them in getToolDefinitions', () => {
    ensureMcpResourceToolsRegistered(mockManager())
    expect(toolRegistry.has('ListMcpResourcesTool')).toBe(true)
    expect(toolRegistry.has('ReadMcpResourceTool')).toBe(true)
    const names = getToolDefinitions().map((d) => d.name)
    expect(names).toContain('ListMcpResourcesTool')
    expect(names).toContain('ReadMcpResourceTool')
  })

  it('executes list and read against the manager', async () => {
    ensureMcpResourceToolsRegistered(mockManager())
    const list = await toolRegistry.execute('ListMcpResourcesTool', {})
    expect(list.success).toBe(true)
    expect(String(list.output || '')).toContain('Doc1')
    expect(String(list.output || '')).toContain('srv')

    const read = await toolRegistry.execute('ReadMcpResourceTool', {
      server: 'srv',
      uri: 'test://doc/1',
    })
    expect(read.success).toBe(true)
    expect(String(read.output || '')).toContain('body')
  })
})
