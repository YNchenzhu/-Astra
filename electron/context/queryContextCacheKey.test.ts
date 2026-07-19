import { describe, expect, it } from 'vitest'
import { buildQueryContextCacheKey } from './queryContextCacheKey'

describe('queryContextCacheKey (AC-6.5)', () => {
  it('same model + inherited system + tool rev => same key (fork shares parent prefix)', () => {
    const parent = buildQueryContextCacheKey({
      model: 'claude-sonnet-4',
      sharedSystemPrefix: 'Parent system core',
      toolsetRevision: 42,
    })
    const fork = buildQueryContextCacheKey({
      model: 'claude-sonnet-4',
      sharedSystemPrefix: 'Parent system core',
      toolsetRevision: 42,
    })
    expect(fork).toBe(parent)
  })

  it('sub-agent wrapper text changes fingerprint vs parent prefix', () => {
    const parent = buildQueryContextCacheKey({
      model: 'm',
      sharedSystemPrefix: 'CORE',
      toolsetRevision: 1,
    })
    const wrapped = buildQueryContextCacheKey({
      model: 'm',
      sharedSystemPrefix: 'CORE\n\nSUB_AGENT_OUTPUT_LEAD',
      toolsetRevision: 1,
    })
    expect(wrapped).not.toBe(parent)
  })
})
