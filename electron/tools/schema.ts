/**
 * Convert Tool definitions to Anthropic API tool format.
 *
 * Anthropic expects:
 * {
 *   tools: [{
 *     name: string,
 *     description: string,
 *     input_schema: {
 *       type: "object",
 *       properties: { [key]: { type, description, enum? } },
 *       required: string[]
 *     }
 *   }]
 * }
 *
 * OpenAI expects a similar but slightly different format.
 * Gemini uses function declarations. Those conversions happen in client.ts.
 */

import { createHash } from 'node:crypto'
import type { Tool, ToolDefinition, ToolParameter } from './types'
import { toolRegistry } from './registry'
import { getToolDiscoveryEpoch, shouldExposeDeferredTool } from './deferredDiscovery'
import { toolAllowedInSimpleToolset, isSimpleToolsetMode } from '../utils/simpleToolset'
import type { PermissionRulePayload } from '../ai/permissionRuleMatch'
import { isToolDeniedForModelListing } from '../ai/permissionRuleMatch'
import { hasEmbeddedSearchTools, shouldHideGlobGrepForEmbeddedSearch } from '../utils/embeddedTools'
import { isToolRuntimeDisabled, runtimeDisabledToolNamesFingerprint } from './toolLoadFlags'

// ── §8.1 session-level ToolDefinition[] memo (name + schema + listing gates) ──

let toolDefinitionsSessionCacheAll: { key: string; defs: ToolDefinition[] } | null = null
let toolDefinitionsSessionCacheRo: { key: string; defs: ToolDefinition[] } | null = null

/** Test / hot-reload hygiene */
export function resetToolDefinitionsSessionCacheForTests(): void {
  toolDefinitionsSessionCacheAll = null
  toolDefinitionsSessionCacheRo = null
}

function permissionRulesFingerprint(permissionRules: PermissionRulePayload[] | undefined): string {
  if (!permissionRules?.length) return '-'
  try {
    return createHash('sha256').update(JSON.stringify(permissionRules)).digest('hex').slice(0, 20)
  } catch {
    return 'err'
  }
}

/** Tools with runtime `isEnabled` / `deferUntil` — must be part of the cache key (e.g. LSP). */
function dynamicToolGateFingerprint(): string {
  const parts: string[] = []
  for (const tool of toolRegistry.getAll()) {
    const bits: string[] = []
    if (typeof tool.isEnabled === 'function') {
      try {
        bits.push(`en=${tool.isEnabled() ? 1 : 0}`)
      } catch {
        bits.push('en=x')
      }
    }
    if (tool.shouldDefer && typeof tool.deferUntil === 'function') {
      try {
        bits.push(`def=${tool.deferUntil() ? 1 : 0}`)
      } catch {
        bits.push('def=x')
      }
    }
    if (bits.length > 0) parts.push(`${tool.name}:${bits.join('&')}`)
  }
  parts.sort()
  return parts.join('|') || '-'
}

/**
 * upstream 上下文报告 §8.1 — session cache key: registry revision, deferred-discovery epoch,
 * permission rules, embedded/simple modes, and dynamic tool gates.
 */
export function buildToolDefinitionsSessionCacheKey(
  permissionRules: PermissionRulePayload[] | undefined,
  variant: 'all' | 'readonly',
): string {
  return [
    variant,
    String(toolRegistry.getToolsetRevision()),
    String(getToolDiscoveryEpoch()),
    permissionRulesFingerprint(permissionRules),
    hasEmbeddedSearchTools() ? 'emb1' : 'emb0',
    isSimpleToolsetMode() ? 'simple1' : 'simple0',
    dynamicToolGateFingerprint(),
    runtimeDisabledToolNamesFingerprint(),
  ].join('\0')
}

function getToolPrimaryDescription(tool: Tool): string {
  try {
    const d = tool.description
    return typeof d === 'string' ? d : String(d)
  } catch {
    return tool.name
  }
}

/** API `description`: base + optional {@link Tool.modelDescriptionExtension} (report §4.1). */
export function buildModelFacingToolDescription(tool: Tool): string {
  const primary = getToolPrimaryDescription(tool)
  const ext = tool.modelDescriptionExtension?.trim()
  if (!ext) return primary
  return `${primary}\n\n${ext}`
}

function parameterTypeToJSON(type: ToolParameter['type']): string {
  switch (type) {
    case 'array':
      return 'array'
    case 'object':
      return 'object'
    case 'number':
      return 'number'
    case 'boolean':
      return 'boolean'
    default:
      return 'string'
  }
}

/**
 * Resolve the `allowed_callers` field from {@link Tool.ptcAllowedCaller}.
 *
 * Emitted into the wire definition unconditionally when the tool opts in;
 * the wire-level sanitizer strips it when the provider doesn't support PTC.
 *
 * Rules (mirror Anthropic docs — "Advanced tool use" 2025-11-24):
 *   - `'code_execution'` → only callable from inside the PTC sandbox
 *   - `'both'`           → callable directly AND from PTC
 *   - `'direct'` / undefined → omit the field (default)
 *
 * MCP bridge tools are explicitly disallowed from opting in because
 * Anthropic's documentation lists them as incompatible.
 */
function resolveAllowedCallers(tool: Tool): string[] | undefined {
  const mode = tool.ptcAllowedCaller
  if (!mode || mode === 'direct') return undefined
  if (tool.isMcpBridge) {
    // Silently drop — surfacing an error here would crash non-PTC sessions.
    // The registry-level assert in `registry.ts` is the right place for loud
    // failure, but we defensively ignore here to stay robust.
    return undefined
  }
  const CE = 'code_execution_20260120'
  if (mode === 'code_execution') return [CE]
  if (mode === 'both') return ['direct', CE]
  return undefined
}

/**
 * Return a defensive shallow copy of the tool's {@link Tool.examples} with
 * non-object entries filtered out, capped to the documented 20. Returns
 * `undefined` when the tool declares no examples.
 */
function resolveInputExamples(tool: Tool): Array<Record<string, unknown>> | undefined {
  const raw = tool.examples
  if (!raw || raw.length === 0) return undefined
  const cleaned: Array<Record<string, unknown>> = []
  for (const ex of raw) {
    if (!ex || typeof ex !== 'object' || Array.isArray(ex)) continue
    cleaned.push({ ...ex })
    if (cleaned.length >= 20) break
  }
  return cleaned.length > 0 ? cleaned : undefined
}

function toolToDefinition(tool: Tool): ToolDefinition {
  const examples = resolveInputExamples(tool)
  const allowedCallers = resolveAllowedCallers(tool)

  if (tool.openEndedJsonSchema) {
    const def: ToolDefinition = {
      name: tool.name,
      description: buildModelFacingToolDescription(tool),
      input_schema: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: true,
      },
    }
    if (examples) def.input_examples = examples
    if (allowedCallers) def.allowed_callers = allowedCallers
    return def
  }

  type JsonSchemaProp = {
    type: string
    description: string
    enum?: string[]
    default?: unknown
    items?: Record<string, unknown>
    properties?: Record<string, unknown>
  }
  const properties: Record<string, JsonSchemaProp> = {}
  const required: string[] = []

  for (const param of tool.inputSchema) {
    const propDef: JsonSchemaProp = {
      type: parameterTypeToJSON(param.type),
      description: param.description,
    }
    if (param.enum) {
      propDef.enum = param.enum
    }
    if (param.default !== undefined) {
      propDef.default = param.default
    }
    if (param.items) {
      const items: Record<string, unknown> = { ...param.items }
      if (param.type === 'array' && items.type === undefined) {
        items.type = 'string'
      }
      propDef.items = items
    }
    if (param.properties) {
      propDef.properties = { ...param.properties }
    }
    properties[param.name] = propDef
    if (param.required) {
      required.push(param.name)
    }
  }

  const def: ToolDefinition = {
    name: tool.name,
    description: buildModelFacingToolDescription(tool),
    input_schema: {
      type: 'object',
      properties,
      required,
    },
  }
  if (examples) def.input_examples = examples
  if (allowedCallers) def.allowed_callers = allowedCallers
  return def
}

/**
 * Get all tool definitions in Anthropic API format.
 * Pass to `client.messages.create({ tools })` or `streamText()`.
 */
const SHELL_EXECUTION_TOOL_NAMES = new Set(['Bash', 'PowerShell'])

/**
 * True when Bash or PowerShell would appear in {@link getToolDefinitions} for this ruleset
 * (enabled, not deferred-hidden, not denied for listing).
 */
export function shellExecutionToolInModelListing(
  permissionRules?: PermissionRulePayload[],
): boolean {
  return toolRegistry.getAll().some(
    (tool) =>
      SHELL_EXECUTION_TOOL_NAMES.has(tool.name) &&
      tool.isEnabled?.() !== false &&
      shouldExposeDeferredTool(tool) &&
      !isToolDeniedForModelListing(tool.name, permissionRules),
  )
}

/** Sub-agent / override tool lists: any shell execution tool exposed to the model. */
export function shellExecutionToolInDefinitions(
  definitions: Array<{ name: string }>,
): boolean {
  return definitions.some((d) => SHELL_EXECUTION_TOOL_NAMES.has(d.name))
}

/**
 * upstream `assembleToolPool` analogue: built-ins (non-`mcp__`) sorted by name first, then
 * MCP bridge tools sorted by name; de-duplicates by `name` while preserving that order
 * (built-in wins over a hypothetical duplicate MCP key — registry normally has unique names).
 */
export function orderToolsForModelListing(tools: Tool[]): Tool[] {
  const builtins = tools
    .filter((t) => !t.name.startsWith('mcp__'))
    .sort((a, b) => a.name.localeCompare(b.name))
  const mcps = tools
    .filter((t) => t.name.startsWith('mcp__'))
    .sort((a, b) => a.name.localeCompare(b.name))
  const seen = new Set<string>()
  const out: Tool[] = []
  for (const t of [...builtins, ...mcps]) {
    if (seen.has(t.name)) continue
    seen.add(t.name)
    out.push(t)
  }
  return out
}

export function getToolDefinitions(permissionRules?: PermissionRulePayload[]): ToolDefinition[] {
  const key = buildToolDefinitionsSessionCacheKey(permissionRules, 'all')
  if (toolDefinitionsSessionCacheAll?.key === key) {
    return toolDefinitionsSessionCacheAll.defs
  }
  const defs = orderToolsForModelListing(
    toolRegistry
      .getAll()
      .filter((tool) => tool.isEnabled?.() !== false)
      .filter((tool) => shouldExposeDeferredTool(tool))
      .filter((tool) => toolAllowedInSimpleToolset(tool))
      .filter((tool) => !shouldHideGlobGrepForEmbeddedSearch(tool.name))
      .filter((tool) => !isToolDeniedForModelListing(tool.name, permissionRules))
      .filter((tool) => !isToolRuntimeDisabled(tool.name)),
  ).map(toolToDefinition)
  toolDefinitionsSessionCacheAll = { key, defs }
  return defs
}

/**
 * Get tool definitions filtered to only read-only tools.
 */
export function getReadOnlyToolDefinitions(permissionRules?: PermissionRulePayload[]): ToolDefinition[] {
  const key = buildToolDefinitionsSessionCacheKey(permissionRules, 'readonly')
  if (toolDefinitionsSessionCacheRo?.key === key) {
    return toolDefinitionsSessionCacheRo.defs
  }
  const defs = orderToolsForModelListing(
    toolRegistry
      .getAll()
      .filter((tool) => tool.isReadOnly)
      .filter((tool) => tool.isEnabled?.() !== false)
      .filter((tool) => shouldExposeDeferredTool(tool))
      .filter((tool) => toolAllowedInSimpleToolset(tool))
      .filter((tool) => !shouldHideGlobGrepForEmbeddedSearch(tool.name))
      .filter((tool) => !isToolDeniedForModelListing(tool.name, permissionRules))
      .filter((tool) => !isToolRuntimeDisabled(tool.name)),
  ).map(toolToDefinition)
  toolDefinitionsSessionCacheRo = { key, defs }
  return defs
}

/**
 * Convert a single tool to its API definition.
 */
export function toolDefinitionFor(name: string): ToolDefinition | null {
  const tool = toolRegistry.get(name)
  if (!tool) return null
  return toolToDefinition(tool)
}
