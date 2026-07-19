/**
 * Helpers to read the user's disabled-LSP-servers list from disk settings.
 * Split out from {@link adminIpcHandlers.ts} so `config.ts` can consume it
 * without pulling in the full IPC surface (which imports `manager.ts` and
 * would otherwise create a cycle: manager → config → adminIpcHandlers → manager).
 */

import { readDiskSettings } from '../settings/settingsAccess'

export const DISABLED_LSP_SERVERS_KEY = 'lspDisabledServers'

export function getDisabledLspServers(): string[] {
  const raw = readDiskSettings()[DISABLED_LSP_SERVERS_KEY]
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const item of raw) {
    if (typeof item === 'string' && item.trim()) {
      out.push(item.trim())
    }
  }
  return out
}
