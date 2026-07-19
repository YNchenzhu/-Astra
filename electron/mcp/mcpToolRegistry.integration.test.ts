/**
 * AC-8.2 — MCP 工具动态注册：passthrough input_schema + 100k 结果预算（集成级）。
 */

import { describe, it, expect, afterEach } from 'vitest'
import { toolRegistry } from '../tools/registry'
import { syncMCPTools, OPENCLAUDE_MCP_TOOL_MAX_RESULT_CHARS } from './registry'
import { getToolDefinitions, resetToolDefinitionsSessionCacheForTests } from '../tools/schema'
import type { MCPClientManager } from './client'

afterEach(() => {
  toolRegistry.unregister('mcp__srv__t1')
  toolRegistry.unregister('mcp__srv__t2')
  resetToolDefinitionsSessionCacheForTests()
})

describe('MCP tool registry → model schema', () => {
  it('uses additionalProperties and OC result cap for empty MCP input schema', () => {
    const mgr = {
      getAllTools: () => [
        {
          serverName: 'srv',
          tool: { name: 't1', description: 'Dynamic MCP tool', inputSchema: {} },
        },
      ],
      callTool: async () => ({ content: [{ type: 'text', text: 'ok' }], isError: false }),
    } as unknown as MCPClientManager

    syncMCPTools(mgr, (t) => toolRegistry.register(t), () => false)

    const reg = toolRegistry.get('mcp__srv__t1')
    expect(reg?.openEndedJsonSchema).toBe(true)
    expect(reg?.maxResultChars).toBe(OPENCLAUDE_MCP_TOOL_MAX_RESULT_CHARS)

    const defs = getToolDefinitions()
    const d = defs.find((x) => x.name === 'mcp__srv__t1')
    expect(d).toBeDefined()
    expect(d!.input_schema.additionalProperties).toBe(true)
  })

  // upstream alignment extra-2: MCP bridged tools auto-derive `zInputSchema`
  // from server-advertised JSON Schema so the Zod gate catches bad inputs
  // before they reach the server (`-32602 Invalid params`).
  it('auto-derives zInputSchema from server-advertised JSON Schema', () => {
    const mgr = {
      getAllTools: () => [
        {
          serverName: 'srv',
          tool: {
            name: 't2',
            description: 'Tool with typed schema',
            inputSchema: {
              type: 'object',
              properties: {
                path: { type: 'string', description: 'file path' },
                limit: { type: 'integer' },
              },
              required: ['path'],
            },
          },
        },
      ],
      callTool: async () => ({ content: [{ type: 'text', text: 'ok' }], isError: false }),
    } as unknown as MCPClientManager

    syncMCPTools(mgr, (t) => toolRegistry.register(t), () => false)

    const reg = toolRegistry.get('mcp__srv__t2')
    expect(reg).toBeDefined()
    expect(reg!.openEndedJsonSchema).toBeFalsy()
    expect(reg!.zInputSchema).toBeDefined()

    // Good input → parses cleanly.
    const goodInput = reg!.zInputSchema!.safeParse({ path: '/x' })
    expect(goodInput.success).toBe(true)

    // Required field missing → Zod rejects (caught at validateToolZodInput
    // before reaching the MCP server).
    const missingRequired = reg!.zInputSchema!.safeParse({ limit: 10 })
    expect(missingRequired.success).toBe(false)

    // Wrong type on required field → Zod rejects.
    const wrongType = reg!.zInputSchema!.safeParse({ path: 42 })
    expect(wrongType.success).toBe(false)

    // Extra fields → preserved (server-advertised schemas rarely set
    // additionalProperties:false; we default to .loose() so the model can
    // send server-specific fields the schema doesn't list).
    const extras = reg!.zInputSchema!.safeParse({ path: '/x', server_only_hint: 'foo' })
    expect(extras.success).toBe(true)
    if (extras.success) {
      expect((extras.data as Record<string, unknown>).server_only_hint).toBe('foo')
    }
  })
})
