/**
 * P4.2 — Unit tests for the subagent retry policy.
 *
 * One row per `TerminationReason` (13 total) plus 2 boundary cases for
 * the attempt-count clamp on `model_error` / `prompt_too_long`.
 */

import { describe, it, expect } from 'vitest'
import { decideSubagentRetry } from './subAgentRetryPolicy'

describe('decideSubagentRetry — TerminationReason decision table', () => {
  it('completed → no_retry (success path)', () => {
    expect(decideSubagentRetry('completed', 0).kind).toBe('no_retry')
  })

  it('max_turns → no_retry (budget exhausted)', () => {
    expect(decideSubagentRetry('max_turns', 0).kind).toBe('no_retry')
  })

  it('output_budget_exhausted → no_retry (budget exhausted)', () => {
    expect(decideSubagentRetry('output_budget_exhausted', 0).kind).toBe('no_retry')
  })

  it('aborted_streaming → no_retry (user-initiated)', () => {
    expect(decideSubagentRetry('aborted_streaming', 0).kind).toBe('no_retry')
  })

  it('aborted_tools → no_retry (user-initiated)', () => {
    expect(decideSubagentRetry('aborted_tools', 0).kind).toBe('no_retry')
  })

  it('iteration_boundary_stopped → no_retry (kernel-initiated)', () => {
    expect(decideSubagentRetry('iteration_boundary_stopped', 0).kind).toBe('no_retry')
  })

  it('stop_hook_prevented → no_retry (hook explicit stop)', () => {
    expect(decideSubagentRetry('stop_hook_prevented', 0).kind).toBe('no_retry')
  })

  it('hook_stopped → no_retry (tool-exec hook stop)', () => {
    expect(decideSubagentRetry('hook_stopped', 0).kind).toBe('no_retry')
  })

  it('image_error → no_retry (task-side issue)', () => {
    expect(decideSubagentRetry('image_error', 0).kind).toBe('no_retry')
  })

  it('blocking_limit → abort (env misconfigured, parent should surface)', () => {
    const d = decideSubagentRetry('blocking_limit', 0)
    expect(d.kind).toBe('abort')
    expect(d.reason).toMatch(/blocking limit|context/i)
  })

  it('stop_hook_circuit_breaker → abort (broken hook config)', () => {
    const d = decideSubagentRetry('stop_hook_circuit_breaker', 0)
    expect(d.kind).toBe('abort')
    expect(d.reason).toMatch(/circuit breaker|hook/i)
  })

  it('model_error on first attempt → retry with backoff', () => {
    const d = decideSubagentRetry('model_error', 0)
    expect(d.kind).toBe('retry')
    if (d.kind === 'retry') {
      expect(d.backoffMs).toBeGreaterThan(0)
    }
  })

  it('prompt_too_long on first attempt → retry with backoff', () => {
    const d = decideSubagentRetry('prompt_too_long', 0)
    expect(d.kind).toBe('retry')
  })

  // ── Boundary cases ─────────────────────────────────────────────────

  it('model_error at maxAttempts boundary → no_retry (give up)', () => {
    // Default maxAttempts is 2; attemptsSoFar=1 means we've already
    // done one retry, so the next call must NOT continue retrying.
    const d = decideSubagentRetry('model_error', 1)
    expect(d.kind).toBe('no_retry')
    expect(d.reason).toMatch(/giving up|attempts/)
  })

  it('prompt_too_long at maxAttempts boundary → no_retry (genuinely too large)', () => {
    const d = decideSubagentRetry('prompt_too_long', 1)
    expect(d.kind).toBe('no_retry')
  })

  it('respects custom maxAttempts override', () => {
    // With maxAttempts=4, attemptsSoFar=2 still retries (2+1 < 4).
    const d = decideSubagentRetry('model_error', 2, { maxAttempts: 4 })
    expect(d.kind).toBe('retry')
  })

  it('respects custom retryBackoffMs override', () => {
    const d = decideSubagentRetry('model_error', 0, { retryBackoffMs: 5_000 })
    if (d.kind === 'retry') {
      expect(d.backoffMs).toBe(5_000)
    }
  })
})
