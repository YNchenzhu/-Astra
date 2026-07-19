import { afterEach, describe, expect, it } from 'vitest'
import type { Tool } from '../tools/types'
import { toolRegistry } from '../tools/registry'
import { extractMcpServerName, resolvePrimaryChatTools } from './resolvePrimaryChatTools'

function mcpTool(name: string): Tool {
  return {
    name,
    description: `Test MCP tool ${name}`,
    inputSchema: [],
    isReadOnly: true,
    execute: async () => ({ success: true, output: 'ok' }),
  }
}

describe('resolvePrimaryChatTools', () => {
  const registered = [
    'mcp__legal_docs__search',
    'mcp__legal__search',
    'mcp__legal_docs_archive__search',
  ]

  afterEach(() => {
    for (const name of registered) {
      toolRegistry.unregister(name)
    }
  })

  it('extracts MCP server names that contain underscores', () => {
    expect(extractMcpServerName('mcp__legal_docs__search')).toBe('legal_docs')
    expect(extractMcpServerName('mcp__legal_docs_archive__search')).toBe(
      'legal_docs_archive',
    )
    expect(extractMcpServerName('read_file')).toBeNull()
  })

  it('keeps primary-chat MCP tools whose server allowlist contains underscores', () => {
    for (const name of registered) {
      toolRegistry.register(mcpTool(name))
    }

    const tools = resolvePrimaryChatTools({
      tools: undefined,
      disallowedTools: undefined,
      mcpServers: ['legal_docs'],
    })

    const names = new Set((tools ?? []).map((t) => t.name))
    expect(names.has('mcp__legal_docs__search')).toBe(true)
    expect(names.has('mcp__legal__search')).toBe(false)
    expect(names.has('mcp__legal_docs_archive__search')).toBe(false)
  })
})
