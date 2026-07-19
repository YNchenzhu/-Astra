import { describe, expect, it, beforeEach } from 'vitest'
import {
  isToolVisibleInPrompt,
  markToolsDiscovered,
  resetDeferredDiscovery,
  shouldExposeDeferredTool,
} from './deferredDiscovery'
import type { Tool } from './types'

describe('shouldExposeDeferredTool', () => {
  beforeEach(() => {
    resetDeferredDiscovery()
  })

  it('exposes non-deferred tools', () => {
    const t = { name: 'read_file', shouldDefer: false } as Tool
    expect(shouldExposeDeferredTool(t)).toBe(true)
  })

  it('uses deferUntil when set', () => {
    const t = {
      name: 'LSP',
      shouldDefer: true,
      deferUntil: () => true,
    } as Tool
    expect(shouldExposeDeferredTool(t)).toBe(true)
    const t2 = { ...t, deferUntil: () => false }
    expect(shouldExposeDeferredTool(t2)).toBe(false)
  })

  it('falls back to ToolSearch discovery when deferUntil missing', () => {
    const t = { name: 'mcp_foo', shouldDefer: true } as Tool
    expect(shouldExposeDeferredTool(t)).toBe(false)
    markToolsDiscovered(['mcp_foo'])
    expect(isToolVisibleInPrompt(t)).toBe(true)
    expect(shouldExposeDeferredTool(t)).toBe(true)
  })
})
