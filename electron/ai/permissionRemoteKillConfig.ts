/**
 * Statsig-style remote toggles (AC-5.7): optional JSON file or inline env read at runtime so
 * admins can disable bypass / auto-style modes without restarting (when file is updated).
 */

import fs from 'node:fs'

export type PermissionRemoteKillPayload = {
  /** When true, same effect as ASTRA_KILL_BYPASS_PERMISSIONS */
  killBypassPermissions?: boolean
  /** When true, same effect as ASTRA_KILL_AUTO_PERMISSION_MODES */
  killAutoPermissionModes?: boolean
}

type CacheEntry = { path: string; mtimeMs: number; payload: PermissionRemoteKillPayload }

let fileCache: CacheEntry | null = null

function parseJsonObject(raw: string): PermissionRemoteKillPayload | undefined {
  try {
    const v = JSON.parse(raw) as unknown
    if (!v || typeof v !== 'object') return undefined
    return v as PermissionRemoteKillPayload
  } catch {
    return undefined
  }
}

function readPayloadFromFile(filePath: string): PermissionRemoteKillPayload {
  try {
    const st = fs.statSync(filePath)
    if (fileCache && fileCache.path === filePath && fileCache.mtimeMs === st.mtimeMs) {
      return fileCache.payload
    }
    const text = fs.readFileSync(filePath, 'utf-8')
    const payload = parseJsonObject(text) ?? {}
    fileCache = { path: filePath, mtimeMs: st.mtimeMs, payload }
    return payload
  } catch {
    return {}
  }
}

/** For tests: clear mtime cache so the next read re-stat the file. */
export function clearPermissionRemoteKillFileCache(): void {
  fileCache = null
}

/**
 * Merged remote payload: `ASTRA_PERMISSION_KILL_CONFIG_JSON` (object) then file at
 * `ASTRA_PERMISSION_KILL_CONFIG_PATH`. Later keys do not override earlier `true` flags (OR semantics).
 */
export function readPermissionRemoteKillPayload(): PermissionRemoteKillPayload {
  const out: PermissionRemoteKillPayload = {}
  const inline = process.env.ASTRA_PERMISSION_KILL_CONFIG_JSON?.trim()
  if (inline) {
    const p = parseJsonObject(inline)
    if (p?.killBypassPermissions) out.killBypassPermissions = true
    if (p?.killAutoPermissionModes) out.killAutoPermissionModes = true
  }
  const filePath = process.env.ASTRA_PERMISSION_KILL_CONFIG_PATH?.trim()
  if (filePath) {
    const p = readPayloadFromFile(filePath)
    if (p.killBypassPermissions) out.killBypassPermissions = true
    if (p.killAutoPermissionModes) out.killAutoPermissionModes = true
  }
  return out
}
