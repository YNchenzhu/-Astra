/**
 * P4.2 — Subagent retry decision policy.
 *
 * upstream parity: `agents/AgentTool.tsx` consumes each subagent's
 * terminal `TerminationReason` and decides whether to retry, abort, or
 * accept the result. Pole's `subAgentRunner.ts` historically captured
 * `terminationResult.reason` via the `onTerminate` hook (L1039-1060)
 * but never used it to drive retry behaviour — the field was harvested
 * "for future use". This module is that future use.
 *
 * Pure function (no I/O, no state, no globals). One row per
 * `TerminationReason`; if a future reason is added without a row here
 * the TypeScript exhaustive check at the bottom flags it at compile
 * time.
 *
 * Decision table (matches `agents/AgentTool.tsx` semantics with one
 * Pole-specific addition: `stop_hook_circuit_breaker` is treated as
 * `abort` instead of `no_retry` so a runaway hook surfaces to the
 * parent's error UI rather than silently completing without output):
 *
 *   completed                       → no_retry (success)
 *   max_turns                       → no_retry (budget exhausted)
 *   iteration_stalled               → no_retry (stall guard — same input re-stalls)
 *   aborted_streaming               → no_retry (user-initiated)
 *   aborted_tools                   → no_retry (user-initiated)
 *   iteration_boundary_stopped      → no_retry (kernel-initiated)
 *   stop_hook_prevented             → no_retry (hook explicit stop)
 *   hook_stopped                    → no_retry (tool-exec hook stop)
 *   image_error                     → no_retry (task-side, retry won't help)
 *   output_budget_exhausted         → no_retry (budget exhausted)
 *   blocking_limit                  → abort (context unrecoverable)
 *   stop_hook_circuit_breaker       → abort (broken hook config)
 *   model_error                     → retry (transient API issue)
 *   prompt_too_long                 → retry (one shot with compact)
 */

import type { TerminationReason } from '../ai/queryTermination'

export type SubagentRetryDecision =
  | { kind: 'retry'; reason: string; backoffMs?: number }
  | { kind: 'abort'; reason: string }
  | { kind: 'no_retry'; reason: string }

export interface SubagentRetryConfig {
  /** Max attempts for retry-eligible terminations. Default 2 (= 1 retry). */
  maxAttempts?: number
  /** Backoff in ms between retry attempts. Default 1000. */
  retryBackoffMs?: number
}

const DEFAULT_MAX_ATTEMPTS = 2
const DEFAULT_RETRY_BACKOFF_MS = 1000

/**
 * Decide what the parent should do with a subagent that terminated with
 * `terminationReason` after `attemptsSoFar` runs.
 *
 * Pure — caller threads `attemptsSoFar` and reads the returned decision.
 */
export function decideSubagentRetry(
  terminationReason: TerminationReason,
  attemptsSoFar: number,
  config: SubagentRetryConfig = {},
): SubagentRetryDecision {
  const maxAttempts = config.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const retryBackoffMs = config.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS

  switch (terminationReason) {
    // ── Success / clean exits — no retry ───────────────────────────
    case 'completed':
      return { kind: 'no_retry', reason: 'subagent completed successfully' }
    case 'max_turns':
      return {
        kind: 'no_retry',
        reason: 'subagent reached max iteration budget — retrying with same params would hit the same cap',
      }
    case 'output_budget_exhausted':
      return {
        kind: 'no_retry',
        reason: 'subagent exhausted its user-supplied output token budget',
      }
    case 'iteration_stalled':
      // Token-delta stall guard fired — same input would re-trigger the
      // same stall pattern, so retrying is pointless (mirrors `max_turns`
      // semantics: budget/progress exhausted).
      return {
        kind: 'no_retry',
        reason: 'subagent stall guard fired — retrying with same params would re-stall',
      }

    // ── User-initiated stops — no retry (would be confusing) ───────
    case 'aborted_streaming':
      return { kind: 'no_retry', reason: 'subagent run aborted by user during streaming' }
    case 'aborted_tools':
      return { kind: 'no_retry', reason: 'subagent run aborted by user during tool execution' }
    case 'iteration_boundary_stopped':
      return { kind: 'no_retry', reason: 'subagent run stopped by kernel boundary hook' }

    // ── Hook-driven stops — no retry (hook said stop, respect that) ─
    case 'stop_hook_prevented':
      return {
        kind: 'no_retry',
        reason: 'subagent stopped by Stop hook explicit terminal request',
      }
    case 'hook_stopped':
      return {
        kind: 'no_retry',
        reason: 'subagent stopped by tool-execution hook',
      }

    // ── Task-side issues — retrying with same input won't help ─────
    case 'image_error':
      return {
        kind: 'no_retry',
        reason: 'subagent rejected an image — re-running with the same payload would fail again',
      }

    // ── Abort-the-parent — the failure is severe enough to surface ─
    case 'verification_required':
      return {
        kind: 'no_retry',
        reason: 'subagent stopped without satisfying required post-mutation verification',
      }

    case 'blocking_limit':
      return {
        kind: 'abort',
        reason: 'subagent context exceeded the hard blocking limit — environment misconfigured',
      }
    case 'stop_hook_circuit_breaker':
      return {
        kind: 'abort',
        reason: 'subagent stop hook ran away (circuit breaker tripped) — hook config needs review',
      }

    // ── Transient failures — retry once ────────────────────────────
    case 'model_error':
      if (attemptsSoFar + 1 >= maxAttempts) {
        return {
          kind: 'no_retry',
          reason: `subagent model_error after ${attemptsSoFar + 1} attempts — giving up`,
        }
      }
      return {
        kind: 'retry',
        reason: 'subagent hit a transient API error',
        backoffMs: retryBackoffMs,
      }
    case 'prompt_too_long':
      if (attemptsSoFar + 1 >= maxAttempts) {
        return {
          kind: 'no_retry',
          reason: `subagent prompt_too_long after ${attemptsSoFar + 1} attempts — context is genuinely too large`,
        }
      }
      return {
        kind: 'retry',
        reason: 'subagent prompt_too_long — one more shot with aggressive compact',
        backoffMs: retryBackoffMs,
      }

    default: {
      // Exhaustive check — if a new TerminationReason is added without
      // updating this switch, TypeScript flags it here.
      const _exhaustive: never = terminationReason
      void _exhaustive
      return {
        kind: 'no_retry',
        reason: `unknown terminationReason: ${String(terminationReason)}`,
      }
    }
  }
}
