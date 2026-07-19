/**
 * Regression test for the 2026-06 invoked-skills per-agent cap.
 *
 * Before the fix, a stream of DISTINCT skill names grew an agent's slice of
 * the registry without limit (the main chat never runs the sub-agent
 * lifecycle cleanup that drains it).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  recordInvokedSkill,
  peekInvokedSkillsPromptFragmentForAgent,
  resetInvokedSkillsRegistryForTests,
} from './invokedSkillsRegistry'
import { asAgentId } from '../tools/ids'

const MAIN = asAgentId('main')

function fragmentSkillCount(agentId = MAIN): number {
  const frag = peekInvokedSkillsPromptFragmentForAgent(agentId)
  return (frag.match(/^- \*\*/gm) ?? []).length
}

describe('invokedSkills per-agent cap', () => {
  beforeEach(() => resetInvokedSkillsRegistryForTests())
  afterEach(() => resetInvokedSkillsRegistryForTests())

  it('repeat invocations of the same skill stay bounded to 1 entry', () => {
    for (let i = 0; i < 500; i++) {
      recordInvokedSkill({ agentId: MAIN, skillName: 'verify', skillPath: '/s/verify', content: 'b' })
    }
    expect(fragmentSkillCount()).toBe(1)
  })

  it('distinct skill names are capped per agent (no unbounded growth)', () => {
    for (let i = 0; i < 500; i++) {
      recordInvokedSkill({ agentId: MAIN, skillName: `dyn-${i}`, skillPath: `/s/${i}`, content: 'b' })
    }
    // Capped well below 500 (MAX_INVOKED_SKILLS_PER_AGENT = 128).
    expect(fragmentSkillCount()).toBeLessThanOrEqual(128)
  })

  it('the cap retains the most-recently invoked skills', () => {
    for (let i = 0; i < 300; i++) {
      recordInvokedSkill({ agentId: MAIN, skillName: `k-${i}`, skillPath: `/s/${i}`, content: 'b' })
    }
    const frag = peekInvokedSkillsPromptFragmentForAgent(MAIN)
    // Newest survives, oldest evicted.
    expect(frag.includes('**k-299**')).toBe(true)
    expect(frag.includes('**k-0**')).toBe(false)
  })

  it('cap is per-agent: separate agents do not evict each other', () => {
    const a = asAgentId('agent-a')
    const b = asAgentId('agent-b')
    for (let i = 0; i < 200; i++) {
      recordInvokedSkill({ agentId: a, skillName: `a-${i}`, skillPath: '/s', content: 'b' })
      recordInvokedSkill({ agentId: b, skillName: `b-${i}`, skillPath: '/s', content: 'b' })
    }
    expect(fragmentSkillCount(a)).toBeLessThanOrEqual(128)
    expect(fragmentSkillCount(b)).toBeLessThanOrEqual(128)
    expect(fragmentSkillCount(a)).toBeGreaterThan(0)
    expect(fragmentSkillCount(b)).toBeGreaterThan(0)
  })
})
