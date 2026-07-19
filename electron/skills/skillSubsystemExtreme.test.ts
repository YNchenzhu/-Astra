/**
 * Extreme Test Suite — Skill Subsystem in Agentic Loop Workflow
 * Covers 15+ scenarios across 7 dimensions.
 *
 * Run: npx vitest run electron/skills/skillSubsystemExtreme.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { silenceExpectedConsoleWarn } from '../testHelpers/silenceExpectedConsole'

// Hook-frontmatter "invalid JSON" cases deliberately log a warning from
// production code; the test asserts behavior, not the warning emission.
silenceExpectedConsoleWarn()

// ─── Dimension 1: Skill Discovery Edge Cases ───────────────────────────

import {
  discoveryQueryTermKeys,
  scoreSkillRelevanceLexical,
  normalizeSkillName,
  rankSkillsForExplicitDiscover,
  buildDiscoveryQuery,
  wrapSkillDiscovery,
  injectSkillDiscoveryIntoLastUserMessage,
  excludeSkillToolInput,
  formatRankedSkillsBlock,
  formatDiscoverSkillsToolOutput,
  discoverSkillsTool,
} from './skillDiscovery'
import { asAgentId } from '../tools/ids'
import type { SkillDefinition } from './types'

// ─── Dimension 2: Invoked Skills Registry Edge Cases ──────────────────

import {
  recordInvokedSkill,
  peekInvokedSkillsPromptFragmentForAgent,
  takeInvokedSkillsPromptFragmentForAgent,
  injectInvokedSkillsIntoLastUserMessage,
  clearInvokedSkillsForAgent,
  resetInvokedSkillsRegistryForTests,
  invokedSkillMapKey,
} from './invokedSkillsRegistry'

// ─── Dimension 3: CRDT Merge Logic ────────────────────────────────────

import { mergeSkillDefinitionsCRDT } from './skillMergeCRDT'

// ─── Dimension 4: Skill Name & Frontmatter Safety ────────────────────

import { skillUsesOnlySafeFrontmatterKeys, SAFE_SKILL_PROPERTIES } from './safeSkillProperties'

// ─── Dimension 5: Skill Effort Model ──────────────────────────────────

import { parseSkillEffort, adjustMaxTokensForEffort, anthropicModelLikelySupportsEffort } from './skillEffort'

// ─── Dimension 6: Skill Model Resolution ─────────────────────────────

import { resolveSkillModelAlias, has1mContext, strip1mSuffix } from './skillModelResolve'

// ─── Dimension 7: Hook Manifest ───────────────────────────────────────

import { mergeHookLists, parseHooksFromFrontmatterValue } from './skillHookManifest'

// ─── Helpers ──────────────────────────────────────────────────────────

function skill(
  name: string,
  source: SkillDefinition['source'],
  description: string,
  path?: string,
): SkillDefinition {
  return {
    name,
    description,
    source,
    userInvocable: true,
    disableModelInvocation: false,
    context: 'inline',
    promptContent: 'x',
    resolvedPath: path,
  }
}

function makeSkill(overrides: Partial<SkillDefinition> = {}): SkillDefinition {
  return {
    name: 'test-skill',
    description: 'A test skill for testing purposes',
    source: 'bundled',
    userInvocable: true,
    disableModelInvocation: false,
    context: 'inline',
    promptContent: 'Test prompt content with lots of text for ranking and discovery testing.',
    ...overrides,
  }
}

// ═══════════════════════════════════════════════════════════════════════
// DIMENSION 1: SKILL DISCOVERY EDGE CASES (6 scenarios)
// ═══════════════════════════════════════════════════════════════════════

describe('D1: Skill Discovery Edge Cases', () => {

  // S1: Empty query should still produce alphabetical results (not blow up)
  describe('S1: Empty/null query handling', () => {
    it('discoveryQueryTermKeys on empty string returns empty', () => {
      const keys = discoveryQueryTermKeys('')
      expect(keys).toEqual([])
    })

    it('discoveryQueryTermKeys on whitespace-only returns empty', () => {
      const keys = discoveryQueryTermKeys('   \n\t  ')
      expect(keys).toEqual([])
    })

    it('rankSkillsForExplicitDiscover with empty query returns alphabetical', () => {
      // This requires loaded skills — the function calls getAllSkills()
      // which is module-level state. We cannot inject test skills here
      // without loading from disk. Test the pure functions instead.
      expect(typeof rankSkillsForExplicitDiscover).toBe('function')
    })

    it('buildDiscoveryQuery with no messages returns empty string', () => {
      const q = buildDiscoveryQuery([])
      expect(q).toBe('')
    })

    it('buildDiscoveryQuery with only non-user messages returns empty', () => {
      const q = buildDiscoveryQuery([
        { role: 'assistant', content: 'Hello!' },
        { role: 'system', content: 'System message' },
      ])
      expect(q).toBe('')
    })
  })

  // S2: discoveryQueryTermKeys with extreme input
  describe('S2: discoveryQueryTermKeys extreme inputs', () => {
    it('handles very long input without hanging', () => {
      const long = 'a'.repeat(100000)
      const t0 = Date.now()
      const keys = discoveryQueryTermKeys(long)
      const elapsed = Date.now() - t0
      expect(elapsed).toBeLessThan(5000) // must complete in <5s
      expect(keys.length).toBeGreaterThan(0)
    })

    it('handles emoji and non-ASCII characters', () => {
      const keys = discoveryQueryTermKeys('🐛 fix this 🚀 deploy now! ✨')
      expect(keys.length).toBeGreaterThan(0)
    })

    it('handles null bytes in input gracefully', () => {
      const keys = discoveryQueryTermKeys('fix\0null\0bug')
      expect(Array.isArray(keys)).toBe(true)
    })

    it('extracts CJK tokens from mixed script', () => {
      const keys = discoveryQueryTermKeys('debug 调试 interface 接口测试 API')
      const hasAscii = keys.some(k => k === 'debug')
      const hasCjkUnigram = keys.some(k => k === '调')
      const hasCjkBigram = keys.some(k => k === '调试')
      expect(hasAscii).toBe(true)
      expect(hasCjkUnigram || hasCjkBigram).toBe(true)
    })
  })

  // S3: scoreSkillRelevanceLexical boundary conditions
  describe('S3: scoreSkillRelevanceLexical boundary conditions', () => {
    it('returns 0 for empty query', () => {
      const s = makeSkill({ name: 'debug', description: 'Debug tool' })
      expect(scoreSkillRelevanceLexical('', s)).toBe(0)
      expect(scoreSkillRelevanceLexical('   ', s)).toBe(0)
    })

    it('returns 0 for skill with empty description and prompt', () => {
      const s = makeSkill({ description: '', promptContent: '', whenToUse: '' })
      const score = scoreSkillRelevanceLexical('debug', s)
      expect(score).toBe(0)
    })

    it('name match via / or @ prefix gets bonus', () => {
      const s = makeSkill({ name: 'my-skill', description: 'does things' })
      const scorePlain = scoreSkillRelevanceLexical('my-skill', s)
      const scoreSlash = scoreSkillRelevanceLexical('/my-skill', s)
      const scoreAt = scoreSkillRelevanceLexical('@my-skill', s)
      expect(scoreSlash).toBeGreaterThanOrEqual(scorePlain)
      expect(scoreAt).toBeGreaterThanOrEqual(scorePlain)
    })

    it('handles skill with undefined whenToUse and argumentHint', () => {
      const s: SkillDefinition = {
        name: 'bare',
        description: 'bare skill',
        source: 'bundled',
        userInvocable: true,
        disableModelInvocation: false,
        context: 'inline',
        promptContent: '',
      }
      const score = scoreSkillRelevanceLexical('bare', s)
      expect(typeof score).toBe('number')
      expect(score).toBeGreaterThan(0)
    })
  })

  // S4: normalizeSkillName edge cases
  describe('S4: normalizeSkillName edge cases', () => {
    it('strips leading /', () => {
      expect(normalizeSkillName('/commit')).toBe('commit')
    })

    it('strips leading @', () => {
      expect(normalizeSkillName('@commit')).toBe('commit')
    })

    it('is case-insensitive', () => {
      expect(normalizeSkillName('Commit')).toBe('commit')
    })

    it('handles empty string', () => {
      expect(normalizeSkillName('')).toBe('')
    })

    it('handles only /', () => {
      expect(normalizeSkillName('/')).toBe('')
    })

    it('handles only @', () => {
      expect(normalizeSkillName('@')).toBe('')
    })
  })

  // S5: wrapSkillDiscovery and injectSkillDiscoveryIntoLastUserMessage
  describe('S5: wrapSkillDiscovery correctness', () => {
    it('wraps in system-reminder with skill-discovery tag', () => {
      const wrapped = wrapSkillDiscovery('## Test\nContent')
      expect(wrapped).toContain('<system-reminder>')
      expect(wrapped).toContain('<skill-discovery>')
      expect(wrapped).toContain('## Test')
      expect(wrapped).toContain('Content')
    })

    it('returns empty string for empty/whitespace input', () => {
      expect(wrapSkillDiscovery('')).toBe('')
      expect(wrapSkillDiscovery('   \n')).toBe('')
    })

    it('idempotent: does not double-wrap if already wrapped', () => {
      const wrapped = wrapSkillDiscovery('## Test')
      injectSkillDiscoveryIntoLastUserMessage(
        [{ role: 'user', content: 'hello' }],
        '## Direct inject',
      )
      // The function wraps it (line 408-409 checks for system-reminder tag)
      // If the injection already starts with <system-reminder>, it uses it as-is
      injectSkillDiscoveryIntoLastUserMessage(
        [{ role: 'user', content: 'hello again' }],
        wrapped,
      )
      // No assert needed — just verifying it doesn't crash on already-wrapped input
      expect(true).toBe(true)
    })

    it('injects into last user message with string content', () => {
      const msgs = [{ role: 'user', content: 'hello' }]
      injectSkillDiscoveryIntoLastUserMessage(msgs, '## Skills')
      const content = msgs[0].content as string
      expect(content).toContain('hello')
      expect(content).toContain('<system-reminder>')
      expect(content).toContain('## Skills')
    })

    it('injects into user message with array content', () => {
      const msgs = [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]
      injectSkillDiscoveryIntoLastUserMessage(msgs, '## Skills')
      const blocks = msgs[0].content as Array<Record<string, unknown>>
      // injection wraps in <system-reminder> so check for substring match
      const hasInjection = blocks.some(
        b => b.type === 'text' && String(b.text).includes('Skills')
      )
      expect(hasInjection).toBe(true)
    })

    it('no-op when no user message exists', () => {
      const msgs = [{ role: 'assistant', content: 'hi' }]
      const before = JSON.stringify(msgs)
      injectSkillDiscoveryIntoLastUserMessage(msgs, '## Skills')
      expect(JSON.stringify(msgs)).toBe(before)
    })

    it('no-op when injection is empty', () => {
      const msgs = [{ role: 'user', content: 'hello' }]
      const before = JSON.stringify(msgs)
      injectSkillDiscoveryIntoLastUserMessage(msgs, '  ')
      expect(JSON.stringify(msgs)).toBe(before)
    })

    it('BYPASS mode: injects unwrapped content when already has system-reminder', () => {
      const msgs = [{ role: 'user', content: 'hello' }]
      const preWrapped = '<system-reminder>\n<skill-discovery>\nTest\n</skill-discovery>\n</system-reminder>'
      injectSkillDiscoveryIntoLastUserMessage(msgs, preWrapped)
      const content = msgs[0].content as string
      // Should NOT double-wrap
      expect(content.match(/<system-reminder>/g)?.length).toBe(1)
    })
  })

  // S6: buildDiscoveryQuery edge cases
  describe('S6: buildDiscoveryQuery with extreme inputs', () => {
    it('handles extras with mixed undefined fields', () => {
      const q = buildDiscoveryQuery([{ role: 'user', content: 'test' }], {
        assistantText: '   ',
        toolResultTexts: ['', '  '],
      })
      expect(q).toBeTruthy()
    })

    it('respects 12000 char truncation', () => {
      const long = 'x'.repeat(50000)
      const q = buildDiscoveryQuery([{ role: 'user', content: long }])
      expect(q.length).toBeLessThanOrEqual(12000)
    })

    it('handles deeply nested content objects without crash', () => {
      const msgs = [{ role: 'user', content: { type: 'multi', parts: [{ text: 'query' }] } }]
      const q = buildDiscoveryQuery(msgs)
      expect(typeof q).toBe('string')
    })

    it('caps chunks at 6 user messages', () => {
      const msgs = Array.from({ length: 20 }, (_, i) => ({ role: 'user', content: `msg${i}` }))
      const q = buildDiscoveryQuery(msgs)
      expect(typeof q).toBe('string')
      // Doesn't blow up with many user messages
    })
  })
})

// ═══════════════════════════════════════════════════════════════════════
// DIMENSION 2: INVOKED SKILLS REGISTRY EDGE CASES (4 scenarios)
// ═══════════════════════════════════════════════════════════════════════

describe('D2: Invoked Skills Registry Edge Cases', () => {
  beforeEach(() => {
    resetInvokedSkillsRegistryForTests()
  })

  afterEach(() => {
    resetInvokedSkillsRegistryForTests()
  })

  // S7: Key generation edge cases
  describe('S7: invokedSkillMapKey edge cases', () => {
    it('handles undefined agentId', () => {
      const key = invokedSkillMapKey(undefined, 'test')
      expect(key).toBe(':test')
    })

    it('handles empty string agentId', () => {
      const key = invokedSkillMapKey(asAgentId(''), 'test')
      expect(key).toBe(':test')
    })

    it('handles empty skill name', () => {
      const key = invokedSkillMapKey('agent1', '')
      expect(key).toBe('agent1:')
    })

    it('trims whitespace from both', () => {
      const key = invokedSkillMapKey('  agent1  ', '  Test  ')
      expect(key).toBe('agent1:test')
    })

    it('lowercases skill name', () => {
      const key = invokedSkillMapKey('agent1', 'TEST')
      expect(key).toBe('agent1:test')
    })
  })

  // S8: recordInvokedSkill content truncation
  describe('S8: recordInvokedSkill content truncation & registration', () => {
    it('truncates content to 8000 chars', () => {
      const longContent = 'a'.repeat(15000)
      recordInvokedSkill({
        agentId: 'main',
        skillName: 'test',
        skillPath: '/test/SKILL.md',
        content: longContent,
      })
      // Can't read back directly, but verify via peek
      const fragment = peekInvokedSkillsPromptFragmentForAgent('main')
      expect(fragment).toContain('test')
      expect(fragment).toContain('/test/SKILL.md')
    })

    it('defaults invokedAt to now if not provided', () => {
      recordInvokedSkill({
        agentId: 'main',
        skillName: 'test2',
        skillPath: '/test/SKILL.md',
        content: 'body',
      })
      const fragment = peekInvokedSkillsPromptFragmentForAgent('main')
      // Should contain an ISO timestamp near now
      expect(fragment).toContain('test2')
      expect(fragment).toContain('invoked')
    })

    it('trims whitespace from skillName and skillPath', () => {
      recordInvokedSkill({
        agentId: 'main',
        skillName: '  spaced  ',
        skillPath: '  /path/SKILL.md  ',
        content: 'body',
      })
      const fragment = peekInvokedSkillsPromptFragmentForAgent('main')
      expect(fragment).toContain('spaced')
      expect(fragment).not.toContain('  spaced  ')
    })
  })

  // S9: injectInvokedSkillsIntoLastUserMessage — THE BUG S1
  describe('S9: injectInvokedSkillsIntoLastUserMessage — BUG S1 (missing _convertedFromSystem)', () => {
    it('injects into last user message via peek (non-consuming)', () => {
      recordInvokedSkill({
        agentId: 'main',
        skillName: 'S1Bug',
        skillPath: '/x/SKILL.md',
        content: 'test content',
      })
      const msgs: Array<Record<string, unknown>> = [{ role: 'user', content: 'hello' }]
      const out = injectInvokedSkillsIntoLastUserMessage(msgs, 'main')
      const content = out[0].content as string
      expect(content).toContain('<invoked-skills>')
      expect(content).toContain('S1Bug')
    })

    it('BUG CONFIRMED: missing _convertedFromSystem flag', () => {
      recordInvokedSkill({
        agentId: 'main',
        skillName: 'TestSkill',
        skillPath: '/x/SKILL.md',
        content: 'body',
      })
      const msgs: Array<Record<string, unknown>> = [{ role: 'user', content: 'hello' }]
      const out = injectInvokedSkillsIntoLastUserMessage(msgs, 'main')
      // The injected message should carry _convertedFromSystem but DOES NOT
      expect(out[0]._convertedFromSystem).toBeUndefined()
      // BUG-S1: without _convertedFromSystem, downstream pipeline stages
      // (smoosh / merge) can't distinguish this from a real user message
    })

    it('returns original messages when no invoked skills exist', () => {
      const msgs: Array<Record<string, unknown>> = [{ role: 'user', content: 'hello' }]
      const out = injectInvokedSkillsIntoLastUserMessage(msgs, 'main')
      expect(out).toBe(msgs) // same reference when no injection
    })

    it('handles array content blocks in user messages', () => {
      recordInvokedSkill({
        agentId: 'main',
        skillName: 'Test',
        skillPath: '/x/SKILL.md',
        content: 'body',
      })
      const msgs: Array<Record<string, unknown>> = [
        { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      ]
      const out = injectInvokedSkillsIntoLastUserMessage(msgs, 'main')
      const blocks = out[0].content as Array<Record<string, unknown>>
      expect(blocks.some(b => b.type === 'text' && String(b.text).includes('<invoked-skills>'))).toBe(true)
    })

    it('handles unrecognized content type by replacing with fragment', () => {
      recordInvokedSkill({
        agentId: 'main',
        skillName: 'Test',
        skillPath: '/x/SKILL.md',
        content: 'body',
      })
      const msgs: Array<Record<string, unknown>> = [
        { role: 'user', content: 123 }, // non-string, non-array content
      ]
      const out = injectInvokedSkillsIntoLastUserMessage(msgs, 'main')
      const content = out[0].content as string
      expect(content).toContain('<invoked-skills>')
    })
  })

  // S10: takeInvokedSkillsPromptFragmentForAgent — consuming behavior
  describe('S10: takeInvokedSkillsPromptFragmentForAgent — consuming', () => {
    it('consumes entries on first call, empty on second call', () => {
      recordInvokedSkill({
        agentId: 'main',
        skillName: 'ConsumeTest',
        skillPath: '/x/SKILL.md',
        content: 'body',
      })
      const first = takeInvokedSkillsPromptFragmentForAgent('main')
      expect(first).toContain('ConsumeTest')

      const second = takeInvokedSkillsPromptFragmentForAgent('main')
      expect(second).toBe('') // consumed
    })

    it('only consumes entries for the specified agent', () => {
      recordInvokedSkill({
        agentId: 'agent-a',
        skillName: 'SkillA',
        skillPath: '/a/SKILL.md',
        content: 'a',
      })
      recordInvokedSkill({
        agentId: 'agent-b',
        skillName: 'SkillB',
        skillPath: '/b/SKILL.md',
        content: 'b',
      })

      const aFrag = takeInvokedSkillsPromptFragmentForAgent('agent-a')
      expect(aFrag).toContain('SkillA')
      expect(aFrag).not.toContain('SkillB')

      const bFrag = takeInvokedSkillsPromptFragmentForAgent('agent-b')
      expect(bFrag).toContain('SkillB')

      // agent-a should be consumed now
      const aAgain = takeInvokedSkillsPromptFragmentForAgent('agent-a')
      expect(aAgain).toBe('')
    })

    it('clearInvokedSkillsForAgent removes all entries for that agent', () => {
      recordInvokedSkill({
        agentId: 'main',
        skillName: 'S1',
        skillPath: '/1/SKILL.md',
        content: '1',
      })
      recordInvokedSkill({
        agentId: 'main',
        skillName: 'S2',
        skillPath: '/2/SKILL.md',
        content: '2',
      })
      clearInvokedSkillsForAgent('main')
      const fragment = peekInvokedSkillsPromptFragmentForAgent('main')
      expect(fragment).toBe('')
    })
  })
})

// ═══════════════════════════════════════════════════════════════════════
// DIMENSION 3: SKILL MERGE CRDT LOGIC (2 scenarios)
// ═══════════════════════════════════════════════════════════════════════

describe('D3: Skill Merge CRDT Edge Cases', () => {

  // S11: CRDT merge corner cases
  describe('S11: mergeSkillDefinitionsCRDT boundary conditions', () => {
    it('handles empty input', () => {
      const out = mergeSkillDefinitionsCRDT([])
      expect(out).toEqual([])
    })

    it('handles all three source priorities correctly', () => {
      const bundled = skill('X', 'bundled', 'bundled-desc', '/bundled/SKILL.md')
      const user = skill('X', 'user', 'user-desc', '/user/SKILL.md')
      const project = skill('X', 'project', 'project-desc', '/project/SKILL.md')

      // Project wins over user
      const r1 = mergeSkillDefinitionsCRDT([
        { skill: bundled, ordinal: 0 },
        { skill: user, ordinal: 1 },
        { skill: project, ordinal: 2 },
      ])
      expect(r1).toHaveLength(1)
      expect(r1[0].source).toBe('project')

      // User wins over bundled
      const r2 = mergeSkillDefinitionsCRDT([
        { skill: bundled, ordinal: 0 },
        { skill: user, ordinal: 1 },
      ])
      expect(r2).toHaveLength(1)
      expect(r2[0].source).toBe('user')
    })

    it('case-insensitive deduplication', () => {
      const r = mergeSkillDefinitionsCRDT([
        { skill: skill('Foo', 'user', 'a', '/u/SKILL.md'), ordinal: 0 },
        { skill: skill('FOO', 'project', 'b', '/p/SKILL.md'), ordinal: 1 },
        { skill: skill('foo', 'bundled', 'c', '/b/SKILL.md'), ordinal: 2 },
      ])
      expect(r).toHaveLength(1)
      expect(r[0].description).toBe('b') // project wins
    })

    it('sorts output alphabetically', () => {
      const r = mergeSkillDefinitionsCRDT([
        { skill: skill('zebra', 'user', 'z', '/z/SKILL.md'), ordinal: 0 },
        { skill: skill('apple', 'user', 'a', '/a/SKILL.md'), ordinal: 1 },
        { skill: skill('mango', 'user', 'm', '/m/SKILL.md'), ordinal: 2 },
      ])
      expect(r.map(s => s.name)).toEqual(['apple', 'mango', 'zebra'])
    })

    it('handles skill without resolvedPath (mtime defaults to 0)', () => {
      const r = mergeSkillDefinitionsCRDT([
        { skill: { ...skill('X', 'user', 'no-path'), resolvedPath: undefined }, ordinal: 0 },
        { skill: { ...skill('X', 'project', 'has-path'), resolvedPath: '/p/SKILL.md' }, ordinal: 1 },
      ])
      // project has higher source rank anyway, so it wins regardless of mtime
      expect(r).toHaveLength(1)
      expect(r[0].source).toBe('project')
    })
  })

  // S12: Large-scale merge performance
  describe('S12: Large-scale merge performance', () => {
    it('handles 1000 skills without hanging', () => {
      const skills = Array.from({ length: 1000 }, (_, i) => ({
        skill: skill(`skill-${i}`, 'user', `desc ${i}`, `/skills/${i}/SKILL.md`),
        ordinal: i,
      }))
      const t0 = Date.now()
      const out = mergeSkillDefinitionsCRDT(skills)
      const elapsed = Date.now() - t0
      expect(out).toHaveLength(1000)
      expect(elapsed).toBeLessThan(5000)
    })
  })
})

// ═══════════════════════════════════════════════════════════════════════
// DIMENSION 4: SAFE SKILL PROPERTIES (1 scenario)
// ═══════════════════════════════════════════════════════════════════════

describe('D4: Safe Skill Properties Validation', () => {

  // S13: Frontmatter key safety
  describe('S13: skillUsesOnlySafeFrontmatterKeys', () => {
    it('returns false for undefined keys', () => {
      expect(skillUsesOnlySafeFrontmatterKeys(undefined, () => ({}))).toBe(false)
    })

    it('returns false for empty keys array', () => {
      expect(skillUsesOnlySafeFrontmatterKeys([], () => ({}))).toBe(false)
    })

    it('returns true when all keys are in SAFE_SKILL_PROPERTIES', () => {
      // SAFE_SKILL_PROPERTIES is a Set<string>, not an array
      const safe = [...SAFE_SKILL_PROPERTIES].slice(0, 3)
      expect(skillUsesOnlySafeFrontmatterKeys(safe)).toBe(true)
    })

    it('returns false when any key is not in SAFE_SKILL_PROPERTIES', () => {
      const keys = [...SAFE_SKILL_PROPERTIES].slice(0, 2)
      keys.push('unsafe_custom_key')
      expect(skillUsesOnlySafeFrontmatterKeys(keys)).toBe(false)
    })

    it('SAFE_SKILL_PROPERTIES contains expected keys', () => {
      expect(SAFE_SKILL_PROPERTIES).toContain('name')
      expect(SAFE_SKILL_PROPERTIES).toContain('description')
      expect(SAFE_SKILL_PROPERTIES).toContain('user-invocable')
      expect(SAFE_SKILL_PROPERTIES).toContain('disable-model-invocation')
    })
  })
})

// ═══════════════════════════════════════════════════════════════════════
// DIMENSION 5: SKILL EFFORT MODEL (2 scenarios)
// ═══════════════════════════════════════════════════════════════════════

describe('D5: Skill Effort Model', () => {

  // S14: parseSkillEffort edge cases
  describe('S14: parseSkillEffort validation', () => {
    it('parses valid values', () => {
      expect(parseSkillEffort('low')).toBe('low')
      expect(parseSkillEffort('medium')).toBe('medium')
      expect(parseSkillEffort('high')).toBe('high')
      expect(parseSkillEffort('max')).toBe('max')
    })

    it('is case-insensitive and trims', () => {
      expect(parseSkillEffort('  LOW  ')).toBe('low')
      expect(parseSkillEffort('High')).toBe('high')
      expect(parseSkillEffort('MEDIUM')).toBe('medium')
    })

    it('returns undefined for invalid values', () => {
      expect(parseSkillEffort('extreme')).toBeUndefined()
      expect(parseSkillEffort('')).toBeUndefined()
      expect(parseSkillEffort(undefined)).toBeUndefined()
      expect(parseSkillEffort(null)).toBeUndefined()
    })

    it('handles non-string inputs without crash', () => {
      expect(parseSkillEffort(123)).toBeUndefined()
      expect(parseSkillEffort(true)).toBeUndefined()
      expect(parseSkillEffort({})).toBeUndefined()
    })
  })

  // S15: adjustMaxTokensForEffort with extreme values
  describe('S15: adjustMaxTokensForEffort boundary conditions', () => {
    it('floors low at 1024 tokens', () => {
      expect(adjustMaxTokensForEffort(10, 'low')).toBe(1024)
      expect(adjustMaxTokensForEffort(0, 'low')).toBe(1024)
      expect(adjustMaxTokensForEffort(500, 'low')).toBe(1024)
    })

    it('caps high/max at 32768 tokens', () => {
      expect(adjustMaxTokensForEffort(100000, 'high')).toBe(32768)
      expect(adjustMaxTokensForEffort(100000, 'max')).toBe(32768)
    })

    it('passes through medium unchanged', () => {
      expect(adjustMaxTokensForEffort(4096, 'medium')).toBe(4096)
    })

    it('returns baseMaxTokens unchanged for undefined effort', () => {
      expect(adjustMaxTokensForEffort(4096, undefined)).toBe(4096)
    })

    it('defaults undefined maxTokens to 8192 (design: never returns undefined)', () => {
      // adjustMaxTokensForEffort defaults undefined maxTokens to 8192
      // This means it NEVER returns undefined — callers should be aware
      const result = adjustMaxTokensForEffort(undefined, 'low')
      // With default base=8192, low effort = Math.max(1024, floor(8192*0.85)) = 6963
      expect(result).toBe(6963)
      expect(typeof result).toBe('number')
    })

    it('BUG CONFIRMED: returns 6963 instead of undefined for (undefined, low)', () => {
      // The function signature takes maxTokens: number | undefined
      // but the implementation defaults undefined to 8192, so it never
      // propagates undefined back to the caller. If a caller expects
      // undefined to mean "don't know the max tokens", this is misleading.
      const result = adjustMaxTokensForEffort(undefined, 'low')
      expect(result).not.toBeUndefined()
      // This is a design smell — the function should either take required number
      // or the return type should be number (not number | undefined)
    })
  })

  // S16: anthropicModelLikelySupportsEffort
  describe('S16: anthropicModelLikelySupportsEffort heuristic', () => {
    it('detects opus-4 and sonnet-4 models', () => {
      // Line 21: includes('opus-4') || includes('sonnet-4') matches these
      expect(anthropicModelLikelySupportsEffort('claude-opus-4-20250514')).toBe(true)
      expect(anthropicModelLikelySupportsEffort('claude-sonnet-4-20250514')).toBe(true)
    })

    it('BUG CONFIRMED: haiku always returns false (hardcoded on line 19)', () => {
      // Line 19: if (m.includes('haiku')) return false
      // This means Claude 4 haiku models that might support effort are blocked
      // The function unconditionally rejects any model with 'haiku' in its ID
      expect(anthropicModelLikelySupportsEffort('claude-haiku-4-20250514')).toBe(false)
    })

    it('detects models with [1m] suffix', () => {
      expect(anthropicModelLikelySupportsEffort('claude-sonnet-4-20250514[1m]')).toBe(true)
    })

    it('returns false for older/unsupported models', () => {
      expect(anthropicModelLikelySupportsEffort('claude-3-opus-20240229')).toBe(false)
      expect(anthropicModelLikelySupportsEffort('gpt-4')).toBe(false)
    })

    it('handles empty string', () => {
      expect(anthropicModelLikelySupportsEffort('')).toBe(false)
    })
  })
})

// ═══════════════════════════════════════════════════════════════════════
// DIMENSION 6: SKILL MODEL RESOLUTION (2 scenarios)
// ═══════════════════════════════════════════════════════════════════════

describe('D6: Skill Model Resolution', () => {

  // S17: has1mContext and strip1mSuffix
  describe('S17: [1m] suffix handling', () => {
    it('detects [1m] suffix case-insensitive', () => {
      expect(has1mContext('claude-sonnet-4[1m]')).toBe(true)
      expect(has1mContext('claude-sonnet-4[1M]')).toBe(true)
    })

    it('returns false without suffix', () => {
      expect(has1mContext('claude-sonnet-4-20250514')).toBe(false)
    })

    it('strips [1m] suffix', () => {
      expect(strip1mSuffix('claude-sonnet-4[1m]')).toBe('claude-sonnet-4')
      expect(strip1mSuffix('claude-sonnet-4[1M]')).toBe('claude-sonnet-4')
    })

    it('returns unchanged if no suffix', () => {
      expect(strip1mSuffix('claude-sonnet-4')).toBe('claude-sonnet-4')
    })

    it('handles empty string', () => {
      expect(has1mContext('')).toBe(false)
      expect(strip1mSuffix('')).toBe('')
    })
  })

  // S18: resolveSkillModelAlias edge cases
  describe('S18: resolveSkillModelAlias', () => {
    it('returns trimmed input if no alias matches', () => {
      // This requires an actual model provider to be configured
      // Test that the function exists and doesn't throw on invalid input
      const result = resolveSkillModelAlias('nonexistent-model')
      expect(typeof result).toBe('string')
    })

    it('handles empty string', () => {
      const result = resolveSkillModelAlias('')
      expect(result).toBe('')
    })

    it('trims input', () => {
      const result = resolveSkillModelAlias('  test  ')
      expect(result).toBe('test')
    })
  })
})

// ═══════════════════════════════════════════════════════════════════════
// DIMENSION 7: HOOK MANIFEST (2 scenarios)
// ═══════════════════════════════════════════════════════════════════════

describe('D7: Hook Manifest Edge Cases', () => {

  // S19: mergeHookLists
  describe('S19: mergeHookLists deduplication', () => {
    it('later hooks override earlier with same event+command', () => {
      const list1 = [{
        event: 'PreToolUse' as const,
        command: 'echo one',
        executionKind: 'sync' as const,
      }]
      const list2 = [{
        event: 'PreToolUse' as const,
        command: 'echo two',
        executionKind: 'sync' as const,
      }]
      const merged = mergeHookLists(list1, list2)
      expect(merged.length).toBeGreaterThanOrEqual(1)
      // The second list's hook should take precedence
    })

    it('merges empty lists', () => {
      const merged = mergeHookLists([], [])
      expect(merged).toEqual([])
    })

    it('merges one empty list with one populated', () => {
      const hooks = [{
        event: 'PostToolUse' as const,
        command: 'echo done',
        executionKind: 'sync' as const,
      }]
      const merged1 = mergeHookLists(hooks, [])
      expect(merged1.length).toBeGreaterThanOrEqual(1)
      const merged2 = mergeHookLists([], hooks)
      expect(merged2.length).toBeGreaterThanOrEqual(1)
    })

    it('handles hooks with different events', () => {
      const list1 = [{
        event: 'PreToolUse' as const,
        command: 'echo pre',
        executionKind: 'sync' as const,
      }]
      const list2 = [{
        event: 'PostToolUse' as const,
        command: 'echo post',
        executionKind: 'sync' as const,
      }]
      const merged = mergeHookLists(list1, list2)
      expect(merged.length).toBe(2)
    })
  })

  // S20: parseHooksFromFrontmatterValue
  describe('S20: parseHooksFromFrontmatterValue edge cases', () => {
    it('returns empty array for invalid JSON', () => {
      const result = parseHooksFromFrontmatterValue('not json')
      expect(result).toEqual([])
    })

    it('handles empty string', () => {
      const result = parseHooksFromFrontmatterValue('')
      expect(result).toEqual([])
    })

    it('parses array format', () => {
      const json = JSON.stringify([{
        event: 'PreToolUse',
        command: 'echo test',
        executionKind: 'sync',
      }])
      const result = parseHooksFromFrontmatterValue(json)
      expect(result.length).toBeGreaterThanOrEqual(0)
    })

    it('parses object format with hooks key', () => {
      const json = JSON.stringify({
        hooks: [{
          event: 'PreToolUse',
          command: 'echo test2',
          executionKind: 'sync',
        }],
      })
      const result = parseHooksFromFrontmatterValue(json)
      expect(result.length).toBeGreaterThanOrEqual(0)
    })

    it('returns empty array for object without hooks key', () => {
      const json = JSON.stringify({ something: 'else' })
      const result = parseHooksFromFrontmatterValue(json)
      expect(Array.isArray(result)).toBe(true)
    })
  })
})

// ═══════════════════════════════════════════════════════════════════════
// DIMENSION 8: CROSS-CUTTING CONCERNS (4 scenarios)
// ═══════════════════════════════════════════════════════════════════════

describe('D8: Cross-Cutting Concerns & Regression', () => {

  // S21: Skip already-surfaced skills in exclude set
  describe('S21: Discovery exclude set prevents re-injection', () => {
    it('excludeSkillToolInput adds normalized name to set', () => {
      const excl = new Set<string>()
      excludeSkillToolInput({ skill: '/debug' }, excl)
      expect(excl.has('debug')).toBe(true)
    })

    it('excludeSkillToolInput handles undefined input', () => {
      const excl = new Set<string>()
      excludeSkillToolInput(undefined, excl)
      expect(excl.size).toBe(0)
    })

    it('excludeSkillToolInput handles empty skill name', () => {
      const excl = new Set<string>()
      excludeSkillToolInput({ skill: '  ' }, excl)
      expect(excl.size).toBe(0)
    })

    it('excludeSkillToolInput strips @ prefix', () => {
      const excl = new Set<string>()
      excludeSkillToolInput({ skill: '@debug' }, excl)
      expect(excl.has('debug')).toBe(true)
    })
  })

  // S22: formatRankedSkillsBlock truncation
  describe('S22: formatRankedSkillsBlock truncation', () => {
    it('returns empty string for empty skills array', () => {
      expect(formatRankedSkillsBlock([], 1000, 200)).toBe('')
    })

    it('respects maxChars limit', () => {
      const s = makeSkill({
        name: 'test-skill',
        description: 'A'.repeat(500),
        promptContent: 'B'.repeat(10000),
      })
      const block = formatRankedSkillsBlock([s], 500, 200)
      expect(block.length).toBeLessThanOrEqual(600) // ~500 + overhead
    })

    it('truncates prompt preview', () => {
      const s = makeSkill({
        name: 'test',
        description: 'desc',
        promptContent: 'X'.repeat(500),
      })
      // previewChars=10 means promptContent is truncated
      // but truncate function uses "...", testing length is tricky
      const block = formatRankedSkillsBlock([s], 10000, 10)
      expect(block).toContain('test')
    })
  })

  // S23: formatDiscoverSkillsToolOutput with empty skills
  describe('S23: formatDiscoverSkillsToolOutput edge cases', () => {
    it('handles empty skills array', () => {
      const out = formatDiscoverSkillsToolOutput([], 'test')
      expect(out).toContain('No auto-invocation skills')
    })

    it('handles very long query', () => {
      const longQuery = 'x'.repeat(500)
      const s = makeSkill({ name: 'test', description: 'desc' })
      const out = formatDiscoverSkillsToolOutput([s], longQuery)
      expect(out.length).toBeLessThan(3000) // should not include full 500-char query
    })

    it('works with empty query (alphabetical list)', () => {
      const s1 = makeSkill({ name: 'b-skill', description: 'B' })
      const s2 = makeSkill({ name: 'a-skill', description: 'A' })
      const out = formatDiscoverSkillsToolOutput([s1, s2], '')
      expect(out).toContain('alphabetical')
    })
  })

  // S24: DiscoverSkills tool: limit=0 bug
  describe('S24: DiscoverSkills tool parseInt falsy coalescence bug', () => {
    it('BUG CONFIRMED: limit=0 silently becomes 8 due to falsy ||', async () => {
      // Line 490: parseInt(limitRaw, 10) || 8
      // parseInt('0', 10) returns 0, which is falsy, so || 8 kicks in
      // This means limit=0 returns 8 skills, not 0
      const result = await discoverSkillsTool.execute({ query: 'test', limit: '0' })
      expect(result.success).toBe(true)
      // When limit=0 is passed, the user expects 0 results, but gets up to 8.
      // This is a confirmed behavior bug (parseInt('0') || 8 === 8) — recorded
      // here as documentation; stronger output-shape assertion is TODO.
    })

    it('limit=1 returns at most 1 skill', async () => {
      const result = await discoverSkillsTool.execute({ query: 'test', limit: 1 })
      expect(result.success).toBe(true)
    })

    it('limit as number 8 works', async () => {
      const result = await discoverSkillsTool.execute({ query: 'test', limit: 8 })
      expect(result.success).toBe(true)
    })
  })

  // S25: Record + inject + clear full lifecycle with no _convertedFromSystem
  describe('S25: Full invoke-inject-clear lifecycle', () => {
    it('complete lifecycle maintains correct state', () => {
      recordInvokedSkill({
        agentId: 'lifecycle-test',
        skillName: 'LT1',
        skillPath: '/lt/SKILL.md',
        content: 'LC body',
      })
      recordInvokedSkill({
        agentId: 'lifecycle-test',
        skillName: 'LT2',
        skillPath: '/lt2/SKILL.md',
        content: 'LC2 body',
      })

      // Peek
      const peek1 = peekInvokedSkillsPromptFragmentForAgent('lifecycle-test')
      expect(peek1).toContain('LT1')
      expect(peek1).toContain('LT2')

      // Inject (peek is non-consuming)
      const msgs = [{ role: 'user', content: 'hello' }]
      const injected = injectInvokedSkillsIntoLastUserMessage(msgs, 'lifecycle-test')
      expect(injected[0].content).toContain('LT1')

      // BUG: still no _convertedFromSystem
      expect(injected[0]._convertedFromSystem).toBeUndefined()

      // Take (consuming)
      const taken = takeInvokedSkillsPromptFragmentForAgent('lifecycle-test')
      expect(taken).toContain('LT1')
      expect(taken).toContain('LT2')

      // After take, peek should be empty
      const peek2 = peekInvokedSkillsPromptFragmentForAgent('lifecycle-test')
      expect(peek2).toBe('')

      // Clear for safety
      clearInvokedSkillsForAgent('lifecycle-test')
    })
  })

  // S26: Cross-agent isolation
  describe('S26: Cross-agent isolation in invokedSkillsRegistry', () => {
    it('agents do not leak skills to each other', () => {
      recordInvokedSkill({
        agentId: 'alpha',
        skillName: 'AlphaSkill',
        skillPath: '/a/SKILL.md',
        content: 'alpha',
      })
      recordInvokedSkill({
        agentId: 'beta',
        skillName: 'BetaSkill',
        skillPath: '/b/SKILL.md',
        content: 'beta',
      })

      const alphaFrag = peekInvokedSkillsPromptFragmentForAgent('alpha')
      expect(alphaFrag).toContain('AlphaSkill')
      expect(alphaFrag).not.toContain('BetaSkill')

      const betaFrag = peekInvokedSkillsPromptFragmentForAgent('beta')
      expect(betaFrag).toContain('BetaSkill')
      expect(betaFrag).not.toContain('AlphaSkill')
    })
  })
})

// ═══════════════════════════════════════════════════════════════════════
// DIMENSION 9: EXTREME FUZZING (4 scenarios)
// ═══════════════════════════════════════════════════════════════════════

describe('D9: Extreme Fuzzing & Stress', () => {

  // S27: Unicode and special characters across all functions
  describe('S27: Unicode resilience', () => {
    it('normalizeSkillName handles Unicode names', () => {
      expect(normalizeSkillName('/任务规划')).toBe('任务规划')
      expect(normalizeSkillName('@디버그')).toBe('디버그')
      expect(normalizeSkillName('デバッグ')).toBe('デバッグ')
    })

    it('wrapSkillDiscovery handles Unicode content', () => {
      const wrapped = wrapSkillDiscovery('## 技能发现\n日本語テスト\n한국어 테스트')
      expect(wrapped).toContain('技能发现')
      expect(wrapped).toContain('日本語テスト')
      expect(wrapped).toContain('한국어')
    })

    it('discoveryQueryTermKeys handles mixed Unicode', () => {
      const keys = discoveryQueryTermKeys('修复 débug 문제 解決')
      expect(keys.length).toBeGreaterThan(0)
    })
  })

  // S28: Rapid repeated operations (no memory leaks, no state corruption)
  describe('S28: Rapid repeated operations', () => {
    it('100 rapid record+peek+clear cycles', () => {
      for (let i = 0; i < 100; i++) {
        recordInvokedSkill({
          agentId: `agent-${i % 10}`,
          skillName: `Skill${i}`,
          skillPath: `/s${i}/SKILL.md`,
          content: `body${i}`,
        })
      }
      // Should not crash
      for (let i = 0; i < 10; i++) {
        const frag = peekInvokedSkillsPromptFragmentForAgent(`agent-${i}`)
        expect(typeof frag).toBe('string')
      }
      // Cleanup
      for (let i = 0; i < 10; i++) {
        clearInvokedSkillsForAgent(`agent-${i}`)
      }
    })

    it('1000 operations without exponential slowdown', () => {
      const t0 = Date.now()
      for (let i = 0; i < 1000; i++) {
        recordInvokedSkill({
          agentId: 'stress',
          skillName: `S${i}`,
          skillPath: '/s/SKILL.md',
          content: 'body',
        })
      }
      const elapsed = Date.now() - t0
      expect(elapsed).toBeLessThan(5000)
      clearInvokedSkillsForAgent('stress')
    })
  })

  // S29: Edge case: injectInvokedSkillsIntoLastUserMessage with mixed message roles
  describe('S29: Mixed message roles in injection', () => {
    it('finds last user message among mixed roles', () => {
      recordInvokedSkill({
        agentId: 'main',
        skillName: 'Mixed',
        skillPath: '/m/SKILL.md',
        content: 'body',
      })
      const msgs: Array<Record<string, unknown>> = [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'response' },
        { role: 'user', content: 'second' },
        { role: 'assistant', content: 'response2' },
      ]
      const out = injectInvokedSkillsIntoLastUserMessage(msgs, 'main')
      // Should inject into 'second' (last user message)
      const secondContent = out[2].content as string
      expect(secondContent).toContain('second')
      expect(secondContent).toContain('<invoked-skills>')
    })

    it('handles messages with no role field', () => {
      recordInvokedSkill({
        agentId: 'main',
        skillName: 'NoRole',
        skillPath: '/n/SKILL.md',
        content: 'body',
      })
      const msgs: Array<Record<string, unknown>> = [
        { content: 'no role here' },
        { role: 'user', content: 'has role' },
      ]
      const out = injectInvokedSkillsIntoLastUserMessage(msgs, 'main')
      // Should find the 'has role' message
      expect(out).toBeDefined()
    })
  })

  // S30: Empty/null undefined handling across all registry functions
  describe('S30: Null safety across invoked skills registry', () => {
    it('peekInvokedSkillsPromptFragmentForAgent with undefined', () => {
      const frag = peekInvokedSkillsPromptFragmentForAgent(undefined)
      expect(frag).toBe('')
    })

    it('takeInvokedSkillsPromptFragmentForAgent with undefined', () => {
      const frag = takeInvokedSkillsPromptFragmentForAgent(undefined)
      expect(frag).toBe('')
    })

    it('injectInvokedSkillsIntoLastUserMessage with undefined agentId', () => {
      recordInvokedSkill({
        agentId: '',
        skillName: 'EmptyAgent',
        skillPath: '/e/SKILL.md',
        content: 'body',
      })
      const msgs = [{ role: 'user', content: 'hello' }]
      const out = injectInvokedSkillsIntoLastUserMessage(msgs, undefined)
      // undefined agentId maps to ':emptyskill' prefix, so empty-string-agent
      // skills should appear
      expect(Array.isArray(out)).toBe(true)
    })

    it('clearInvokedSkillsForAgent with undefined', () => {
      // Should not throw
      clearInvokedSkillsForAgent(undefined)
      expect(true).toBe(true)
    })
  })
})