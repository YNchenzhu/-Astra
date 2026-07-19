import { describe, it, expect } from 'vitest'
import {
  has1mContext,
  resolveSkillModelOverride,
  resolveSkillModelAlias,
} from './skillModelResolve'

describe('skillModelResolve', () => {
  it('detects [1m] suffix', () => {
    expect(has1mContext('claude-sonnet-4-20250514[1m]')).toBe(true)
    expect(has1mContext('claude-sonnet-4-20250514')).toBe(false)
  })

  it('maps opus alias for anthropic', () => {
    const id = resolveSkillModelAlias('opus', 'anthropic')
    expect(id).toContain('opus')
    expect(id.toLowerCase()).not.toBe('opus')
  })

  it('carries [1m] from current session onto sonnet alias', () => {
    const out = resolveSkillModelOverride('sonnet', 'claude-sonnet-4-20250514[1m]', 'anthropic')
    expect(out.endsWith('[1m]')).toBe(true)
    expect(out.toLowerCase()).toContain('sonnet')
  })

  it('does not add [1m] when session has no 1m', () => {
    const out = resolveSkillModelOverride('sonnet', 'claude-sonnet-4-20250514', 'anthropic')
    expect(out.includes('[1m]')).toBe(false)
  })
})
