/**
 * upstream 报告 §8.7 / §8.8 — 插件市场索引拉取（JSON），用于下架检测等。
 *
 * 期望响应：`{ "plugins": [ { "id": "foo" }, ... ] }`
 */

export type MarketplaceFetchResult =
  | { ok: true; pluginIds: string[] }
  | { ok: false; code: 'marketplace-load-failed'; error: string }

export async function fetchMarketplacePluginIndex(url: string): Promise<MarketplaceFetchResult> {
  const u = url.trim()
  if (!u) {
    return { ok: false, code: 'marketplace-load-failed', error: 'empty url' }
  }
  try {
    const r = await fetch(u, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    })
    if (!r.ok) {
      return {
        ok: false,
        code: 'marketplace-load-failed',
        error: `HTTP ${r.status}`,
      }
    }
    const j = (await r.json()) as unknown
    if (!j || typeof j !== 'object' || Array.isArray(j)) {
      return { ok: false, code: 'marketplace-load-failed', error: 'invalid json root' }
    }
    const plugins = (j as { plugins?: unknown }).plugins
    if (!Array.isArray(plugins)) {
      return { ok: false, code: 'marketplace-load-failed', error: 'missing plugins[]' }
    }
    const ids: string[] = []
    for (const p of plugins) {
      if (p && typeof p === 'object' && !Array.isArray(p)) {
        const id = (p as { id?: unknown }).id
        if (typeof id === 'string' && id.trim()) ids.push(id.trim())
      }
    }
    return { ok: true, pluginIds: ids }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, code: 'marketplace-load-failed', error: msg }
  }
}
