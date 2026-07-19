/**
 * Factory for the in-process sub-agent agentic-loop callbacks.
 *
 * Extracted verbatim from `runSubAgent` (subAgentRunner.ts) — pure code move,
 * no logic changes. The two helper closures (`markFirstModelByte`,
 * `recordUsageForBudgets`) and the `loopCallbacks` object close over the shared
 * run-state (`ctx`) plus a handful of outer values threaded in via `deps`.
 */

import type { CompactDetail } from '../ai/agenticLoopTypes'
import type { ToolResultEventPayload } from '../ai/runAgenticToolUse'
import type { AgentId } from '../tools/ids'
import type { AgentDefinitionUnion, SubAgentEvent } from './types'
import type { SubAgentRunState } from './subAgentRunContext'
import { logAsyncAgentPhase } from './asyncAgentLifecycle'
import { recordAgentTokenUsage } from './activeAgentRegistry'
import { taskRuntimeStore } from '../tools/TaskRuntimeStore'
import {
  READONLY_AGENT_TYPES,
  readonlyToolCallLimit,
  readonlyToolCallWarnAt,
  readonlyTokenBudget,
  shouldAbortReadonlyBudgetAfterMessageEnd,
  computeReadonlyWindDownDirective,
  shouldInjectIterationWindDown,
  buildIterationWindDownDirective,
} from './subAgentReadonlyBudget'
import { appendSubAgentSidechain } from './subAgentSidechainTranscript'
import { getResourceQuotaManager } from '../orchestration/toolRuntime/quota'
import { getToolUseIdFromStopScope } from '../ai/toolExecutionScope'
import { recordToolResourceDelta } from '../orchestration/toolRuntime/state'
import { getAgentContext } from './agentContext'

export function createSubAgentLoopCallbacks(deps: {
  ctx: SubAgentRunState
  onEvent: (event: SubAgentEvent) => void
  agentId: AgentId
  agentDef: AgentDefinitionUnion
  markAbortReason: (reason: string) => void
  bridgeAc: AbortController
  maxRecordedFailures: number
  /**
   * Effective iteration cap for this run (agent `maxTurns` / fork cap, or the
   * loop default when unset). Drives the iteration-limit graceful wind-down —
   * one forced tool-free report turn as the run approaches this cap.
   */
  maxIterations: number
}) {
  const { ctx, onEvent, agentId, agentDef, markAbortReason, bridgeAc, maxRecordedFailures, maxIterations } = deps
  const markFirstModelByte = (): void => {
    if (ctx.firstModelByteLogged) return
    ctx.firstModelByteLogged = true
    logAsyncAgentPhase(agentId, 'first_model_byte')
  }
  const recordUsageForBudgets = (usage: { inputTokens: number; outputTokens: number }) => {
    const safeIn = Math.max(0, usage.inputTokens)
    const safeOut = Math.max(0, usage.outputTokens)
    // `latestInputTokens` (max) → context-size budget gate.
    // `inputTokSum` (sum) → user-facing billing total in SubAgentResult.
    ctx.latestInputTokens = Math.max(ctx.latestInputTokens, safeIn)
    ctx.inputTokSum += safeIn
    ctx.outputTokTotal += safeOut
    recordAgentTokenUsage(agentId, usage.inputTokens, usage.outputTokens)
  }
  const loopCallbacks = {
    onTextDelta: (text: string) => {
      markFirstModelByte()
      ctx.outputText += text
      onEvent({ type: 'subagent_text', agentId, text })
    },
    onThinkingDelta: (text: string) => {
      markFirstModelByte()
      onEvent({ type: 'subagent_thinking_delta', agentId, text })
    },
    onThinkingBlock: (block: { thinking: string; signature?: string; thinkingTimeMs?: number; thinkingTokens?: number }) => {
      // Mirror the parent-chat plumbing: forward the completed block so the
      // renderer can round-trip the signature on cross-turn replay. Without
      // this, sub-agent conversations that mix `thinking` + `tool_use`
      // hit the same DeepSeek / Anthropic 400 the parent chat did.
      //
      // `thinkingTimeMs` is the canonical wall-clock duration produced by
      // the SSE consumer; passing it through lets `<ThinkingBlock>` inside
      // `AgentBlock` snap to the authoritative elapsed time when streaming
      // ends, matching parent-chat behaviour.
      //
      // Multi-thinking-block / SDK-path correctness note: this callback is a
      // pure forwarder — sub-agents do NOT maintain their own thinking
      // accumulator. They consume `onThinkingBlock` calls produced upstream
      // by the same `streamAnthropic` / `anthropicCompatHttp` providers
      // (via the shared `electron/ai/thinkingBlockAccumulator.ts` helper).
      // That means sub-agents inherit the per-stop emission order
      // transparently: a response with `[thinking-A, text, thinking-B]`
      // produces `subagent_thinking_block_complete` events in the same
      // wire order as the main chat, and the renderer's two-pass walk-
      // backwards targeting in `mainStreamRouter.ts` (for sub-agent UI
      // routing the corresponding `SubAgentDisplay.thinking` field is
      // overwritten directly, no targeting needed) stays correct without
      // any sub-agent-specific change. Audited 2026-05-15.
      onEvent({ type: 'subagent_thinking_block_complete', agentId, thinkingBlock: block })
    },
    onRedactedThinkingBlock: (block: { data: string; startedAtMs?: number }) => {
      // Plan Phase 4 — sub-agent mirror of redacted_thinking. The
      // `data` blob must be forwarded all the way to the renderer so
      // it survives into SubAgentDisplay.blocks and gets echoed back
      // on the sub-agent's next turn via chatMessageToAgentApiRows.
      onEvent({
        type: 'subagent_redacted_thinking_block',
        agentId,
        redactedThinkingBlock: block,
      })
    },
    onReasoningSummaryDelta: (text: string) => {
      markFirstModelByte()
      onEvent({ type: 'subagent_reasoning_summary_delta', agentId, text })
    },
    onReasoningSummaryBlock: (
      block: { text: string; thinkingTimeMs?: number; thinkingTokens?: number },
    ) => {
      // OpenAI Responses safe-to-show summary for sub-agent runs.
      // Sibling channel to `onThinkingBlock` — no signature, never
      // round-tripped to the parent model, surfaces in a dedicated
      // `<ReasoningSummaryBlock>` row inside `AgentBlock`.
      onEvent({
        type: 'subagent_reasoning_summary_block_complete',
        agentId,
        reasoningSummaryBlock: block,
      })
    },
    onQueryLoopPreModel: (info: {
      iteration: number
      phases: unknown[]
      snippedCount: number
      wasContextManaged: boolean
      idleToolClearApplied?: boolean
    }) => {
      ctx.outputLenBeforeThisStream = ctx.outputText.length
      ctx.taskCursorBeforeThisStream = taskRuntimeStore.getCursor(agentId)
      // Per-iteration reset: `iterationToolCount` / `iterationStartOutputLen` bound the current
      // iteration's tool count and text window so `onMessageEnd` (fires once at termination) can
      // distinguish the final iteration's deliverable text from cross-iteration preamble.
      ctx.iterationToolCount = 0
      ctx.iterationStartOutputLen = ctx.outputText.length
      // Phase B (granularity uplift): the parent now forwards the real
      // §6.1 pipeline `phases` (was hard-coded `[]` until iteration.ts
      // started passing the live data). Record the non-trivial cases
      // to the sub-agent sidechain so post-mortem readers can see
      // exactly which compaction / clamp steps fired this iteration
      // without having to enable AppendixA telemetry. Skip empty /
      // baseline-only iterations (every iteration runs
      // `tool_result_budget` + `context_manager_none`; logging that
      // would be pure noise).
      if (Array.isArray(info.phases) && info.phases.length > 0) {
        const significant = info.phases.filter(
          (p): p is string =>
            typeof p === 'string' &&
            p !== 'tool_result_budget' &&
            p !== 'context_manager_none',
        )
        if (significant.length > 0 || info.wasContextManaged || info.snippedCount > 0) {
          const parts: string[] = []
          if (significant.length > 0) parts.push(`phases=[${significant.join(',')}]`)
          if (info.snippedCount > 0) parts.push(`snipped=${info.snippedCount}`)
          if (info.wasContextManaged) parts.push('compacted')
          appendSubAgentSidechain(agentId, {
            kind: 'iteration',
            summary: `pre-model iter=${info.iteration} ${parts.join(' ')}`,
          })
        }
      }
      // ── Graceful wind-down (root-cause fix for truncated parent results) ──
      // Two triggers, both for read-only agents, latched once via
      // `budgetDirectiveInjected`:
      //   - tool-call pressure: ≥85% of the tool-call warn threshold.
      //   - token pressure: ≥ the token wind-down line (85% of the hard
      //     token budget). PROACTIVE — fires BEFORE the `onMessageEnd` hard
      //     abort, so the agent self-finishes with a complete report and the
      //     run is reported as `success` instead of an aborted/truncated
      //     fragment. The `onMessageEnd` abort remains a true backstop for the
      //     rare single-turn budget overshoot.
      if (!ctx.budgetDirectiveInjected) {
        const effectiveTokensPreModel = ctx.latestInputTokens + ctx.outputTokTotal
        // Read-only tool/token pressure first (its thresholds are the
        // historically-tuned ones and usually trip earliest); fall back to the
        // generic iteration-limit wind-down that applies to EVERY agent type.
        const directive =
          computeReadonlyWindDownDirective({
            agentType: agentDef.agentType,
            totalToolUses: ctx.totalToolUses,
            effectiveTokens: effectiveTokensPreModel,
          }) ??
          (shouldInjectIterationWindDown({ iteration: info.iteration, maxIterations })
            ? buildIterationWindDownDirective({ iteration: info.iteration, maxIterations })
            : undefined)
        if (directive) {
          ctx.budgetDirectiveInjected = true
          const windDownInfo = {
            trigger: directive.trigger,
            ...(directive.trigger === 'iterations'
              ? { iteration: info.iteration, maxIterations }
              : {}),
          }
          // Record on the run-state so the runner can surface it on
          // `SubAgentResult.windDown` (symmetric with the rescue metadata).
          ctx.windDown = windDownInfo
          appendSubAgentSidechain(agentId, {
            kind: 'limit',
            summary:
              directive.trigger === 'iterations'
                ? `winddown trigger=iterations iter=${info.iteration}/${maxIterations} tools=${ctx.totalToolUses}`
                : `winddown trigger=${directive.trigger} tools=${ctx.totalToolUses} tokens=${effectiveTokensPreModel}`,
          })
          // Typed signal for the renderer (parity with the worker path). Carry
          // iteration/cap only for the iteration trigger; tool/token triggers
          // leave them undefined (the pressure is budget-based, not turn-based).
          onEvent({ type: 'subagent_winddown', agentId, ...windDownInfo })
          return {
            appendUserContent: directive.appendUserContent,
            disableToolsForThisTurn: directive.disableToolsForThisTurn,
          }
        }
      }
    },
    onToolStart: (toolUse: { id: string; name: string; input: Record<string, unknown> }) => {
      // Diagnostic: a sub-agent whose first model output is a tool call
      // (no preamble text / thinking) would previously NEVER log the
      // `first_model_byte` phase, leaving "+Nms" hidden for read-only
      // agents that go straight to Read/Grep. Fire it here too so the
      // spawn → first-byte gap is always observable.
      markFirstModelByte()
      ctx.totalToolUses++
      ctx.iterationToolCount++
      ctx.toolUseCounts.set(toolUse.name, (ctx.toolUseCounts.get(toolUse.name) ?? 0) + 1)
      appendSubAgentSidechain(agentId, {
        kind: 'tool_start',
        summary: `${toolUse.name}(${toolUse.id})`,
      })
      onEvent({ type: 'subagent_tool_start', agentId, toolUse })
    },
    onToolInputDelta: (delta: { toolUseId: string; toolName: string; partialJson: string }) => {
      // Sub-agent mirror of the main-chat `tool_input_delta` plumbing
      // (IDE-style live writing). The throttle is applied by the
      // provider stream consumer (anthropicCompatHttp / providers/
      // anthropic / compatibleClient), so by the time this callback
      // fires the rate is already coalesced to ~20Hz/tool. We add
      // `agentId` to scope the event to this sub-agent run and pass
      // through the typed payload — see `subAgentStreamRouter.ts` for
      // the renderer-side placeholder-creation logic.
      markFirstModelByte()
      onEvent({
        type: 'subagent_tool_input_delta',
        agentId,
        toolUseId: delta.toolUseId,
        toolName: delta.toolName,
        partialJson: delta.partialJson,
      })
      // ── Read-only sub-agent tool-call hard limit ──
      // Explore/Plan/Verification agents have no write tools and can
      // burn through 150 iterations of Glob/Grep/Read without producing
      // a useful report. Force-terminate when the limit is exceeded so
      // the accumulated output is returned to the parent.
      if (READONLY_AGENT_TYPES.has(agentDef.agentType)) {
        const warnAt = readonlyToolCallWarnAt(agentDef.agentType)
        const hardLimit = readonlyToolCallLimit(agentDef.agentType)
        if (ctx.totalToolUses >= warnAt && !ctx.warnedToolCount) {
          ctx.warnedToolCount = true
          appendSubAgentSidechain(agentId, {
            kind: 'warning',
            summary: `toolCount=${ctx.totalToolUses} approaching limit ${hardLimit}`,
          })
        }
        if (ctx.totalToolUses >= hardLimit) {
          appendSubAgentSidechain(agentId, {
            kind: 'limit',
            summary: `maxToolCalls=${hardLimit} reached — aborting`,
          })
          markAbortReason(
            `${agentDef.agentType} tool-call budget exceeded (${ctx.totalToolUses}/${hardLimit})`,
          )
          bridgeAc.abort()
        }
      }
    },
    onToolResult: (toolResult: ToolResultEventPayload) => {
      if (!toolResult.success && ctx.toolFailures.length < maxRecordedFailures) {
        const errSnippet = (toolResult.error ?? '').slice(0, 200)
        ctx.toolFailures.push({ name: toolResult.name, error: errSnippet || 'unknown error' })
      }
      appendSubAgentSidechain(agentId, {
        kind: 'tool_result',
        summary: `${toolResult.name} ok=${toolResult.success}`,
      })
      onEvent({ type: 'subagent_tool_result', agentId, toolResult })
    },
    onStreamUsage: (usage: { inputTokens: number; outputTokens: number }) => {
      ctx.sawPerStreamUsage = true
      recordUsageForBudgets(usage)
    },
    onMessageEnd: (usage?: { inputTokens: number; outputTokens: number }) => {
      if (usage && !ctx.sawPerStreamUsage) {
        recordUsageForBudgets(usage)
      }
      // Audit P0+ self-fix F-2 — feed sub-agent token usage into the
      // global ResourceQuotaManager sliding window so
      // `maxTokenRatePerMinute` admission actually accounts for sub-agent
      // traffic. Before this hook the quota only saw main-chat tokens
      // (streamHandler.onMessageEnd was the only writer), letting N
      // concurrent sub-agents quietly blow past the cap. Defensive
      // try/catch: telemetry must never break the model-end callback.
      //
      // Audit A-3 wire-up — also record `tokensUsed` into the
      // per-tool resource delta of the PARENT tool's ToolRuntimeEntry.
      // `getToolUseIdFromStopScope` reads the parent's ALS-scoped
      // tool_use id (set by the `Agent` / `SendMessage` tool that spawned
      // this sub-agent), so the snapshot shows the real token cost
      // attributed to that tool slot. When sub-agent runs outside any
      // tool scope (rare; direct API path) the per-tool delta is
      // skipped but the global window still gets the entry.
      if (usage) {
        try {
          const total =
            (typeof usage.inputTokens === 'number' ? usage.inputTokens : 0) +
            (typeof usage.outputTokens === 'number' ? usage.outputTokens : 0)
          if (total > 0) {
            getResourceQuotaManager().recordTokenUsage(total)
            const parentToolUseId = getToolUseIdFromStopScope()
            if (parentToolUseId) {
              recordToolResourceDelta(parentToolUseId, { tokensUsed: total })
            }
          }
        } catch (e) {
          console.warn('[subAgentRunner] quota.recordTokenUsage failed:', e)
        }
      }
      // Phase D (granularity uplift) — surface the per-model-call
      // "iteration ended" signal as a typed subagent event so the
      // renderer's AgentBlock can track token spend before the run
      // terminates. Kept in lockstep with `loopEventToSubAgentEvent`'s
      // `message_end` case on the worker path. `usage` is optional
      // because not every provider reports it on every chunk.
      onEvent(
        usage
          ? { type: 'subagent_message_end', agentId, usage }
          : { type: 'subagent_message_end', agentId },
      )
      const toolsThisTurn = ctx.iterationToolCount
      let finalText = ''
      const msgLen = getAgentContext()?.messages?.length
      appendSubAgentSidechain(agentId, {
        kind: 'iteration',
        summary: `toolsThisTurn=${toolsThisTurn} apiMsgs~${msgLen ?? '?'}`,
      })
      // `onMessageEnd` only fires at agenticLoop termination. If the terminating iteration had
      // no tool calls, the text emitted after `iterationStartOutputLen` is the agent's final
      // deliverable. Otherwise the loop exited via abort/max_turns with tools still pending —
      // fall back to the full accumulated `outputText` in `resolveSubAgentReportedOutput`.
      if (toolsThisTurn === 0) {
        finalText = ctx.outputText.slice(ctx.iterationStartOutputLen).trim()
        if (finalText) {
          ctx.lastFinalText = finalText
          appendSubAgentSidechain(agentId, {
            kind: 'text',
            summary: finalText.length > 240 ? `${finalText.slice(0, 240)}…` : finalText,
          })
        }
      }
      // Read-only sub-agent token budget enforcement. If this message is
      // already a tool-free final report, do not retroactively abort the
      // completed result just because final usage accounting crossed the
      // budget. That was surfacing completed reports as incomplete in
      // team fan-out runs.
      const effectiveTokens = ctx.latestInputTokens + ctx.outputTokTotal
      if (
        READONLY_AGENT_TYPES.has(agentDef.agentType) &&
        effectiveTokens >= readonlyTokenBudget(agentDef.agentType) &&
        shouldAbortReadonlyBudgetAfterMessageEnd({ toolsThisTurn, finalText })
      ) {
        const tokenBudget = readonlyTokenBudget(agentDef.agentType)
        appendSubAgentSidechain(agentId, {
          kind: 'limit',
          summary: `tokenBudget=${tokenBudget} exceeded (${effectiveTokens}); aborting`,
        })
        markAbortReason(
          `${agentDef.agentType} token budget exceeded (${effectiveTokens}/${tokenBudget})`,
        )
        bridgeAc.abort()
      }
    },
    onStreamingFallback: (info: { status: number; reason: string }) => {
      ctx.outputText = ctx.outputText.slice(0, ctx.outputLenBeforeThisStream)
      // Roll the persistent runtime buffer back to the same point so the
      // non-streaming retry's full response replaces — rather than stacks
      // on top of — the abandoned partial deltas the parent agent reads
      // via TaskOutput. Without this rollback the parent sees "half old
      // chunks + full new chunks", which presents as duplicate / spurious
      // restart-overwrite content.
      if (ctx.taskCursorBeforeThisStream !== null) {
        try {
          taskRuntimeStore.rollbackToCursor(agentId, ctx.taskCursorBeforeThisStream)
        } catch {
          /* rollback is best-effort; never sink the fallback path */
        }
        try {
          taskRuntimeStore.append(
            agentId,
            'meta',
            `<stream-fallback-reset status=${info.status} reason=${info.reason}>\n`,
          )
        } catch {
          /* meta append is best-effort */
        }
      }
      onEvent({
        type: 'subagent_stream_fallback_reset',
        agentId,
        reason: info.reason,
      })
    },
    onError: (error: string) => {
      onEvent({ type: 'subagent_error', agentId, error })
    },
    onContextCompact: (detail: CompactDetail) => {
      // Phase D (granularity uplift) — surface mid-run compaction so
      // the renderer can render a compact pill on the AgentBlock
      // instead of silently changing the on-screen token count.
      // Mirrors the parent-chat `context_compact` LoopEvent and the
      // worker-path `loopEventToSubAgentEvent` `context_compact` case.
      // Sub-agent wire type currently only carries `level`; pre/post
      // token deltas stay parent-only until the AgentBlock UI needs
      // them too.
      onEvent({ type: 'subagent_context_compact', agentId, level: detail.level })
    },
    onMaxIterationsReached: (maxIterations: number) => {
      ctx.reachedMaxIterations = true
      // Phase D — emit the typed `subagent_max_iterations` first so a
      // renderer that prefers the structured signal can react before
      // (or instead of) the legacy `subagent_error`. The legacy event
      // is still emitted below to keep existing UI state-machines
      // (which release agent block slots on `subagent_error`) working
      // without modification.
      onEvent({ type: 'subagent_max_iterations', agentId, maxIterations })
      onEvent({ type: 'subagent_error', agentId, error: `Reached maximum iterations (${maxIterations})` })
    },
  }
  return { loopCallbacks, markFirstModelByte, recordUsageForBudgets }
}
