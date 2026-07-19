/**
 * MCP dynamic tool names tracked for unregister on disconnect / full resync after connect.
 * Lives in its own module so callers (e.g. subAgentMcpLease) do not import ./handlers (cycle risk).
 */

import type { MCPClientManager } from './client'
import { syncMCPTools, encodeMcpServerNameForRegistry } from './registry'
import { ensureMcpResourceToolsRegistered } from './mcpResourceToolRegistration'
import { toolRegistry } from '../tools/registry'

let registeredMCPToolNames: string[] = []

/** Rebuild MCP tool registrations from the live manager (after connect/disconnect). */
export function fullResyncMcpRegistry(manager: MCPClientManager): void {
  for (const name of registeredMCPToolNames) {
    toolRegistry.unregister(name)
  }
  registeredMCPToolNames = []
  for (const { serverName, tool } of manager.getAllTools()) {
    // BUG-M2 fix: the registry stores tools under the *encoded* server
    // name (see `mcpToolToTool` in `registry.ts`). Previously we tracked
    // raw `mcp__<serverName>__<tool>`, leaving zombie registrations
    // every time a server name contained `__`. Encoding here keeps the
    // tracking list in lock-step with the actual registry keys.
    const encodedServer = encodeMcpServerNameForRegistry(serverName)
    registeredMCPToolNames.push(`mcp__${encodedServer}__${tool.name}`)
  }
  syncMCPTools(
    manager,
    (tool) => toolRegistry.register(tool),
    (name) => toolRegistry.unregister(name),
  )
  ensureMcpResourceToolsRegistered(manager)
}

/** After a single server disconnect: drop its mcp__* tools from registry and tracking. */
export function unregisterMcpToolsTrackedForServer(serverName: string): void {
  // BUG-M2 fix: match on the *encoded* prefix so zombie tools left over
  // from earlier (raw-prefix) tracking are still cleaned up correctly.
  const encodedServer = encodeMcpServerNameForRegistry(serverName)
  const prefix = `mcp__${encodedServer}__`
  for (const name of registeredMCPToolNames) {
    if (name.startsWith(prefix)) {
      toolRegistry.unregister(name)
    }
  }
  registeredMCPToolNames = registeredMCPToolNames.filter((n) => !n.startsWith(prefix))
}

/** After disconnect-all: clear all tracked MCP bridge tools from registry. */
export function unregisterAllMcpToolsTracked(): void {
  for (const name of registeredMCPToolNames) {
    toolRegistry.unregister(name)
  }
  registeredMCPToolNames = []
}
