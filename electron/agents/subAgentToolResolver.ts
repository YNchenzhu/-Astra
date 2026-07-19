/**
 * Sub-agent tool resolver — filters and transforms the global tool registry
 * into a sub-agent-specific tool surface.
 */

import type { Tool, ToolDefinition } from '../tools/types'
import { toolRegistry } from '../tools/registry'
import { registryPrimaryToolName } from '../tools/builtinToolAliases'
import type { AgentDefinitionUnion } from './types'
import {
  ALL_AGENT_DISALLOWED_TOOLS,
  ASYNC_AGENT_ALLOWED_TOOLS,
  getAlwaysAvailableSubagentTools,
  getCoordinatorModeAllowedToolNames,
} from './types'
import { normalizeToolsList } from './normalizeToolLists'
import { normalizeMcpServerNameList } from './normalizeAgentMcpServers'
import { getActiveBundle } from './bundles/bundleRegistry'
import { toolAllowedInSimpleToolset } from '../utils/simpleToolset'
import { getPermissionMode } from '../ai/interactionState'
import { getAgentContext } from './agentContext'

/** Map agent config tool ids → registry `Tool.name` (e.g. Read → read_file). */
function toolNamesToRegistryKeys(names: string[]): Set<string> {
  const set = new Set<string>()
  for (const raw of names) {
    const n = typeof raw === 'string' ? raw.trim() : ''
    if (!n) continue
    if (n === '*') {
      set.add('*')
      continue
    }
    set.add(registryPrimaryToolName(n))
  }
  return set
}

/**
 * P1-15: extract the MCP server name from a tool name like
 * `mcp__<server>__<tool>`. Server names commonly contain single underscores
 * (`my_server`); the previous `/^mcp__([^_]+)__/` regex truncated those at
 * the first underscore, so `mcp__my_server__tool` was misclassified as
 * server `my` and then either rejected (whitelist) or accepted (deny-list)
 * for the wrong reasons.
 *
 * We split by the literal `__` separator: `['mcp', '<server>', ...tool…]`.
 * The server segment is `parts[1]`. Tool names that contain `__` (rare)
 * stay joined in `parts.slice(2)` and don't affect server identification.
 */
export function extractMcpServerName(toolName: string): string | null {
  if (!toolName.startsWith('mcp__')) return null
  const parts = toolName.split('__')
  if (parts.length < 3 || !parts[1]) return null
  return parts[1]
}

function filterMcpToolsByServers(tools: Tool[], mcpServers: string[] | undefined): Tool[] {
  if (!mcpServers || mcpServers.length === 0) {
    return tools
  }
  const allow = new Set(mcpServers.map((s) => s.trim()).filter(Boolean))
  return tools.filter((t) => {
    if (!t.name.startsWith('mcp__')) return true
    const server = extractMcpServerName(t.name)
    return server !== null && allow.has(server)
  })
}

function coordinatorDefWithRuntimeAllowlist(agentDef: AgentDefinitionUnion): AgentDefinitionUnion {
  if (agentDef.agentType !== 'Coordinator') return agentDef
  return { ...agentDef, tools: getCoordinatorModeAllowedToolNames() }
}

/**
 * Apply active Bundle-level capability constraints on top of agent-level tool resolution.
 * If the active bundle declares `enabledTools`, the agent's resolved set is intersected.
 * If the bundle declares `disallowedTools`, they are additionally removed.
 * If the bundle declares `enabledMcpServers`, only those MCP tools are retained.
 */
function applyBundleCapabilityOverlay(resolvedTools: Tool[]): Tool[] {
  const bundle = getActiveBundle()
  if (!bundle) return resolvedTools
  const caps = bundle.capabilities
  if (!caps) return resolvedTools

  let out = resolvedTools

  // enabledTools whitelist: intersect with bundle-level allowlist
  if (Array.isArray(caps.enabledTools) && caps.enabledTools.length > 0) {
    const bundleAllow = new Set(caps.enabledTools.map((n) => n.trim()))
    out = out.filter((t) => bundleAllow.has(t.name))
  }

  // disallowedTools: always remove regardless of agent-level settings
  if (Array.isArray(caps.disallowedTools) && caps.disallowedTools.length > 0) {
    const bundleDeny = new Set(caps.disallowedTools.map((n) => n.trim()))
    out = out.filter((t) => !bundleDeny.has(t.name))
  }

  // enabledMcpServers: only keep mcp__* tools from listed servers
  if (Array.isArray(caps.enabledMcpServers) && caps.enabledMcpServers.length > 0) {
    const mcpAllow = new Set(caps.enabledMcpServers.map((n) => n.trim()))
    out = out.filter((t) => {
      if (!t.name.startsWith('mcp__')) return true
      // P1-15: same fix as filterMcpToolsByServers — handle underscore-containing
      // server names instead of truncating at the first `_`.
      const server = extractMcpServerName(t.name)
      return server !== null && mcpAllow.has(server)
    })
  }

  return out
}

export function resolveAgentTools(agentDef: AgentDefinitionUnion): Tool[] {
  const def = coordinatorDefWithRuntimeAllowlist(agentDef)
  const toolsAllow = normalizeToolsList(def.tools)
  const toolsDeny = normalizeToolsList(def.disallowedTools)
  const mcpAllowNames = normalizeMcpServerNameList(def.mcpServers)

  const allTools = toolRegistry.getAll()
  const nonInteractiveTools = allTools.filter(t => !INTERACTIVE_TOOL_NAMES.has(t.name))

  let base: Tool[]

  // If agent has a tools whitelist (not wildcard), filter by it
  if (toolsAllow && !(toolsAllow.length === 1 && toolsAllow[0] === '*')) {
    const allowedSet = toolNamesToRegistryKeys(toolsAllow)
    const resolved = nonInteractiveTools.filter(t => allowedSet.has(t.name))
    // MCP: only add servers explicitly listed in agent.mcpServers.
    // When mcpAllowNames is undefined/empty, MCP tools must NOT leak into
    // a whitelist-scoped agent (e.g. session-memory-internal which only
    // allows Read/Write/Edit/Glob/Grep — leaking mcp__filesystem__*
    // tools wastes turns on "Access denied" denials).
    if (mcpAllowNames && mcpAllowNames.length > 0) {
      const mcpTools = nonInteractiveTools.filter(t => t.name.startsWith('mcp__') && !allowedSet.has(t.name))
      base = [...resolved, ...filterMcpToolsByServers(mcpTools, mcpAllowNames)]
    } else {
      base = resolved
    }
  } else if (toolsDeny && toolsDeny.length > 0) {
    const deniedSet = toolNamesToRegistryKeys(toolsDeny)
    base = nonInteractiveTools.filter(t => !deniedSet.has(t.name))
    // P1-14: an agent that only specifies a disallow list and no `mcpServers`
    // previously inherited the FULL MCP tool universe — anything not in
    // the deny list passed through. Mirror the whitelist branch's
    // posture: when no MCP servers are explicitly authorized, drop all
    // `mcp__*` tools so configuring a disallow-list doesn't accidentally
    // re-open MCP access for restricted agents.
    if (mcpAllowNames && mcpAllowNames.length > 0) {
      base = filterMcpToolsByServers(base, mcpAllowNames)
    } else {
      base = base.filter((t) => !t.name.startsWith('mcp__'))
    }
  } else {
    base = filterMcpToolsByServers(nonInteractiveTools, mcpAllowNames)
  }

  let resolved = applyGlobalSubagentDenylist(base, def)
  if (def.subagentToolProfile === 'async_agent') {
    resolved = resolved.filter(
      (t) =>
        t.name.startsWith('mcp__') ||
        asyncAgentToolAllowed(t.name),
    )
  }
  resolved = injectExitPlanModeInPlanPermission(resolved, def)
  resolved = injectAlwaysAvailableTools(resolved, def)
  // NOTE: Read-only enforcement is intentionally *not* a post-injection
  // `t.isReadOnly === true` filter here. That earlier design over-stripped:
  //   - `bash` (`isReadOnly: false`) was removed from Explore even though
  //     the async_agent profile explicitly allows it for read-only shell
  //     introspection (grep/find).
  //   - Always-available admin tools (TodoWrite, ExitPlanMode) — which
  //     don't touch the workspace — were stripped right after being
  //     injected by the system, contradicting their own injection.
  // The agent-level `isReadOnly` flag is now treated as a *spawn-routing
  // hint* (consumed by `agentSpawnReadOnly.ts` for `Agent` tool concurrency
  // safety); workspace-mutation containment relies on the definition's
  // explicit `disallowedTools` (e.g. Explore/Plan deny Write/Edit) and the
  // `subagentToolProfile: 'async_agent'` allowlist, both of which run
  // earlier in this function.

  // Bundle-level capability overlay: regardless of agent-level settings,
  // never exceed the active bundle's enabledTools / disallowedTools bounds.
  // This ensures industry-specific bundles (legal, medical, finance) can
  // enforce a hard tool surface boundary across ALL their agents.
  resolved = applyBundleCapabilityOverlay(resolved)

  return resolved.filter(toolAllowedInSimpleToolset)
}

/**
 * Union {@link getAlwaysAvailableSubagentTools} into the resolved tool
 * surface unless the agent explicitly disallows them. Membership is
 * mode-dependent (V1 → `TodoWrite`; V2 → `TaskCreate` + `TaskUpdate` +
 * `TaskList` + `TaskGet`); see the function's docstring for the
 * rationale.
 */
function injectAlwaysAvailableTools(
  tools: Tool[],
  agentDef: AgentDefinitionUnion,
): Tool[] {
  const alwaysAvailable = getAlwaysAvailableSubagentTools()
  if (alwaysAvailable.size === 0) return tools
  // upstream parity (`constants/tools.ts:104-112`): Coordinator gets
  // ONLY the four-tool upstream core surface (`Agent`, `TaskStop`,
  // `SendMessage`, `TaskOutput`). Skip the always-available
  // injection for any coordinator regardless of the strict env knob
  // — Phase D makes strict the default. The env still toggles the
  // extension set (`TeamStatus`, `Read`, `Grep`, `Glob`) via
  // `getCoordinatorModeAllowedToolNames()`.
  if (agentDef.agentType === 'Coordinator') {
    return tools
  }
  if (agentDef.subagentToolProfile === 'in_process_teammate') {
    return tools
  }
  // P1-17: session-memory-internal is sandboxed to ~/.claude/session-memory/*.md.
  // The default always-available set includes TodoWrite / Task*, which
  // (a) doesn't touch the file tree the gate checks and so silently passes
  // `gateSessionMemoryInternalAgentToolUse`, and (b) lets the model invent
  // task state that bleeds into the parent's UI. Skip the auto-injection
  // entirely for this agent type — its explicit `tools` whitelist is the
  // sole source of truth.
  if (agentDef.agentType === 'session-memory-internal') {
    return tools
  }

  const deniedNames = normalizeToolsList(agentDef.disallowedTools) ?? []
  const deniedSet = new Set(deniedNames.map((n) => registryPrimaryToolName(n)))
  const present = new Set(tools.map((t) => t.name))
  const allTools = toolRegistry.getAll()

  const extras: Tool[] = []
  for (const raw of alwaysAvailable) {
    const key = registryPrimaryToolName(raw)
    if (present.has(key) || deniedSet.has(key)) continue
    const tool = allTools.find((t) => t.name === key)
    if (tool) extras.push(tool)
  }
  return extras.length > 0 ? [...tools, ...extras] : tools
}

/** upstream §7.2 — sub-agents in plan permission may call ExitPlanMode even though it is normally stripped as interactive. */
function injectExitPlanModeInPlanPermission(
  tools: Tool[],
  agentDef: AgentDefinitionUnion,
): Tool[] {
  if (EXEMPT_FROM_GLOBAL_SUBAGENT_DENY.has(agentDef.agentType)) {
    return tools
  }
  // BUG-H1 fix: when the sub-agent owns a captured `permissionModeOverride`
  // (set at spawn time by `resolveSubAgentPermissionOverride`), trust it
  // exclusively — never let a *later* main-thread toggle of the global
  // permission mode flip the sub-agent's tool surface mid-run. Falling
  // back to `getPermissionMode()` is only safe when no override was
  // captured (the inherit case for foreground non-async sub-agents
  // pre-§7.8); §7.2 still requires plan-mode parents to project
  // `ExitPlanMode` onto those children.
  const planMode = isPlanModeForSubAgent(agentDef)
  if (!planMode) return tools
  if (tools.some((t) => t.name === 'ExitPlanMode')) return tools
  const exit = toolRegistry.getAll().find((t) => t.name === 'ExitPlanMode')
  if (!exit) return tools
  return [...tools, exit]
}

function asyncAgentToolAllowed(toolName: string): boolean {
  if (ASYNC_AGENT_ALLOWED_TOOLS.has(toolName)) return true
  return ASYNC_AGENT_ALLOWED_TOOLS.has(registryPrimaryToolName(toolName))
}

/** Sub-agent types with a curated tool surface — keep TaskStop/TaskOutput etc. (product behavior predates §7.1 strict strip). */
const EXEMPT_FROM_GLOBAL_SUBAGENT_DENY = new Set<string>(['Coordinator', 'Debug'])

/**
 * Decide whether a sub-agent is in plan permission mode.
 *
 * Precedence (BUG-H1):
 *  1. Sub-agent's own snapshot (`agentContext.permissionModeOverride`).
 *     This was captured at spawn time and is immune to later main-thread
 *     toggles. If it disagrees with the current global state, the
 *     snapshot wins — that is precisely why we capture it.
 *  2. Agent definition's static `permissionMode`. Only consulted when the
 *     spawn flow did not provide a runtime override.
 *  3. Global `getPermissionMode()`. Only consulted when neither (1) nor
 *     (2) constrains the answer — i.e. the foreground "inherit from
 *     main chat" case where no snapshot was captured (legacy §7.2
 *     projection). At that point the parent main chat IS the global,
 *     so reading it here is a snapshot-of-the-parent at sub-agent boot.
 */
function isPlanModeForSubAgent(agentDef: AgentDefinitionUnion): boolean {
  const ctxOverride = getAgentContext()?.permissionModeOverride
  // `'default'` means "no opinion" — propagate to the next layer instead
  // of treating it as a non-plan assertion. Without this carve-out,
  // upstream's BASE defaults (`permissionMode: 'default'`) would
  // shadow the global plan mode for every sub-agent that didn't set
  // its own non-default value, breaking the §7.2 ExitPlanMode injection
  // when the user toggled the main chat into plan mode.
  if (ctxOverride !== undefined && ctxOverride !== 'default') {
    return ctxOverride === 'plan'
  }
  if (agentDef.permissionMode !== undefined && agentDef.permissionMode !== 'default') {
    return agentDef.permissionMode === 'plan'
  }
  return getPermissionMode() === 'plan'
}

/**
 * Strip tools every sub-agent must not hold (upstream §7.1). Coordinator / Debug use explicit
 * curated allowlists and are exempt; MCP tools are never removed here.
 */
function applyGlobalSubagentDenylist(
  tools: Tool[],
  agentDef: AgentDefinitionUnion,
): Tool[] {
  if (EXEMPT_FROM_GLOBAL_SUBAGENT_DENY.has(agentDef.agentType)) {
    return tools
  }
  // BUG-H1 fix: same rationale as `injectExitPlanModeInPlanPermission`.
  const planMode = isPlanModeForSubAgent(agentDef)
  const deny = new Set(ALL_AGENT_DISALLOWED_TOOLS)
  if (agentDef.subagentToolProfile === 'in_process_teammate') {
    deny.delete('Agent')
  }
  if (planMode) {
    deny.delete('ExitPlanMode')
  }
  return tools.filter((t) => {
    if (t.name.startsWith('mcp__')) return true
    return !deny.has(t.name)
  })
}

/**
 * Convert filtered tools to API definitions (ToolDefinition format).
 */
export function toolsToApiDefinitions(tools: Tool[]): ToolDefinition[] {
  return tools.map(tool => {
    const toolProps: Record<string, Record<string, unknown>> = {}
    const toolRequired: string[] = []

    for (const param of tool.inputSchema) {
      const propDef: Record<string, unknown> = {
        type: param.type,
        description: param.description,
        ...(param.enum && { enum: param.enum }),
        ...(param.default !== undefined && { default: param.default }),
        ...(param.items && { items: param.items }),
        ...(param.properties && { properties: param.properties }),
      }
      toolProps[param.name] = propDef
      if (param.required) {
        toolRequired.push(param.name)
      }
    }

    return {
      name: tool.name,
      description: tool.description,
      input_schema: {
        type: 'object' as const,
        properties: toolProps,
        required: toolRequired,
      },
    } as ToolDefinition
  })
}

const INTERACTIVE_TOOL_NAMES = new Set([
  'EnterPlanMode',
  'ExitPlanMode',
  'AskUserQuestion',
])
