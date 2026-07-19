/**
 * Backs the Settings → Agents panel IPC endpoints:
 * - `agents:list-all` — scan every scope dir + expose `sourceScope / sourcePath / extraDirIndex`
 *   so the panel can render scope badges, edit-in-place, and delete buttons.
 * - `agents:save-to-disk` / `agents:delete-from-disk` — materialize / remove `.md`
 *   files inside a *known* scope directory only (defense-in-depth path check).
 *
 * The reader re-uses {@link parseAgentFromMarkdown} so disk-loaded agents in
 * the panel are identical to what {@link rebuildAgentDefinitions} sees — no
 * separate parser drift.
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { app } from 'electron'
import { writeFileAtomicUtf8 } from '../fs/atomicWrite'
import {
  parseAgentFromMarkdown,
  PROJECT_AGENT_DIR_RELATIVE_PATHS,
} from './customAgents'
import type { CustomAgentDefinition } from './types'

export type AgentScope = 'user-global' | 'user-app' | 'project' | 'extra'

export interface ScopeDirsSnapshot {
  userGlobal: string
  userApp: string | null
  project: string | null
  extra: string[]
}

export interface DiskAgentPanelInfo {
  agentType: string
  source: 'custom'
  sourceScope: AgentScope
  sourcePath: string
  extraDirIndex?: number
  whenToUse: string
  capability?: string
  model?: string
  tools?: string[]
  disallowedTools?: string[]
  isReadOnly?: boolean
  maxTurns?: number
  timeout?: number
  thinkingBudgetTokens?: number
  prompt?: string
  filename?: string
}

function userGlobalAgentsDir(): string {
  return path.join(os.homedir(), '.claude', 'agents')
}

function userAppAgentsDir(userDataPath: string | null | undefined): string | null {
  if (!userDataPath) return null
  return path.join(userDataPath, 'agents')
}

function projectAgentsDir(workspacePath: string | null | undefined): string | null {
  if (!workspacePath) return null
  // Mirror the *primary* scan path used by loadProjectScopedAgents so the
  // panel's "project" scope always writes into the same dir that gets picked
  // up on reload. `.cursor/agents/` is only read, never written by the panel.
  return path.join(workspacePath, PROJECT_AGENT_DIR_RELATIVE_PATHS[0])
}

export function computeScopeDirs(opts: {
  workspacePath: string | null | undefined
  userDataPath: string | null | undefined
  extraDirs: readonly string[]
}): ScopeDirsSnapshot {
  return {
    userGlobal: userGlobalAgentsDir(),
    userApp: userAppAgentsDir(opts.userDataPath),
    project: projectAgentsDir(opts.workspacePath),
    extra: (opts.extraDirs || []).map((d) => path.normalize(d)),
  }
}

function scanDir(dirPath: string): Array<{ filePath: string; def: CustomAgentDefinition }> {
  const out: Array<{ filePath: string; def: CustomAgentDefinition }> = []
  if (!dirPath || !fs.existsSync(dirPath)) return out
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue
    const fullPath = path.join(dirPath, entry.name)
    try {
      const content = fs.readFileSync(fullPath, 'utf-8')
      const def = parseAgentFromMarkdown(fullPath, content)
      if (def) out.push({ filePath: fullPath, def })
    } catch {
      // skip unreadable
    }
  }
  return out
}

function defToPanelInfo(
  def: CustomAgentDefinition,
  filePath: string,
  scope: AgentScope,
  extraDirIndex?: number,
): DiskAgentPanelInfo {
  // `getSystemPrompt()` in parseAgentFromMarkdown returns the markdown body.
  let prompt: string | undefined
  try {
    prompt = typeof def.getSystemPrompt === 'function' ? def.getSystemPrompt() : undefined
  } catch {
    prompt = undefined
  }
  return {
    agentType: def.agentType,
    source: 'custom',
    sourceScope: scope,
    sourcePath: filePath,
    extraDirIndex,
    whenToUse: typeof def.whenToUse === 'string' ? def.whenToUse : '',
    capability: (def as { capability?: string }).capability,
    model: def.model,
    tools: Array.isArray(def.tools) ? def.tools : undefined,
    disallowedTools: Array.isArray(def.disallowedTools) ? def.disallowedTools : undefined,
    isReadOnly: def.isReadOnly,
    maxTurns: def.maxTurns,
    timeout: def.timeout,
    thinkingBudgetTokens: def.thinkingBudgetTokens,
    prompt,
    filename: def.filename,
  }
}

/**
 * Scan every scope dir and return a flat list with scope badges. Duplicates
 * across scopes are kept — the panel dedupes visually; resolution for the
 * Agent tool happens inside {@link mergeLayeredAgentDefinitions}.
 */
export function listAllDiskAgentsForPanel(opts: {
  workspacePath: string | null | undefined
  userDataPath: string | null | undefined
  extraDirs: readonly string[]
}): { agents: DiskAgentPanelInfo[]; scopeDirs: ScopeDirsSnapshot } {
  const scopeDirs = computeScopeDirs(opts)
  const agents: DiskAgentPanelInfo[] = []

  for (const { filePath, def } of scanDir(scopeDirs.userGlobal)) {
    agents.push(defToPanelInfo(def, filePath, 'user-global'))
  }
  if (scopeDirs.userApp) {
    for (const { filePath, def } of scanDir(scopeDirs.userApp)) {
      agents.push(defToPanelInfo(def, filePath, 'user-app'))
    }
  }
  if (scopeDirs.project) {
    for (const { filePath, def } of scanDir(scopeDirs.project)) {
      agents.push(defToPanelInfo(def, filePath, 'project'))
    }
  }
  scopeDirs.extra.forEach((dir, idx) => {
    for (const { filePath, def } of scanDir(dir)) {
      agents.push(defToPanelInfo(def, filePath, 'extra', idx))
    }
  })

  return { agents, scopeDirs }
}

// ========== Save / Delete ==========

function sanitizeAgentTypeForFilename(s: string): string {
  // Keep ASCII letters / digits / dash / underscore / dot. Replace the rest
  // with `-`. We still assert non-empty after trimming trailing separators
  // so callers can't sneak path traversal in via encoded forms.
  const cleaned = s
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return cleaned
}

function yamlEscapeScalar(raw: string): string {
  // Keep it simple: if it has YAML-special chars, wrap in double quotes and
  // escape `\` and `"`. Multiline strings are passed through `|`.
  if (raw.includes('\n')) {
    const lines = raw.split('\n').map((l) => `  ${l}`).join('\n')
    return `|\n${lines}`
  }
  if (/[:#&*!|>'"%@`[\]{},]/.test(raw) || raw.trim() !== raw) {
    return `"${raw.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  }
  return raw
}

function buildMarkdownForAgent(agent: {
  agentType: string
  description?: string
  capability?: string
  tools?: string[]
  disallowedTools?: string[]
  model?: string
  prompt: string
  maxTurns?: number
  timeout?: number
  thinkingBudgetTokens?: number
}): string {
  const fm: string[] = []
  fm.push(`name: ${yamlEscapeScalar(agent.agentType)}`)
  if (agent.description && agent.description.trim()) {
    fm.push(`description: ${yamlEscapeScalar(agent.description.trim())}`)
  }
  if (agent.capability && agent.capability.trim()) {
    fm.push(`capability: ${yamlEscapeScalar(agent.capability.trim())}`)
  }
  if (agent.model && agent.model.trim()) {
    fm.push(`model: ${yamlEscapeScalar(agent.model.trim())}`)
  }
  if (agent.tools && agent.tools.length > 0) {
    fm.push('tools:')
    for (const t of agent.tools) fm.push(`  - ${yamlEscapeScalar(t)}`)
  }
  if (agent.disallowedTools && agent.disallowedTools.length > 0) {
    fm.push('disallowedTools:')
    for (const t of agent.disallowedTools) fm.push(`  - ${yamlEscapeScalar(t)}`)
  }
  if (typeof agent.maxTurns === 'number') fm.push(`maxTurns: ${agent.maxTurns}`)
  if (typeof agent.timeout === 'number') fm.push(`timeout: ${agent.timeout}`)
  if (typeof agent.thinkingBudgetTokens === 'number') {
    fm.push(`thinkingBudgetTokens: ${agent.thinkingBudgetTokens}`)
  }
  return `---\n${fm.join('\n')}\n---\n${agent.prompt.trim()}\n`
}

/**
 * Resolve the destination directory for a `saveToDisk` call. Rejects scopes
 * whose underlying dir isn't usable (no workspace / no extra dir registered).
 */
export function resolveScopeTargetDir(
  scope: AgentScope,
  opts: {
    workspacePath: string | null | undefined
    userDataPath: string | null | undefined
    extraDirs: readonly string[]
    extraDirIndex?: number
  },
): { ok: true; dir: string } | { ok: false; error: string } {
  const scopeDirs = computeScopeDirs(opts)
  switch (scope) {
    case 'user-global':
      return { ok: true, dir: scopeDirs.userGlobal }
    case 'user-app':
      if (!scopeDirs.userApp) return { ok: false, error: 'userData path unavailable' }
      return { ok: true, dir: scopeDirs.userApp }
    case 'project':
      if (!scopeDirs.project) return { ok: false, error: '当前没有打开工作区，无法保存到项目级目录' }
      return { ok: true, dir: scopeDirs.project }
    case 'extra': {
      const idx = typeof opts.extraDirIndex === 'number' ? opts.extraDirIndex : 0
      const dir = scopeDirs.extra[idx]
      if (!dir) return { ok: false, error: '所选的额外目录不存在' }
      return { ok: true, dir }
    }
    default:
      return { ok: false, error: `unknown scope: ${String(scope)}` }
  }
}

export function saveAgentMarkdown(params: {
  scope: AgentScope
  extraDirIndex?: number
  agent: Parameters<typeof buildMarkdownForAgent>[0]
  opts: {
    workspacePath: string | null | undefined
    userDataPath: string | null | undefined
    extraDirs: readonly string[]
  }
}): { success: true; sourcePath: string; filePath: string } | { success: false; error: string } {
  const resolved = resolveScopeTargetDir(params.scope, {
    ...params.opts,
    extraDirIndex: params.extraDirIndex,
  })
  if (!resolved.ok) return { success: false, error: resolved.error }

  const filename = sanitizeAgentTypeForFilename(params.agent.agentType)
  if (!filename) return { success: false, error: '智能体名无效，请使用字母/数字/._-' }

  const targetPath = path.join(resolved.dir, `${filename}.md`)
  // Defense in depth: the joined path MUST still live under the resolved dir.
  const normTarget = path.resolve(targetPath)
  const normDir = path.resolve(resolved.dir)
  if (!normTarget.startsWith(normDir + path.sep) && normTarget !== normDir) {
    return { success: false, error: '非法路径' }
  }

  try {
    fs.mkdirSync(resolved.dir, { recursive: true })
    const content = buildMarkdownForAgent(params.agent)
    writeFileAtomicUtf8(targetPath, content)
    return { success: true, sourcePath: targetPath, filePath: targetPath }
  } catch (e) {
    return {
      success: false,
      error: e instanceof Error ? e.message : 'unknown write error',
    }
  }
}

/**
 * Delete a disk-backed agent `.md` file. Only allowed when the path falls
 * inside one of the known scope directories — prevents the renderer from
 * unlinking arbitrary files via this IPC.
 */
export function deleteAgentMarkdown(
  sourcePath: string,
  opts: {
    workspacePath: string | null | undefined
    userDataPath: string | null | undefined
    extraDirs: readonly string[]
  },
): { success: boolean; error?: string } {
  if (!sourcePath || typeof sourcePath !== 'string') {
    return { success: false, error: 'missing sourcePath' }
  }
  const normTarget = path.resolve(sourcePath)
  if (!normTarget.endsWith('.md')) {
    return { success: false, error: '只允许删除 .md 文件' }
  }

  const scopeDirs = computeScopeDirs(opts)
  const allowedDirs = [
    scopeDirs.userGlobal,
    scopeDirs.userApp,
    scopeDirs.project,
    ...scopeDirs.extra,
  ].filter((d): d is string => typeof d === 'string' && d.length > 0)

  const insideAllowed = allowedDirs.some((dir) => {
    const nd = path.resolve(dir)
    return normTarget.startsWith(nd + path.sep)
  })
  if (!insideAllowed) {
    return { success: false, error: '拒绝删除：路径不在允许的 agent 目录内' }
  }

  if (!fs.existsSync(normTarget)) {
    // Idempotent: already gone is fine.
    return { success: true }
  }
  try {
    fs.unlinkSync(normTarget)
    return { success: true }
  } catch (e) {
    return {
      success: false,
      error: e instanceof Error ? e.message : 'unknown delete error',
    }
  }
}

/** Small helper so callers can resolve the app userData path lazily. */
export function getAppUserDataPath(): string | null {
  try {
    return app.getPath('userData')
  } catch {
    return null
  }
}
