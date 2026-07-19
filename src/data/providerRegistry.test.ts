import { describe, expect, it } from 'vitest'
import { buildRegistryContextWindowMap, PROVIDER_ENTRIES } from './providerRegistry'

describe('PROVIDER_ENTRIES — uniqueness', () => {
  it('every provider id appears exactly once (no UI dropdown duplicates)', () => {
    const seen = new Map<string, number>()
    for (const e of PROVIDER_ENTRIES) {
      seen.set(e.id, (seen.get(e.id) ?? 0) + 1)
    }
    const dupes = [...seen.entries()].filter(([, n]) => n > 1)
    expect(dupes).toEqual([])
  })

  it('every model id within a provider is unique', () => {
    for (const provider of PROVIDER_ENTRIES) {
      const ids = provider.models.map((m) => m.id)
      const set = new Set(ids)
      expect(set.size).toBe(ids.length)
    }
  })
})

describe('buildRegistryContextWindowMap', () => {
  it('only includes models with a positive numeric contextWindow', () => {
    const map = buildRegistryContextWindowMap()
    for (const [id, tokens] of Object.entries(map)) {
      expect(typeof id).toBe('string')
      expect(id).toBe(id.toLowerCase())
      expect(tokens).toBeGreaterThan(0)
      expect(Number.isFinite(tokens)).toBe(true)
    }
  })

  it('includes user-confirmed cases (qwen3.6-plus 256K, deepseek-v4-pro 1M, claude-sonnet-4 200K)', () => {
    const map = buildRegistryContextWindowMap()
    expect(map['qwen3.6-plus']).toBe(256_000)
    expect(map['deepseek-v4-pro']).toBe(1_000_000)
    expect(map['claude-sonnet-4-20250514']).toBe(200_000)
    expect(map['qwen3-coder-plus']).toBe(1_000_000)
  })

  it('skips models without contextWindow declared', () => {
    // `compatible` entries (`auto`, `custom`) deliberately omit contextWindow.
    const map = buildRegistryContextWindowMap()
    expect(map['auto']).toBeUndefined()
    expect(map['custom']).toBeUndefined()
  })

  it('every model with contextWindow declares a sane value (1k..50M)', () => {
    for (const provider of PROVIDER_ENTRIES) {
      for (const m of provider.models) {
        if (m.contextWindow != null) {
          expect(m.contextWindow).toBeGreaterThanOrEqual(1_000)
          expect(m.contextWindow).toBeLessThanOrEqual(50_000_000)
        }
      }
    }
  })
})
