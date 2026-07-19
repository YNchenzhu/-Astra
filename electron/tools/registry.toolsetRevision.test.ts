import { describe, it, expect, afterEach } from 'vitest'
import { toolRegistry } from './registry'

describe('toolRegistry toolset revision', () => {
  const probeName = '__vitest_toolset_revision_probe__'

  afterEach(() => {
    toolRegistry.unregister(probeName)
  })

  it('increments on register and again on unregister', () => {
    const r0 = toolRegistry.getToolsetRevision()
    toolRegistry.register({
      name: probeName,
      description: 'vitest probe',
      inputSchema: [],
      isReadOnly: true,
      execute: async () => ({ success: true, output: 'ok' }),
    })
    const r1 = toolRegistry.getToolsetRevision()
    expect(r1).toBe(r0 + 1)
    toolRegistry.unregister(probeName)
    const r2 = toolRegistry.getToolsetRevision()
    expect(r2).toBe(r1 + 1)
  })

  it('increments when register replaces an existing tool', () => {
    toolRegistry.register({
      name: probeName,
      description: 'v1',
      inputSchema: [],
      isReadOnly: true,
      execute: async () => ({ success: true, output: '1' }),
    })
    const r1 = toolRegistry.getToolsetRevision()
    toolRegistry.register({
      name: probeName,
      description: 'v2',
      inputSchema: [],
      isReadOnly: true,
      execute: async () => ({ success: true, output: '2' }),
    })
    expect(toolRegistry.getToolsetRevision()).toBe(r1 + 1)
  })
})
