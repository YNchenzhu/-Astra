/**
 * upstream report Phase 5 — Query loop termination conditions registry.
 *
 * **Integration note (5-piece set §A1)**: the cleanup pipeline now
 * delegates to {@link registerQueryStopHook} / {@link runQueryStopHooks}
 * (`electron/ai/agenticLoop/queryStopHooks.ts`). The previous
 * module-local `cleanupCallbacks: CleanupCallback[]` array is gone;
 * registrations get translated to priority-ordered hooks and run via
 * the async generator. The legacy {@link registerTerminationCleanup}
 * surface is preserved verbatim so existing call sites compile and
 * behave identically — they just gain implicit priority 100 and can be
 * interleaved with explicitly priority-aware callers (e.g. the cache
 * snapshot hook at priority 10).
 *
 * Termination reasons (upstream-aligned: every reason maps to a structural
 * external signal — API stop event, hook decision, counter, or abort).
 *
 * ┌──────────────────────────────┬────────────────────────────────────────────┐
 * │ Termination Reason           │ Trigger Scenario                           │
 * ├──────────────────────────────┼────────────────────────────────────────────┤
 * │ 'blocking_limit'             │ Context exceeds hard blocking limit        │
 * │ 'aborted_streaming'          │ User abort during streaming (Esc/Ctrl+C)   │
 * │ 'aborted_tools'              │ User abort during tool execution           │
 * │ 'prompt_too_long'            │ All compress/recover paths failed          │
 * │ 'image_error'                │ Image size/adjustment unrecoverable        │
 * │ 'model_error'                │ API threw unrecoverable exception          │
 * │ 'stop_hook_prevented'        │ Stop hook blocked continuation             │
 * │ 'hook_stopped'               │ Tool execution hook stopped                │
 * │ 'iteration_boundary_stopped' │ Kernel iterationBoundaryHook returned stop │
 * │ 'max_turns'                  │ Reached max iteration limit                │
 * │ 'output_budget_exhausted'    │ User-supplied output token budget hit cap  │
 * │ 'completed'                  │ Normal: model finished with no tools       │
 * └──────────────────────────────┴────────────────────────────────────────────┘
 */

import {
  registerQueryStopHook,
  runQueryStopHooks,
  __resetQueryStopHooksForTests,
} from './agenticLoop/queryStopHooks'

/**
 * 2026-07 contract tightening (cc-haha `transitions.ts` parity) — the
 * union is now DERIVED from the shared runtime array, symmetric with
 * {@link import('./loopEvents').KNOWN_LOOP_TRANSITIONS}. Every value must
 * have at least one production writer (a `createTerminalResult('X', …)`
 * literal or a decision-table / loopSignal mapping site); the dead-value
 * + classification audit lives in `queryTermination.contract.test.ts`.
 * Adding a value here is a deliberate act: it requires (1) a real writer,
 * (2) a `TERMINATION_DESCRIPTIONS` entry (compile-enforced Record), and
 * (3) a classification row in the contract test's expectation matrix.
 */
export {
  KNOWN_TERMINATION_REASONS,
  type TerminationReason,
} from '../../shared/terminationReasons'
import type { TerminationReason } from '../../shared/terminationReasons'

export interface QueryTerminalResult {
  reason: TerminationReason
  turnCount: number
  totalUsage?: { inputTokens: number; outputTokens: number }
  errorDetail?: string
  /** When `max_turns`, the limit that was hit. */
  maxTurnsLimit?: number
  /** When `stop_hook_prevented` / `hook_stopped`, which hook triggered. */
  hookName?: string
  /** Timestamp of termination. */
  terminatedAt: number
}

export type CleanupCallback = (result: QueryTerminalResult) => void | Promise<void>

/**
 * Default priority for legacy {@link registerTerminationCleanup}
 * registrations. upstream parity: their stop-hooks system numbers state
 * capture in the 0-99 band, persistence/memory in 100-199, proactive
 * agents in 200-299, UI in 300+. 100 puts legacy callbacks above
 * snapshot hooks (which use priority 10) but below memory / dream
 * extensions that explicitly opt into a higher priority. Existing
 * callbacks therefore land in roughly the same slot they would have
 * naturally occupied if they'd been priority-aware from day one.
 */
const LEGACY_CLEANUP_DEFAULT_PRIORITY = 100

/**
 * Internal id counter for legacy registrations — gives each one a unique
 * `name` so the hook pipeline can log meaningful failures. Not consumed
 * by callers (they only get an unregister closure back).
 */
let legacyCleanupSeq = 0

/**
 * Register a cleanup callback that runs on any termination.
 *
 * **Wired since the 5-piece-set integration**: this now delegates to
 * {@link registerQueryStopHook} at {@link LEGACY_CLEANUP_DEFAULT_PRIORITY}.
 * Behaviour matches the previous module-local-array implementation
 * (callbacks fire on every termination; failures are isolated and
 * logged) plus a priority dimension callers can opt into via
 * {@link registerQueryStopHook} directly.
 */
export function registerTerminationCleanup(cb: CleanupCallback): () => void {
  const id = legacyCleanupSeq++
  return registerQueryStopHook({
    name: `legacy-cleanup-${id}`,
    priority: LEGACY_CLEANUP_DEFAULT_PRIORITY,
    run: cb,
  })
}

/**
 * Run every registered cleanup, in priority order.
 *
 * Drains the unified {@link runQueryStopHooks} async generator (which is
 * also where {@link registerQueryStopHook}'s explicit registrations
 * land). Failures inside any single hook are caught and logged by the
 * generator itself — the loop never aborts the pipeline.
 */
export async function runTerminationCleanup(result: QueryTerminalResult): Promise<void> {
  for await (const _ev of runQueryStopHooks(result)) {
    // The async generator handles logging on failure; nothing else to do
    // in the legacy drain shape (callers that want per-hook status
    // events should iterate `runQueryStopHooks` themselves).
  }
}

/**
 * Create a QueryTerminalResult for the given termination reason.
 */
export function createTerminalResult(
  reason: TerminationReason,
  opts: {
    turnCount: number
    totalUsage?: { inputTokens: number; outputTokens: number }
    errorDetail?: string
    maxTurnsLimit?: number
    hookName?: string
  },
): QueryTerminalResult {
  return {
    reason,
    turnCount: opts.turnCount,
    totalUsage: opts.totalUsage,
    errorDetail: opts.errorDetail,
    maxTurnsLimit: opts.maxTurnsLimit,
    hookName: opts.hookName,
    terminatedAt: Date.now(),
  }
}

/** Whether this is an error termination (not a normal completion). */
export function isErrorTermination(reason: TerminationReason): boolean {
  return reason !== 'completed' && reason !== 'max_turns' && reason !== 'verification_required'
}

/**
 * Audit Bug 5 — true when the loop ended in a way that likely left the
 * user's task incomplete, even if it didn't surface as an "error". UI
 * consumers should warn the user instead of presenting these the same
 * way as a clean `'completed'`.
 */
export function isPossiblyIncompleteTermination(reason: TerminationReason): boolean {
  return reason === 'max_turns' || reason === 'verification_required'
}

/** Whether the user actively aborted. */
export function isUserAbort(reason: TerminationReason): boolean {
  return reason === 'aborted_streaming' || reason === 'aborted_tools'
}

/** Whether this was a context/token overflow. */
export function isContextOverflow(reason: TerminationReason): boolean {
  return reason === 'blocking_limit' || reason === 'prompt_too_long'
}

/** Whether a hook prevented continuation. */
export function isHookPrevented(reason: TerminationReason): boolean {
  // P1-28: include the kernel boundary stop here so consumers that batch
  // "loop ended via a hook decision rather than user/error" treat it
  // consistently (e.g., UI badges, replay logic).
  return (
    reason === 'stop_hook_prevented' ||
    reason === 'hook_stopped' ||
    reason === 'iteration_boundary_stopped'
  )
}

/**
 * Human-readable description of termination for UI/logging.
 */
export function describeTermination(result: QueryTerminalResult): string {
  const base = TERMINATION_DESCRIPTIONS[result.reason]
  const parts = [base]
  if (result.turnCount > 0) {
    parts.push(`after ${result.turnCount} turn(s)`)
  }
  if (result.errorDetail) {
    parts.push(`— ${result.errorDetail}`)
  }
  if (result.hookName) {
    parts.push(`(hook: ${result.hookName})`)
  }
  return parts.join(' ')
}

const TERMINATION_DESCRIPTIONS: Record<TerminationReason, string> = {
  blocking_limit: 'Context reached hard blocking limit; no recovery possible.',
  aborted_streaming: 'User interrupted during model streaming.',
  aborted_tools: 'User interrupted during tool execution.',
  prompt_too_long: 'Prompt too long after all compression attempts.',
  image_error: 'Unrecoverable image size or format error.',
  model_error: 'API returned an unrecoverable error.',
  stop_hook_prevented: 'A stop hook prevented continuation.',
  hook_stopped: 'A tool-execution hook stopped the loop.',
  stop_hook_circuit_breaker:
    'Stop hook circuit breaker tripped — a hook kept firing without forward progress.',
  iteration_boundary_stopped: 'Kernel iteration-boundary hook ended the loop.',
  iteration_stalled: 'Iteration stall detector terminated the turn — model produced no forward progress over consecutive turns.',
  max_turns: 'Maximum iteration limit reached — task may be incomplete.',
  output_budget_exhausted: 'User-supplied output token budget exhausted.',
  verification_required:
    'Code changes remain unverified; the task cannot be marked complete yet.',
  completed: 'Model completed normally (no tool calls requested).',
}

/**
 * Canonical body for synthetic tool_results of tools the user interrupted.
 *
 * 2026-07 interruption-protocol fix — cc-haha CANCEL_MESSAGE parity: the
 * bare "was interrupted by user." statement carried no behavioural contract,
 * so a model replaying the transcript would either assume the tool ran or
 * silently re-issue it. The directive suffix pins both failure modes down.
 * Callers prefix `Error: ` themselves where the `startsWith('Error:')`
 * failure heuristics expect it.
 */
export const TOOL_INTERRUPTED_BY_USER_MESSAGE =
  'Tool execution was interrupted by user. Do not assume it completed and ' +
  'do not retry it on your own — stop and wait for the user to tell you how to proceed.'

/**
 * Build a user-facing interruption message for the chat UI.
 * Used when the abort reason is NOT 'interrupt' (which means a follow-up is queued).
 */
export function createUserInterruptionMessage(
  reason: 'aborted_streaming' | 'aborted_tools',
): Record<string, unknown> {
  return {
    role: 'user',
    content:
      reason === 'aborted_streaming'
        ? '[User interrupted during model response.]'
        : '[User interrupted during tool execution.]',
    _type: 'interruption',
  }
}

/**
 * Generate synthetic tool_result blocks for tools that were never completed
 * due to user interruption.
 */
export function yieldMissingToolResultBlocks(
  toolUseBlocks: Array<{ id: string; name: string }>,
  completedToolIds: Set<string>,
): Array<Record<string, unknown>> {
  const missing: Array<Record<string, unknown>> = []
  for (const tu of toolUseBlocks) {
    if (!completedToolIds.has(tu.id)) {
      missing.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: `Error: ${TOOL_INTERRUPTED_BY_USER_MESSAGE}`,
        is_error: true,
      })
    }
  }
  return missing
}

/** Reset all registered cleanup callbacks (for tests). */
export function resetTerminationCleanup(): void {
  __resetQueryStopHooksForTests()
  // Reset the legacy registration sequence so test runs see stable
  // generated names ('legacy-cleanup-0', '-1', …) instead of an
  // ever-growing counter.
  legacyCleanupSeq = 0
}
