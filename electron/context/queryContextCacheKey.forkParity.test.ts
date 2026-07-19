import { describe, it, expect } from 'vitest'
import { buildQueryContextCacheKey } from './queryContextCacheKey'

/**
 * AC-6.5 / upstream §6.4 — fork child shares app-side queryContext key with parent when
 * model + inherited system prefix + tool revision match ({@link subAgentRunner} fork path).
 */
describe('buildQueryContextCacheKey fork parity', () => {
  it('matches for same model, shared system prefix, tool revision', () => {
    const a = buildQueryContextCacheKey({
      model: 'claude-sonnet-4-20250514',
      sharedSystemPrefix: 'parent system body v1',
      toolsetRevision: 42,
    })
    const b = buildQueryContextCacheKey({
      model: 'claude-sonnet-4-20250514',
      sharedSystemPrefix: 'parent system body v1',
      toolsetRevision: 42,
    })
    expect(a).toBe(b)
    expect(a).toMatch(/^pole:qctx:v1:/)
  })

  it('differs when model, system prefix, or tool revision differ', () => {
    const base = {
      model: 'm',
      sharedSystemPrefix: 'sys',
      toolsetRevision: 1,
    }
    const k0 = buildQueryContextCacheKey(base)
    expect(buildQueryContextCacheKey({ ...base, model: 'm2' })).not.toBe(k0)
    expect(buildQueryContextCacheKey({ ...base, sharedSystemPrefix: 'other' })).not.toBe(k0)
    expect(buildQueryContextCacheKey({ ...base, toolsetRevision: 2 })).not.toBe(k0)
  })
})
