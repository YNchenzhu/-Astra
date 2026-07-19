import { describe, it, expect } from 'vitest'
import { resolveHookTimeoutMs, SESSION_END_HOOK_TIMEOUT_MS, defaultTimeoutMsForHookKind } from './execCommand'

describe('resolveHookTimeoutMs', () => {
  it('uses short timeout for SessionEnd only', () => {
    expect(resolveHookTimeoutMs('SessionEnd', 'command')).toBe(SESSION_END_HOOK_TIMEOUT_MS)
    expect(resolveHookTimeoutMs('SessionEnd', 'http')).toBe(SESSION_END_HOOK_TIMEOUT_MS)

    expect(resolveHookTimeoutMs('SessionStart', 'command')).toBe(
      defaultTimeoutMsForHookKind('command'),
    )
    expect(resolveHookTimeoutMs('Setup', 'command')).toBe(defaultTimeoutMsForHookKind('command'))
  })
})
