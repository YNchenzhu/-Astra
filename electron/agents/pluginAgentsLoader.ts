/**
 * upstream report §2.2 / §2.3 — agent definitions shipped inside workspace plugins
 * (`pluginRoot/.claude/agents/*.md` and `agents.json`), merged after env plugin JSON.
 */

import fs from 'node:fs'
import path from 'node:path'
import { listPluginManifestDirs } from '../mcp/pluginMcpIntegration'
import { isPluginBlockedByPolicy } from '../plugins/pluginPolicy'
import { safeParseAgentsJsonFile } from './agentDefinitionSchema'
import type { PluginAgentDefinition } from './types'
import { parseAgentFromMarkdown } from './customAgents'

function loadPluginAgentsFromDir(agentsDir: string, pluginId: string): PluginAgentDefinition[] {
  const agents: PluginAgentDefinition[] = []
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(agentsDir, { withFileTypes: true })
  } catch {
    return agents
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const full = path.join(agentsDir, entry.name)
    if (entry.name.endsWith('.md')) {
      try {
        const content = fs.readFileSync(full, 'utf-8')
        const c = parseAgentFromMarkdown(full, content)
        if (!c) continue
        agents.push({
          ...c,
          source: 'plugin',
          pluginName: pluginId,
        })
      } catch {
        /* skip */
      }
    } else if (entry.name === 'agents.json') {
      try {
        const data = JSON.parse(fs.readFileSync(full, 'utf-8')) as unknown
        const parsed = safeParseAgentsJsonFile(data, 'plugin', pluginId)
        if (parsed.ok) {
          for (const a of parsed.agents) {
            agents.push(a as PluginAgentDefinition)
          }
        }
      } catch {
        /* skip */
      }
    }
  }
  return agents
}

/**
 * Load plugin-bundled agents for every enabled plugin manifest under the workspace.
 */
export function loadBundledPluginAgentsFromWorkspace(
  workspaceRoot: string | null | undefined,
): PluginAgentDefinition[] {
  if (!workspaceRoot?.trim()) return []
  const root = workspaceRoot.trim()
  const manifests = listPluginManifestDirs(root)
  const out: PluginAgentDefinition[] = []
  for (const manifestPath of manifests) {
    const pluginRoot = path.dirname(manifestPath)
    const dirName = path.basename(pluginRoot)
    let pluginId = dirName
    try {
      const text = fs.readFileSync(manifestPath, 'utf8')
      const data = JSON.parse(text) as { name?: unknown }
      if (typeof data.name === 'string' && data.name.trim()) {
        pluginId = data.name.trim().replace(/:/g, '_')
      }
    } catch {
      /* keep dirName */
    }
    if (isPluginBlockedByPolicy(pluginId)) continue
    const agentsDir = path.join(pluginRoot, '.claude', 'agents')
    if (!fs.existsSync(agentsDir) || !fs.statSync(agentsDir).isDirectory()) continue
    out.push(...loadPluginAgentsFromDir(agentsDir, pluginId))
  }
  return out
}
