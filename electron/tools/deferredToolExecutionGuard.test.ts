import { describe, it, expect, afterEach } from 'vitest'
import { getDeferredToolExecutionBlockMessage } from './deferredToolExecutionGuard'
import { markToolsDiscovered, resetDeferredDiscovery } from './deferredDiscovery'
import type { Tool } from './types'

function stubTool(partial: Partial<Tool> & Pick<Tool, 'name'>): Tool {
  return {
    inputSchema: [],
    isReadOnly: true,
    async execute() {
      return { success: true, output: '' }
    },
    ...partial,
  }
}

describe('getDeferredToolExecutionBlockMessage (report §4.3)', () => {
  afterEach(() => {
    resetDeferredDiscovery()
  })

  it('allows non-deferred tools', () => {
    expect(getDeferredToolExecutionBlockMessage(stubTool({ name: 'read_file' }))).toBeNull()
  })

  it('blocks deferred tool until ToolSearch discovery', () => {
    const t = stubTool({ name: 'deferred_stub_42', shouldDefer: true })
    const msg = getDeferredToolExecutionBlockMessage(t)
    expect(msg).toContain('ToolSearch')
    expect(msg).toContain('deferred_stub_42')
  })

  it('allows deferred tool after markToolsDiscovered', () => {
    const t = stubTool({ name: 'deferred_stub_43', shouldDefer: true })
    markToolsDiscovered(['deferred_stub_43'])
    expect(getDeferredToolExecutionBlockMessage(t)).toBeNull()
  })
})
