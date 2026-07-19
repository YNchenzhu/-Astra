/**
 * MemdirScan — registered in initAgentTools and exposed in the default
 * tool list (no ToolSearch discovery required).
 *
 * 2026-05 — was previously deferred (`shouldDefer: true`). The
 * single-parameter schema and "AI test scenarios" workflow made the
 * gate's UX cost outweigh its ~50-token savings, so MemdirScan now
 * loads with the rest of the read tools. MCP tools and `LSP` remain
 * deferred (genuinely heavy schemas).
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { initAgentTools, toolRegistry } from './registry'
import { getToolDefinitions, resetToolDefinitionsSessionCacheForTests } from './schema'
import { resetDeferredDiscovery } from './deferredDiscovery'

describe('MemdirScan tool registration', () => {
  beforeEach(() => {
    resetToolDefinitionsSessionCacheForTests()
    resetDeferredDiscovery()
  })

  it('registers MemdirScan after initAgentTools', () => {
    initAgentTools(undefined, undefined)
    expect(toolRegistry.has('MemdirScan')).toBe(true)
  })

  it('does NOT mark MemdirScan as deferred (it must load by default)', () => {
    initAgentTools(undefined, undefined)
    const t = toolRegistry.get('MemdirScan')
    expect(t?.shouldDefer).toBeFalsy()
  })

  it('exposes MemdirScan in getToolDefinitions without needing ToolSearch discovery', () => {
    initAgentTools(undefined, undefined)
    resetToolDefinitionsSessionCacheForTests()
    const visible = getToolDefinitions().some((d) => d.name === 'MemdirScan')
    expect(visible).toBe(true)
  })
})
