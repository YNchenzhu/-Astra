/**
 * Self-audit fix B3 (2026-05) — pins G14 fix:
 *   - `skillForkRunner.runSkillFork` clears invoked-skill entries
 *     scoped to the fork's agentId in its `finally` block
 *   - `subAgentLifecycleCleanup.finalizeSubAgentLifecycle` does the same
 *     for general sub-agent terminals
 *
 * We mix two test styles:
 *  1) Source-level grep (cheap, immune to runtime mocking complexity).
 *     This is the same idiom used by `promptInjectionBudget.test.ts`.
 *  2) Behavioural test against the registry: confirms that calling
 *     `clearInvokedSkillsForAgent(forkAgentId)` actually drops entries
 *     scoped to that id and leaves siblings untouched — the contract
 *     the call sites rely on.
 */

import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  clearInvokedSkillsForAgent,
  peekInvokedSkillsPromptFragmentForAgent,
  recordInvokedSkill,
  resetInvokedSkillsRegistryForTests,
} from './invokedSkillsRegistry'
import { asAgentId } from '../tools/ids'

const repoRoot = path.resolve(__dirname, '..', '..')

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf-8')
}

describe('G14 — invoked-skills leak fix is wired at terminal points', () => {
  it('skillForkRunner.ts clears invoked-skills in a finally block', () => {
    const src = readRepoFile('electron/skills/skillForkRunner.ts')
    // Static guard: the finally block must clear by the FORK's agentId.
    expect(src).toContain('clearInvokedSkillsForAgent')
    // Allow up to ~800 chars between `finally {` and the clear call so
    // future audit-trail comments can grow without breaking the test —
    // the structural property we care about is "the clear is inside a
    // finally block keyed on the fork's agentId".
    expect(src).toMatch(/finally\s*\{[\s\S]{0,800}clearInvokedSkillsForAgent\(agentId\)/u)
  })

  it('subAgentLifecycleCleanup.ts clears invoked-skills as part of the standard terminal cleanup', () => {
    const src = readRepoFile('electron/agents/subAgentLifecycleCleanup.ts')
    expect(src).toContain('clearInvokedSkillsForAgent')
    // The cleanup function is named `finalizeSubAgentLifecycle`. The
    // clear must be inside its body — we keep the assertion loose so
    // future reorderings (e.g. inserting other steps) don't break it
    // unnecessarily.
    expect(src).toMatch(
      /export async function finalizeSubAgentLifecycle[\s\S]+clearInvokedSkillsForAgent\(agentId\)/u,
    )
  })
})

describe('clearInvokedSkillsForAgent contract (consumer-facing)', () => {
  beforeEach(() => {
    resetInvokedSkillsRegistryForTests()
  })

  afterEach(() => {
    resetInvokedSkillsRegistryForTests()
  })

  it('drops only entries scoped to the given fork agentId', () => {
    const fork = asAgentId('skill-fork-1234')
    const sibling = asAgentId('skill-fork-9999')
    recordInvokedSkill({
      agentId: fork,
      skillName: 'foo',
      skillPath: '/x/SKILL.md',
      content: 'body',
    })
    recordInvokedSkill({
      agentId: sibling,
      skillName: 'bar',
      skillPath: '/y/SKILL.md',
      content: 'body',
    })

    expect(peekInvokedSkillsPromptFragmentForAgent(fork)).toContain('foo')
    expect(peekInvokedSkillsPromptFragmentForAgent(sibling)).toContain('bar')

    // Fork's finally block runs.
    clearInvokedSkillsForAgent(fork)

    expect(peekInvokedSkillsPromptFragmentForAgent(fork)).toBe('')
    // Sibling fork's entries MUST survive (per-agent scoping).
    expect(peekInvokedSkillsPromptFragmentForAgent(sibling)).toContain('bar')
  })

  it('tolerates clear-of-empty (idempotent, no-throw)', () => {
    const fork = asAgentId('skill-fork-empty')
    expect(() => clearInvokedSkillsForAgent(fork)).not.toThrow()
    expect(peekInvokedSkillsPromptFragmentForAgent(fork)).toBe('')
  })

  it('parent-scoped entries survive a fork cleanup (only fork id is affected)', () => {
    const parent = asAgentId('main')
    const fork = asAgentId('skill-fork-A')

    // executeSkill records under parent agentId for the inline+fork
    // entry-point; we simulate that here.
    recordInvokedSkill({
      agentId: parent,
      skillName: 'parent-scoped',
      skillPath: '/p/SKILL.md',
      content: 'body',
    })
    // A nested Skill call INSIDE the fork records under the fork id.
    recordInvokedSkill({
      agentId: fork,
      skillName: 'nested-in-fork',
      skillPath: '/n/SKILL.md',
      content: 'body',
    })

    clearInvokedSkillsForAgent(fork)

    expect(peekInvokedSkillsPromptFragmentForAgent(parent)).toContain('parent-scoped')
    expect(peekInvokedSkillsPromptFragmentForAgent(fork)).toBe('')
  })
})
