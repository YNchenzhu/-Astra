import { describe, it, expect } from 'vitest'
import { buildPreloadedSkillsPromptAppend } from './subAgentSkillPreload'

describe('buildPreloadedSkillsPromptAppend', () => {
  it('returns empty for undefined / empty', () => {
    expect(buildPreloadedSkillsPromptAppend(undefined)).toBe('')
    expect(buildPreloadedSkillsPromptAppend([])).toBe('')
  })
})
