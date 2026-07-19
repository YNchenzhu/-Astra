import { describe, it, expect, afterEach } from 'vitest'
import { getToolDefinitions, resetToolDefinitionsSessionCacheForTests } from './schema'
import { resetRuntimeDisabledToolNamesForTests } from './toolLoadFlags'

describe('getToolDefinitions + ASTRA_DISABLED_TOOLS', () => {
  afterEach(() => {
    delete process.env.ASTRA_DISABLED_TOOLS
    resetRuntimeDisabledToolNamesForTests()
    resetToolDefinitionsSessionCacheForTests()
  })

  it('hides tools listed in ASTRA_DISABLED_TOOLS', () => {
    resetToolDefinitionsSessionCacheForTests()
    const before = getToolDefinitions().some((d) => d.name === 'read_file')
    expect(before).toBe(true)

    process.env.ASTRA_DISABLED_TOOLS = 'read_file'
    resetRuntimeDisabledToolNamesForTests()
    resetToolDefinitionsSessionCacheForTests()
    const after = getToolDefinitions().some((d) => d.name === 'read_file')
    expect(after).toBe(false)
  })
})
