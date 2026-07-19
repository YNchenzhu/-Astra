/**
 * Stop-hook circuit breaker — consecutive-block cap (upstream parity).
 *
 * Replaces the previous 3-in-6 rolling-window test suite. The new semantics
 * align with the official upstream `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`
 * behaviour (default 8 consecutive blocks → loop overrides the hook).
 *
 * Consecutive counting means a transient activation that the model
 * recovers from no longer "counts" against an unrelated activation many
 * iterations later — the orchestrator resets the counter to 0 on
 * genuine forward progress (tool execution succeeded). That reset is
 * not exercised here (it lives in `iteration.ts`); these tests verify
 * the pure decision rule.
 */

import { describe, expect, it } from 'vitest'
import { STOP_HOOK_BLOCK_CAP, recordStopHookBlock } from './noTools'

describe('recordStopHookBlock — consecutive-cap circuit breaker', () => {
  it('does not trip on a single block', () => {
    const r = recordStopHookBlock(0, 8)
    expect(r.tripped).toBe(false)
    expect(r.count).toBe(1)
  })

  it('does not trip below the cap', () => {
    let count = 0
    for (let i = 0; i < 7; i++) {
      const r = recordStopHookBlock(count, 8)
      count = r.count
      expect(r.tripped).toBe(false)
    }
    expect(count).toBe(7)
  })

  it('trips exactly at the cap', () => {
    let count = 0
    let lastResult: { tripped: boolean; count: number } | undefined
    for (let i = 0; i < 8; i++) {
      lastResult = recordStopHookBlock(count, 8)
      count = lastResult.count
    }
    expect(lastResult?.tripped).toBe(true)
    expect(lastResult?.count).toBe(8)
  })

  it('keeps tripping once at the cap (no auto-reset)', () => {
    const r = recordStopHookBlock(10, 8)
    expect(r.tripped).toBe(true)
    expect(r.count).toBe(11)
  })

  it('honors a custom (lower) cap', () => {
    expect(recordStopHookBlock(0, 2).tripped).toBe(false)
    expect(recordStopHookBlock(1, 2).tripped).toBe(true)
  })

  it('honors a custom (higher) cap', () => {
    expect(recordStopHookBlock(9, 16).tripped).toBe(false)
    expect(recordStopHookBlock(15, 16).tripped).toBe(true)
  })

  it('defaults the cap to STOP_HOOK_BLOCK_CAP when omitted', () => {
    const r1 = recordStopHookBlock(STOP_HOOK_BLOCK_CAP - 2)
    expect(r1.tripped).toBe(false)
    const r2 = recordStopHookBlock(STOP_HOOK_BLOCK_CAP - 1)
    expect(r2.tripped).toBe(true)
  })

  it('module constant is a positive integer (env override sanity)', () => {
    expect(Number.isInteger(STOP_HOOK_BLOCK_CAP)).toBe(true)
    expect(STOP_HOOK_BLOCK_CAP).toBeGreaterThan(0)
  })

  it('default cap matches Claude Code official (8)', () => {
    // The env-driven module constant may be overridden in CI, but the
    // default value baked into the call site should be 8 — the official
    // `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` shipping in upstream.
    // If POLE_STOP_HOOK_BLOCK_CAP is set, this test is informational only.
    if (!process.env.POLE_STOP_HOOK_BLOCK_CAP) {
      expect(STOP_HOOK_BLOCK_CAP).toBe(8)
    }
  })
})
