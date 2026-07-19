import { describe, expect, it } from 'vitest'
import { buildSystemPromptLayers, type SystemPromptOptions } from '../systemPrompt'
import { FORK_GUIDANCE_BLOCK, forkGuidanceSection } from './forkGuidance'
import { SELF_AWARENESS_BLOCK, selfAwarenessSection } from './selfAwareness'

const baseOptions: SystemPromptOptions = {
  cwd: '/tmp/ws',
  platform: 'linux',
  outputStyle: 'default',
  language: 'en',
  memoryContext: '',
  sessionContext: '',
  lspPassiveDiagnosticsContext: '',
}

describe('Phase F sections', () => {
  it('fork-guidance section lands in the cache-friendly system layer', () => {
    expect(forkGuidanceSection.layer).toBe('system')
    expect(forkGuidanceSection.owner).toBe('core')
    expect(forkGuidanceSection.build({ options: baseOptions })).toBe(FORK_GUIDANCE_BLOCK)
  })

  it('self-awareness section lands in the cache-friendly system layer', () => {
    expect(selfAwarenessSection.layer).toBe('system')
    expect(selfAwarenessSection.owner).toBe('core')
    expect(selfAwarenessSection.build({ options: baseOptions })).toBe(SELF_AWARENESS_BLOCK)
  })

  it('built systemContext carries the fork-guidance key directives', () => {
    const layers = buildSystemPromptLayers(baseOptions)
    expect(layers.systemContext).toContain('# Forking the conversation')
    expect(layers.systemContext).toMatch(/fork yourself/iu)
    expect(layers.systemContext).toMatch(/will i need this raw output again\?/iu)
  })

  it('built systemContext carries the self-awareness directives', () => {
    const layers = buildSystemPromptLayers(baseOptions)
    expect(layers.systemContext).toContain('# Working assumptions')
    // The bullets that remain in `# Working assumptions` after the
    // audit-fix R1-2 dedup.
    expect(layers.systemContext).toMatch(/Avoid giving time estimates/u)
    expect(layers.systemContext).toMatch(/Tool execution latency is on the host/u)
  })

  // Audit fix R1-2 — guard against the rules drifting back into the
  // self-awareness block. The canonical phrasings for "highly capable"
  // and "all text outside of tool use is displayed" live in
  // `instructionBlockSection` (`# Doing tasks` / `# System` headings).
  // If a future edit re-adds them to SELF_AWARENESS_BLOCK, this test
  // catches it before two near-identical-but-differently-worded copies
  // ship to the model again.
  it('"You are highly capable" appears exactly once in systemContext (SSOT)', () => {
    const layers = buildSystemPromptLayers(baseOptions)
    const occurrences = layers.systemContext.split('You are highly capable').length - 1
    expect(occurrences).toBe(1)
  })

  it('"displayed to the user" appears at most once in systemContext (SSOT)', () => {
    const layers = buildSystemPromptLayers(baseOptions)
    // Use a substring distinctive enough to not collide with other
    // unrelated mentions of the word "displayed".
    const occurrences = layers.systemContext.split('displayed to the user').length - 1
    expect(occurrences).toBeLessThanOrEqual(1)
  })

  it('forkGuidance + selfAwareness sit AFTER the legacy instruction block (so cache-stable prefix order is preserved)', () => {
    const layers = buildSystemPromptLayers(baseOptions)
    const idxInstruction = layers.systemContext.indexOf('You are an interactive agent')
    const idxFork = layers.systemContext.indexOf('# Forking the conversation')
    const idxSelf = layers.systemContext.indexOf('# Working assumptions')
    expect(idxInstruction).toBeGreaterThan(-1)
    expect(idxFork).toBeGreaterThan(idxInstruction)
    expect(idxSelf).toBeGreaterThan(idxFork)
  })
})
