/**
 * AC-9.1 — inventory: every declared hook event is a stable string (prevents drift / typos).
 */

import { describe, expect, it } from 'vitest'
import { HOOK_EVENTS } from './types'

describe('HOOK_EVENTS inventory (AC-9.1)', () => {
  it('has expected OpenClaude-style events including StatusLine / FileSuggestion / skill hooks', () => {
    const set = new Set(HOOK_EVENTS)
    expect(set.size).toBe(HOOK_EVENTS.length)
    for (const e of [
      'PreToolUse',
      'PostToolUse',
      'UserPromptSubmit',
      'PreCompact',
      'PostCompact',
      'SessionStart',
      'SessionEnd',
      'SessionIdle',
      'StatusLine',
      'FileSuggestion',
      'PreSkillUse',
      'PostSkillUse',
      'Stop',
      'SubagentStop',
    ]) {
      expect(set.has(e as (typeof HOOK_EVENTS)[number])).toBe(true)
    }
  })
})
