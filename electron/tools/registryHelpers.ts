/**
 * Small helpers shared between the ToolRegistry constructor and runtime
 * registration paths.
 */

import type { Tool } from './types'
import { getBuiltinToolExamples } from './builtinToolExamples'

/**
 * Attach curated Anthropic Tool Use Examples ({@link BUILTIN_TOOL_EXAMPLES})
 * to the corresponding built-in tool. No-op when either the tool already
 * declares `examples` (manual override wins) or no examples are curated.
 */
export function attachBuiltinExamples(tool: Tool): Tool {
  if (tool.examples !== undefined) return tool
  const ex = getBuiltinToolExamples(tool.name)
  if (!ex || ex.length === 0) return tool
  return { ...tool, examples: ex }
}

/**
 * Enforce the Advanced Tool Use incompatibilities documented by Anthropic
 * (see "Advanced tool use" 2025-11-24 §Constraints):
 *
 *   - Tools provided via MCP connector cannot be called programmatically.
 *   - Deferred tools (lazy-loaded via ToolSearch) cannot be opted into PTC
 *     because they're not materialised at request time.
 *   - Per-tool `examples` must be plain objects and cap at 20 entries.
 *
 * Throws synchronously on misuse — this runs at startup, so a loud failure
 * is strictly better than a silent gateway 400 downstream.
 */
export function assertAdvancedToolUseCoherence(tool: Tool): void {
  if (tool.ptcAllowedCaller && tool.ptcAllowedCaller !== 'direct') {
    if (tool.isMcpBridge) {
      throw new Error(
        `[ToolRegistry] Tool "${tool.name}" is an MCP bridge; Anthropic PTC ` +
          `does not accept MCP tools in \`allowed_callers\`. Remove \`ptcAllowedCaller\` ` +
          `or stop marking the tool as an MCP bridge.`,
      )
    }
    if (tool.shouldDefer === true) {
      throw new Error(
        `[ToolRegistry] Tool "${tool.name}" is deferred (\`shouldDefer: true\`); ` +
          `PTC requires the tool definition to be present at request time. ` +
          `Either set \`alwaysLoad: true\` or drop \`ptcAllowedCaller\`.`,
      )
    }
  }
  if (tool.examples !== undefined) {
    if (!Array.isArray(tool.examples)) {
      throw new Error(
        `[ToolRegistry] Tool "${tool.name}" declares a non-array \`examples\`; ` +
          `expected ReadonlyArray<Record<string, unknown>>.`,
      )
    }
    if (tool.examples.length > 20) {
      throw new Error(
        `[ToolRegistry] Tool "${tool.name}" declares ${tool.examples.length} examples; ` +
          `Anthropic limits \`input_examples\` to 20 per tool.`,
      )
    }
    for (let i = 0; i < tool.examples.length; i += 1) {
      const ex = tool.examples[i]
      if (!ex || typeof ex !== 'object' || Array.isArray(ex)) {
        throw new Error(
          `[ToolRegistry] Tool "${tool.name}" example #${i} is not a plain object.`,
        )
      }
    }
  }
}
