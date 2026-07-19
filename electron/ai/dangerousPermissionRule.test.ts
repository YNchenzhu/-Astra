import { describe, it, expect } from 'vitest'
import {
  isUnrestrictedShellAllowRule,
  isInterpreterPrefixAllowRule,
  listDangerousPermissionRules,
} from './dangerousPermissionRule'

describe('dangerousPermissionRule (report §5.7)', () => {
  it('flags Bash allow without shellPattern', () => {
    expect(
      isUnrestrictedShellAllowRule({
        id: '1',
        pattern: 'bash',
        mode: 'allow',
      }),
    ).toBe(true)
  })

  it('does not flag Bash ask', () => {
    expect(
      isUnrestrictedShellAllowRule({ id: '1', pattern: 'bash', mode: 'ask' }),
    ).toBe(false)
  })

  it('flags interpreter prefix allows', () => {
    expect(
      isInterpreterPrefixAllowRule({
        id: '1',
        pattern: 'bash',
        mode: 'allow',
        shellPattern: 'python:*',
      }),
    ).toBe(true)
  })

  it('listDangerousPermissionRules collects both kinds', () => {
    const rules = [
      { id: 'a', pattern: 'read_file', mode: 'allow' as const },
      { id: 'b', pattern: 'bash', mode: 'allow' as const },
      { id: 'c', pattern: 'bash', mode: 'allow' as const, shellPattern: 'node:*' },
    ]
    const d = listDangerousPermissionRules(rules)
    expect(d.map((x) => x.id).sort()).toEqual(['b', 'c'])
  })
})
