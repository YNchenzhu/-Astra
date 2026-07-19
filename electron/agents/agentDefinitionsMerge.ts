/**
 * upstream-style agent definition layering (§2.3): later layers override `agentType`,
 * except built-in types are only replaced by **flag** or **policy** env JSON.
 */

import type { AgentDefinitionUnion, BuiltInAgentDefinition } from './types'
import { safeParseAgentsJsonFile } from './agentDefinitionSchema'

function parseEnvAgentsLayer(
  envName: string,
  source: 'custom' | 'plugin',
  defaultPluginName: string,
): AgentDefinitionUnion[] {
  const raw = process.env[envName]?.trim()
  if (!raw) return []
  try {
    const data = JSON.parse(raw) as unknown
    const parsed = safeParseAgentsJsonFile(data, source, defaultPluginName)
    if (!parsed.ok) {
      console.warn(`[agentDefinitionsMerge] ${envName}: ${parsed.error}`)
      return []
    }
    return parsed.agents
  } catch (e) {
    console.warn(`[agentDefinitionsMerge] ${envName}: invalid JSON`, e)
    return []
  }
}

function isBuiltInEntry(map: Map<string, AgentDefinitionUnion>, agentType: string): boolean {
  return map.get(agentType)?.source === 'built-in'
}

/**
 * Built-in agentTypes that operate under a hard runtime sandbox (path
 * gating, fixed tool surface, etc.). Even Flag / Policy env layers — which
 * normally win against built-ins via `force:true` — must NOT be allowed to
 * replace these slots, since a permissive replacement would silently bypass
 * the sandbox the rest of the codebase still trusts (e.g.
 * `gateSessionMemoryInternalAgentToolUse` in
 * `electron/tools/fileToolValidation.ts` keys off `agentType ===
 * 'session-memory-internal'`). Replacement attempts are logged and ignored.
 */
const PROTECTED_BUILTIN_AGENT_TYPES: ReadonlySet<string> = new Set([
  'session-memory-internal',
])

/** Apply agents; do not replace a built-in slot unless {@link force} is true. */
function overlayAgents(
  map: Map<string, AgentDefinitionUnion>,
  agents: AgentDefinitionUnion[],
  force: boolean,
): void {
  for (const a of agents) {
    if (!force && isBuiltInEntry(map, a.agentType)) continue
    if (
      force &&
      isBuiltInEntry(map, a.agentType) &&
      PROTECTED_BUILTIN_AGENT_TYPES.has(a.agentType)
    ) {
      console.warn(
        `[agentDefinitionsMerge] Refusing to replace protected built-in agent "${a.agentType}" via env layer; sandbox slot retained.`,
      )
      continue
    }
    map.set(a.agentType, a)
  }
}

/**
 * Merge order (each step may override prior for the same `agentType`):
 * built-in → plugin (env) → **plugin (disk)** → user disk → project disk → renderer snapshot → **bundle (active)** → flag (env) → policy (env).
 *
 * `bundle` 层对应 Workbench Bundle 里定义的 agents,随激活 Bundle 切换
 * 而热插拔。由于 `force: false`,内置 agentType 仍然保留 built-in 实现
 * (Bundle 里的 `general-purpose` 只当 meta 覆盖,不替代内置 prompt)。
 */
export function mergeLayeredAgentDefinitions(params: {
  builtIn: BuiltInAgentDefinition[]
  pluginEnv: AgentDefinitionUnion[]
  /** §2.2 — agents from `plugin/.claude/agents` under each workspace plugin manifest. */
  pluginDisk: AgentDefinitionUnion[]
  userDisk: AgentDefinitionUnion[]
  projectDisk: AgentDefinitionUnion[]
  renderer: AgentDefinitionUnion[]
  /** Agents in the currently active Bundle (from `bundleAgentsToDefinitions`). */
  bundle?: AgentDefinitionUnion[]
  flagEnv: AgentDefinitionUnion[]
  policyEnv: AgentDefinitionUnion[]
}): AgentDefinitionUnion[] {
  const map = new Map<string, AgentDefinitionUnion>()
  overlayAgents(map, params.builtIn, true)
  overlayAgents(map, params.pluginEnv, false)
  overlayAgents(map, params.pluginDisk, false)
  overlayAgents(map, params.userDisk, false)
  overlayAgents(map, params.projectDisk, false)
  overlayAgents(map, params.renderer, false)
  overlayAgents(map, params.bundle ?? [], false)
  overlayAgents(map, params.flagEnv, true)
  overlayAgents(map, params.policyEnv, true)
  return [...map.values()]
}

export function loadPluginAgentsFromEnv(): AgentDefinitionUnion[] {
  return parseEnvAgentsLayer('ASTRA_PLUGIN_AGENTS_JSON', 'plugin', 'env-plugin')
}

export function loadFlagAgentsFromEnv(): AgentDefinitionUnion[] {
  return parseEnvAgentsLayer('ASTRA_FLAG_AGENTS_JSON', 'custom', '')
}

export function loadPolicyAgentsFromEnv(): AgentDefinitionUnion[] {
  return parseEnvAgentsLayer('ASTRA_POLICY_AGENTS_JSON', 'custom', '')
}

/**
 * Resume path: re-resolve by type; if the type disappeared from disk, fall back to built-in general-purpose.
 */
export function resolveAgentDefinitionForResume(
  agentType: string,
  allAgents: AgentDefinitionUnion[],
): AgentDefinitionUnion | undefined {
  const direct = allAgents.find((a) => a.agentType === agentType)
  if (direct) return direct
  const gpBuiltIn = allAgents.find((a) => a.agentType === 'general-purpose' && a.source === 'built-in')
  if (gpBuiltIn) return gpBuiltIn
  return allAgents.find((a) => a.agentType === 'general-purpose')
}
