/**
 * MCPB（ZIP bundle）解压并解析其中的 MCP 清单（upstream 报告 §8.4）。
 */

import fs from 'node:fs'
import path from 'node:path'
import AdmZip from 'adm-zip'
import { PluginMcpErrorCodes, type PluginMcpErrorCode } from './pluginMcpErrors'

export type McpbReadResult =
  | { ok: true; mcpServers: unknown; pickedEntry: string }
  | { ok: false; code: PluginMcpErrorCode; detail?: string }

function normalizeEntryName(name: string): string {
  return name.replace(/\\/g, '/').replace(/^\/+/, '')
}

/**
 * 从 .mcpb / .zip 文件中读取 `mcpServers` 对象（或整文件即为 servers 映射的 JSON）。
 */
export function readMcpbMcpServersRecord(bundlePath: string): McpbReadResult {
  try {
    if (!fs.existsSync(bundlePath) || !fs.statSync(bundlePath).isFile()) {
      return { ok: false, code: PluginMcpErrorCodes.PATH_NOT_FOUND, detail: bundlePath }
    }
    const buf = fs.readFileSync(bundlePath)
    let zip: AdmZip
    try {
      zip = new AdmZip(buf)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { ok: false, code: PluginMcpErrorCodes.MCPB_EXTRACT_FAILED, detail: msg }
    }

    const entries = zip.getEntries().filter((e) => !e.isDirectory)
    if (entries.length === 0) {
      return { ok: false, code: PluginMcpErrorCodes.MCPB_INVALID_MANIFEST, detail: 'empty zip' }
    }

    const score = (name: string): number => {
      const n = normalizeEntryName(name).toLowerCase()
      if (n === 'manifest.json' || n.endsWith('/manifest.json')) return 0
      if (n === 'mcp.json' || n.endsWith('/mcp.json')) return 1
      if (n.endsWith('package.json')) return 3
      return 10
    }

    entries.sort((a, b) => score(a.entryName) - score(b.entryName))

    for (const ent of entries) {
      if (score(ent.entryName) > 2) break
      let text: string
      try {
        text = ent.getData().toString('utf8')
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        return { ok: false, code: PluginMcpErrorCodes.MCPB_EXTRACT_FAILED, detail: msg }
      }
      let data: unknown
      try {
        data = JSON.parse(text) as unknown
      } catch {
        continue
      }
      if (!data || typeof data !== 'object' || Array.isArray(data)) continue
      const rec = data as Record<string, unknown>
      if (rec.mcpServers !== undefined) {
        return { ok: true, mcpServers: rec.mcpServers, pickedEntry: ent.entryName }
      }
      const keys = Object.keys(rec)
      const looksLikeServerMap = keys.some((k) => {
        const v = rec[k]
        return v && typeof v === 'object' && !Array.isArray(v) && ('command' in v || 'url' in v)
      })
      if (looksLikeServerMap) {
        return { ok: true, mcpServers: rec, pickedEntry: ent.entryName }
      }
    }

    return {
      ok: false,
      code: PluginMcpErrorCodes.MCPB_INVALID_MANIFEST,
      detail: 'no manifest.json / mcp.json with mcpServers',
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, code: PluginMcpErrorCodes.MCPB_EXTRACT_FAILED, detail: msg }
  }
}

export function isMcpbPath(ref: string): boolean {
  const lower = ref.trim().toLowerCase()
  return lower.endsWith('.mcpb') || lower.endsWith('.zip')
}

export function resolveMcpbPath(pluginRoot: string, ref: string): string {
  return path.isAbsolute(ref) ? ref : path.resolve(pluginRoot, ref)
}
