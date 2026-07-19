/**
 * Tool-use batch execution for the agentic loop (parallel read-only batches + serial otherwise).
 * Keeps {@link agenticLoop} focused on model I/O and conversation state.
 *
 * `Agent` tool_uses run in parallel only when each targets a **read-only** sub-agent
 * (e.g. Explore, Plan, Verification). Writable agents (general-purpose, Debug, …) stay serial.
 */

import { runAgenticToolUse, type InlineSkillSessionState, type ToolResultEventPayload } from './runAgenticToolUse'
import type { PermissionRulePayload } from './permissionRuleMatch'
import { mergeAbortSignals } from './toolExecutionScope'
import { createSiblingShellFailureReason } from './siblingShellAbortReason'
import { StreamingToolBatchTracer } from './streamingToolExecutor'
import type { AppendixAFlowReporter } from '../orchestration/appendixAFlow'
import {
  canToolUseRunInParallelBatch as canToolUseRunInParallelBatchFromPipeline,
  isShellToolName as isShellToolNameFromPipeline,
  planToolExecution,
  type ToolUseItem,
} from '../orchestration/toolPipeline'
import {
  attachAdvisoryToToolResult,
  extractErrorSummaryFromToolResult,
  type ToolCallHistory,
} from './toolCallHistory'
import {
  getRepetitionGuard,
  type RepetitionGuard,
} from '../orchestration/repetitionGuard'
import type { LoopSignal } from './loopSignal'

/** Exported for §4.4 tests — `tool_result` content convention from {@link runAgenticToolUse}. */
export function toolResultBlockIndicatesFailure(block: Record<string, unknown>): boolean {
  const c = block.content
  return typeof c === 'string' && c.trimStart().startsWith('Error:')
}

/**
 * G4 — Placeholder for a tool_use that was scheduled in this batch but skipped because a
 * prior tool paused for HITL. We mark `is_error: false` and use an informational content
 * string so the assistant message stays Anthropic-API-valid (tool_use ↔ tool_result
 * pairing); the model never reads it because the kernel terminates the iteration before
 * the next model call.
 */
function buildSkippedDueToHitlBlock(toolUseId: string, toolName: string): Record<string, unknown> {
  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    is_error: false,
    content: `[Skipped: tool ${toolName} not executed because a sibling tool paused this batch for human input.]`,
    _hitlSkipped: true,
  }
}

/**
 * 阶段 2.3 — re-export from the unified planner in `electron/orchestration/toolPipeline.ts` so
 * external callers (`runAgenticLoop`, tests) keep the import path stable while the
 * serial/parallel rules live in a single place.
 */
export const canToolUseRunInParallelBatch = canToolUseRunInParallelBatchFromPipeline
const isShellToolName = isShellToolNameFromPipeline

export type AgenticToolBatchCallbacks = {
  onToolStart: (toolUse: { id: string; name: string; input: Record<string, unknown> }) => void
  onToolResult: (toolResult: ToolResultEventPayload) => void
  /**
   * Phase 5 (upstream alignment) — structured-signal channel for the
   * tool-execution boundary, parallel to {@link StreamCallbacks.onLoopSignal}.
   *
   * Fired when the {@link RepetitionGuard} short-circuits a tool call
   * (`tool:repetition_halt`) or attaches an advisory to it
   * (`tool:repetition_warn`). The envelope carries the same advisory
   * text that the model sees in the synthetic / decorated tool_result,
   * plus structured `details` (toolName, consecutiveCount) so consumers
   * (telemetry, future loop policies) can react without parsing the
   * rendered advisory string.
   *
   * Optional: existing callers don't have to wire it. The existing
   * `RepetitionAdvice` flow inside `repetitionGuard.ts` and the
   * synthetic-result short-circuit are unchanged — this is an additive
   * observability channel, not a control-flow replacement.
   */
  onLoopSignal?: (signal: LoopSignal) => void
}

export type RunAgenticToolBatchParams = {
  toolUseBlocks: Array<{
    id: string
    name: string
    input: Record<string, unknown>
    thoughtSignature?: string
  }>
  signal: AbortSignal
  callbacks: AgenticToolBatchCallbacks
  diffPermissionMode: 'default' | 'bypassPermissions'
  permissionDefaultMode: 'allow' | 'ask' | 'deny'
  permissionRules?: PermissionRulePayload[]
  discoveryExclude: Set<string>
  getInlineSkillSession: () => InlineSkillSessionState
  setInlineSkillSession: (s: InlineSkillSessionState) => void
  /** Appendix A phase-three telemetry (optional). */
  appendixAFlow?: AppendixAFlowReporter
  /**
   * Loop-scoped tracker that prevents "AI retries the same failed call"
   * loops. When provided, we:
   *   - short-circuit tool_uses whose identical-args failure streak has
   *     reached `blockThreshold` (default 2 → blocks the 3rd attempt);
   *   - prepend an advisory to the model-visible result on the `hintThreshold`
   *     attempt so the model sees "you already did this and it failed."
   * When omitted the batch executes with the legacy unguarded behaviour.
   * See {@link createToolCallHistory} for scoping and rationale.
   */
  toolCallHistory?: ToolCallHistory
  /**
   * Process-wide repetition guard. Catches "5 identical successful calls
   * in a row" — the no-op-echo phantom-work failure mode that the
   * failure-driven `toolCallHistory` cannot see. Defaults to the
   * orchestration-layer singleton so cross-agent repetition counts; tests
   * inject their own (or call `resetRepetitionGuardForTests()`) for
   * isolation. See `electron/orchestration/repetitionGuard.ts`.
   */
  repetitionGuard?: RepetitionGuard
  /** Await an authoritative scheduler grant immediately before this tool starts. */
  beforeToolStart?: (toolUse: ToolUseItem) => Promise<void>
  /**
   * P0-2 — per-tool signal resolver. When provided, the batch runner calls this
   * for every tool_use and uses the returned signal in place of the batch-wide
   * `signal`. The orchestration kernel populates this so 'block' tools
   * (`interruptBehavior: 'block'`) receive its hard-abort signal while
   * 'cancel' tools (the default) receive its soft-abort signal. The resolver
   * receives the tool's input so heuristics (e.g. bash `timeoutMs >= 60000`
   * picks block) can pick per-invocation. Omitted callers (legacy / sub-agents
   * without a kernel) fall back to the batch signal as before.
   *
   * Note: shell sibling-cancel chunks still derive a merged signal that ANDs
   * the resolver's choice with the sibling AbortController, so behaviour stays
   * correct even when multiple bash tools run in parallel.
   */
  /**
   * P1 (audit §5.2) — optional third positional `toolUseId`. The kernel
   * adapter (`DefaultToolRuntimePort.executeToolBatch`) uses it to merge
   * the per-tool preempt signal from `ToolRuntimeState` so a high-priority
   * newcomer's preempt fires only on the victim, not on every concurrent
   * tool in the same batch. Optional + positional so legacy resolvers
   * (`callModel.ts` etc.) keep working unchanged.
   */
  resolveToolSignal?: (
    toolName: string,
    input: Record<string, unknown>,
    toolUseId?: string,
  ) => AbortSignal | undefined
}

/**
 * Synthetic short-circuit tool_result returned when the repeat-call guard
 * refuses to spawn an identical failing call again. Shape matches the one
 * {@link mapToolUseToToolResultBlockParam} produces so downstream code
 * (context pairing, failure detection, telemetry) treats it uniformly.
 */
function buildShortCircuitToolResult(
  toolUseId: string,
  message: string,
): Record<string, unknown> {
  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content: `Error: ${message}`,
  }
}

/**
 * Execute all tool_use blocks from one assistant turn, preserving ordering of results.
 */
export async function runAgenticToolUseBatch(
  params: RunAgenticToolBatchParams,
): Promise<Array<Record<string, unknown>>> {
  const {
    toolUseBlocks,
    signal,
    callbacks,
    diffPermissionMode,
    permissionDefaultMode,
    permissionRules,
    discoveryExclude,
    getInlineSkillSession,
    setInlineSkillSession,
    appendixAFlow,
    toolCallHistory,
    repetitionGuard = getRepetitionGuard(),
    beforeToolStart,
    resolveToolSignal,
  } = params

  const toolResults: Array<Record<string, unknown>> = []
  const phaseTracer = new StreamingToolBatchTracer(toolUseBlocks.length)
  appendixAFlow?.report('P3_tool_partition_done', { toolUseCount: toolUseBlocks.length })

  /**
   * Core executor for a single tool_use. When a `toolCallHistory` is wired
   * in, we intercept:
   *   - BEFORE: if the advice is `block`, return a synthetic error
   *     WITHOUT calling into `runAgenticToolUse` (no spawn, no side
   *     effects). If the advice is `hint`, execute normally and remember
   *     to decorate the result afterwards.
   *   - AFTER: record the outcome so subsequent iterations can detect
   *     repeats. On a hint-level retry that still failed, attach the
   *     advisory to the model-visible `tool_result.content`.
   */
  const runOneToolUse = async (
    toolUse: {
      id: string
      name: string
      input: Record<string, unknown>
      thoughtSignature?: string
    },
    cb: AgenticToolBatchCallbacks = callbacks,
    signalOverride?: AbortSignal,
  ): Promise<Record<string, unknown>> => {
    phaseTracer.notifyExecutionBegun()
    await beforeToolStart?.(toolUse)

    // Repetition guard runs FIRST — its `halt` is the only branch that
    // dominates the failure-driven `toolCallHistory.block`. Both record
    // the eventual short-circuit so subsequent calls keep advancing.
    const repAdvice = repetitionGuard.check(toolUse.name, toolUse.input)
    if (repAdvice.level === 'halt') {
      appendixAFlow?.report('P3_tool_repetition_halt', {
        toolName: toolUse.name,
        consecutiveCount: repAdvice.consecutiveCount,
      })
      // Phase 5 (upstream alignment): also surface the halt as a typed
      // LoopSignal envelope. Consumer-thrown exceptions are swallowed
      // — a misbehaving onLoopSignal must NEVER influence the
      // short-circuit + record sequence below.
      try {
        cb.onLoopSignal?.({
          kind: 'tool:repetition_halt',
          rawMessage: repAdvice.message,
          provider: 'tool',
          details: {
            toolName: toolUse.name,
            consecutiveCount: repAdvice.consecutiveCount,
          },
        })
      } catch (sigErr) {
        console.warn('[agenticToolBatch] onLoopSignal consumer threw (halt):', sigErr)
      }
      cb.onToolStart(toolUse)
      cb.onToolResult({
        id: toolUse.id,
        name: toolUse.name,
        success: false,
        error: repAdvice.message,
      })
      const synthetic = buildShortCircuitToolResult(toolUse.id, repAdvice.message)
      repetitionGuard.record(toolUse.name, toolUse.input)
      toolCallHistory?.record(toolUse.name, toolUse.input, {
        success: false,
        errorSummary: repAdvice.message,
      })
      phaseTracer.notifyToolSettled()
      return synthetic
    }

    const advice = toolCallHistory?.checkBeforeCall(toolUse.name, toolUse.input) ?? null

    if (advice?.level === 'block') {
      // Hard short-circuit — surface through callbacks so UI + telemetry see it.
      appendixAFlow?.report('P3_tool_repeat_block', {
        toolName: toolUse.name,
        previousFailures: advice.previousFailures,
      })
      cb.onToolStart(toolUse)
      cb.onToolResult({
        id: toolUse.id,
        name: toolUse.name,
        success: false,
        error: advice.message,
      })
      const synthetic = buildShortCircuitToolResult(toolUse.id, advice.message)
      repetitionGuard.record(toolUse.name, toolUse.input)
      toolCallHistory?.record(toolUse.name, toolUse.input, {
        success: false,
        errorSummary: advice.message,
      })
      phaseTracer.notifyToolSettled()
      return synthetic
    }

    // P0-2 — pick the per-tool signal:
    //   1. explicit `signalOverride` (e.g. shell sibling-cancel merge) wins
    //   2. otherwise `resolveToolSignal(toolUse.name, toolUse.input, toolUse.id)`
    //      from the kernel (P1 — toolUseId enables per-tool preempt merging)
    //   3. otherwise batch-wide `signal` (legacy / sub-agent path)
    const effectiveSignal =
      signalOverride ?? resolveToolSignal?.(toolUse.name, toolUse.input, toolUse.id) ?? signal
    try {
      const raw = await runAgenticToolUse({
        toolUse,
        signal: effectiveSignal,
        callbacks: cb,
        diffPermissionMode,
        permissionDefaultMode,
        permissionRules,
        discoveryExclude,
        getInlineSkillSession,
        setInlineSkillSession,
      })

      const failed = toolResultBlockIndicatesFailure(raw)
      const errorSummary = failed ? extractErrorSummaryFromToolResult(raw) : undefined
      repetitionGuard.record(toolUse.name, toolUse.input)
      toolCallHistory?.record(toolUse.name, toolUse.input, {
        success: !failed,
        errorSummary,
      })

      // Advisory layering: rep `warn` (degenerate-loop early warning) and
      // history `hint` (failure-history early warning) can both fire on
      // the same call. We attach rep first because it speaks to the
      // higher-level failure mode; history hint then layers on top via
      // a second decoration pass.
      let decorated = raw
      let attached = false
      if (repAdvice.level === 'warn') {
        appendixAFlow?.report('P3_tool_repetition_warn', {
          toolName: toolUse.name,
          consecutiveCount: repAdvice.consecutiveCount,
        })
        // Phase 5 (upstream alignment): also surface the warn advisory
        // as a typed LoopSignal envelope. The tool DID execute (unlike
        // halt) — this envelope is observational, not a short-circuit.
        try {
          cb.onLoopSignal?.({
            kind: 'tool:repetition_warn',
            rawMessage: repAdvice.message,
            provider: 'tool',
            details: {
              toolName: toolUse.name,
              consecutiveCount: repAdvice.consecutiveCount,
            },
          })
        } catch (sigErr) {
          console.warn('[agenticToolBatch] onLoopSignal consumer threw (warn):', sigErr)
        }
        decorated = attachAdvisoryToToolResult(decorated, repAdvice.message)
        attached = true
      }
      if (failed && advice?.level === 'hint') {
        appendixAFlow?.report('P3_tool_repeat_hint', {
          toolName: toolUse.name,
          previousFailures: advice.previousFailures,
        })
        decorated = attachAdvisoryToToolResult(decorated, advice.message)
        attached = true
      }
      return attached ? decorated : raw
    } finally {
      phaseTracer.notifyToolSettled()
    }
  }

  // 阶段 2.3 — single source of truth: planner in `toolPipeline.ts` produces concrete steps that
  // already respect serial/parallel policy + Agent-aware chunk size + shell-sibling-cancel flag.
  const plan = planToolExecution(toolUseBlocks)
  // G4 — after a HITL placeholder lands in the results, short-circuit the remaining plan
  // steps. Continuing would (a) run side-effectful tools that the kernel is about to abort
  // anyway, and (b) potentially fire a second `InterruptForHITL` whose `recordPendingHITL`
  // would overwrite the first user-visible question (G7 warn). We synthesise paired
  // tool_result blocks for the skipped tool_use ids so the assistant message stays
  // Anthropic-API-valid; the model never sees these because the iteration terminates.
  let hitlHit = false
  for (const step of plan) {
    if (hitlHit) {
      const skipped =
        step.kind === 'serial'
          ? [step.item]
          : step.items
      for (const tu of skipped) {
        toolResults.push(buildSkippedDueToHitlBlock(tu.id, tu.name))
        try {
          callbacks.onToolResult({
            id: tu.id,
            name: tu.name,
            success: false,
            error: 'Skipped: prior tool in batch paused for HITL.',
          })
        } catch {
          /* callback failures must not break the loop */
        }
      }
      continue
    }
    if (step.kind === 'serial') {
      appendixAFlow?.report('P3_tool_batch_serial', {
        toolName: step.item.name,
        index: step.originalIndex,
      })
      const out = await runOneToolUse(step.item)
      toolResults.push(out)
      // G4 — AskUserQuestion runs here (it's in NON_PARALLEL_TOOLS). A HITL throw lands
      // as `_hitlPlaceholder` on `out` so subsequent serial steps in the same batch get
      // skipped instead of executed.
      if ((out as { _hitlPlaceholder?: unknown })._hitlPlaceholder === true) {
        hitlHit = true
      }
      continue
    }
    // Parallel chunk — pre-announce onToolStart so the renderer shows siblings immediately.
    appendixAFlow?.report('P3_tool_batch_parallel', {
      chunkSize: step.items.length,
      toolNames: step.items.map((tu) => tu.name),
    })
    for (const tu of step.items) {
      callbacks.onToolStart(tu)
    }
    const suppressDuplicateStart: AgenticToolBatchCallbacks = {
      ...callbacks,
      onToolStart: () => {},
    }
    // Two parallel-execution shapes:
    //   1. Shell sibling-cancel (planner marks shell-only chunks) — first shell failure
    //      aborts the rest via shared AbortController.
    //   2. Plain Promise.all — everything else, including pure-Agent chunks.
    //
    // Chunk 10 removed the third branch (barrier-wave wrap of pure-Agent chunks). The
    // wave subsystem was opt-in (`POLE_ORCHESTRATION_BARRIER_WAVE`, default off) and the
    // wave path was observationally identical to `Promise.all` for the legacy code path
    // because `runOneToolUse` already converts rejections to error tool_result blocks.
    let chunkOut: Array<Record<string, unknown>>
    if (step.useShellSiblingCancel) {
      const siblingAc = new AbortController()
      // P0-2 — merge sibling-cancel with the **per-tool** signal so a 'block'
      // shell tool (rsync etc.) inherits the hard signal lane while still
      // honoring sibling-cancel for its in-chunk peer failures.
      chunkOut = await Promise.all(
        step.items.map((tu) => {
          const perToolBase =
            resolveToolSignal?.(tu.name, tu.input, tu.id) ?? signal
          const merged = mergeAbortSignals(perToolBase, siblingAc.signal)
          return runOneToolUse(tu, suppressDuplicateStart, merged).then((out) => {
            if (isShellToolName(tu.name) && toolResultBlockIndicatesFailure(out)) {
              if (!siblingAc.signal.aborted) {
                siblingAc.abort(createSiblingShellFailureReason(tu.id))
              }
            }
            return out
          })
        }),
      )
    } else {
      chunkOut = await Promise.all(
        step.items.map((tu) => runOneToolUse(tu, suppressDuplicateStart)),
      )
    }
    toolResults.push(...chunkOut)
    // G4 — detect HITL placeholder produced by any tool in this step. The runtime that
    // converts `InterruptForHITL` (see `runAgenticToolUse.ts`) tags the result with
    // `_hitlPlaceholder: true`. Once set, the next plan iteration short-circuits.
    if (!hitlHit && chunkOut.some((b) => (b as { _hitlPlaceholder?: unknown })._hitlPlaceholder === true)) {
      hitlHit = true
    }
  }

  phaseTracer.notifyResultsHandedOff()
  appendixAFlow?.report('P3_tool_batch_complete', {
    toolResultCount: toolResults.length,
  })
  return toolResults
}
