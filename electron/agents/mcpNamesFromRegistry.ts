/**
 * MCP server display names for prompts that need the worker-tool surface
 * (coordinator prompts, subAgent tool context). Kept separate from
 * {@link coordinatorMode} to avoid import cycles
 * (registry → builtInAgents → coordinator).
 *
 * Audit Bug O8: previously this only looked at the tool registry, which
 * holds every `mcp__*` tool that was ever registered — including servers
 * that later disconnected. Workers would then be told they have access to
 * tools whose underlying MCP connection is dead, producing confused
 * behavior. We now cross-reference with the live
 * {@link peekMcpManagerIfInitialized} connection state so only **connected**
 * servers appear.
 */

import { toolRegistry } from '../tools/registry'
import { peekMcpManagerIfInitialized } from '../mcp/handlers'

/** Sorted unique MCP server names whose connections are currently live. */
export function listMcpServerNamesFromToolRegistry(): string[] {
  // Build the registry-derived set first as the superset.
  const registryNames = new Set<string>()
  for (const t of toolRegistry.getAll()) {
    // `[^_]` was too strict for sanitized server names that may contain
    // a single `_`. Use a lazy match up to the first `__` separator.
    const m = /^mcp__(.+?)__/.exec(t.name)
    if (m) registryNames.add(m[1])
  }

  // Intersect with the live MCP manager's connected servers. If the
  // manager hasn't been initialized (cold boot / tests), fall back to
  // the registry set so we don't regress behavior.
  const mgr = peekMcpManagerIfInitialized()
  if (!mgr) return [...registryNames].sort()

  const connected = new Set<string>()
  try {
    for (const row of mgr.listServers()) {
      if (row.connected && row.toolCount > 0) connected.add(row.name)
    }
  } catch {
    // If the listing throws, fall back to registry — safer than emitting
    // an empty list which would hide the whole MCP surface from the model.
    return [...registryNames].sort()
  }

  const result = [...registryNames].filter((n) => connected.has(n))
  return result.sort()
}
