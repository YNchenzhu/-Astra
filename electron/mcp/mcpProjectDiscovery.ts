/**
 * 工作区 MCP 发现 + 与已保存配置、审批存储比对（upstream §8.3 / §8.4）。
 */

import path from 'node:path'
import fs from 'node:fs'
import type { MCPServerConfig } from './transport'
import {
  mcpServerConfigFingerprint,
  workspaceApprovalKey,
  type McpApprovalFile,
  loadMcpApprovalFile,
} from './mcpApprovalStore'
import { loadAllProjectScopedMcpEntries, type ScopedMcpEntry } from './pluginMcpIntegration'
import type { PluginMcpLoadIssue } from './pluginMcpIntegration'

export type PendingProjectMcpRow = {
  config: MCPServerConfig
  fingerprint: string
  source: ScopedMcpEntry['source']
  pluginId?: string
  sourceLabel: string
}

function configsShallowEqual(a: MCPServerConfig, b: MCPServerConfig): boolean {
  return (
    a.name === b.name &&
    a.transport === b.transport &&
    a.command === b.command &&
    JSON.stringify(a.args) === JSON.stringify(b.args) &&
    (a.url ?? '') === (b.url ?? '')
  )
}

function isAlreadyInSaved(config: MCPServerConfig, saved: MCPServerConfig[]): boolean {
  const row = saved.find((s) => s.name === config.name)
  return Boolean(row && configsShallowEqual(config, row))
}

function labelForEntry(e: ScopedMcpEntry): string {
  if (e.source === 'dot_mcp_json') return '.mcp.json'
  return e.pluginId ? `plugin.json (${e.pluginId})` : 'plugin.json'
}

export function discoverProjectMcpContext(params: {
  workspacePath: string
  savedConfigs: MCPServerConfig[]
  approvalFilePath: string
  userConfig: Record<string, string>
  processEnv: NodeJS.ProcessEnv
}): {
  pending: PendingProjectMcpRow[]
  issues: PluginMcpLoadIssue[]
  entries: ScopedMcpEntry[]
} {
  const ws = path.resolve(params.workspacePath.trim())
  if (!ws || !fs.existsSync(ws) || !fs.statSync(ws).isDirectory()) {
    return { pending: [], issues: [], entries: [] }
  }

  const { entries, issues } = loadAllProjectScopedMcpEntries(ws, params.userConfig, params.processEnv)
  const approvalData: McpApprovalFile = loadMcpApprovalFile(params.approvalFilePath)
  const wkey = workspaceApprovalKey(ws)
  const approvedSet = new Set(approvalData.workspaces[wkey]?.approvedFingerprints ?? [])
  const declinedSet = new Set(approvalData.workspaces[wkey]?.declinedFingerprints ?? [])

  const pending: PendingProjectMcpRow[] = []

  for (const e of entries) {
    const fp = mcpServerConfigFingerprint(e.config)
    if (isAlreadyInSaved(e.config, params.savedConfigs)) continue
    if (approvedSet.has(fp)) continue
    if (declinedSet.has(fp)) continue
    pending.push({
      config: e.config,
      fingerprint: fp,
      source: e.source,
      pluginId: e.pluginId,
      sourceLabel: labelForEntry(e),
    })
  }

  return { pending, issues, entries }
}
