/**
 * Agent-tool registration and custom-agent lifecycle.
 *
 * Kept separate from the core ToolRegistry so the registry file stays small.
 */

import { createAgentTool } from '../agents/agentTool'
import { sendMessageTool } from '../agents/sendMessageTool'
import { getBuiltInAgents } from '../agents/builtInAgents'
import { loadProjectScopedAgents, loadUserScopedAgents } from '../agents/customAgents'
import { safeParseCustomAgentJsonRecord } from '../agents/agentDefinitionSchema'
import {
  loadFlagAgentsFromEnv,
  loadPluginAgentsFromEnv,
  loadPolicyAgentsFromEnv,
  mergeLayeredAgentDefinitions,
} from '../agents/agentDefinitionsMerge'
import { loadBundledPluginAgentsFromWorkspace } from '../agents/pluginAgentsLoader'
import { getActiveBundle } from '../agents/bundles/bundleRegistry'
import { bundleAgentsToDefinitions } from '../agents/bundles/bundleAgentsBridge'
import type {
  AgentDefinitionUnion,
  AgentDefinitionPermissionMode,
  AgentIsolationMode,
  AgentMemoryScope,
  CustomAgentDefinition,
} from '../agents/types'
import { enterPlanModeTool } from './EnterPlanModeTool'
import { exitPlanModeTool } from './ExitPlanModeTool'
import { verifyPlanExecutionTool } from './VerifyPlanExecutionTool'
import { askUserQuestionTool } from './AskUserQuestionTool'
import { todoWriteTool } from './TodoWriteTool'
import { notebookEditTool } from './NotebookEditTool'
import { configTool } from './ConfigTool'
import { toolSearchTool } from './ToolSearchTool'
import { briefTool } from './BriefTool'
import { taskListTool } from './TaskListTool'
import { taskCreateTool } from './TaskCreateTool'
import { taskGetTool } from './TaskGetTool'
import { taskUpdateTool } from './TaskUpdateTool'
import { taskStopTool } from './TaskStopTool'
import { killAllTasksTool } from './KillAllTasksTool'
import { killAgentTasksTool } from './KillAgentTasksTool'
import { teamCreateTool, teamStatusTool } from './TeamCreateTool'
import { teamDeleteTool } from './TeamDeleteTool'
import { lspTool } from './LSPTool'
import { taskOutputTool } from './TaskOutputTool'
import { skillTool } from '../skills/skillTool'
import { discoverSkillsTool } from '../skills/skillDiscovery'
import { enterWorktreeTool } from './EnterWorktreeTool'
import { exitWorktreeTool } from './ExitWorktreeTool'
import { cronCreateTool, cronDeleteTool, cronListTool } from './CronTools'
import { remoteTriggerTool } from './RemoteTriggerTool'
import { replTool } from './REPLTool'
import { awaySummaryTool } from './AwaySummaryTool'
import { magicDocsTool } from './MagicDocsTool'
import { promptSuggestionTool } from './PromptSuggestionTool'
import { teamMemorySyncTool } from './TeamMemorySyncTool'
import { testingPermissionTool } from './TestingPermissionTool'
import { swarmMultiplexerTool } from './SwarmMultiplexerTool'
import { readDiagnosticsTool } from './ReadDiagnosticsTool'
import { spawnTeammateTool } from './SpawnTeammateTool'
import { memdirScanTool } from './MemdirScanTool'
import { toolRegistry } from './registry'
let allAgentsCache: AgentDefinitionUnion[] = []

/**
 * Settings UI / renderer sync: custom agents before next {@link rebuildAgentDefinitions}.
 *
 * This shape mirrors {@link AgentDefinition} fields that a user can reasonably
 * configure from the Settings UI. Filesystem-based agents (`.claude/agents/`,
 * `.cursor/agents/`) can declare every field {@link agentJsonRecordZod}
 * accepts; the renderer snapshot extends that surface with the same fields so
 * users don't need to switch to a text editor for advanced options.
 *
 * Any field omitted here falls back to the agent's defaults. All optional
 * fields are passed through to {@link safeParseCustomAgentJsonRecord} which
 * validates + normalises them the same way as on-disk agents.
 */
export interface RendererCustomAgentSnapshot {
  id: string
  name: string
  description: string
  /**
   * Optional "功能是..." slot filled by the Settings custom-agent form. When
   * present, it is appended to the Agent tool prompt listing so the router
   * sees a sharper capability hint alongside `whenToUse`.
   */
  capability?: string
  /** upstream `whenToUse` — when set, overrides `description` for routing. */
  whenToUse?: string
  prompt: string
  tools?: unknown
  disallowedTools?: unknown
  model?: string
  maxTurns?: number
  timeout?: number
  thinkingBudgetTokens?: number
  mcpServers?: string[]
  skills?: string[]
  effort?: string | number
  permissionMode?: AgentDefinitionPermissionMode
  initialPrompt?: string
  memory?: AgentMemoryScope
  isolation?: AgentIsolationMode
  omitClaudeMd?: boolean
  background?: boolean
  color?: string
  // ── Parity extensions so renderer UI can fully configure an agent ───
  /**
   * Per-agent hooks — same payload as filesystem `hooks:` frontmatter, passes
   * through {@link parseAgentHooksField}. Either a JSON string or an array of
   * hook specs is accepted (UI typically stores a JSON string).
   */
  hooks?: string | unknown[]
  /** Read-only hint — UI checkbox. Gates destructive tools during permission resolution. */
  isReadOnly?: boolean
  /** Per-run token ceiling (input+output). Enforced in `subAgentRunner`. */
  maxTokenBudget?: number
  /** Parent-isolation vs parent transcript. `inherit` / `restricted` / `isolated`. */
  parentPolicy?: 'inherit' | 'restricted' | 'isolated'
  /** Curated tool-surface profile — e.g. `async_agent` narrows `*` to the read/write set. */
  subagentToolProfile?: 'default' | 'async_agent' | 'in_process_teammate'
  /**
   * Path B — explicit orchestration role declared by the user, drives the
   * runtime contract appendix ({@link buildOrchestrationContractAppend}).
   */
  orchestrationRole?: 'solo' | 'readonly-worker' | 'writing-worker' | 'coordinator' | 'verifier'
  /** Verbatim banner prepended to the agent's body prompt. */
  criticalReminder?: string
}

let rendererCustomAgentsSnapshot: RendererCustomAgentSnapshot[] = []

export function setRendererCustomAgentsSnapshot(snapshot: RendererCustomAgentSnapshot[]): void {
  rendererCustomAgentsSnapshot = Array.isArray(snapshot) ? snapshot.map((s) => ({ ...s })) : []
}

/**
 * Set of custom agent types (`agentType`) the user has hidden from the main
 * AI via the Settings panel. Built-in agents are never filterable — they are
 * part of the product surface.
 *
 * Hidden agents are still fully registered and spawnable; only the Agent
 * tool's *description* (the routing prompt seen by the main AI) omits them.
 * This way existing conversations / team mailboxes referencing a hidden
 * agent keep working.
 */
let disabledCustomAgentTypes: Set<string> = new Set()

export function setDisabledCustomAgentTypes(names: readonly string[]): void {
  disabledCustomAgentTypes = new Set(
    (names ?? [])
      .filter((n): n is string => typeof n === 'string' && n.trim().length > 0)
      .map((n) => n.trim()),
  )
}

export function getDisabledCustomAgentTypes(): string[] {
  return [...disabledCustomAgentTypes]
}

/** Filter the Agent tool's routing listing; built-in agents are never hidden. */
function visibleAgentsForMainPrompt(): AgentDefinitionUnion[] {
  let visible = allAgentsCache
  if (disabledCustomAgentTypes.size > 0) {
    visible = visible.filter(
      (a) => a.source === 'built-in' || !disabledCustomAgentTypes.has(a.agentType),
    )
  }
  // session-memory-internal is an implementation detail — never exposed to the
  // main AI as a spawnable agent type (it is launched by the host directly).
  return visible.filter((a) => a.agentType !== 'session-memory-internal')
}

/**
 * Rebuild {@link allAgentsCache} from disk + renderer snapshot and refresh the Agent tool.
 * Pass workspace/user paths like {@link initAgentTools} (null/undefined skips disk roots).
 */
export function rebuildAgentDefinitions(
  workspacePath: string | null | undefined,
  userDataPath: string | null | undefined,
  agentStoragePath?: string | null,
): void {
  const builtIn = getBuiltInAgents()
  const pluginEnv = loadPluginAgentsFromEnv()
  const pluginDisk = loadBundledPluginAgentsFromWorkspace(workspacePath ?? null)
  const userDisk = loadUserScopedAgents(userDataPath ?? undefined)
  const projectDisk = loadProjectScopedAgents(
    workspacePath ?? undefined,
    agentStoragePath ?? undefined,
    userDataPath ?? undefined,
  )

  const builtInTypes = new Set(builtIn.map((a) => a.agentType))
  const seenRendererNames = new Set<string>()
  const fromRenderer: CustomAgentDefinition[] = []
  for (const row of rendererCustomAgentsSnapshot) {
    const displayName = typeof row.name === 'string' ? row.name.trim() : ''
    if (!displayName) continue
    if (builtInTypes.has(displayName)) continue
    if (seenRendererNames.has(displayName)) continue
    seenRendererNames.add(displayName)
    const prompt = typeof row.prompt === 'string' ? row.prompt : ''
    const description = typeof row.description === 'string' ? row.description : ''
    if (!prompt.trim()) continue

    const extra: Record<string, unknown> = {
      description,
      prompt,
    }
    if (row.whenToUse !== undefined) extra.whenToUse = row.whenToUse
    if (row.capability !== undefined) extra.capability = row.capability
    if (row.tools !== undefined) extra.tools = row.tools
    if (row.disallowedTools !== undefined) extra.disallowedTools = row.disallowedTools
    if (row.model !== undefined) extra.model = row.model
    if (row.maxTurns !== undefined) extra.maxTurns = row.maxTurns
    if (row.timeout !== undefined) extra.timeout = row.timeout
    if (row.thinkingBudgetTokens !== undefined) extra.thinkingBudgetTokens = row.thinkingBudgetTokens
    if (row.mcpServers !== undefined) extra.mcpServers = row.mcpServers
    if (row.skills !== undefined) extra.skills = row.skills
    if (row.effort !== undefined) extra.effort = row.effort
    if (row.permissionMode !== undefined) extra.permissionMode = row.permissionMode
    if (row.initialPrompt !== undefined) extra.initialPrompt = row.initialPrompt
    if (row.memory !== undefined) extra.memory = row.memory
    if (row.isolation !== undefined) extra.isolation = row.isolation
    if (row.omitClaudeMd !== undefined) extra.omitClaudeMd = row.omitClaudeMd
    if (row.background !== undefined) extra.background = row.background
    if (row.color !== undefined) extra.color = row.color
    // Parity extensions (advanced fields previously only settable via filesystem frontmatter).
    if (row.hooks !== undefined) extra.hooks = row.hooks
    if (row.isReadOnly !== undefined) extra.isReadOnly = row.isReadOnly
    if (row.maxTokenBudget !== undefined) extra.maxTokenBudget = row.maxTokenBudget
    if (row.parentPolicy !== undefined) extra.parentPolicy = row.parentPolicy
    if (row.subagentToolProfile !== undefined) extra.subagentToolProfile = row.subagentToolProfile
    if (row.orchestrationRole !== undefined) extra.orchestrationRole = row.orchestrationRole
    if (row.criticalReminder !== undefined) extra.criticalReminder = row.criticalReminder

    const parsed = safeParseCustomAgentJsonRecord(displayName, extra)
    if (parsed.ok) {
      fromRenderer.push(parsed.def)
    } else {
      const whenToUse =
        description.trim() ||
        prompt
          .split('\n')
          .find((l) => l.trim())
          ?.trim() ||
        displayName
      fromRenderer.push({
        source: 'custom',
        agentType: displayName,
        whenToUse,
        getSystemPrompt: () => prompt,
        ...(typeof row.maxTurns === 'number' ? { maxTurns: row.maxTurns } : {}),
        ...(typeof row.timeout === 'number' ? { timeout: row.timeout } : {}),
        ...(typeof row.thinkingBudgetTokens === 'number'
          ? { thinkingBudgetTokens: row.thinkingBudgetTokens }
          : {}),
      })
    }
  }

  const flagEnv = loadFlagAgentsFromEnv()
  const policyEnv = loadPolicyAgentsFromEnv()
  // Workbench Bundle 层:当前激活 Bundle 里的 agents。切换 Bundle 后
  // `bundleHandlers.activate` 会重新调本函数,让 Agent 工具路由列表
  // 跟着热更新(否则主 AI 永远只看得见内置 + 磁盘 / renderer 老 agents)。
  const bundleAgents = bundleAgentsToDefinitions(getActiveBundle())

  allAgentsCache = mergeLayeredAgentDefinitions({
    builtIn,
    pluginEnv,
    pluginDisk,
    userDisk,
    projectDisk,
    renderer: fromRenderer,
    bundle: bundleAgents,
    flagEnv,
    policyEnv,
  })
  toolRegistry.register(createAgentTool(() => allAgentsCache, visibleAgentsForMainPrompt))
}

/**
 * Initialize agent tools. Call after MCP setup so the full agent list
 * (including custom agents) is available for the Agent tool's description.
 * @param workspacePath - Project workspace directory
 * @param userDataPath - Electron userData directory (for user-level agents)
 */
export function initAgentTools(workspacePath?: string, userDataPath?: string): void {
  rebuildAgentDefinitions(workspacePath ?? null, userDataPath ?? null)

  // Register SendMessage tool
  toolRegistry.register(sendMessageTool)

  // Register plan/ask interaction tools
  toolRegistry.register(enterPlanModeTool)
  toolRegistry.register(exitPlanModeTool)
  toolRegistry.register(verifyPlanExecutionTool)
  toolRegistry.register(askUserQuestionTool)

  // 星构Astra coexist extension: V1 TodoWrite AND V2 Task* are now
  // both registered unconditionally. The previous "register exactly
  // one set, mirror upstream's mutual exclusion" pattern blocked the
  // product design where TodoWrite is the ephemeral in-conversation
  // checklist and Task* is the durable cross-conversation surface.
  //
  // Mode narrowing (`'v1-only'` / `'v2-only'`) is enforced at the
  // `isEnabled()` filter consulted by `toolRegistry.getAll()` —
  // narrowed-out tools stay in the registry but never appear in the
  // model's tool list. This trade-off (always register, gate visibility
  // at read time) is documented in `todoMode.ts` under "Process-level
  // constant" — it means a `settings.todoMode` flip mid-process DOES
  // take effect (unlike the old register-once-and-forget pattern).
  toolRegistry.register(todoWriteTool)
  toolRegistry.register(notebookEditTool)
  toolRegistry.register(configTool)

  // Register tool discovery / user messaging tools
  toolRegistry.register(toolSearchTool)
  toolRegistry.register(briefTool)

  // Register V2 task management tools. Visibility narrows via
  // `isEnabled()` when the deployment forces `'v1-only'`.
  toolRegistry.register(taskListTool)
  toolRegistry.register(taskCreateTool)
  toolRegistry.register(taskGetTool)
  toolRegistry.register(taskUpdateTool)
  toolRegistry.register(taskStopTool)
  toolRegistry.register(killAllTasksTool)
  toolRegistry.register(killAgentTasksTool)

  // Register team (swarm) management tools
  toolRegistry.register(teamCreateTool)
  toolRegistry.register(teamDeleteTool)
  toolRegistry.register(teamStatusTool)
  toolRegistry.register(swarmMultiplexerTool)

  // Register LSP tool
  toolRegistry.register(lspTool)

  // Register task output tool
  toolRegistry.register(taskOutputTool)

  // Register skill tool
  toolRegistry.register(skillTool)
  toolRegistry.register(discoverSkillsTool)

  // Workspace memory scan (deferred; async sub-agents may use — see ASYNC_AGENT_ALLOWED_TOOLS)
  toolRegistry.register(memdirScanTool)

  // Register worktree tools
  toolRegistry.register(enterWorktreeTool)
  toolRegistry.register(exitWorktreeTool)

  toolRegistry.register(cronCreateTool)
  toolRegistry.register(cronListTool)
  toolRegistry.register(cronDeleteTool)
  toolRegistry.register(remoteTriggerTool)
  toolRegistry.register(replTool)

  // Extended tools (AwaySummary, MagicDocs, PromptSuggestion, TeamMemorySync)
  toolRegistry.register(awaySummaryTool)
  toolRegistry.register(magicDocsTool)
  toolRegistry.register(promptSuggestionTool)
  toolRegistry.register(teamMemorySyncTool)

  /** Opt-in tools (plan P1): main registry + renderer policy stay aligned via env. */
  if (isOptionalProductToolEnvEnabled('ASTRA_READ_DIAGNOSTICS')) {
    toolRegistry.register(readDiagnosticsTool)
  }
  if (isOptionalProductToolEnvEnabled('ASTRA_SPAWN_TEAMMATE')) {
    toolRegistry.register(spawnTeammateTool)
  }

  // Register testing tools (non-production only)
  toolRegistry.register(testingPermissionTool)
}

function isOptionalProductToolEnvEnabled(envKey: string): boolean {
  const v = process.env[envKey]?.trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes'
}

/**
 * Get all registered agent definitions (built-in + custom).
 */
export function getAllAgentDefinitions(): AgentDefinitionUnion[] {
  return allAgentsCache
}
