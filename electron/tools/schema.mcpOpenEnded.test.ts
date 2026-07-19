import { describe, it, expect, afterEach } from 'vitest'
import { toolRegistry } from './registry'
import { toolDefinitionFor, resetToolDefinitionsSessionCacheForTests } from './schema'
import type { Tool } from './types'

describe('ToolDefinition openEndedJsonSchema (OpenClaude MCPTool passthrough)', () => {
  afterEach(() => {
    toolRegistry.unregister('__test_mcp_open_ended')
    resetToolDefinitionsSessionCacheForTests()
  })

  it('emits additionalProperties: true for MCP-style tools', () => {
    const t: Tool = {
      name: '__test_mcp_open_ended',
      description: 'test',
      inputSchema: [],
      openEndedJsonSchema: true,
      isReadOnly: true,
      isConcurrencySafe: true,
      execute: async () => ({ success: true, output: 'ok' }),
    }
    toolRegistry.register(t)
    resetToolDefinitionsSessionCacheForTests()
    const d = toolDefinitionFor('__test_mcp_open_ended')
    expect(d).not.toBeNull()
    expect(d!.input_schema.additionalProperties).toBe(true)
    expect(d!.input_schema.properties).toEqual({})
  })
})
