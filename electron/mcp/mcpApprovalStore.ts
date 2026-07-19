/**
 * 工作区级 MCP 导入审批持久化（upstream 报告 §8.3 / §8.4）。
 * 与全局 `mcp-servers.json` 分离：仅记录用户对工作区发现的指纹的允许/拒绝。
 */

import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { MCPServerConfig } from './transport'

export type McpApprovalFile = {
  version: 1
  workspaces: Record<
    string,
    {
      approvedFingerprints: string[]
      declinedFingerprints: string[]
    }
  >
}

export function workspaceApprovalKey(resolvedPath: string): string {
  const n = path.resolve(resolvedPath.trim())
  return process.platform === 'win32' ? n.toLowerCase() : n
}

export function mcpServerConfigFingerprint(config: MCPServerConfig): string {
  const payload = JSON.stringify({
    n: config.name,
    t: config.transport,
    c: config.command,
    a: config.args,
    u: config.url ?? '',
    e: config.env ?? {},
  })
  return createHash('sha256').update(payload).digest('hex').slice(0, 32)
}

function defaultFile(): McpApprovalFile {
  return { version: 1, workspaces: {} }
}

export function loadMcpApprovalFile(filePath: string): McpApprovalFile {
  try {
    if (!fs.existsSync(filePath)) return defaultFile()
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as McpApprovalFile
    if (raw?.version !== 1 || typeof raw.workspaces !== 'object' || !raw.workspaces) {
      return defaultFile()
    }
    return raw
  } catch {
    return defaultFile()
  }
}

export function saveMcpApprovalFile(filePath: string, data: McpApprovalFile): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8')
}

export function isFingerprintApproved(
  filePath: string,
  workspaceResolved: string,
  fingerprint: string,
): boolean {
  const data = loadMcpApprovalFile(filePath)
  const row = data.workspaces[workspaceApprovalKey(workspaceResolved)]
  return Boolean(row?.approvedFingerprints?.includes(fingerprint))
}

export function isFingerprintDeclined(
  filePath: string,
  workspaceResolved: string,
  fingerprint: string,
): boolean {
  const data = loadMcpApprovalFile(filePath)
  const row = data.workspaces[workspaceApprovalKey(workspaceResolved)]
  return Boolean(row?.declinedFingerprints?.includes(fingerprint))
}

export function recordApprovedFingerprints(
  filePath: string,
  workspaceResolved: string,
  fingerprints: string[],
): void {
  const data = loadMcpApprovalFile(filePath)
  const key = workspaceApprovalKey(workspaceResolved)
  const prev = data.workspaces[key] ?? { approvedFingerprints: [], declinedFingerprints: [] }
  const merged = new Set([...prev.approvedFingerprints, ...fingerprints])
  const declined = new Set(prev.declinedFingerprints)
  for (const f of fingerprints) declined.delete(f)
  data.workspaces[key] = {
    approvedFingerprints: [...merged],
    declinedFingerprints: [...declined],
  }
  saveMcpApprovalFile(filePath, data)
}

export function recordDeclinedFingerprints(
  filePath: string,
  workspaceResolved: string,
  fingerprints: string[],
): void {
  const data = loadMcpApprovalFile(filePath)
  const key = workspaceApprovalKey(workspaceResolved)
  const prev = data.workspaces[key] ?? { approvedFingerprints: [], declinedFingerprints: [] }
  const merged = new Set([...prev.declinedFingerprints, ...fingerprints])
  const approved = new Set(prev.approvedFingerprints)
  for (const f of fingerprints) approved.delete(f)
  data.workspaces[key] = {
    approvedFingerprints: [...approved],
    declinedFingerprints: [...merged],
  }
  saveMcpApprovalFile(filePath, data)
}
