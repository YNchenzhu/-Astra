/**
 * Shared mutable run-state for a single `runSubAgent` invocation.
 *
 * `runSubAgent` threads ~19 mutable values through deeply nested closures
 * (stream callbacks write them; the main loop / rescue / result assembly read
 * them). To split those closures into their own modules without losing the
 * shared-by-reference semantics, the values live on this object and every site
 * reads/writes `ctx.<field>` instead of a captured `let`.
 *
 * Only state that crosses a module boundary after the file split lives here.
 * Purely-local scratch (corePrompt, stableSystemContext, volatileUserContextParts,
 * continuation API, rescue metadata, worker-branch flags) stays local to its
 * owning function.
 */

import type { QueryTerminalResult } from '../ai/queryTermination'

export interface SubAgentRunState {
  // ── Token / tool metrics (shared: callbacks write, result reads) ──
  /** Per-turn cumulative input tokens (max across turns) → context-size budget gate. */
  latestInputTokens: number
  /** Sum of per-turn input tokens → user-facing billing total in SubAgentResult. */
  inputTokSum: number
  /** Sum of per-turn output tokens. */
  outputTokTotal: number
  /** Total tool invocations across the run. */
  totalToolUses: number
  /** Accumulated assistant text (final-output resolver reads this). */
  outputText: string
  /** Latch so the readonly tool-budget warning fires at most once. */
  warnedToolCount: boolean

  // ── Sub-agent process digest (bounded; surfaced to the parent) ──
  readonly toolUseCounts: Map<string, number>
  readonly toolFailures: Array<{ name: string; error: string }>

  // ── Abort bookkeeping (shared: callbacks set, result reads) ──
  abortReason: string | undefined

  // ── In-process agentic-loop state (callbacks write, loop/result read) ──
  reachedMaxIterations: boolean
  lastFinalText: string
  iterationToolCount: number
  budgetDirectiveInjected: boolean
  /**
   * Records the graceful wind-down when it fires (at most once, in lockstep
   * with {@link budgetDirectiveInjected}). Surfaced on `SubAgentResult.windDown`
   * so the digest / telemetry can note the report was budget-driven — symmetric
   * with the final-summary rescue metadata.
   */
  windDown:
    | { trigger: 'tools' | 'tokens' | 'iterations'; iteration?: number; maxIterations?: number }
    | undefined
  outputLenBeforeThisStream: number
  taskCursorBeforeThisStream: number | null
  iterationStartOutputLen: number
  sawPerStreamUsage: boolean
  firstModelByteLogged: boolean
  /**
   * Ref container (not a bare field) because TS flow analysis can't see
   * assignments made inside the `onTerminate` closure; the container keeps the
   * captured `terminationResult` visible at read sites outside the closure.
   */
  terminationResultRef: { value: QueryTerminalResult | null }
}

/** Initialize a fresh run-state with the same defaults the inline `let`s used. */
export function createSubAgentRunState(): SubAgentRunState {
  return {
    latestInputTokens: 0,
    inputTokSum: 0,
    outputTokTotal: 0,
    totalToolUses: 0,
    outputText: '',
    warnedToolCount: false,
    toolUseCounts: new Map<string, number>(),
    toolFailures: [],
    abortReason: undefined,
    reachedMaxIterations: false,
    lastFinalText: '',
    iterationToolCount: 0,
    budgetDirectiveInjected: false,
    windDown: undefined,
    outputLenBeforeThisStream: 0,
    taskCursorBeforeThisStream: null,
    iterationStartOutputLen: 0,
    sawPerStreamUsage: false,
    firstModelByteLogged: false,
    terminationResultRef: { value: null },
  }
}
