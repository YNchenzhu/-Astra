import { afterEach, describe, expect, it } from 'vitest'
import {
  buildSystemPrompt,
  buildSystemPromptLayers,
  invalidateAllSystemPromptMemoCaches,
  invalidateSystemPromptInstructionCache,
  systemPromptInstructionCacheSize,
  userContextLayerCacheSize,
} from './systemPrompt'

const baseOpts = {
  cwd: '/tmp/ws',
  platform: 'linux',
  memoryContext: '',
  sessionContext: '',
  lspPassiveDiagnosticsContext: '',
}

describe('systemPrompt instruction section cache (§6.2 subset)', () => {
  afterEach(() => {
    invalidateAllSystemPromptMemoCaches()
  })

  it('reuses cached instruction for same outputStyle + language', () => {
    buildSystemPrompt({ ...baseOpts, outputStyle: 'concise', language: 'en' })
    expect(systemPromptInstructionCacheSize()).toBe(1)
    buildSystemPrompt({ ...baseOpts, outputStyle: 'concise', language: 'en' })
    expect(systemPromptInstructionCacheSize()).toBe(1)
  })

  it('adds a cache entry for a different language', () => {
    buildSystemPrompt({ ...baseOpts, outputStyle: 'default', language: '' })
    buildSystemPrompt({ ...baseOpts, outputStyle: 'default', language: 'zh' })
    expect(systemPromptInstructionCacheSize()).toBe(2)
  })

  it('invalidate clears entries', () => {
    buildSystemPrompt({ ...baseOpts, outputStyle: 'default', language: '' })
    expect(systemPromptInstructionCacheSize()).toBe(1)
    invalidateSystemPromptInstructionCache()
    expect(systemPromptInstructionCacheSize()).toBe(0)
  })
})

describe('userContext layer memo (§6.2 / AC-6.3)', () => {
  afterEach(() => {
    invalidateAllSystemPromptMemoCaches()
  })

  it('reuses userContext cache for identical memory/session/LSP inputs', () => {
    const o = {
      cwd: '/w',
      platform: 'linux',
      outputStyle: 'default' as const,
      language: '',
      memoryContext: 'm',
      sessionContext: 's',
      lspPassiveDiagnosticsContext: '',
    }
    buildSystemPromptLayers(o)
    expect(userContextLayerCacheSize()).toBe(1)
    buildSystemPromptLayers({ ...o, cwd: '/other' })
    expect(userContextLayerCacheSize()).toBe(1)
  })

  it('invalidateAllSystemPromptMemoCaches clears user layer cache', () => {
    buildSystemPromptLayers({
      cwd: '/w',
      platform: 'linux',
      memoryContext: 'x',
    })
    expect(userContextLayerCacheSize()).toBe(1)
    invalidateAllSystemPromptMemoCaches()
    expect(userContextLayerCacheSize()).toBe(0)
  })
})
