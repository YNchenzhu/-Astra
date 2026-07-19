import { describe, it, expect } from 'vitest'
import {
  buildPromptCacheFingerprint,
  serializeSystemForFingerprint,
} from './promptCacheFingerprint'

describe('promptCacheFingerprint (§7.4)', () => {
  it('serializeSystemForFingerprint prefers layers shape', () => {
    const s = serializeSystemForFingerprint('plain', {
      systemContext: 'a',
      userContext: 'b',
    })
    expect(s).toContain('a')
    expect(s).toContain('---')
    expect(s).toContain('b')
  })

  it('buildPromptCacheFingerprint changes when tool names change', () => {
    const a = buildPromptCacheFingerprint({
      providerId: 'anthropic',
      model: 'claude-3-5-sonnet',
      systemSerialized: 'sys',
      toolNames: ['Read', 'Grep'],
    })
    const b = buildPromptCacheFingerprint({
      providerId: 'anthropic',
      model: 'claude-3-5-sonnet',
      systemSerialized: 'sys',
      toolNames: ['Read'],
    })
    expect(a).not.toBe(b)
  })
})
