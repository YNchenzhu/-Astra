/**
 * Registers upstream-style MCP resource tools on the global {@link toolRegistry}.
 * These are not `mcp__*` dynamic tools — they must survive `fullResyncMcpRegistry` (which only
 * unregisters prefixed MCP tool names).
 */

import path from 'node:path'
import { app } from 'electron'
import type { MCPClientManager } from './client'
import { toolRegistry } from '../tools/registry'
import { createListMcpResourcesTool } from '../tools/ListMcpResourcesTool'
import { createReadMcpResourceTool } from '../tools/ReadMcpResourceTool'

/** Stable registry names (also in builtinToolAliases). */
export const MCP_RESOURCE_TOOL_NAMES = ['ListMcpResourcesTool', 'ReadMcpResourceTool'] as const

export function mcpResourceTempDir(): string {
  return path.join(app.getPath('temp'), 'astra-mcp-resources')
}

/**
 * (Re)register resource list/read tools bound to the given manager.
 * Safe to call after every MCP sync so tools always reference the live manager.
 */
export function ensureMcpResourceToolsRegistered(manager: MCPClientManager): void {
  toolRegistry.register(createListMcpResourcesTool(manager))
  toolRegistry.register(createReadMcpResourceTool(manager, { getTempDir: () => mcpResourceTempDir() }))
}
