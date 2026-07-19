/**
 * Unit tests for the agent-definition revision counter.
 *
 * Covers the contract the `agent_listing_delta` collector and any
 * future agent-aware UI rely on:
 *
 *   - starts at 1 (matches the `getToolsetRevision()` convention),
 *   - bumps monotonically,
 *   - notifies subscribers AFTER the bump (i.e. subscribers see the
 *     new value when they read `getAgentDefinitionRevision()`),
 *   - swallows listener throws so a buggy subscriber cannot block
 *     other listeners or future bumps,
 *   - test seam fully resets state.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  __resetAgentDefinitionRevisionForTests,
  bumpAgentDefinitionRevision,
  getAgentDefinitionRevision,
  subscribeAgentDefinitionRevision,
} from './agentRegistryRevision'

afterEach(() => __resetAgentDefinitionRevisionForTests())

describe('getAgentDefinitionRevision', () => {
  it('starts at 1', () => {
    expect(getAgentDefinitionRevision()).toBe(1)
  })

  it('increments monotonically on each bump', () => {
    bumpAgentDefinitionRevision()
    expect(getAgentDefinitionRevision()).toBe(2)
    bumpAgentDefinitionRevision()
    bumpAgentDefinitionRevision()
    expect(getAgentDefinitionRevision()).toBe(4)
  })
})

describe('subscribeAgentDefinitionRevision', () => {
  it('fires the listener after each bump', () => {
    const listener = vi.fn()
    subscribeAgentDefinitionRevision(listener)
    bumpAgentDefinitionRevision()
    expect(listener).toHaveBeenCalledTimes(1)
    bumpAgentDefinitionRevision()
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('listener sees the post-bump revision value', () => {
    const observed: number[] = []
    subscribeAgentDefinitionRevision(() => observed.push(getAgentDefinitionRevision()))
    bumpAgentDefinitionRevision()
    bumpAgentDefinitionRevision()
    expect(observed).toEqual([2, 3])
  })

  it('returns an unsubscribe that stops further notifications', () => {
    const listener = vi.fn()
    const unsub = subscribeAgentDefinitionRevision(listener)
    bumpAgentDefinitionRevision()
    expect(listener).toHaveBeenCalledTimes(1)
    unsub()
    bumpAgentDefinitionRevision()
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('isolates listener throws — other listeners still fire', () => {
    const ok = vi.fn()
    subscribeAgentDefinitionRevision(() => {
      throw new Error('bad listener')
    })
    subscribeAgentDefinitionRevision(ok)
    expect(() => bumpAgentDefinitionRevision()).not.toThrow()
    expect(ok).toHaveBeenCalledTimes(1)
  })

  it('isolated listener throws do not block future bumps', () => {
    subscribeAgentDefinitionRevision(() => {
      throw new Error('bad')
    })
    bumpAgentDefinitionRevision()
    bumpAgentDefinitionRevision()
    expect(getAgentDefinitionRevision()).toBe(3)
  })
})

describe('__resetAgentDefinitionRevisionForTests', () => {
  it('returns revision to 1 and clears listeners', () => {
    const listener = vi.fn()
    subscribeAgentDefinitionRevision(listener)
    bumpAgentDefinitionRevision()
    bumpAgentDefinitionRevision()
    expect(getAgentDefinitionRevision()).toBe(3)

    __resetAgentDefinitionRevisionForTests()
    expect(getAgentDefinitionRevision()).toBe(1)

    bumpAgentDefinitionRevision()
    // Pre-reset listener should NOT fire after a reset.
    expect(listener).toHaveBeenCalledTimes(2) // 2 calls from before reset
  })
})
