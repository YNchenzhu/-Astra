/**
 * Sub-agent worker event bridge — translates worker-side {@link LoopEvent}s
 * into renderer-facing {@link SubAgentEvent}s and houses the per-event
 * bookkeeping (tool-use counting, sidechain writes, read-only budget
 * enforcement) that `runSubAgentInWorker` runs for each `case 'event'`.
 *
 * Extracted verbatim from `subAgentWorkerClient.ts` as a pure code move —
 * see that module for the historical context behind each branch.
 */

import type { LoopEvent } from '../ai/loopEvents'
import type { AgentId } from '../tools/ids'
import type { SubAgentEvent } from './types'
import type { WorkerRunCtx } from './subAgentWorkerRunContext'
import { appendSubAgentSidechain } from './subAgentSidechainTranscript'
import { taskRuntimeStore } from '../tools/TaskRuntimeStore'
import {
  readonlyToolCallLimit,
  readonlyToolCallWarnAt,
  readonlyTokenBudget,
  shouldAbortReadonlyBudgetAfterMessageEnd,
} from './subAgentReadonlyBudget'

/**
 * Translate a worker-side {@link LoopEvent} into the corresponding renderer-
 * facing {@link SubAgentEvent}. The renderer's `subAgentStreamRouter` whitelists
 * `subagent_*` types and silently drops everything else, so without this
 * adapter the worker path looked correct from the worker's POV but the UI
 * froze on `starting…` because no `subagent_text` / `subagent_tool_*` ever
 * arrived. The in-process path in `subAgentRunner.ts` does the same thing
 * inline via `loopCallbacks` — keep this function in sync with that mapping.
 *
 * Phase D (granularity uplift): `message_end`, `context_compact`, and
 * `max_iterations` now translate to typed `subagent_*` events so the
 * renderer can surface per-iteration usage, compact signals, and
 * limit-reached badges instead of waiting for `subagent_complete`. The
 * remaining unrouted events (`pre_model`, `stop_hook`,
 * `streaming_fallback`) stay `null` — exposing them would be UI noise
 * with no current consumer.
 */
/** @internal exported for regression test in `subAgentWorkerClient.test.ts`. */
export function loopEventToSubAgentEvent(
  ev: LoopEvent,
  agentId: AgentId,
): SubAgentEvent | null {
  switch (ev.type) {
    case 'text_delta':
      return { type: 'subagent_text', agentId, text: ev.text }
    case 'thinking_delta':
      return { type: 'subagent_thinking_delta', agentId, text: ev.text }
    case 'thinking_block':
      return {
        type: 'subagent_thinking_block_complete',
        agentId,
        thinkingBlock: ev.block,
      }
    case 'reasoning_summary_delta':
      return { type: 'subagent_reasoning_summary_delta', agentId, text: ev.text }
    case 'reasoning_summary_block':
      return {
        type: 'subagent_reasoning_summary_block_complete',
        agentId,
        reasoningSummaryBlock: ev.block,
      }
    case 'tool_start':
      return { type: 'subagent_tool_start', agentId, toolUse: ev.toolUse }
    case 'tool_input_delta':
      // Worker path mirror of the in-process `subAgentRunner.onToolInputDelta`
      // wiring — translates the loop event into the canonical sub-agent
      // event shape so the renderer's `subAgentStreamRouter` sees the
      // same payload regardless of whether the sub-agent ran in a
      // utility process or in-thread.
      return {
        type: 'subagent_tool_input_delta',
        agentId,
        toolUseId: ev.toolUseId,
        toolName: ev.toolName,
        partialJson: ev.partialJson,
      }
    case 'tool_result':
      return { type: 'subagent_tool_result', agentId, toolResult: ev.toolResult }
    case 'error':
      return { type: 'subagent_error', agentId, error: ev.error }
    case 'message_end':
      // `iteration` is not on the worker-side LoopEvent shape; only the
      // in-process path can populate it (it owns the agentic loop's
      // iteration counter directly). Worker-path consumers see `usage`
      // alone, which is what they get from the existing in-line
      // `message_end` handling at the bottom of the worker.on('message')
      // body below.
      return ev.usage
        ? { type: 'subagent_message_end', agentId, usage: ev.usage }
        : { type: 'subagent_message_end', agentId }
    case 'context_compact':
      return { type: 'subagent_context_compact', agentId, level: String(ev.level) }
    case 'max_iterations':
      return {
        type: 'subagent_max_iterations',
        agentId,
        maxIterations: ev.maxIterations,
      }
    default:
      return null
  }
}

/**
 * Translate a worker-side `winddown` message payload into the typed
 * `subagent_winddown` renderer event. Pulled out of the client's inline
 * `case 'winddown'` so the mapping is unit-testable (the client body itself
 * needs a live worker to exercise). Parity with the in-process emission in
 * `subAgentLoopCallbacks.onQueryLoopPreModel`.
 */
export function windDownMessageToSubAgentEvent(
  agentId: AgentId,
  payload: {
    trigger: 'tools' | 'tokens' | 'iterations'
    iteration?: number
    maxIterations?: number
  },
): SubAgentEvent {
  return {
    type: 'subagent_winddown',
    agentId,
    trigger: payload.trigger,
    ...(typeof payload.iteration === 'number' ? { iteration: payload.iteration } : {}),
    ...(typeof payload.maxIterations === 'number'
      ? { maxIterations: payload.maxIterations }
      : {}),
  }
}

/**
 * P1 audit fix: derive `SubAgentResult.success` for the worker `done`
 * branch. Mirrors the in-process path's logic
 * (`subAgentRunner.ts` ~L1526) so both spawn paths report `success`
 * consistently.
 *
 * A worker run is successful when the user did NOT cancel it (`signalAborted`
 * is a hard failure) AND either:
 *   - it completed cleanly (no internal budget abort AND did not hit
 *     `max_turns`), OR
 *   - it still delivered a usable final report (`producedReport`) despite
 *     hitting an iteration / token budget.
 *
 * The `producedReport` branch is the output-aware relaxation that mirrors the
 * in-process path (`subAgentRunner.ts`): a run that crossed a limit but still
 * produced a complete report (directly, via graceful wind-down, or via the
 * final-summary rescue turn) is a success, not a failure. When `producedReport`
 * is omitted the helper degrades to the original limit-only rule, so callers
 * that cannot compute it (and the existing unit tests) keep their behaviour.
 *
 * A true user cancel (`signalAborted`) always fails regardless of output.
 *
 * Exported for unit testing — production callers go through the inline
 * `'done'` branch in {@link runSubAgentInWorker}.
 *
 * @internal
 */
export function deriveWorkerSubAgentSuccess(input: {
  signalAborted: boolean
  budgetAbortReason: string | null
  reachedMaxIterations: boolean
  /** True when a usable final report was committed (see `subAgentProducedUsableReport`). */
  producedReport?: boolean
}): boolean {
  if (input.signalAborted) return false
  const cleanCompletion =
    input.budgetAbortReason === null && !input.reachedMaxIterations
  return cleanCompletion || input.producedReport === true
}

/**
 * Per-`case 'event'` handler extracted from `runSubAgentInWorker`'s
 * `worker.on('message')` switch. Runs the worker-path bookkeeping for a
 * single {@link LoopEvent} (tool-use counting, sidechain writes, read-only
 * budget enforcement) and forwards the translated renderer event via
 * `onEvent`. Pure code move — behaviour is byte-for-byte identical to the
 * inline block it replaced.
 */
export function handleWorkerLoopEvent(
  loopEv: LoopEvent,
  deps: {
    wctx: WorkerRunCtx
    onEvent?: (event: SubAgentEvent) => void
    onToolActivity?: () => void
    effectiveAgentId: AgentId
    agentDef: { agentType: string; maxTurns?: number; tools?: string[]; disallowedTools?: string[]; mcpServers?: string[] }
    readonlyAgent: boolean
    sendBudgetAbort: (reason: string) => void
  },
): void {
  const { wctx, onEvent, onToolActivity, effectiveAgentId, agentDef, readonlyAgent, sendBudgetAbort } = deps
  // P1-5: count actual tool starts for the eventual SubAgentResult.
  // The previous heuristic checked for a `'subagent_tool_use'` type
  // that never existed in either LoopEvent or SubAgentEvent, so
  // totalToolUses always reported 0 from the worker path. Counting
  // `tool_start` events matches the in-process path's tally.
  if (loopEv?.type === 'tool_start') {
    // SA-3 fix 2 — the worker's agentic loop is about to execute
    // a tool (local or RPC); from this point on, an in-process
    // re-run after worker failure could duplicate side effects.
    onToolActivity?.()
    wctx.totalToolUses++
    wctx.outputAcc.onToolStart()
    // Phase 1B matrix item 5 of 5: mirror in-process sidechain
    // writes so worker-path sub-agents leave the same debug
    // trail (consumed by `TaskOutput` + crash reports).
    appendSubAgentSidechain(effectiveAgentId, {
      kind: 'tool_start',
      summary: `${loopEv.toolUse.name}(${loopEv.toolUse.id})`,
    })
    // Tool-call hard cap for read-only sub-agents. In-process
    // path applies the same gate inside `runAgenticLoop` itself;
    // here we apply it at the `tool_start` event boundary, which
    // is the earliest point we can observe the count in the
    // worker stream.
    if (readonlyAgent) {
      const warnAt = readonlyToolCallWarnAt(agentDef.agentType)
      const hardLimit = readonlyToolCallLimit(agentDef.agentType)
      if (wctx.totalToolUses >= warnAt && !wctx.warnedToolCount) {
        wctx.warnedToolCount = true
        appendSubAgentSidechain(effectiveAgentId, {
          kind: 'warning',
          summary: `toolCount=${wctx.totalToolUses} approaching limit ${hardLimit}`,
        })
      }
      if (wctx.totalToolUses >= hardLimit) {
        appendSubAgentSidechain(effectiveAgentId, {
          kind: 'limit',
          summary: `maxToolCalls=${hardLimit} reached — aborting`,
        })
        sendBudgetAbort(
          `${agentDef.agentType} tool-call cap exceeded (${wctx.totalToolUses}/${hardLimit})`,
        )
      }
    }
  } else if (loopEv?.type === 'tool_result') {
    appendSubAgentSidechain(effectiveAgentId, {
      kind: 'tool_result',
      summary: `${loopEv.toolResult.name} ok=${loopEv.toolResult.success}`,
    })
  } else if (loopEv?.type === 'text_delta') {
    wctx.outputAcc.onTextDelta(loopEv.text)
  } else if (loopEv?.type === 'streaming_fallback') {
    // Audit 2026-06 — worker mirror of the in-process
    // `onStreamingFallback` rollback (subAgentRunner.ts ~L1577).
    // The provider abandoned the partial stream and will replay
    // the full response via the non-streaming retry; drop the
    // partial deltas from BOTH the local accumulator and the
    // persistent runtime buffer that `TaskOutput` reads, so the
    // parent agent never sees "half old + full new" duplicates.
    const dropped = wctx.outputAcc.onStreamingFallback()
    if (wctx.taskCursorAtTurnStart !== null) {
      try {
        taskRuntimeStore.rollbackToCursor(effectiveAgentId, wctx.taskCursorAtTurnStart)
        taskRuntimeStore.append(
          effectiveAgentId,
          'meta',
          `<stream-fallback-reset status=${loopEv.info?.status ?? '?'} reason=${loopEv.info?.reason ?? '?'}>\n`,
        )
      } catch {
        /* rollback is best-effort; never sink the event handler */
      }
    }
    appendSubAgentSidechain(effectiveAgentId, {
      kind: 'limit',
      summary: `streaming_fallback rollback droppedChars=${dropped} status=${loopEv.info?.status ?? '?'}`,
    })
    onEvent?.({
      type: 'subagent_stream_fallback_reset',
      agentId: effectiveAgentId,
      ...(loopEv.info?.reason ? { reason: String(loopEv.info.reason) } : {}),
    })
  } else if (loopEv?.type === 'message_end') {
    // Tool-free final reply rule: only treat this turn's freshly-
    // emitted text as the candidate report when zero tools fired.
    // Matches the in-process path's logic in
    // `subAgentRunner.ts:onMessageEnd`.
    const ended = wctx.outputAcc.onMessageEnd()
    const finalThisTurn = ended.finalText
    const toolsThisTurn = ended.toolsThisTurn
    // New turn boundary — re-snapshot the runtime-store cursor so
    // a fallback in the NEXT turn only rewinds that turn's chunks.
    wctx.taskCursorAtTurnStart = taskRuntimeStore.getCursor(effectiveAgentId)

    // Iteration-boundary sidechain entry. The in-process path
    // records `apiMsgs~${len}`; the worker path has no apiMsgs
    // view here (it lives inside the worker thread), so we
    // record `?` for parity with the entry shape.
    appendSubAgentSidechain(effectiveAgentId, {
      kind: 'iteration',
      summary: `toolsThisTurn=${toolsThisTurn} apiMsgs~?`,
    })
    if (finalThisTurn) {
      appendSubAgentSidechain(effectiveAgentId, {
        kind: 'text',
        summary:
          finalThisTurn.length > 240
            ? `${finalThisTurn.slice(0, 240)}…`
            : finalThisTurn,
      })
    }

    // Token budget enforcement, mirrored from in-process path
    // (`subAgentRunner.ts:onMessageEnd`). `usage` reports
    // running totals (input is conversation-level, output is
    // per-message — same convention as the main-process call
    // site) so we sum outputs and overwrite input each turn.
    if (loopEv.usage) {
      wctx.latestInputTokens = loopEv.usage.inputTokens
      wctx.outputTokTotal += loopEv.usage.outputTokens
    }
    if (readonlyAgent) {
      const effectiveTokens = wctx.latestInputTokens + wctx.outputTokTotal
      const tokenBudget = readonlyTokenBudget(agentDef.agentType)
      if (
        effectiveTokens >= tokenBudget &&
        shouldAbortReadonlyBudgetAfterMessageEnd({
          toolsThisTurn,
          finalText: finalThisTurn,
        })
      ) {
        appendSubAgentSidechain(effectiveAgentId, {
          kind: 'limit',
          summary: `tokenBudget=${tokenBudget} exceeded (${effectiveTokens}); aborting`,
        })
        sendBudgetAbort(
          `${agentDef.agentType} token budget exceeded (${effectiveTokens}/${tokenBudget})`,
        )
      }
    }
  }
  // Translate from worker-side `LoopEvent` to renderer-facing
  // `SubAgentEvent`. The renderer's `subAgentStreamRouter` only
  // whitelists `subagent_*` types and silently drops everything
  // else — without this translation the AgentBlock froze on
  // `starting…` even though the worker's underlying agentic loop
  // was emitting deltas correctly.
  const translated = loopEventToSubAgentEvent(loopEv, effectiveAgentId)
  if (translated) onEvent?.(translated)
}
