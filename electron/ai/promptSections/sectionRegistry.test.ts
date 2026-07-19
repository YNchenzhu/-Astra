import { describe, expect, it } from 'vitest'
import { buildSystemPromptLayers, type SystemPromptOptions } from '../systemPrompt'
import { assembleLayersFromRegistry, listRegisteredSections } from './registry'

const baseOptions: SystemPromptOptions = {
  cwd: '/tmp/ws',
  platform: 'linux',
  outputStyle: 'default',
  language: 'en',
  memoryContext: '',
  sessionContext: '',
  lspPassiveDiagnosticsContext: '',
}

function permutations(): SystemPromptOptions[] {
  return [
    baseOptions,
    { ...baseOptions, includeEditFileContract: true },
    { ...baseOptions, memoryCapabilities: 'memory tutorial text', memoryContext: 'recalled fact A' },
    { ...baseOptions, sessionContext: 'state: investigating', lspPassiveDiagnosticsContext: 'src/foo.ts:1 error' },
    {
      ...baseOptions,
      platform: 'win32',
      memoryCapabilities: 'cap',
      memoryContext: 'mem',
      sessionContext: 'sess',
      lspPassiveDiagnosticsContext: 'lsp',
      includeEditFileContract: true,
    },
  ]
}

describe('prompt section registry', () => {
  it('every registered section declares a unique id and an owner', () => {
    const sections = listRegisteredSections()
    const ids = sections.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const s of sections) {
      expect(s.id).toMatch(/^[a-z][a-z0-9-]*$/u)
      expect(s.owner).toBeDefined()
      expect(['system', 'user', 'user-meta']).toContain(s.layer)
    }
  })

  it('every registered section build function is pure (no env / Date reliance)', () => {
    const opts = baseOptions
    const sections = listRegisteredSections()
    for (const s of sections) {
      const a = s.build({ options: opts })
      const b = s.build({ options: opts })
      expect(a).toBe(b)
    }
  })

  it('assembleLayersFromRegistry produces the same systemContext as buildSystemPromptLayers', () => {
    for (const opts of permutations()) {
      const fromRegistry = assembleLayersFromRegistry(opts)
      const layered = buildSystemPromptLayers(opts)
      expect(fromRegistry.systemContext).toBe(layered.systemContext)
    }
  })

  it('assembleLayersFromRegistry produces the same userMessageContext as buildSystemPromptLayers', () => {
    for (const opts of permutations()) {
      const fromRegistry = assembleLayersFromRegistry(opts)
      const layered = buildSystemPromptLayers(opts)
      expect(fromRegistry.userMessageContext).toBe(layered.userMessageContext)
    }
  })

  it('layer assignment matches expected buckets', () => {
    const sections = listRegisteredSections()
    const systemLayer = sections.filter((s) => s.layer === 'system').map((s) => s.id)
    const userLayer = sections.filter((s) => s.layer === 'user').map((s) => s.id)
    const userMeta = sections.filter((s) => s.layer === 'user-meta').map((s) => s.id)

    expect(systemLayer).toEqual([
      'attribution',
      'instruction-block',
      'tool-use-conventions',
      'fork-guidance',
      'self-awareness',
      'edit-file-contract',
      // PR-4 Team Active Loop. Returns empty when POLE_TEAM_ACTIVE_LOOP is
      // unset so byte-equality with `buildSystemPromptLayers` is preserved
      // in the default test environment.
      'team-inbox-guidance',
    ])
    expect(userLayer).toEqual([])
    expect(userMeta).toEqual([
      'memory-capabilities',
      'project-memory',
      'lsp-passive-diagnostics',
      'environment',
      'session-context',
      // Audit P0-2a (2026-05) — companion / buddy intro. Returns empty when
      // `options.buddyPromptBody` is omitted (default), so byte-equality with
      // `buildSystemPromptLayers` on default options is preserved.
      'buddy-state',
    ])
  })
})
