/**
 * Narrow API tool definitions for inline/fork skill sessions (upstream-style allowlist).
 */

import type { ToolDefinition } from '../tools/types'
import { canonicalBuiltinToolName } from '../tools/builtinToolAliases'

/**
 * When `allowedTools` is non-empty, keep only those names (after canonical
 * alias resolution) plus MCP tools that pass the patterns in the allowlist.
 *
 * MCP matching semantics (audit Bug O15 — previously ALL `mcp__*` tools
 * leaked through regardless of `allowedTools`):
 *   - `mcp__*`            → every MCP tool is allowed (opt-in "all MCP"
 *                           mode, preserves legacy behavior when the skill
 *                           author writes `mcp__*` explicitly)
 *   - `mcp__server__*`    → every tool from that server is allowed
 *   - `mcp__server__tool` → exact match only
 *   - No MCP entry        → no MCP tool is allowed (strict subset)
 */
export function filterToolDefinitionsForSkill(
  definitions: ToolDefinition[],
  allowedTools: string[] | undefined,
): ToolDefinition[] {
  if (!allowedTools || allowedTools.length === 0) return definitions

  const trimmed = allowedTools.map((t) => t.trim()).filter(Boolean)
  const allowedBuiltins = new Set(
    trimmed.filter((t) => !t.startsWith('mcp__')).map((t) => canonicalBuiltinToolName(t)),
  )
  const mcpPatterns = trimmed.filter((t) => t.startsWith('mcp__'))
  const mcpAllowAll = mcpPatterns.includes('mcp__*')
  const mcpPrefixMatchers: string[] = []
  const mcpExactMatchers = new Set<string>()
  for (const p of mcpPatterns) {
    if (p === 'mcp__*') continue
    if (p.endsWith('*')) {
      mcpPrefixMatchers.push(p.slice(0, -1))
    } else {
      mcpExactMatchers.add(p)
    }
  }

  return definitions.filter((d) => {
    if (d.name.startsWith('mcp__')) {
      if (mcpAllowAll) return true
      if (mcpExactMatchers.has(d.name)) return true
      return mcpPrefixMatchers.some((prefix) => d.name.startsWith(prefix))
    }
    return allowedBuiltins.has(canonicalBuiltinToolName(d.name))
  })
}
