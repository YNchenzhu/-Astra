/**
 * upstream 报告 §8.6 / §8.8 — 插件策略（磁盘设置驱动子集）。
 */

import { readDiskSettings } from '../settings/settingsAccess'

function settingsRecord(): Record<string, unknown> {
  try {
    return readDiskSettings() as Record<string, unknown>
  } catch {
    return {}
  }
}

/** `enabledPlugins[pluginId] === false` 时阻止加载。 */
export function isPluginBlockedByPolicy(pluginId: string): boolean {
  const s = settingsRecord()
  const ep = s.enabledPlugins
  if (ep && typeof ep === 'object' && !Array.isArray(ep)) {
    const v = (ep as Record<string, unknown>)[pluginId]
    if (v === false) return true
  }
  return false
}

/** 市场列表存在时，返回已安装但不在市场中的插件 id（用于下架检测）。 */
export function detectDelistedPlugins(
  installedPluginIds: string[],
  marketplacePluginIds: string[],
): string[] {
  if (!marketplacePluginIds.length) return []
  const set = new Set(marketplacePluginIds)
  return installedPluginIds.filter((id) => !set.has(id))
}

export function isSourceAllowedByPolicy(source: string): boolean {
  const s = settingsRecord()
  const allowed = s.pluginSourceAllowlist
  if (!Array.isArray(allowed) || allowed.length === 0) return true
  return allowed.some((a) => typeof a === 'string' && source.includes(a))
}

export function isSourceInBlocklist(source: string): boolean {
  const s = settingsRecord()
  const bl = s.pluginSourceBlocklist
  if (!Array.isArray(bl)) return false
  return bl.some((b) => typeof b === 'string' && source.includes(b))
}
