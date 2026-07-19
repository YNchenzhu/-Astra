import { describe, it, expect, afterEach } from 'vitest'
import {
  getRuntimeDisabledToolNames,
  isToolRuntimeDisabled,
  resetRuntimeDisabledToolNamesForTests,
  runtimeDisabledToolNamesFingerprint,
} from './toolLoadFlags'

describe('toolLoadFlags', () => {
  afterEach(() => {
    delete process.env.ASTRA_DISABLED_TOOLS
    resetRuntimeDisabledToolNamesForTests()
  })

  it('parses ASTRA_DISABLED_TOOLS', () => {
    process.env.ASTRA_DISABLED_TOOLS = 'Bash, WebFetch'
    resetRuntimeDisabledToolNamesForTests()
    expect(getRuntimeDisabledToolNames()).toEqual(['Bash', 'WebFetch'])
    expect(isToolRuntimeDisabled('Bash')).toBe(true)
    expect(isToolRuntimeDisabled('read_file')).toBe(false)
    expect(runtimeDisabledToolNamesFingerprint().startsWith('dis:')).toBe(true)
  })

  it('returns empty when unset', () => {
    resetRuntimeDisabledToolNamesForTests()
    expect(getRuntimeDisabledToolNames()).toEqual([])
    expect(runtimeDisabledToolNamesFingerprint()).toBe('-')
  })
})
