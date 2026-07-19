/**
 * Main-process bridge: Settings UI / renderer custom agents → {@link setRendererCustomAgentsSnapshot} + rebuild.
 */

import fs from 'node:fs'
import path from 'node:path'
import {
  rebuildAgentDefinitions,
  setRendererCustomAgentsSnapshot,
  type RendererCustomAgentSnapshot,
} from '../tools/registry'

export function parseRendererCustomAgentsPayload(raw: unknown): RendererCustomAgentSnapshot[] {
  const list = Array.isArray(raw) ? raw : null
  if (!list) return []

  const out: RendererCustomAgentSnapshot[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const id = typeof o.id === 'string' && o.id.trim() ? o.id.trim() : `renderer-${out.length}`
    const name = typeof o.name === 'string' ? o.name.trim() : ''
    const description = typeof o.description === 'string' ? o.description : ''
    const prompt = typeof o.prompt === 'string' ? o.prompt.trim() : ''
    if (!name || !prompt) continue
    const snap: RendererCustomAgentSnapshot = { id, name, description, prompt }
    if (typeof o.capability === 'string' && o.capability.trim()) {
      snap.capability = o.capability.trim()
    }
    if (typeof o.whenToUse === 'string' && o.whenToUse.trim()) {
      snap.whenToUse = o.whenToUse.trim()
    }
    if (o.tools !== undefined) snap.tools = o.tools
    if (o.disallowedTools !== undefined) snap.disallowedTools = o.disallowedTools
    if (typeof o.model === 'string') snap.model = o.model
    if (typeof o.maxTurns === 'number') snap.maxTurns = o.maxTurns
    if (typeof o.timeout === 'number') snap.timeout = o.timeout
    if (typeof o.thinkingBudgetTokens === 'number') snap.thinkingBudgetTokens = o.thinkingBudgetTokens
    if (Array.isArray(o.mcpServers)) {
      snap.mcpServers = o.mcpServers.map((s) => String(s).trim()).filter(Boolean)
    }
    if (Array.isArray(o.skills)) {
      snap.skills = o.skills.map((s) => String(s).trim()).filter(Boolean)
    }
    if (o.effort !== undefined) snap.effort = o.effort as string | number
    if (typeof o.permissionMode === 'string') {
      snap.permissionMode = o.permissionMode as RendererCustomAgentSnapshot['permissionMode']
    }
    if (typeof o.initialPrompt === 'string') snap.initialPrompt = o.initialPrompt
    if (typeof o.memory === 'string') snap.memory = o.memory as RendererCustomAgentSnapshot['memory']
    if (typeof o.isolation === 'string') snap.isolation = o.isolation as RendererCustomAgentSnapshot['isolation']
    if (typeof o.omitClaudeMd === 'boolean') snap.omitClaudeMd = o.omitClaudeMd
    if (typeof o.background === 'boolean') snap.background = o.background
    if (typeof o.color === 'string') snap.color = o.color
    // Parity extensions — same fields that filesystem frontmatter exposes.
    if (typeof o.hooks === 'string' || Array.isArray(o.hooks)) {
      snap.hooks = o.hooks as RendererCustomAgentSnapshot['hooks']
    }
    if (typeof o.isReadOnly === 'boolean') snap.isReadOnly = o.isReadOnly
    if (typeof o.maxTokenBudget === 'number') snap.maxTokenBudget = o.maxTokenBudget
    if (
      typeof o.parentPolicy === 'string' &&
      (o.parentPolicy === 'inherit' ||
        o.parentPolicy === 'restricted' ||
        o.parentPolicy === 'isolated')
    ) {
      snap.parentPolicy = o.parentPolicy
    }
    if (
      typeof o.subagentToolProfile === 'string' &&
      (o.subagentToolProfile === 'default' ||
        o.subagentToolProfile === 'async_agent' ||
        o.subagentToolProfile === 'in_process_teammate')
    ) {
      snap.subagentToolProfile = o.subagentToolProfile
    }
    if (
      typeof o.orchestrationRole === 'string' &&
      (o.orchestrationRole === 'solo' ||
        o.orchestrationRole === 'readonly-worker' ||
        o.orchestrationRole === 'writing-worker' ||
        o.orchestrationRole === 'coordinator' ||
        o.orchestrationRole === 'verifier')
    ) {
      snap.orchestrationRole = o.orchestrationRole
    }
    if (typeof o.criticalReminder === 'string' && o.criticalReminder.trim()) {
      snap.criticalReminder = o.criticalReminder
    }
    out.push(snap)
  }
  return out
}

export function readPersistedCustomAgentsFile(agentsRootDir: string): RendererCustomAgentSnapshot[] {
  const file = path.join(agentsRootDir, 'custom-agents.json')
  if (!fs.existsSync(file)) return []
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf-8')) as unknown
    return parseRendererCustomAgentsPayload(data)
  } catch {
    return []
  }
}

/**
 * Apply UI custom agents and refresh built-in + disk + renderer merge (re-registers Agent tool).
 */
export function applyRendererCustomAgentsFromMain(
  snapshots: RendererCustomAgentSnapshot[],
  opts: {
    workspacePath?: string | null
    userDataPath?: string | null
    agentStoragePath?: string | null
  },
): void {
  setRendererCustomAgentsSnapshot(snapshots)
  rebuildAgentDefinitions(
    opts.workspacePath ?? null,
    opts.userDataPath ?? null,
    opts.agentStoragePath ?? undefined,
  )
}
