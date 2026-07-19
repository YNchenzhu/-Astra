/**
 * upstream §6 — Agent-scoped durable memory (user / project / local).
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseFrontmatter } from './storage'
import type { MemoryFrontmatter } from './types'
export type AgentMemoryScope = 'user' | 'project' | 'local'

/** Windows-safe agent type for paths (colon → dash). */
export function sanitizeAgentTypeForPath(agentType: string): string {
  return agentType.trim().replace(/:/g, '-').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 64) || 'agent'
}

export function getAgentMemoryDir(
  scope: AgentMemoryScope,
  agentType: string,
  workspacePath: string | null | undefined,
): string | null {
  const safe = sanitizeAgentTypeForPath(agentType)
  if (scope === 'user') {
    return path.join(os.homedir(), '.claude', 'agent-memory', safe)
  }
  if (!workspacePath?.trim()) return null
  const ws = workspacePath.trim()
  if (scope === 'project') {
    return path.join(ws, '.claude', 'agent-memory', safe)
  }
  return path.join(ws, '.claude', 'agent-memory-local', safe)
}

export function isAgentMemoryPath(
  filePath: string,
  workspacePath: string | null | undefined,
): boolean {
  const abs = path.normalize(path.resolve(filePath))
  const home = path.normalize(path.join(os.homedir(), '.claude', 'agent-memory'))
  if (abs.startsWith(home + path.sep) || abs === home) return true
  if (!workspacePath?.trim()) return false
  const ws = path.normalize(workspacePath.trim())
  const proj = path.join(ws, '.claude', 'agent-memory')
  const loc = path.join(ws, '.claude', 'agent-memory-local')
  return (
    abs.startsWith(path.normalize(proj) + path.sep) ||
    abs === path.normalize(proj) ||
    abs.startsWith(path.normalize(loc) + path.sep) ||
    abs === path.normalize(loc)
  )
}

function readMdFilesInDir(dir: string, maxFiles: number): string[] {
  if (!fs.existsSync(dir)) return []
  const names = fs.readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md')
  const out: string[] = []
  for (const n of names.slice(0, maxFiles)) {
    try {
      const raw = fs.readFileSync(path.join(dir, n), 'utf8')
      out.push(raw)
    } catch {
      /* skip */
    }
  }
  return out
}

/**
 * Build a prompt fragment from agent memory dirs (non-fork sub-agents).
 *
 * `preferredScope` 对应 `agentDef.memory`(user / project / local)。
 *   - **已声明时**:只从对应 scope 读记忆,防止隐式跨域污染(例如:一个 user
 *     scope 的记录,不会意外被 project scope 的 agent 读到)。
 *   - **未声明时**:保持旧行为,扫 user / project / local 三个 scope,
 *     便于向后兼容那些没设 `memory` 字段的自定义 / 内置 agent。
 */
export function buildAgentMemoryPromptAppend(
  agentType: string,
  workspacePath: string | null | undefined,
  preferredScope?: AgentMemoryScope,
): string {
  const parts: string[] = []
  const scopes: AgentMemoryScope[] = preferredScope
    ? [preferredScope]
    : ['user', 'project', 'local']
  for (const scope of scopes) {
    const dir = getAgentMemoryDir(scope, agentType, workspacePath)
    if (!dir) continue
    const bodies = readMdFilesInDir(dir, 12)
    if (bodies.length === 0) continue
    parts.push(`### Agent memory (${scope} / ${agentType})`)
    for (const raw of bodies) {
      const parsed = parseFrontmatter(raw)
      if (!parsed) {
        parts.push(raw.slice(0, 2000))
        continue
      }
      const fm = parsed.frontmatter as MemoryFrontmatter
      parts.push(`#### ${fm.name} [${fm.type}]`)
      parts.push(parsed.content.slice(0, 3000))
    }
  }
  if (parts.length === 0) return ''
  return ['## Sub-agent persistent memory', '', ...parts].join('\n')
}
