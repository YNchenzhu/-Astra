import { describe, it, expect } from 'vitest'
import { mergeSkillDefinitionsCRDT } from './skillMergeCRDT'
import type { SkillDefinition } from './types'

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

describe('mergeSkillDefinitionsCRDT', () => {
  it('keeps one entry per name (case-insensitive)', () => {
    const out = mergeSkillDefinitionsCRDT([
      { skill: skill('Foo', 'user', 'a'), ordinal: 0 },
      { skill: skill('foo', 'project', 'b'), ordinal: 1 },
    ])
    expect(out).toHaveLength(1)
    expect(out[0].source).toBe('project')
    expect(out[0].description).toBe('b')
  })

  it('prefers higher source rank when mtime tie', () => {
    const out = mergeSkillDefinitionsCRDT([
      { skill: skill('x', 'bundled', 'b', '/nope/bundled/SKILL.md'), ordinal: 0 },
      { skill: skill('x', 'user', 'u', '/nope/user/SKILL.md'), ordinal: 1 },
    ])
    expect(out[0].source).toBe('user')
  })
})
