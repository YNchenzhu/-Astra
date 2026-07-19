import { describe, expect, it } from 'vitest'
import { normalizeToIdChars, chineseToId, isIdStillDerivedFrom } from './chineseToId'

describe('normalizeToIdChars', () => {
  it('lowercases and keeps allowed chars', () => {
    expect(normalizeToIdChars('Foo_Bar-1')).toBe('foo_bar-1')
  })

  it('replaces runs of disallowed chars with single dash', () => {
    expect(normalizeToIdChars('a   b!!!c')).toBe('a-b-c')
  })

  it('strips leading and trailing dashes', () => {
    expect(normalizeToIdChars('  hello  ')).toBe('hello')
    expect(normalizeToIdChars('---x---')).toBe('x')
  })

  it('returns empty for all-disallowed input', () => {
    expect(normalizeToIdChars('!!!')).toBe('')
    expect(normalizeToIdChars('')).toBe('')
  })

  it('preserves underscores (they are in the allowlist)', () => {
    expect(normalizeToIdChars('a_b__c')).toBe('a_b__c')
  })
})

describe('chineseToId', () => {
  it('returns empty for blank input', () => {
    expect(chineseToId('')).toBe('')
    expect(chineseToId('   ')).toBe('')
  })

  it('passes through pure ascii (lowercased, dashed)', () => {
    expect(chineseToId('My Agent 1')).toBe('my-agent-1')
  })

  it('romanizes pure CJK to dash-joined pinyin', () => {
    expect(chineseToId('售前工程师')).toBe('shou-qian-gong-cheng-shi')
  })

  it('handles mixed CJK + ascii', () => {
    const id = chineseToId('售前 Engineer 1')
    expect(id).toMatch(/^[a-z0-9_-]+$/)
    expect(id.startsWith('-')).toBe(false)
    expect(id.endsWith('-')).toBe(false)
    expect(id).toContain('engineer')
  })

  it('output always matches the id charset constraint', () => {
    for (const input of ['中文@@@123', 'A B C', '一二三', '混合Mix 99']) {
      const id = chineseToId(input)
      if (id) expect(id).toMatch(/^[a-z0-9_-]+$/)
    }
  })
})

describe('isIdStillDerivedFrom', () => {
  it('true when id is empty (still auto-linked)', () => {
    expect(isIdStillDerivedFrom('', 'anything')).toBe(true)
  })

  it('true when id equals derived id', () => {
    expect(isIdStillDerivedFrom('my-agent', 'My Agent')).toBe(true)
  })

  it('false when user diverged the id', () => {
    expect(isIdStillDerivedFrom('custom-id', 'My Agent')).toBe(false)
  })
})
