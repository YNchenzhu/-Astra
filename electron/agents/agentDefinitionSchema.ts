/**
 * Zod validation for custom / env / UI agent JSON (upstream AgentJsonSchema parity, AC-2.5).
 */

import { z } from 'zod'
import { normalizeToolsList } from './normalizeToolLists'
import { parseAgentHooksField } from './agentHooksField'
import type { AgentMcpServerRef, CustomAgentDefinition, PluginAgentDefinition } from './types'
import { parseSkillEffort } from '../skills/skillEffort'

const permissionModeZod = z.enum([
  'default',
  'plan',
  'bypassPermissions',
  'acceptEdits',
  'dontAsk',
  'auto',
  'bubble',
])

const memoryZod = z.enum(['user', 'project', 'local'])
const isolationZod = z.enum(['worktree', 'remote'])

const mcpServerEntryZod = z.union([
  z.string(),
  z
    .object({
      name: z.string(),
      config: z.record(z.string(), z.unknown()).optional(),
    })
    .passthrough(),
])

/** One agent entry as in `agents.json` or env keyed JSON. */
export const agentJsonRecordZod = z
  .object({
    description: z.string().optional(),
    whenToUse: z.string().optional(),
    /**
     * "功能是..." slot in the main-AI-facing Agent tool prompt. Optional and
     * orthogonal to `whenToUse` — populated by the Settings panel form so the
     * AI sees a clean three-slot template for custom agents.
     */
    capability: z.string().optional(),
    prompt: z.string(),
    tools: z.unknown().optional(),
    disallowedTools: z.unknown().optional(),
    model: z.string().optional(),
    maxTurns: z.number().optional(),
    mcpServers: z.array(mcpServerEntryZod).optional(),
    hooks: z.union([z.string(), z.array(z.unknown())]).optional(),
    color: z.string().optional(),
    background: z.boolean().optional(),
    skills: z.array(z.string()).optional(),
    effort: z.union([z.string(), z.number()]).optional(),
    permissionMode: permissionModeZod.optional(),
    initialPrompt: z.string().optional(),
    memory: memoryZod.optional(),
    isolation: isolationZod.optional(),
    omitClaudeMd: z.boolean().optional(),
    isReadOnly: z.boolean().optional(),
    maxTokenBudget: z.number().optional(),
    timeout: z.number().optional(),
    thinkingBudgetTokens: z.number().optional(),
    parentPolicy: z.enum(['inherit', 'restricted', 'isolated']).optional(),
    coordinatorPhase: z
      .enum(['research', 'synthesis', 'implementation', 'verification'])
      .optional(),
    subagentToolProfile: z.enum(['default', 'async_agent', 'in_process_teammate']).optional(),
    orchestrationRole: z
      .enum(['solo', 'readonly-worker', 'writing-worker', 'coordinator', 'verifier'])
      .optional(),
    criticalReminder: z.string().optional(),
    pluginName: z.string().optional(),
    /**
     * P1-2 (audit Bug-7 follow-up B7-D) — default tool-scheduling priority
     * for this agent. Forwarded into `AgentContext.priority` at sub-agent
     * spawn so `DefaultToolRuntimePort` / `executeFallbackBatchWithWiring`
     * enqueue tools at the right priority. Match values to `ToolPriority`
     * (10/30/50/70/100); range loose (0-1000) to allow user-defined bands.
     *
     * Without this on the JSON schema, custom + plugin agents couldn't
     * declare BACKGROUND priority and would land at NORMAL by default —
     * defeating the whole cross-agent preemption story for user-authored
     * background agents.
     */
    defaultPriority: z.number().int().min(0).max(1_000).optional(),
  })
  .strip()
  .superRefine((d, ctx) => {
    const w = (d.whenToUse ?? d.description ?? '').trim()
    if (!w) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'description or whenToUse (non-empty) is required',
      })
    }
  })

export type AgentJsonRecordInput = z.infer<typeof agentJsonRecordZod>

function normalizeMcpServersFromZod(
  raw: AgentJsonRecordInput['mcpServers'],
): AgentMcpServerRef[] | undefined {
  if (!raw?.length) return undefined
  const out: AgentMcpServerRef[] = []
  for (const e of raw) {
    if (typeof e === 'string') {
      const s = e.trim()
      if (s) out.push(s)
    } else if (e && typeof e.name === 'string' && e.name.trim()) {
      out.push({
        name: e.name.trim(),
        ...(e.config && typeof e.config === 'object' ? { config: e.config as Record<string, unknown> } : {}),
      })
    }
  }
  return out.length > 0 ? out : undefined
}

function hooksFieldToString(hooks: AgentJsonRecordInput['hooks']): string | undefined {
  if (hooks === undefined) return undefined
  if (typeof hooks === 'string') return hooks.trim() || undefined
  try {
    return JSON.stringify(hooks)
  } catch {
    return undefined
  }
}

function toSharedDefinitionFields(agentType: string, d: AgentJsonRecordInput) {
  const hooksStr = hooksFieldToString(d.hooks)
  return {
    agentType,
    whenToUse: (d.whenToUse ?? d.description ?? '').trim(),
    capability: d.capability?.trim() || undefined,
    tools: normalizeToolsList(d.tools),
    disallowedTools: normalizeToolsList(d.disallowedTools),
    model: d.model?.trim() || 'inherit',
    maxTurns: d.maxTurns,
    mcpServers: normalizeMcpServersFromZod(d.mcpServers),
    agentHooks: hooksStr ? parseAgentHooksField(hooksStr) : undefined,
    color: d.color?.trim() || undefined,
    background: d.background,
    skills: d.skills?.length ? d.skills.map((s) => s.trim()).filter(Boolean) : undefined,
    effort: parseSkillEffort(d.effort),
    permissionMode: d.permissionMode,
    initialPrompt: d.initialPrompt?.trim() || undefined,
    memory: d.memory,
    isolation: d.isolation,
    omitClaudeMd: d.omitClaudeMd,
    isReadOnly: d.isReadOnly,
    maxTokenBudget: d.maxTokenBudget,
    timeout: d.timeout,
    thinkingBudgetTokens: d.thinkingBudgetTokens,
    parentPolicy: d.parentPolicy,
    coordinatorPhase: d.coordinatorPhase,
    subagentToolProfile: d.subagentToolProfile,
    orchestrationRole: d.orchestrationRole,
    criticalReminder: d.criticalReminder?.trim() || undefined,
    // Audit Bug-7 follow-up B7-D — forward through to the AgentDefinition.
    defaultPriority: d.defaultPriority,
    getSystemPrompt: () => d.prompt,
  }
}

export function safeParseCustomAgentJsonRecord(
  agentType: string,
  raw: unknown,
): { ok: true; def: CustomAgentDefinition } | { ok: false; error: string } {
  const r = agentJsonRecordZod.safeParse(raw)
  if (!r.success) {
    return { ok: false, error: r.error.issues.map((i) => i.message).join('; ') }
  }
  return {
    ok: true,
    def: {
      source: 'custom',
      ...toSharedDefinitionFields(agentType, r.data),
    },
  }
}

export function safeParsePluginAgentJsonRecord(
  agentType: string,
  raw: unknown,
  defaultPluginName: string,
): { ok: true; def: PluginAgentDefinition } | { ok: false; error: string } {
  const r = agentJsonRecordZod.safeParse(raw)
  if (!r.success) {
    return { ok: false, error: r.error.issues.map((i) => i.message).join('; ') }
  }
  const pluginName = (r.data.pluginName?.trim() || defaultPluginName).trim() || defaultPluginName
  return {
    ok: true,
    def: {
      source: 'plugin',
      pluginName,
      ...toSharedDefinitionFields(agentType, r.data),
    },
  }
}

/** Validate `agents.json` object: { "agentType": { ... }, ... } */
export function safeParseAgentsJsonFile(
  raw: unknown,
  source: 'custom' | 'plugin',
  defaultPluginName = 'plugin',
): { ok: true; agents: (CustomAgentDefinition | PluginAgentDefinition)[] } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'agents.json root must be an object' }
  }
  const agents: (CustomAgentDefinition | PluginAgentDefinition)[] = []
  for (const [name, def] of Object.entries(raw as Record<string, unknown>)) {
    const key = name.trim()
    if (!key) continue
    const parsed =
      source === 'plugin'
        ? safeParsePluginAgentJsonRecord(key, def, defaultPluginName)
        : safeParseCustomAgentJsonRecord(key, def)
    if (!parsed.ok) {
      return { ok: false, error: `agent "${key}": ${parsed.error}` }
    }
    agents.push(parsed.def)
  }
  return { ok: true, agents }
}
