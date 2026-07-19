/**
 * Tests for the loop-stop / per-tool-deny distinction in
 * {@link hookResponseRequestsLoopStop} vs {@link hookResponseBlocksExecution}.
 *
 * Why this matters for `hook_stopped`:
 *   The agentic loop translates `continue: false` / `preventContinuation: true`
 *   into a `hook_stopped` termination. Conflating that with
 *   `permissionDecision: deny` (per-tool deny) would either over-terminate
 *   benign denies or under-terminate genuine loop-stop requests. Pin the
 *   semantics here so the wiring inside `runAgenticToolUseBody` /
 *   `runAgenticLoop` keeps behaving correctly.
 */
import { describe, it, expect } from 'vitest'
import {
  hookResponseBlocksExecution,
  hookResponseRequestsLoopStop,
} from './hookIntegration'
import type { HookResponse } from '../tools/hooks/types'

describe('hookResponseBlocksExecution', () => {
  it('returns false for undefined / empty response', () => {
    expect(hookResponseBlocksExecution(undefined)).toBe(false)
    expect(hookResponseBlocksExecution({} as HookResponse)).toBe(false)
  })

  it('returns true for continue: false', () => {
    expect(hookResponseBlocksExecution({ continue: false })).toBe(true)
  })

  it('returns true for preventContinuation: true', () => {
    expect(hookResponseBlocksExecution({ preventContinuation: true })).toBe(true)
  })

  it('returns true for permissionDecision: deny', () => {
    expect(hookResponseBlocksExecution({ permissionDecision: 'deny' })).toBe(true)
  })

  it('returns true for decision: deny', () => {
    expect(hookResponseBlocksExecution({ decision: 'deny' })).toBe(true)
  })

  it('returns false for allow / ask / unrelated fields', () => {
    expect(hookResponseBlocksExecution({ permissionDecision: 'allow' })).toBe(false)
    expect(hookResponseBlocksExecution({ permissionDecision: 'ask' })).toBe(false)
    expect(hookResponseBlocksExecution({ updatedInput: { x: 1 } })).toBe(false)
  })
})

describe('hookResponseRequestsLoopStop', () => {
  it('returns false for undefined / empty response', () => {
    expect(hookResponseRequestsLoopStop(undefined)).toBe(false)
    expect(hookResponseRequestsLoopStop({} as HookResponse)).toBe(false)
  })

  it('returns true ONLY for continue: false', () => {
    expect(hookResponseRequestsLoopStop({ continue: false })).toBe(true)
  })

  it('returns true ONLY for preventContinuation: true', () => {
    expect(hookResponseRequestsLoopStop({ preventContinuation: true })).toBe(true)
  })

  it('returns false for permissionDecision: deny (per-tool deny, NOT loop stop)', () => {
    // This is the key distinction: a `deny` should let the model see the
    // tool error and adapt, NOT terminate the agentic loop with `hook_stopped`.
    expect(hookResponseRequestsLoopStop({ permissionDecision: 'deny' })).toBe(false)
    expect(hookResponseRequestsLoopStop({ decision: 'deny' })).toBe(false)
  })

  it('returns false for ask / allow / unrelated fields', () => {
    expect(hookResponseRequestsLoopStop({ permissionDecision: 'allow' })).toBe(false)
    expect(hookResponseRequestsLoopStop({ permissionDecision: 'ask' })).toBe(false)
    expect(hookResponseRequestsLoopStop({ updatedInput: { x: 1 } })).toBe(false)
    expect(hookResponseRequestsLoopStop({ continue: true })).toBe(false)
  })

  it('combined: a deny + preventContinuation is a loop-stop request', () => {
    // If a hook author sets both, prefer the loop-stop signal — the deny
    // will still block the tool, and the loop will terminate.
    expect(
      hookResponseRequestsLoopStop({
        permissionDecision: 'deny',
        preventContinuation: true,
      }),
    ).toBe(true)
  })
})
