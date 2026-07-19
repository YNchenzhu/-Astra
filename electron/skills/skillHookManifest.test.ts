import { describe, it, expect } from 'vitest'
import type { SkillHookSpec } from './types'
import { mergeHookLists, parseHooksFromFrontmatterValue } from './skillHookManifest'

describe('skillHookManifest', () => {
  it('parseHooksFromFrontmatterValue parses JSON array string', () => {
    const hooks = parseHooksFromFrontmatterValue(
      '[{"event":"PreToolUse","command":"echo ok"}]',
    )
    expect(hooks).toHaveLength(1)
    expect(hooks[0].event).toBe('PreToolUse')
    expect(hooks[0].command).toBe('echo ok')
  })

  it('mergeHookLists lets later list override the same hook key', () => {
    const a: SkillHookSpec[] = [{ event: 'PreToolUse', command: 'node gate.js' }]
    const b: SkillHookSpec[] = [{ event: 'PreToolUse', command: 'node gate.js', async: true }]
    const m = mergeHookLists(a, b)
    expect(m).toHaveLength(1)
    expect(m[0].async).toBe(true)
  })
})
