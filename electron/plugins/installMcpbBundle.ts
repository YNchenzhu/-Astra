/**
 * Copy .mcpb into plugin-cache and merge declared MCP servers into `mcp-servers.json`.
 */

import fs from 'node:fs'
import path from 'node:path'
import { readMcpbMcpServersRecord } from '../mcp/mcpbBundle'
import { rawEntryToMcpConfig } from '../mcp/pluginMcpIntegration'
import type { MCPClientManager } from '../mcp/client'
import type { MCPServerConfig } from '../mcp/transport'
import { getPluginBundleCacheRoot } from './pluginBundlePaths'

function safeSlug(s: string, max = 48): string {
  return s.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, max) || 'bundle'
}

export function copyMcpbToPluginCache(
  userDataPath: string,
  absSourcePath: string,
): { ok: true; cachePath: string } | { ok: false; error: string } {
  try {
    const src = path.normalize(absSourcePath.trim())
    if (!fs.existsSync(src) || !fs.statSync(src).isFile()) {
      return { ok: false, error: 'Source file not found' }
    }
    const lower = src.toLowerCase()
    if (!lower.endsWith('.mcpb') && !lower.endsWith('.zip')) {
      return { ok: false, error: 'Expected .mcpb or .zip bundle' }
    }
    const root = getPluginBundleCacheRoot(userDataPath)
    fs.mkdirSync(root, { recursive: true })
    const base = safeSlug(path.basename(src, path.extname(src)))
    const dest = path.join(root, `${Date.now()}-${base}${path.extname(src)}`)
    fs.copyFileSync(src, dest)
    return { ok: true, cachePath: dest }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, error: msg }
  }
}

/**
 * Audit P1-3 (2026-05): now async + returns `addedConfigs` (the full MCPServerConfig
 * objects) alongside `added` (name list). The IPC handler uses `addedConfigs` to
 * call `manager.connect(config)` directly — avoiding the previous race where
 * `manager.mergeServerConfigIntoFile` (queued atomic write) might not have
 * flushed before a `reconnectServer(name)` path tried to `loadConfigs()` from
 * disk. Awaiting each merge here also fixes a pre-existing dropped-promise
 * (Promise was returned by `mergeServerConfigIntoFile` and discarded).
 */
export async function mergeMcpbServersIntoUserConfig(
  manager: MCPClientManager,
  bundlePath: string,
): Promise<
  | { ok: true; added: string[]; addedConfigs: MCPServerConfig[] }
  | { ok: false; error: string }
> {
  const r = readMcpbMcpServersRecord(bundlePath)
  if (!r.ok) {
    return { ok: false, error: r.detail || String(r.code) }
  }
  const rec = r.mcpServers
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) {
    return { ok: false, error: 'Bundle has no mcpServers object' }
  }
  const slug = safeSlug(path.basename(bundlePath, path.extname(bundlePath)))
  const added: string[] = []
  const addedConfigs: MCPServerConfig[] = []
  for (const [serverName, raw] of Object.entries(rec as Record<string, unknown>)) {
    const cfg = rawEntryToMcpConfig(serverName, raw)
    if (!cfg) continue
    const uniqueName = safeSlug(`${slug}_${serverName}`, 64)
    const finalCfg = { ...cfg, name: uniqueName }
    await manager.mergeServerConfigIntoFile(finalCfg)
    added.push(uniqueName)
    addedConfigs.push(finalCfg)
  }
  if (added.length === 0) {
    return { ok: false, error: 'No valid MCP server entries in bundle' }
  }
  return { ok: true, added, addedConfigs }
}
