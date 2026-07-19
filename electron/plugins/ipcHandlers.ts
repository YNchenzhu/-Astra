/**
 * §8.7 / §8.8 — 插件市场与下架检测 IPC。
 */

import type { IpcMain } from 'electron'
import { app } from 'electron'
import { readDiskSettings } from '../settings/settingsAccess'
import { fetchMarketplacePluginIndex } from './pluginMarketplace'
import { detectDelistedPlugins, isSourceInBlocklist } from './pluginPolicy'
import { describePluginMcpError, PluginMcpErrorCodes } from '../mcp/pluginMcpErrors'
import { copyMcpbToPluginCache, mergeMcpbServersIntoUserConfig } from './installMcpbBundle'
import { getPluginBundleCacheRoot } from './pluginBundlePaths'

export function registerPluginIntegrationHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('plugin:bundle-cache-path', async () => {
    return { path: getPluginBundleCacheRoot(app.getPath('userData')) }
  })

  ipcMain.handle('plugin:install-mcpb-bundle', async (_event, filePath: unknown) => {
    if (typeof filePath !== 'string' || !filePath.trim()) {
      return { success: false as const, error: 'filePath required' }
    }
    const userData = app.getPath('userData')
    const copied = copyMcpbToPluginCache(userData, filePath)
    if (!copied.ok) {
      return { success: false as const, error: copied.error }
    }
    const { getSharedMcpManager } = await import('../mcp/handlers')
    const mgr = getSharedMcpManager()
    if (!mgr) {
      return { success: false as const, error: 'MCP manager not ready' }
    }
    const merged = await mergeMcpbServersIntoUserConfig(mgr, copied.cachePath)
    if (!merged.ok) {
      return { success: false as const, error: merged.error, cachePath: copied.cachePath }
    }
    // Audit P1-3 (2026-05): connect each freshly-merged server immediately so
    // the user doesn't have to manually click Connect (or restart) before any
    // bundle-provided MCP tools become visible to the agent. Failures are
    // collected per-server and reported; one bad server doesn't block the
    // others. `connect()` internally cascades to `fullResyncMcpRegistry` via
    // `connectInner` so the agent's tool surface refreshes.
    const connectFailures: Array<{ name: string; error: string }> = []
    for (const cfg of merged.addedConfigs) {
      try {
        await mgr.connect(cfg)
      } catch (err) {
        connectFailures.push({
          name: cfg.name,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    return {
      success: true as const,
      added: merged.added,
      cachePath: copied.cachePath,
      ...(connectFailures.length > 0 ? { connectFailures } : {}),
    }
  })

  ipcMain.handle(
    'plugin:fetch-marketplace-index',
    async (_event, urlOverride?: string | null) => {
      const s = readDiskSettings() as Record<string, unknown>
      const fromDisk =
        typeof s.pluginMarketplaceIndexUrl === 'string' ? s.pluginMarketplaceIndexUrl.trim() : ''
      const url =
        typeof urlOverride === 'string' && urlOverride.trim()
          ? urlOverride.trim()
          : fromDisk
      if (!url) {
        return {
          success: false as const,
          error: describePluginMcpError(PluginMcpErrorCodes.MARKETPLACE_NOT_FOUND),
        }
      }
      if (isSourceInBlocklist(url)) {
        return {
          success: false as const,
          error: describePluginMcpError(PluginMcpErrorCodes.MARKETPLACE_BLOCKED_BY_POLICY),
        }
      }
      const r = await fetchMarketplacePluginIndex(url)
      if (!r.ok) {
        return {
          success: false as const,
          error: `${r.code}: ${r.error}`,
        }
      }
      return { success: true as const, pluginIds: r.pluginIds }
    },
  )

  ipcMain.handle(
    'plugin:detect-delisted',
    async (_event, installedIds: unknown, marketplaceUrl?: string | null) => {
      if (!Array.isArray(installedIds)) {
        return { delisted: [] as string[], error: 'installedIds must be array' }
      }
      const ids = installedIds.filter((x): x is string => typeof x === 'string' && x.trim() !== '')
      const s = readDiskSettings() as Record<string, unknown>
      const url =
        typeof marketplaceUrl === 'string' && marketplaceUrl.trim()
          ? marketplaceUrl.trim()
          : typeof s.pluginMarketplaceIndexUrl === 'string'
            ? s.pluginMarketplaceIndexUrl.trim()
            : ''
      if (!url) {
        return { delisted: [] as string[], error: 'no marketplace url' }
      }
      const r = await fetchMarketplacePluginIndex(url)
      if (!r.ok) {
        return { delisted: [] as string[], error: r.error }
      }
      return { delisted: detectDelistedPlugins(ids, r.pluginIds) }
    },
  )
}
