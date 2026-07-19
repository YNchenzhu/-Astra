/**
 * AC-4.5: Deferred tools are hidden from getToolDefinitions until markToolsDiscovered.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { toolRegistry } from '../tools/registry'
import { toolSearchTool } from '../tools/ToolSearchTool'
import { getToolDefinitions, resetToolDefinitionsSessionCacheForTests } from '../tools/schema'
import { markToolsDiscovered, resetDeferredDiscovery } from '../tools/deferredDiscovery'
import type { Tool } from '../tools/types'

describe('ToolSearch deferred listing (integration)', () => {
  let name: string

  afterEach(() => {
    if (name) toolRegistry.unregister(name)
    resetDeferredDiscovery()
    resetToolDefinitionsSessionCacheForTests()
  })

  it('excludes deferred tool until discovered, then includes it', () => {
    name = `__defer_list_${Math.random().toString(36).slice(2, 9)}`
    const tool: Tool = {
      name,
      description: 'integration deferred stub',
      inputSchema: [{ name: 'x', type: 'string', description: 'x', required: true }],
      shouldDefer: true,
      isEnabled: () => true,
      isReadOnly: true,
      execute: async () => ({ success: true, output: 'ok' }),
    }
    toolRegistry.register(tool)
    resetDeferredDiscovery()

    const before = getToolDefinitions().map((t) => t.name)
    expect(before).not.toContain(name)

    markToolsDiscovered([name])
    const after = getToolDefinitions().map((t) => t.name)
    expect(after).toContain(name)
  })

  it('bumps the toolset revision when ToolSearch discovers a deferred tool', async () => {
    name = `__defer_rev_${Math.random().toString(36).slice(2, 9)}`
    const tool: Tool = {
      name,
      description: 'integration deferred revision stub',
      inputSchema: [{ name: 'x', type: 'string', description: 'x', required: true }],
      shouldDefer: true,
      isEnabled: () => true,
      isReadOnly: true,
      execute: async () => ({ success: true, output: 'ok' }),
    }
    toolRegistry.register(tool)
    resetDeferredDiscovery()

    const revBefore = toolRegistry.getToolsetRevision()
    const res = await toolSearchTool.execute({ query: `select:${name}` })
    expect(res.success).toBe(true)

    // The agentic loop refreshes its wire tool list off this revision; without
    // the bump a discovered deferred tool never reaches the next request.
    expect(toolRegistry.getToolsetRevision()).toBe(revBefore + 1)
    expect(getToolDefinitions().map((t) => t.name)).toContain(name)
  })

  it('does not bump the revision when ToolSearch matches nothing new', async () => {
    const revBefore = toolRegistry.getToolsetRevision()
    const res = await toolSearchTool.execute({
      query: 'select:__no_such_deferred_tool_exists__',
    })
    expect(res.success).toBe(true)
    expect(toolRegistry.getToolsetRevision()).toBe(revBefore)
  })
})
