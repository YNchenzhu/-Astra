/**
 * Settings for the workspace pre-warm / FS watcher bridge.
 *
 * Persisted key: `lspWorkspaceScan` in the main settings JSON.
 * Shape:
 *   {
 *     enabled?: boolean                      // default true
 *     maxFilesPerLanguage?: number           // default 5000
 *     maxTotalFiles?: number                 // default 20000
 *     exclude?: string[]                     // extra glob fragments
 *   }
 */

import { readDiskSettings } from '../settings/settingsAccess'

export const WORKSPACE_SCAN_SETTINGS_KEY = 'lspWorkspaceScan'

export interface WorkspaceScanSettings {
  enabled: boolean
  maxFilesPerLanguage: number
  maxTotalFiles: number
  exclude: string[]
}

export const DEFAULT_WORKSPACE_SCAN_SETTINGS: WorkspaceScanSettings = {
  enabled: true,
  maxFilesPerLanguage: 5000,
  maxTotalFiles: 20_000,
  exclude: [],
}

function asNumber(v: unknown, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback
  return Math.min(max, Math.max(min, Math.floor(v)))
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
}

export function readWorkspaceScanSettings(): WorkspaceScanSettings {
  const raw = readDiskSettings()[WORKSPACE_SCAN_SETTINGS_KEY]
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_WORKSPACE_SCAN_SETTINGS }
  const obj = raw as Record<string, unknown>
  return {
    enabled: obj.enabled === false ? false : true,
    maxFilesPerLanguage: asNumber(
      obj.maxFilesPerLanguage,
      DEFAULT_WORKSPACE_SCAN_SETTINGS.maxFilesPerLanguage,
      1,
      1_000_000,
    ),
    maxTotalFiles: asNumber(
      obj.maxTotalFiles,
      DEFAULT_WORKSPACE_SCAN_SETTINGS.maxTotalFiles,
      1,
      10_000_000,
    ),
    exclude: asStringArray(obj.exclude),
  }
}
