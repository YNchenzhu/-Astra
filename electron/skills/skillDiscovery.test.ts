import { describe, it, expect } from 'vitest'
import { discoveryQueryTermKeys, scoreSkillRelevanceLexical } from './skillDiscovery'
import type { SkillDefinition } from './types'

describe('skillDiscovery CJK tokenization', () => {
  it('extracts ASCII tokens', () => {
    const keys = discoveryQueryTermKeys('debug flaky API')
    expect(keys.some((k) => k.includes('debug'))).toBe(true)
    expect(keys.some((k) => k.includes('flaky'))).toBe(true)
  })

  it('extracts Chinese unigrams and bigrams so TF-IDF is non-zero', () => {
    const keys = discoveryQueryTermKeys('调试接口与技能发现')
    expect(keys.length).toBeGreaterThan(0)
    expect(keys).toContain('调试')
    expect(keys).toContain('技能')
    expect(keys).toContain('调')
  })
})

describe('scoreSkillRelevanceLexical + CJK query words', () => {
  it('matches Chinese terms in skill corpus via normalizeWords', () => {
    const skill: SkillDefinition = {
      name: 'test-skill',
      description: '用于调试和接口测试的工作流',
      source: 'bundled',
      userInvocable: true,
      disableModelInvocation: false,
      context: 'inline',
      promptContent: '',
    }
    const score = scoreSkillRelevanceLexical('需要调试帮助', skill)
    expect(score).toBeGreaterThan(0)
  })
})
