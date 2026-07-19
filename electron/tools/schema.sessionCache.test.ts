import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { resetDeferredDiscovery } from './deferredDiscovery'
import {
  buildToolDefinitionsSessionCacheKey,
  getToolDefinitions,
  resetToolDefinitionsSessionCacheForTests,
} from './schema'

describe('getToolDefinitions session cache (§8.1)', () => {
  beforeEach(() => {
    resetToolDefinitionsSessionCacheForTests()
  })

  afterEach(() => {
    resetToolDefinitionsSessionCacheForTests()
    resetDeferredDiscovery()
  })

  it('returns the same array reference on consecutive calls when key is stable', () => {
    const a = getToolDefinitions()
    const b = getToolDefinitions()
    expect(a).toBe(b)
  })

  it('buildToolDefinitionsSessionCacheKey changes with discovery epoch', async () => {
    const { markToolsDiscovered, resetDeferredDiscovery } = await import('./deferredDiscovery')
    resetDeferredDiscovery()
    const k0 = buildToolDefinitionsSessionCacheKey(undefined, 'all')
    markToolsDiscovered(['__fake_deferred_name_for_epoch__'])
    const k1 = buildToolDefinitionsSessionCacheKey(undefined, 'all')
    expect(k1).not.toBe(k0)
  })
})
