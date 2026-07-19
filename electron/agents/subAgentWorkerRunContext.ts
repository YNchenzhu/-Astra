/**
 * Shared mutable run-state for a single `runSubAgentInWorker` invocation.
 *
 * Mirrors `subAgentRunContext.ts` for the worker path: the worker message
 * handler's sub-blocks (RPC tool bridge, LoopEvent bridge) and the
 * done/fail/error/exit handlers all read & write the same per-run counters.
 * Bundling them here lets the RPC bridge and event bridge live in their own
 * modules while sharing state by reference.
 *
 * The `worker` handle and the lifecycle closures (`finish` / `sendBudgetAbort`)
 * are passed to the bridges as explicit deps rather than living here.
 */

import { WorkerOutputAccumulator } from './subAgentWorkerOutputAccumulator'

export interface WorkerRunCtx {
  /** Once-guard: flipped by `finish()`; read by error/exit/abort handlers. */
  done: boolean
  /** Actual tool-use count (mirrors in-process `totalToolUses`). */
  totalToolUses: number
  /**
   * `taskRuntimeStore` write cursor at the start of the current turn; used by
   * the streaming-fallback rollback to rewind the persistent buffer. `null`
   * when no runtime record exists for this agent.
   */
  taskCursorAtTurnStart: number | null
  /** Summed across every `message_end.usage` (mirrors in-process). */
  outputTokTotal: number
  /** Last seen `usage.inputTokens` (conversation-level, not per-message). */
  latestInputTokens: number
  /** Set the first time a budget cap trips; subsequent trips are ignored. */
  budgetAbortReason: string | null
  /** Latch so the readonly tool-count warning sidechain fires at most once. */
  warnedToolCount: boolean
  /**
   * Set when the worker reported a graceful wind-down (`winddown` message).
   * Surfaced on `SubAgentResult.windDown` at `done` — parity with the
   * in-process `ctx.windDown` and symmetric with the rescue metadata.
   */
  windDown:
    | { trigger: 'tools' | 'tokens' | 'iterations'; iteration?: number; maxIterations?: number }
    | undefined
  /** Output text state machine shared with `resolveSubAgentReportedOutputDetail`. */
  readonly outputAcc: WorkerOutputAccumulator
  /** Granted-but-not-yet-`admit_done` LOCAL tool admissions (released on finish). */
  readonly outstandingLocalAdmissions: Set<string>
  /** Main-process RPC admissions still executing when the worker session ends. */
  readonly outstandingRpcAdmissions: Set<string>
  /** Abort listener cleanup for LOCAL admissions whose work runs in the worker. */
  readonly localAdmissionAbortCleanups: Map<string, () => void>
}

/** Initialize a fresh worker run-state. `taskCursorAtTurnStart` is seeded by the caller. */
export function createWorkerRunCtx(taskCursorAtTurnStart: number | null): WorkerRunCtx {
  return {
    done: false,
    totalToolUses: 0,
    taskCursorAtTurnStart,
    outputTokTotal: 0,
    latestInputTokens: 0,
    budgetAbortReason: null,
    warnedToolCount: false,
    windDown: undefined,
    outputAcc: new WorkerOutputAccumulator(),
    outstandingLocalAdmissions: new Set<string>(),
    outstandingRpcAdmissions: new Set<string>(),
    localAdmissionAbortCleanups: new Map<string, () => void>(),
  }
}
