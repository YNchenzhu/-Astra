import { describe, expect, it } from 'vitest'
import { SAFE_SKILL_PROPERTIES, skillUsesOnlySafeFrontmatterKeys } from './safeSkillProperties'

describe('safeSkillProperties', () => {
  it('has 38 keys (AC-9.6)', () => {
    expect(SAFE_SKILL_PROPERTIES.size).toBe(38)
  })

  it('skillUsesOnlySafeFrontmatterKeys rejects unknown keys', () => {
    expect(skillUsesOnlySafeFrontmatterKeys(['name', 'description'])).toBe(true)
    expect(skillUsesOnlySafeFrontmatterKeys(['name', 'evil-injection'])).toBe(false)
    expect(skillUsesOnlySafeFrontmatterKeys([])).toBe(false)
    expect(skillUsesOnlySafeFrontmatterKeys(undefined)).toBe(false)
  })
})
