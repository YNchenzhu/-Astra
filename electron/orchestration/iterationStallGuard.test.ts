/**
 * P1-1 — Tests for the iteration-stall guard.
 *
 * The guard must:
 *   1. Not trip below the consecutive threshold.
 *   2. Trip after the threshold is reached with all three conditions
 *      (no tool use, low text, low token delta) simultaneously.
 *   3. Reset on a tool-use iteration, a high-text iteration, OR a
 *      high-token-delta iteration.
 *   4. Scope state per conversation id so sub-agents don't poison main.
 *   5. Honor `resetFor` mid-streak.
 *   6. No-op on empty conversation id (defensive — sub-agents without
 *      `streamConversationId` should not contribute or affect anything).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createIterationStallGuard,
  resetIterationStallGuardForTests,
} from './iterationStallGuard'

describe('IterationStallGuard', () => {
  beforeEach(() => {
    resetIterationStallGuardForTests()
  })
  afterEach(() => {
    resetIterationStallGuardForTests()
  })

  it('does not trip below threshold', () => {
    const guard = createIterationStallGuard({
      consecutiveStallThreshold: 3,
      textCharFloor: 100,
      tokenDeltaFloor: 800,
    })
    const r1 = guard.record('conv', { hadToolUse: false, textLength: 10, tokenDelta: 50 })
    expect(r1.stalled).toBe(false)
    expect(r1.consecutiveCount).toBe(1)
    const r2 = guard.record('conv', { hadToolUse: false, textLength: 20, tokenDelta: 80 })
    expect(r2.stalled).toBe(false)
    expect(r2.consecutiveCount).toBe(2)
  })

  it('trips at the threshold with three consecutive stalled iterations', () => {
    const guard = createIterationStallGuard({
      consecutiveStallThreshold: 3,
      textCharFloor: 100,
      tokenDeltaFloor: 800,
    })
    guard.record('conv', { hadToolUse: false, textLength: 5, tokenDelta: 50 })
    guard.record('conv', { hadToolUse: false, textLength: 10, tokenDelta: 100 })
    const advice = guard.record('conv', { hadToolUse: false, textLength: 0, tokenDelta: 0 })
    expect(advice.stalled).toBe(true)
    expect(advice.consecutiveCount).toBe(3)
    expect(advice.message).toMatch(/iterations/i)
  })

  it('resets on a tool-use iteration', () => {
    const guard = createIterationStallGuard({
      consecutiveStallThreshold: 3,
      textCharFloor: 100,
      tokenDeltaFloor: 800,
    })
    guard.record('conv', { hadToolUse: false, textLength: 5, tokenDelta: 50 })
    guard.record('conv', { hadToolUse: false, textLength: 5, tokenDelta: 50 })
    const r = guard.record('conv', { hadToolUse: true, textLength: 0, tokenDelta: 0 })
    expect(r.stalled).toBe(false)
    expect(r.consecutiveCount).toBe(0)
    // After reset, the next two stalls only go up to 2 (not 4)
    const r2 = guard.record('conv', { hadToolUse: false, textLength: 5, tokenDelta: 50 })
    expect(r2.consecutiveCount).toBe(1)
  })

  it('resets on a high-text iteration even with no tool use', () => {
    const guard = createIterationStallGuard({
      consecutiveStallThreshold: 3,
      textCharFloor: 100,
      tokenDeltaFloor: 800,
    })
    guard.record('conv', { hadToolUse: false, textLength: 5, tokenDelta: 50 })
    guard.record('conv', { hadToolUse: false, textLength: 5, tokenDelta: 50 })
    const r = guard.record('conv', { hadToolUse: false, textLength: 500, tokenDelta: 100 })
    expect(r.stalled).toBe(false)
    expect(r.consecutiveCount).toBe(0)
  })

  it('resets on a high-token-delta iteration', () => {
    const guard = createIterationStallGuard({
      consecutiveStallThreshold: 3,
      textCharFloor: 100,
      tokenDeltaFloor: 800,
    })
    guard.record('conv', { hadToolUse: false, textLength: 5, tokenDelta: 50 })
    guard.record('conv', { hadToolUse: false, textLength: 5, tokenDelta: 50 })
    const r = guard.record('conv', { hadToolUse: false, textLength: 5, tokenDelta: 1500 })
    expect(r.stalled).toBe(false)
    expect(r.consecutiveCount).toBe(0)
  })

  it('scopes per conversation', () => {
    const guard = createIterationStallGuard({
      consecutiveStallThreshold: 2,
      textCharFloor: 100,
      tokenDeltaFloor: 800,
    })
    guard.record('main', { hadToolUse: false, textLength: 5, tokenDelta: 50 })
    const r = guard.record('main', { hadToolUse: false, textLength: 5, tokenDelta: 50 })
    expect(r.stalled).toBe(true)

    const sub = guard.record('sub', { hadToolUse: false, textLength: 5, tokenDelta: 50 })
    expect(sub.stalled).toBe(false) // sub starts fresh
    expect(sub.consecutiveCount).toBe(1)
  })

  it('resetFor clears one conversation only', () => {
    const guard = createIterationStallGuard({
      consecutiveStallThreshold: 3,
      textCharFloor: 100,
      tokenDeltaFloor: 800,
    })
    guard.record('A', { hadToolUse: false, textLength: 5, tokenDelta: 50 })
    guard.record('A', { hadToolUse: false, textLength: 5, tokenDelta: 50 })
    guard.record('B', { hadToolUse: false, textLength: 5, tokenDelta: 50 })
    guard.resetFor('A')
    expect(guard.snapshot('A')?.streak).toBe(0)
    expect(guard.snapshot('B')?.streak).toBe(1)
  })

  // Audit Bug-3 fix — deleteFor removes the entry entirely (not just zero
  // the streak). Critical for long-uptime processes (multi-tab / daemon)
  // so the internal Map doesn't accumulate dead conversation entries.
  it('deleteFor removes conversation entry entirely', () => {
    const guard = createIterationStallGuard()
    guard.record('cleanup-target', { hadToolUse: false, textLength: 5, tokenDelta: 50 })
    expect(guard.snapshot('cleanup-target')).not.toBeNull()
    guard.deleteFor('cleanup-target')
    expect(guard.snapshot('cleanup-target')).toBeNull()
  })

  it('no-ops on empty conversation id', () => {
    const guard = createIterationStallGuard()
    const r = guard.record('', { hadToolUse: false, textLength: 5, tokenDelta: 50 })
    expect(r.stalled).toBe(false)
    expect(r.consecutiveCount).toBe(0)
  })

  it('clamps threshold to >= 2', () => {
    const guard = createIterationStallGuard({
      consecutiveStallThreshold: 0,
      textCharFloor: 100,
      tokenDeltaFloor: 800,
    })
    // After 1 stall, should not trip (effective threshold is 2)
    const r1 = guard.record('conv', { hadToolUse: false, textLength: 5, tokenDelta: 50 })
    expect(r1.stalled).toBe(false)
    const r2 = guard.record('conv', { hadToolUse: false, textLength: 5, tokenDelta: 50 })
    expect(r2.stalled).toBe(true)
  })
})
