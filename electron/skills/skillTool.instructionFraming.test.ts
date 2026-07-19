/**
 * Pins the inline-skill instruction frame
 * (`formatInlineSkillInstructionsOutput` — skill-adherence audit, 2026-06).
 *
 * Load-bearing facts locked here:
 *   1. `Skill: <name>` stays the FIRST line — `toolResultBudget`'s
 *      skill-block clamp protection and renderer labels key on it.
 *   2. The body rides inside `<skill-instructions skill="...">` so the
 *      active-skill reminder collector can reference the tag by name.
 *   3. A trailing directive (recency position) declares the instructions
 *      ACTIVE until task completion / explicit session clear.
 *   4. Empty body degrades to the legacy "(Skill executed.)" shape.
 */

import { describe, expect, it } from 'vitest'
import { formatInlineSkillInstructionsOutput } from './skillTool'
import { isSkillInstructionsBlock } from '../ai/toolResultBudget'

describe('formatInlineSkillInstructionsOutput', () => {
  it('keeps `Skill: <name> <args>` as the first line', () => {
    const out = formatInlineSkillInstructionsOutput('my-flow', 'arg1 arg2', 'step 1\nstep 2')
    expect(out.split('\n')[0]).toBe('Skill: my-flow arg1 arg2')
  })

  it('wraps the body in a <skill-instructions> envelope with the skill name', () => {
    const out = formatInlineSkillInstructionsOutput('my-flow', undefined, 'step 1\nstep 2')
    expect(out).toContain('<skill-instructions skill="my-flow">')
    expect(out).toContain('step 1\nstep 2')
    expect(out.indexOf('<skill-instructions')).toBeLessThan(out.indexOf('step 1'))
    expect(out.indexOf('step 2')).toBeLessThan(out.indexOf('</skill-instructions>'))
  })

  it('appends the ACTIVE-directive trailer after the envelope (recency position)', () => {
    const out = formatInlineSkillInstructionsOutput('my-flow', undefined, 'body')
    const trailerIdx = out.indexOf('ACTIVE workflow directive')
    expect(trailerIdx).toBeGreaterThan(out.indexOf('</skill-instructions>'))
    expect(out).toContain('verify that step')
    expect(out).toContain('end_inline_skill_session=true')
  })

  it('degrades to the legacy executed-marker for empty bodies', () => {
    const out = formatInlineSkillInstructionsOutput('my-flow', undefined, '   ')
    expect(out).toBe('Skill: my-flow\n\n(Skill "my-flow" executed.)')
    expect(out).not.toContain('<skill-instructions')
  })

  it('framed output is recognised by the budget clamp protection', () => {
    const out = formatInlineSkillInstructionsOutput('my-flow', undefined, 'body')
    expect(isSkillInstructionsBlock(out)).toBe(true)
  })
})
