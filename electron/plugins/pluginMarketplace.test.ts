import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchMarketplacePluginIndex } from './pluginMarketplace'

describe('pluginMarketplace', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('parses plugins[].id from JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ plugins: [{ id: 'a' }, { id: 'b' }] }),
      })) as unknown as typeof fetch,
    )
    const r = await fetchMarketplacePluginIndex('https://example.com/index.json')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.pluginIds).toEqual(['a', 'b'])
  })
})
