/**
 * Agentic-loop event union — generator-first event surface.
 *
 * upstream §11.1 (AsyncGenerator pipeline) prescribes the loop produces a single
 * **typed event stream** consumers can `for await` over. We've operated
 * historically on twelve separate {@link AgenticLoopCallbacks} fields
 * (onTextDelta / onToolStart / onMessageEnd / …); that surface is wide,
 * untyped at the consumption site, and imposes a fan-in pattern at every
 * caller.
 *
 * Collapsing every callback into a single discriminated union — one event
 * type per callback signature — gives us four wins simultaneously:
 *
 *   1. **Generator API**: `runAgenticLoopAsync` can `for await ... of` a
 *      single iterable; consumers see the full event timeline in source
 *      order without juggling closures.
 *   2. **Type narrowing**: `switch (event.type)` lets TS prove the
 *      absence of, say, a `toolUse` field on a `'text_delta'` event;
 *      the old shape required runtime checks for each branch.
 *   3. **Cancellation**: a generator's natural `.return()` /
 *      `.throw()` protocol propagates abort up the consumer chain
 *      automatically; with callbacks we previously had to thread an
 *      AbortController plus check `state.signal.aborted` at every site.
 *   4. **Replay / record**: events serialise to a flat array; tests
 *      can record-and-replay the full timeline for golden-output
 *      assertions without subclassing every callback signature.
 *
 * Backward compat: {@link AgenticLoopCallbacks} stays the public callback
 * surface; the new generator API is offered alongside it. Internally,
 * `runAgenticLoop(params, callbacks)` becomes a thin fan-out adapter that
 * subscribes to the generator and dispatches to callback fields.
 */

import type { ContextLevel } from '../context/manager'
import type { CompactDetail } from './agenticLoopTypes'
import type { QueryLoopPreModelPhase } from './queryLoopPreModel'
import type { QueryTerminalResult } from './queryTermination'

// ────────────────────────────────────────────────────────────────────────
// Inner block shapes (kept thin — they mirror the existing callback args).
// ────────────────────────────────────────────────────────────────────────

export interface ToolUseBlock {
  id: string
  name: string
  input: Record<string, unknown>
}

export interface ToolResultBlock {
  id: string
  name: string
  success: boolean
  output?: string
  error?: string
}

export interface ThinkingBlock {
  thinking: string
  signature?: string
}

export interface UsageDelta {
  inputTokens: number
  outputTokens: number
}

export interface PreModelInfo {
  iteration: number
  phases: QueryLoopPreModelPhase[]
  snippedCount: number
  wasContextManaged: boolean
  idleToolClearApplied?: boolean
}

export interface StopHookInfo {
  iteration: number
  action: 'end' | 'continue'
}

export interface StreamingFallbackInfo {
  status: number
  reason: string
}

// ────────────────────────────────────────────────────────────────────────
// LoopEvent — one shape per existing AgenticLoopCallbacks field.
// ────────────────────────────────────────────────────────────────────────

/**
 * Mirrors {@link AgenticLoopCallbacks} 1:1 so the fan-out adapter can route
 * each event to its corresponding callback without a translation table:
 *
 *   text_delta                     → onTextDelta(text)
 *   thinking_delta                 → onThinkingDelta(text)
 *   thinking_block                 → onThinkingBlock({thinking, signature})
 *   reasoning_summary_delta        → onReasoningSummaryDelta(text)
 *   reasoning_summary_block        → onReasoningSummaryBlock({text, ...})
 *   tool_start                     → onToolStart(toolUse)
 *   tool_input_delta               → onToolInputDelta({toolUseId, toolName, partialJson})
 *   tool_result                    → onToolResult(toolResult)
 *   message_end                    → onMessageEnd(usage?)
 *   error                          → onError(error)
 *   context_compact                → onContextCompact(detail)
 *   max_iterations                 → onMaxIterationsReached(maxIterations)
 *   pre_model                      → onQueryLoopPreModel(info)
 *   stop_hook                      → onQueryLoopStopHook(info)
 *   streaming_fallback             → onStreamingFallback(info)
 */
export type LoopEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'thinking_block'; block: ThinkingBlock }
  | { type: 'reasoning_summary_delta'; text: string }
  | {
      type: 'reasoning_summary_block'
      block: { text: string; thinkingTimeMs?: number; thinkingTokens?: number }
    }
  | { type: 'tool_start'; toolUse: ToolUseBlock }
  | { type: 'tool_input_delta'; toolUseId: string; toolName: string; partialJson: string }
  | { type: 'tool_result'; toolResult: ToolResultBlock }
  | { type: 'message_end'; usage?: UsageDelta }
  | { type: 'error'; error: string }
  | ({ type: 'context_compact'; level: ContextLevel | string } & Omit<CompactDetail, 'level'>)
  | { type: 'max_iterations'; maxIterations: number }
  | { type: 'pre_model'; info: PreModelInfo }
  | { type: 'stop_hook'; info: StopHookInfo }
  | { type: 'streaming_fallback'; info: StreamingFallbackInfo }

/** Narrow extracter — `event.type === 'tool_start'` ⇒ payload typed. */
export type LoopEventOfType<T extends LoopEvent['type']> = Extract<LoopEvent, { type: T }>

// ────────────────────────────────────────────────────────────────────────
// LoopTransition — debugging / telemetry trail (upstream §11.2).
// ────────────────────────────────────────────────────────────────────────

/**
 * Single source of truth for the per-iteration "why did this turn happen?"
 * marker. Each entry must have at least one production writer (`state.transition = ...`)
 * in `electron/ai/agenticLoop/`. upstream parity: their `query.ts` Continue
 * union has the same property — every reason in the union is reachable.
 *
 * Adding a value here is a deliberate act: it requires (1) at least one
 * phase-module write site, (2) updating {@link isRecoveryTransition} so
 * the TS exhaustive-switch check confirms the new value's classification.
 *
 * Audit coverage lives in `loopEvents.test.ts` — see that test for the
 * inventory of writers and the dead-value guard.
 */
export const KNOWN_LOOP_TRANSITIONS = [
  // Lifecycle markers
  'init',                  // setup.ts initial value
  // Normal advances
  'tool_use',              // agenticLoop.ts — tool batch completed; iteration advanced
  'no_tool_use_continue',  // noTools.ts — decideAfterNoToolUse / inter-agent / token-budget continue
  'stop_hook_continue',    // noTools.ts — Stop hook injected user content (continue mode)
  // Recovery paths (stream phase mid-iteration retries)
  'reactive_compact',      // stream.ts — PTL reactive compact succeeded; loop retried
  // P0-3 audit Bug-5 fix — distinct value for the FREE drain-only layer
  // ahead of `reactive_compact`. Telemetry consumers can now tell when the
  // cheap path alone fixed PTL (no extra LLM summary cost) vs when the full
  // compact was needed. Writer: stream/recoverFromContext.ts.
  'collapse_drain',        // stream/recoverFromContext.ts — drain-only retry succeeded
  'max_output_recovery',   // stream.ts — output truncated; loop retried with continuation
  'max_output_escalate',   // stream.ts — first-shot 8k→64k escalation; no meta message
  'strip_retry',           // stream.ts — image strip-retry succeeded; loop retried
  'overload_fallback',     // stream.ts — Anthropic 529 fell back to alternate model
] as const

export type LoopTransition = (typeof KNOWN_LOOP_TRANSITIONS)[number]

/**
 * True when {@link t} represents a stream-phase **recovery path** (we hit a
 * provider error / over-budget condition and the loop self-healed within
 * the same iteration). False for normal lifecycle advances.
 *
 * Implemented as an exhaustive `switch` so TypeScript flags a missing case
 * the moment a new {@link LoopTransition} value lands without an explicit
 * classification — the compile-time analogue of upstream's runtime
 * `transition.reason` switch in `query.ts`.
 */
export function isRecoveryTransition(t: LoopTransition): boolean {
  switch (t) {
    case 'reactive_compact':
    case 'collapse_drain':
    case 'max_output_recovery':
    case 'max_output_escalate':
    case 'strip_retry':
    case 'overload_fallback':
      return true
    case 'init':
    case 'tool_use':
    case 'no_tool_use_continue':
    case 'stop_hook_continue':
      return false
  }
}

// ────────────────────────────────────────────────────────────────────────
// AgenticLoopResult — generator return value.
// ────────────────────────────────────────────────────────────────────────

/**
 * What the generator yields when the run terminates cleanly.
 * Mirrors what the legacy callback `runAgenticLoop` left behind in
 * `LoopState.terminationResult` + `LoopState.totalUsage` — exposed now
 * as the natural `return value` of the generator so consumers no longer
 * need to peek into a bag of side-effects.
 */
export interface AgenticLoopResult {
  /**
   * Always present: `runTerminationCleanup` is already invoked inside
   * each phase's terminal branch, so this is purely informational for
   * the consumer (e.g. UI surfaces "max_turns" badge).
   */
  terminationResult: QueryTerminalResult
  totalUsage: UsageDelta
  /** Final transition value at termination time (debug-only). */
  transition: LoopTransition
  /** The full ordered transition trail for the session. */
  transitionHistory: ReadonlyArray<LoopTransition>
}

// ────────────────────────────────────────────────────────────────────────
// Constructor helpers (cheap & strongly-typed; no runtime validation).
// ────────────────────────────────────────────────────────────────────────
//
// These exist so phase modules don't sprinkle `as const` / explicit
// `type: 'foo'` literals at every emit site. `event('text_delta', { text })`
// reads as a single, type-checked emission.

export function event<T extends LoopEvent['type']>(
  type: T,
  payload: Omit<LoopEventOfType<T>, 'type'>,
): LoopEventOfType<T> {
  return { type, ...payload } as LoopEventOfType<T>
}
