import { describe, expect, it } from 'vitest'
import {
  injectInvokedSkillsIntoLastUserMessage,
  recordInvokedSkill,
  resetInvokedSkillsRegistryForTests,
  clearInvokedSkillsForAgent,
  peekInvokedSkillsPromptFragmentForAgent,
  takeInvokedSkillsPromptFragmentForAgent,
  INVOKED_SKILLS_CONTINUATION_DIRECTIVE,
} from './invokedSkillsRegistry'

describe('invokedSkillsRegistry §16.6', () => {
  it('scopes keys by agent id and reinjects (peek, non-consuming)', () => {
    resetInvokedSkillsRegistryForTests()
    recordInvokedSkill({
      agentId: 'main',
      skillName: 'Test',
      skillPath: '/x/SKILL.md',
      content: 'body',
    })
    const messages: Array<Record<string, unknown>> = [{ role: 'user', content: 'hi' }]
    const out = injectInvokedSkillsIntoLastUserMessage(messages, 'main')
    expect(String(out[0].content)).toContain('<invoked-skills>')
    expect(String(out[0].content)).toContain('Test')
    // Second call still sees the skill (peek is non-consuming).
    const out2 = injectInvokedSkillsIntoLastUserMessage([{ role: 'user', content: 'hi' }], 'main')
    expect(String(out2[0].content)).toContain('<invoked-skills>')
    expect(String(out2[0].content)).toContain('Test')
    // Explicit clear removes it.
    clearInvokedSkillsForAgent('main')
    const out3 = injectInvokedSkillsIntoLastUserMessage([{ role: 'user', content: 'hi' }], 'main')
    expect(out3[0].content).toBe('hi')
  })

  it('peek and take fragments carry the continuation directive (skill-adherence audit)', () => {
    resetInvokedSkillsRegistryForTests()
    recordInvokedSkill({
      agentId: 'main',
      skillName: 'Workflow',
      skillPath: '/y/SKILL.md',
      content: 'body',
    })
    const peeked = peekInvokedSkillsPromptFragmentForAgent('main')
    expect(peeked).toContain(INVOKED_SKILLS_CONTINUATION_DIRECTIVE)
    // Directive sits INSIDE the envelope so it travels with the block.
    expect(peeked.indexOf(INVOKED_SKILLS_CONTINUATION_DIRECTIVE)).toBeLessThan(
      peeked.indexOf('</invoked-skills>'),
    )
    const taken = takeInvokedSkillsPromptFragmentForAgent('main')
    expect(taken).toContain(INVOKED_SKILLS_CONTINUATION_DIRECTIVE)
    // take() consumed the entry — fragment is now empty.
    expect(takeInvokedSkillsPromptFragmentForAgent('main')).toBe('')
  })
})
