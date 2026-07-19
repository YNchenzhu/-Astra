/**
 * Agentic loop — stream pass with anthropic overload retry, max-output
 * recovery, and reactive compact.
 *
 * Extracted from agenticLoop.ts (§ streamPass, § runStreamPassWithAnthropicOverloadRetry,
 * § maxOutputRecovery loop, § contextLengthExceeded reactive compact).
 */


import { StreamWatchdog } from '../streamWatchdog'
import { StreamingToolExecutor } from '../streamingToolExecutor'
// P2 — moved-out pure helpers. `stream.ts` re-exports them so
// existing test imports keep working without code-shaped changes.
import {
  decideOverloadRetry as decideOverloadRetryImpl,
  MAX_OVERLOAD_FALLBACK_ATTEMPTS,
  type OverloadRetryDecision as OverloadRetryDecisionImpl,
} from './stream/overloadRetry'
import { shouldBypassStreamingExecutorForPolicy as shouldBypassStreamingExecutorForPolicyImpl } from './stream/policyBypass'
import {
  createModelCallBudget,
  MODEL_CALL_BUDGET_ENV_VAR,
  resolveMaxModelCallAttemptsPerIteration,
} from './stream/modelCallBudget'
import { promoteOrRecoverWithheldSignal } from './stream/withheldSignalPromotion'
import { maybeRunImageStripRetry } from './stream/stripImageRetry'
import { maybeRunReactiveCompactRecovery } from './stream/reactiveCompactRecovery'
import { tryDrainOnlyContextRecovery } from './stream/recoverFromContext'
import {
  getAgentContext,
  recordAgentContextOutputBudgetUsage,
} from '../../agents/agentContext'
import {
  attachPoleQueryTrackingToTailUserMessage,
  buildPoleQueryTrackingForNextRequest,
} from '../../agents/queryTracking'
import { consumeMicroCompactMessageCacheForkShiftOnce } from '../../context/cachedMicrocompactPromptCache'
import {
  buildCacheKeyFactors,
  getConversationCacheBreakDetector,
} from '../../context/promptCacheBreakDetection'
import {
  buildPoleContextUsageSnapshot,
  getTokenCountFromUsage,
  POLE_CONTEXT_USAGE_MESSAGE_KEY,
} from '../../context/tokenUsageAccounting'
import {
  failPromptDiagnostics,
  finishPromptDiagnostics,
  markPromptDiagnosticsFirstResponse,
  startPromptDiagnostics,
} from '../../context/promptDiagnostics'
import {
  getModelMaxOutputTokensBounds,
  MAX_OUTPUT_TOKENS_RECOVERY_ATTEMPTS,
} from '../../context/openClaudeParityConstants'
// 2026-05 audit — the `…_SUMMARY_FALLBACK_MESSAGE` companion is no
// longer used at this call site (upstream-main has a single recovery
// message, not two — the previous astra fallback explicitly
// instructed the model to hand work off to a follow-up turn, which
// was one of the four root causes of long-run "narrate-only end_turn"
// regressions). The symbol stays exported from
// `maxOutputTruncationRecovery.ts` as a deprecated alias for binary
// compatibility with downstream callers / tests; importing it here
// no longer serves any purpose.
import { MAX_OUTPUT_TRUNCATION_USER_MESSAGE } from '../maxOutputTruncationRecovery'
import { QUERY_PROFILER_LABELS } from '../queryProfiler'
import { createTerminalResult, runTerminationCleanup } from '../queryTermination'
import { patchToolDefinitionsForSendMessageRecipients } from '../../agents/sendMessageToolSchema'
import { providerAllowsOpenAiNativeStrictTools } from '../strictToolCallingSupport'
import type { LoopState, StreamInput, StreamOutput } from './loopShared'
import {
  createCompleteEvidenceStreamFilter,
  withEphemeralCompletionEvidenceReminder,
} from './completionEvidenceGate'
import { withEphemeralVerificationPendingReminder } from './verificationGate'
import { resetStreamAccumulators } from './streamAccumulatorReset'
import { recordTransition } from './loopShared'
import { withEphemeralGoalRecitation } from './goalRecitation'
import { withEphemeralActiveSkillRecitation } from './activeSkillRecitation'
import { resolveAdaptiveThinkingBudget } from './adaptiveThinkingBudget'
import { applyEphemeralDistanceThinkingTruncation } from '../../context/anthropicThinkingTranscript'
import { getProviderQuirks } from '../providerQuirks'

// P2 — `decideOverloadRetry` and `shouldBypassStreamingExecutorForPolicy`
// were extracted into focused sibling modules. Re-export from here so
// any existing test that imports these from `./stream` keeps working.
// New code should import directly from `./stream/overloadRetry` /
// `./stream/policyBypass`.
export type OverloadRetryDecision = OverloadRetryDecisionImpl
export const decideOverloadRetry = decideOverloadRetryImpl
export const shouldBypassStreamingExecutorForPolicy =
  shouldBypassStreamingExecutorForPolicyImpl

// ── Public entry ──

export async function runStreamPhase(input: StreamInput): Promise<StreamOutput> {
  const { state, systemPrompt } = input

  let iterationModel = state.iterationModel
  let streamMaxOutTokens = state.streamMaxOutTokens
  let maxOutputRecoveryCycles = state.maxOutputRecoveryCycles

  // ── Build per-iteration tools ──
  const toolsBase = state.iterationToolDefs.length > 0 ? state.iterationToolDefs : undefined
  const shouldPatchSendMessageRecipientEnum = providerAllowsOpenAiNativeStrictTools(state.config.id)
  const tools = toolsBase
    ? patchToolDefinitionsForSendMessageRecipients(toolsBase, {
        includeRecipientEnum: shouldPatchSendMessageRecipientEnum,
      })
    : undefined
  const openAiStrictToolNames =
    tools?.some((t) => t.name === 'SendMessage') &&
    shouldPatchSendMessageRecipientEnum
      ? ['SendMessage']
      : undefined

  const anthropicOverloadModel =
    process.env.POLE_ANTHROPIC_OVERLOAD_FALLBACK_MODEL?.trim() || undefined

  // ── Inner: single stream pass ──
  const streamPass = async (overloadRef: { value: string | null }): Promise<{
    contextLengthExceeded: boolean
    accumulatedText: string
    toolUseBlocks: LoopState['toolUseBlocks']
    thinkingBlocks: LoopState['thinkingBlocks']
    serverToolUseBlocks: LoopState['serverToolUseBlocks']
    codeExecutionResultBlocks: LoopState['codeExecutionResultBlocks']
    lastStreamStopReason: string | undefined
    lastStreamUsageForPole: Record<string, unknown> | null
    lastStreamInputTokens: number
    lastStreamEndMs: number
    streamingToolExecutor: StreamingToolExecutor
    useStreamingToolExecutor: boolean
  }> => {
    // P1-25: previous code constructed `new StreamWatchdog({...})` without
    // an AbortController, so an idle stream would log the warning but never
    // actually abort — the in-flight HTTP request would hang forever.
    // We now build a local AC, mirror parent abort onto it, and pass it to
    // the watchdog so its `onIdleAbort` path can fire `.abort()` on the
    // signal that `streamText` actually consumes.
    const watchdogAc = new AbortController()
    const forwardParentAbort = () => {
      if (!watchdogAc.signal.aborted) watchdogAc.abort(state.signal.reason)
    }
    if (state.signal.aborted) {
      watchdogAc.abort(state.signal.reason)
    } else {
      state.signal.addEventListener('abort', forwardParentAbort, { once: true })
    }
    const watchdog = new StreamWatchdog(
      {
        onIdleWarning: (elapsed) =>
          state.appendixReport('P2_Q_stream_idle_warning', { iteration: state.iteration, elapsedMs: elapsed }),
        onIdleAbort: (elapsed) => {
          state.appendixReport('P2_Q_stream_idle_abort', { iteration: state.iteration, elapsedMs: elapsed })
          return true
        },
        onStallCheck: (stats) =>
          state.appendixReport('P2_Q_stream_stall', {
            iteration: state.iteration,
            stallCount: stats.stallCount,
            totalStallTimeMs: stats.totalStallTimeMs,
          }),
      },
      watchdogAc,
    )
    watchdog.start()
    const disposeWatchdog = () => {
      watchdog.dispose()
      state.signal.removeEventListener('abort', forwardParentAbort)
    }

    const promptLenAtRequest = state.apiMessages.length
    let localUsageForPole: Record<string, unknown> | null = null
    let localInputTokens = 0
    let localStopReason: string | undefined
    // 5-piece-set §A3 — write side of the clock seam (audit Finding 7).
    // Reading from the seam means a test that pins
    // `state.queryDeps.now()` will see consistent timestamps on both
    // sides of the `applyIdleToolClear` read in the next iteration.
    let localStreamEndMs = state.queryDeps.now()
    let accText = ''
    // Completion-evidence handshake (row 12f) — UI-side invisibility. The
    // model appends `<complete-evidence>…</complete-evidence>` to its final
    // reply per the system-prompt protocol; the transcript copy (`accText`)
    // keeps it (the no-tools branch detects it there), but the renderer
    // must never see it. This filter strips the tag from the text-delta
    // stream with cross-chunk prefix holdback; `flush()` runs at
    // `onMessageEnd` so a held false-positive prefix still reaches the UI.
    let evidenceFilter = createCompleteEvidenceStreamFilter()
    const localToolUses: LoopState['toolUseBlocks'] = []
    const localThinking: LoopState['thinkingBlocks'] = []
    const localServerToolUses: LoopState['serverToolUseBlocks'] = []
    const localCodeExecResults: LoopState['codeExecutionResultBlocks'] = []
    const contextLengthExceededRef = { value: false }

    // Streaming tool executor for this pass
    const streamingToolExecutor = new StreamingToolExecutor({
      signal: state.signal,
      callbacks: {
        onToolStart: state.callbacks.onToolStart,
        onToolResult: state.callbacks.onToolResult,
      },
      diffPermissionMode: state.diffPermissionMode as 'default' | 'bypassPermissions',
      permissionDefaultMode: state.permissionDefaultMode as 'allow' | 'ask' | 'deny',
      permissionRules: state.permissionRules,
      chatMode: state.chatMode,
      discoveryExclude: state.discoveryExclude,
      getInlineSkillSession: () => state.activeInlineSkillSession,
      setInlineSkillSession: (s) => { state.activeInlineSkillSession = s },
      appendixAFlow: state.appendAppendixAFlow,
      toolCallHistory: state.toolCallHistory,
    })

    // Audit P0b — decide once per stream pass whether to keep streaming-path
    // tool execution on. When the bypass gate fires we still construct the
    // executor (it owns `markInterrupted` / `getAbortedResults` plumbing the
    // batch path consults on abort) but skip `addTool` so the executor stays
    // empty — downstream `streamingExec.isEmpty()` check in `toolExec.ts`
    // then falls through to the orchestrated / fallback batch path that runs
    // `PolicyEngine` preflight + emits `permission_denied_preflight`.
    const bypassStreamingForPolicy = shouldBypassStreamingExecutorForPolicy({
      permissionRules: state.permissionRules,
      permissionDefaultMode: state.permissionDefaultMode,
      chatMode: state.chatMode,
      envOverride: process.env.POLE_STREAMING_TOOL_EXECUTOR,
    })
    if (bypassStreamingForPolicy) {
      state.appendixReport('P2_Q_stream_request_start', {
        iteration: state.iteration,
        streamingToolExecutorBypassed: true,
        // Mirror the precedence in `shouldBypassStreamingExecutorForPolicy`:
        // env override → chat mode → permission rules → default-deny.
        reason:
          process.env.POLE_STREAMING_TOOL_EXECUTOR === '0'
            ? 'env_override'
            : state.chatMode && state.chatMode !== 'agent'
              ? `chat_mode:${state.chatMode}`
              : (state.permissionRules?.length ?? 0) > 0
                ? 'permission_rules_present'
                : state.permissionDefaultMode === 'deny'
                  ? 'permission_default_deny'
                  : 'env_override',
      })
    }

    state.appendixReport('P2_Q_stream_request_start', { iteration: state.iteration, model: iterationModel })
    state.appendixReport('P2_Q_query_tracking_attach', { iteration: state.iteration, promptLenAtRequest })

    attachPoleQueryTrackingToTailUserMessage(
      state.apiMessages,
      buildPoleQueryTrackingForNextRequest(getAgentContext()),
    )

    // ── Ephemeral tail slot policy (2026-07 复审 item 6 — unified) ──
    //
    // All four tail re-surfacers are EPHEMERAL wire-copy appends: never
    // persisted to `state.apiMessages`, rebuilt fresh per request,
    // prompt-cache prefix untouched. Each returns the same reference
    // when its gate says no-op.
    //
    // ORDER IS THE CONTRACT. Inner wrappers append FIRST (furthest from
    // generation); the outermost wrapper appends LAST (closest). Before
    // this fix each author grabbed the outermost slot for their own
    // reminder — the completion-evidence PROTOCOL ended up closer to
    // generation than the user's GOAL, and two code comments each
    // claimed the last position. The unified policy, furthest → closest:
    //
    //   1. completion-evidence protocol reminder (how to end the turn —
    //      housekeeping, weakest claim on recency; 2026-07 smoothness
    //      fix, N1: no-op for non-code work packages)
    //   2. verification-pending reminder (verify BEFORE composing the
    //      final declaration — row-12d front-load, code work package only)
    //   3. active-skill recitation (HOW to execute — the binding
    //      workflow; Codex parity 2026-07)
    //   4. goal recitation (WHAT the user wants + current step — GAP 1,
    //      2026-06; always the last thing the model reads)
    //
    // Rationale: the user's objective must win every recency contest —
    // protocol rituals matter only when the work itself is on-goal.
    //
    // `applyEphemeralDistanceThinkingTruncation` (2026-06 root cause 4)
    // transforms historical thinking blocks in place — it appends
    // nothing, so wrapping order relative to the re-surfacers is
    // irrelevant; it stays outermost for clarity.
    const messagesForRequest = applyEphemeralDistanceThinkingTruncation(
      withEphemeralGoalRecitation(
        withEphemeralActiveSkillRecitation(
          withEphemeralVerificationPendingReminder(
            withEphemeralCompletionEvidenceReminder(state.apiMessages, {
              turnUsedTools: state.transitionHistory.includes('tool_use'),
            }),
          ),
          { activeSkillName: state.activeInlineSkillSession?.skillName },
        ),
        { iteration: state.iteration },
      ),
      {
        strictThinkingEcho: getProviderQuirks(state.config).thinkingRequiresHistoryEcho,
      },
    )

    const microCacheForkShiftOnce = consumeMicroCompactMessageCacheForkShiftOnce(
      getAgentContext()?.streamConversationId,
    )
    const ctxForCache = getAgentContext()
    const convIdForCache = ctxForCache?.streamConversationId
    // 2026-07 uplift #14 — per-iteration thinking-budget throttle. Never
    // exceeds the session base; routine mid-loop iterations get a reduced
    // budget while planning / post-failure iterations keep the full one.
    //
    // P2-2 audit fix — the first all-errors batch latches the full budget
    // for the rest of the run so budget_tokens doesn't oscillate between
    // routine and full values (each flip invalidates the Anthropic
    // message-level prompt cache). See `adaptiveThinkingFullBudgetLatched`.
    if (state.lastToolBatchAllErrors) {
      state.adaptiveThinkingFullBudgetLatched = true
    }
    const effectiveThinkingBudgetTokens = resolveAdaptiveThinkingBudget({
      iteration: state.iteration,
      alwaysThinking: !!state.alwaysThinking,
      // P3 audit fix (2026-07) — read the session base budget from the
      // frozen QueryConfig snapshot instead of live ALS. The two were
      // always equal (AgentContext.thinkingBudgetTokens is only written
      // at context construction, never mid-run), but the ALS read left
      // `queryConfig.thinkingBudgetTokens` as a promised-but-unconsumed
      // field. This is the first read-site migration of the QueryConfig
      // plan (see queryConfig.ts "Migration plan").
      baseBudgetTokens: state.queryConfig.thinkingBudgetTokens,
      lastToolBatchAllErrors: !!state.lastToolBatchAllErrors,
      latchedFullBudget: state.adaptiveThinkingFullBudgetLatched,
    })
    const messageLevelCacheControl =
      process.env.POLE_ANTHROPIC_MESSAGE_CACHE_CONTROL === '1'
    const promptDiagnosticsId = startPromptDiagnostics({
      conversationId: convIdForCache,
      agentId: ctxForCache?.agentId,
      providerId: state.config.id,
      model: iterationModel,
      iteration: state.iteration,
      systemPrompt,
      systemPromptLayers: state.systemPromptLayers,
      apiMessages: messagesForRequest,
      toolTokens: state.toolTokensForContext,
      effort: state.iterationEffort,
      alwaysThinking: state.alwaysThinking,
      thinkingBudgetTokens: effectiveThinkingBudgetTokens,
      messageLevelCacheControl,
      systemContextCacheControl:
        state.config.id === 'anthropic' &&
        process.env.POLE_ANTHROPIC_SYSTEM_BLOCK_CACHE_DISABLE !== '1' &&
        (state.systemPromptLayers?.systemContext.trim().length ?? 0) > 0,
      now: state.queryDeps.now(),
    })
    if (convIdForCache && systemPrompt) {
      const factors = buildCacheKeyFactors({
        systemPrompt,
        toolSchemas: (tools ?? []) as unknown as Array<Record<string, unknown>>,
        model: iterationModel,
        thinkingEnabled: !!state.alwaysThinking,
        // P2-2 audit fix — budget_tokens changes invalidate the Anthropic
        // message-level cache; track the effective (adaptive) value so the
        // break detector reports these flips instead of being blind to them.
        thinkingBudgetTokens: effectiveThinkingBudgetTokens,
      })
      const detectorScope =
        ctxForCache?.agentId === 'main' || !ctxForCache?.agentId
          ? 'main'
          : `agent:${ctxForCache.agentId}:${ctxForCache.querySource ?? 'unknown'}`
      const breakEvent = getConversationCacheBreakDetector(convIdForCache, detectorScope).check(factors)
      if (breakEvent) {
        state.appendixReport('P2_Q_prompt_cache_break', {
          iteration: state.iteration,
          changedFactors: breakEvent.changedFactors,
        })
      }
    }

    try {
        // 5-piece-set §A3 — DI seam. `state.queryDeps.callModel` defaults to
    // the imported `streamText` reference; tests can substitute a fake
    // by overriding `defaultQueryDeps({ callModel: ... })` at
    // state-init time. Module-level `vi.mock('../client')` against
    // `streamText` continues to work because the mock replaces the
    // export at import time — `setup.ts` captures the replaced
    // reference and stores it on `state.queryDeps`.
    await state.queryDeps.callModel(
      state.config,
      {
        model: iterationModel,
        systemPrompt,
        systemPromptLayers: state.systemPromptLayers,
        maxTokens: streamMaxOutTokens,
        effort: state.iterationEffort,
        tools,
        openAiStrictToolNames,
        apiMessages: messagesForRequest,
        messages: [],
        alwaysThinking: state.alwaysThinking,
        thinkingBudgetTokens: effectiveThinkingBudgetTokens,
        contextLengthExceededRef,
        ...(state.temperature !== undefined ? { temperature: state.temperature } : {}),
        ...(state.topP !== undefined ? { topP: state.topP } : {}),
        ...(state.anthropicFastModeEnabled ? { anthropicFastMode: true } : {}),
        ...(anthropicOverloadModel ? { anthropicOverloadFallbackModel: anthropicOverloadModel, anthropicOverloadFallbackModelRef: overloadRef } : {}),
        anthropicMessagePromptCache:
          messageLevelCacheControl
            ? {
                secondToLastBreakpoint:
                  state.apiMessages.length >= 2 &&
                  ((process.env.POLE_ANTHROPIC_MESSAGE_CACHE_FORK_SHIFT === '1' &&
                    (getAgentContext()?.replDepth ?? 0) > 0) ||
                    microCacheForkShiftOnce),
              }
            : undefined,
      },
      {
        onTextDelta: (text) => {
          watchdog.notifyActivity()
          markPromptDiagnosticsFirstResponse(promptDiagnosticsId, state.queryDeps.now())
          accText += text
          // Renderer sees the filtered stream only; `accText` keeps the raw
          // text so the completion-evidence gate can detect the tag.
          const visible = evidenceFilter.push(text)
          if (visible) state.callbacks.onTextDelta(visible)
        },
        onThinkingDelta: (text) => {
          watchdog.notifyActivity()
          markPromptDiagnosticsFirstResponse(promptDiagnosticsId, state.queryDeps.now())
          state.callbacks.onThinkingDelta?.(text)
        },
        onThinkingBlock: (block) => {
          watchdog.notifyActivity()
          markPromptDiagnosticsFirstResponse(promptDiagnosticsId, state.queryDeps.now())
          localThinking.push(block)
          state.callbacks.onThinkingBlock?.(block)
        },
        onMessageEnd: (usage) => {
          localStreamEndMs = state.queryDeps.now()
          disposeWatchdog()
          // Release any held-back text: a tail that looked like the start
          // of the evidence tag but never completed it belongs to the user;
          // a suppressed unclosed tag is dropped.
          const heldTail = evidenceFilter.flush()
          if (heldTail) state.callbacks.onTextDelta(heldTail)
          if (usage?.stopReason) localStopReason = usage.stopReason
          // P0.2 — refusal soft recovery. When the provider signals
          // `stop_reason === 'refusal'` (Anthropic refusal / OpenAI
          // content_filter / Gemini SAFETY, all normalised by
          // `mapStopReasonToClaude`), synthesise a withheld signal so
          // the unified promotion flow at the end of `runStreamPhase`
          // picks it up. Two outcomes follow naturally:
          //
          //   - The model produced text / thinking / tool_use anyway
          //     ("I cannot help with that, but here's…") →
          //     `producedSomething` is true → withheld signal is
          //     silently discarded → loop continues as if completed.
          //   - The model produced nothing → `!producedSomething` →
          //     promotion fires → terminate with `model_error`.
          //
          // First-wins capture (same invariant as `onLoopSignal` /
          // `onError` slots): a later retry that re-fires the same
          // refusal won't clobber the original classification.
          //
          // upstream parity: see `services/api/errors.ts#getErrorMessageIfRefusal`
          // — upstream yields a typed `AssistantMessage` with
          // `apiError: 'invalid_request'` that the outer loop handles via
          // its normal `lastMessage.isApiErrorMessage` exit path, also
          // without a hard error termination.
          if (usage?.stopReason === 'refusal' && state.withheldStreamSignal == null) {
            state.withheldStreamSignal = {
              kind: 'stream:refusal',
              rawMessage:
                'Model declined to respond (stop_reason: refusal). The request may have triggered the provider\u2019s safety policy.',
              details: { stopReason: 'refusal', model: iterationModel },
            }
          }
          if (usage) {
            localInputTokens = usage.inputTokens
            state.totalUsage.inputTokens += usage.inputTokens
            state.totalUsage.outputTokens += usage.outputTokens
            state.callbacks.onStreamUsage?.({
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
            })
            recordAgentContextOutputBudgetUsage(usage.outputTokens)
            const snap = buildPoleContextUsageSnapshot(usage)
            if (getTokenCountFromUsage(snap) > 0) {
              localUsageForPole = snap
              state.loopContextManager.recordUsageAfterRequest(
                getTokenCountFromUsage(snap),
                promptLenAtRequest,
                snap,
              )
            }
            finishPromptDiagnostics(promptDiagnosticsId, snap, localStreamEndMs)
          } else {
            finishPromptDiagnostics(promptDiagnosticsId, undefined, localStreamEndMs)
          }
        },
        onError: (err) => {
          localStreamEndMs = state.queryDeps.now()
          disposeWatchdog()
          failPromptDiagnostics(promptDiagnosticsId, err, localStreamEndMs)
          state.loopContextManager.clearUsageSnapshot()
          // Withhold provider errors here. Recovery paths below
          // (max-output retry, reactive compact, anthropic overload fallback)
          // may yet succeed and make the original error irrelevant. Only the
          // final post-recovery decision (see end of `runStreamPhase`)
          // promotes a withheld error into a terminal `onError` emit + a
          // typed `TerminationReason`.
          //
          // Phase 3: the typed classification source-of-truth is now
          // `state.withheldStreamSignal` (captured via `onLoopSignal`
          // below); this string is kept purely as the carrier of the
          // human-readable message passed to `state.callbacks.onError`
          // on terminal promotion.
          if (state.withheldStreamError == null) {
            state.withheldStreamError = err
          }
        },
        // Phase 3 (upstream alignment) — typed envelope from the provider
        // catch boundary (see `loopSignalEmit.ts`). First-wins capture
        // so a retry that re-fires the same error doesn't clobber the
        // original classification. The stream phase reads `.kind` for
        // routing decisions (strip-retry, terminal promotion) instead
        // of running regex over the rendered error text.
        onLoopSignal: (sig) => {
          if (state.withheldStreamSignal == null) {
            state.withheldStreamSignal = sig
          }
        },
        onToolUse: (toolUse) => {
          watchdog.notifyActivity()
          markPromptDiagnosticsFirstResponse(promptDiagnosticsId, state.queryDeps.now())
          const i = localToolUses.findIndex((t) => t.id === toolUse.id)
          if (i >= 0) localToolUses[i] = toolUse
          else localToolUses.push(toolUse)
          // Audit P0b — skip streaming-path admission when policy is non-trivial;
          // the orchestrated / fallback batch path then runs the full preflight
          // for this tool. `localToolUses` still grows so the dedup + assistant
          // message construction downstream sees the same tool_use blocks.
          if (!state.signal.aborted && !bypassStreamingForPolicy) {
            streamingToolExecutor.addTool(toolUse)
          }
        },
        // Mid-block JSON streaming for Write/Edit tools. Routed straight to
        // the loop callbacks so the IPC layer can forward to the renderer
        // — no need to retain state here; the provider already hands us
        // the accumulated buffer.
        onToolInputDelta: (delta) => {
          watchdog.notifyActivity()
          markPromptDiagnosticsFirstResponse(promptDiagnosticsId, state.queryDeps.now())
          state.callbacks.onToolInputDelta?.(delta)
        },
        onServerToolUse: (block) => {
          watchdog.notifyActivity()
          markPromptDiagnosticsFirstResponse(promptDiagnosticsId, state.queryDeps.now())
          localServerToolUses.push(block)
        },
        onCodeExecutionResult: (result) => {
          watchdog.notifyActivity()
          markPromptDiagnosticsFirstResponse(promptDiagnosticsId, state.queryDeps.now())
          localCodeExecResults.push(result)
        },
        onStreamingFallback: (info) => {
          // Reset accumulators in a single audited contract; see
          // `streamAccumulatorReset.ts` for why this is critical AFTER the
          // SDK-path Step 3 change (per-content_block_stop emission moved
          // partial `onThinkingBlock` calls INTO the streaming phase, so
          // a 529 between two thinking blocks would otherwise double-count
          // them with the non-streaming retry's emissions).
          accText = ''
          // The fallback retry replays the whole message; reset the
          // evidence filter alongside the accumulators so holdback /
          // suppression state from the abandoned pass cannot leak into
          // the retry's delta stream.
          evidenceFilter = createCompleteEvidenceStreamFilter()
          resetStreamAccumulators({
            toolUses: localToolUses,
            serverToolUses: localServerToolUses,
            codeExecResults: localCodeExecResults,
            thinking: localThinking,
          })
          // Audit Bug 4 — previously this dropped the underlying status
          // (e.g. 529 overloaded) and substituted a hardcoded `0`, leaving
          // UI / telemetry consumers unable to distinguish overload from
          // any other fallback reason. Forward the actual `{status, reason}`.
          state.callbacks.onStreamingFallback?.(info)
        },
      },
      // P1-25: pass the merged signal so the watchdog's `idleAbort` actually
      // tears down the in-flight HTTP request. `state.signal` aborts are
      // already mirrored onto `watchdogAc` above.
      watchdogAc.signal,
    )
    } finally {
      // P1-25: idempotent cleanup — guarantees the parent-abort listener and
      // watchdog timers are released even if streamText throws or never
      // reaches `onMessageEnd` / `onError` (e.g. synchronous setup failure).
      disposeWatchdog()
    }

    state.appendixReport('P2_Q_stream_complete', {
      iteration: state.iteration,
      toolUseCount: localToolUses.length,
      stopReason: localStopReason,
      contextLengthExceeded: contextLengthExceededRef.value,
    })

    // Dedup: DeepSeek streaming can fire onToolUse twice for the same ID
    // (streaming flush + non-streaming fallback in compatibleClient).
    // P1-26: previously this kept the FIRST occurrence, which could discard
    // a later, more-complete `input` payload (e.g. the streaming flush
    // emits an eagerly-parsed partial object, then the non-stream
    // fallback emits the fully decoded JSON). Now we keep the LAST entry
    // per id by walking right-to-left, so downstream tool execution sees
    // the freshest schema-valid input.
    const lastById = new Map<string, number>()
    for (let i = localToolUses.length - 1; i >= 0; i--) {
      const id = localToolUses[i].id
      if (!lastById.has(id)) lastById.set(id, i)
    }
    const keepIndices = new Set(lastById.values())
    const dedupedToolUses = localToolUses.filter((tu, i) => {
      if (keepIndices.has(i)) return true
      console.warn(`[Stream] Dropping duplicate tool_use id from stream: ${tu.id} (${tu.name})`)
      return false
    })

    return {
      contextLengthExceeded: contextLengthExceededRef.value,
      accumulatedText: accText,
      toolUseBlocks: dedupedToolUses,
      thinkingBlocks: localThinking,
      serverToolUseBlocks: localServerToolUses,
      codeExecutionResultBlocks: localCodeExecResults,
      lastStreamStopReason: localStopReason,
      lastStreamUsageForPole: localUsageForPole,
      lastStreamInputTokens: localInputTokens,
      lastStreamEndMs: localStreamEndMs,
      streamingToolExecutor,
      useStreamingToolExecutor: dedupedToolUses.length > 0,
    }
  }

  // ── Anthropic overload retry wrapper ──
  //
  // P2 audit fix — the previous `for (;;)` loop had **no upper bound** on
  // how many overload→fallback rounds a single turn could go through. In
  // production this is normally bounded by the provider eventually
  // succeeding or the user pressing Stop, but two specific configurations
  // can busy-loop:
  //
  //   1. `POLE_ANTHROPIC_OVERLOAD_FALLBACK_MODEL` points at the SAME SKU
  //      family that's currently overloaded — every fallback attempt hits
  //      the same overloaded backend and 529s, perpetually setting
  //      `overloadRef.value` to the same model.
  //   2. Provider returns 529 immediately on every request (regional
  //      outage). Without a cap, the loop hammers the API with no chance
  //      of recovery.
  //
  // Guards added:
  //   - Per-turn attempt counter (`MAX_OVERLOAD_FALLBACK_ATTEMPTS`).
  //   - "Fallback ≡ current model" short-circuit so a misconfigured env
  //     var fails fast instead of busy-looping silently.
  //
  // When either guard fires the loop returns the last response as-is. The
  // downstream withheld-error promotion path picks it up and surfaces a
  // typed terminal `model_error` (since the response carries no usable
  // content from the failed pass).
  const overloadRef = { value: null as string | null }
  // Audit SA-6 (P1) — single total budget over every loop-level model call
  // launched this iteration. Each recovery layer keeps its own cap; this is
  // a final backstop over their multiplicative worst case. Provider-level
  // inner HTTP retries (`withRetry` / `streamWithMidStreamRetry`) are NOT
  // counted here — they live inside one counted `streamPass` and have
  // their own limits (see ./stream/modelCallBudget.ts header).
  const modelCallBudget = createModelCallBudget(
    resolveMaxModelCallAttemptsPerIteration(),
  )
  // Most recent completed streamPass result — returned when the budget
  // refuses a new call so callers always receive a well-formed result.
  let lastBudgetedPassResult: Awaited<ReturnType<typeof streamPass>> | null = null
  // P2 — `MAX_OVERLOAD_FALLBACK_ATTEMPTS` is now imported from
  // ./stream/overloadRetry so the constant has a single source of truth.
  const runStreamWithRetry = async (
    entryLabel: string = 'initial',
  ): Promise<Awaited<ReturnType<typeof streamPass>>> => {
    let overloadAttempts = 0
    let lastResult: Awaited<ReturnType<typeof streamPass>> | null = null
    for (;;) {
      // Attribution label for budget breakdown stats, DERIVED from the loop
      // state at the top of every round (not carried across iterations via a
      // mutable variable). The first pass of this invocation is attributed
      // to the recovery layer that initiated it (`entryLabel`); every
      // overload-fallback round (`overloadAttempts > 0`) is attributed to
      // 'overload_fallback'. Deriving it here keeps the budget breakdown
      // (consumed just below) and the overload counter (incremented before
      // `continue`) the single source of truth — reordering the two budget
      // systems can no longer desync the label.
      const attemptLabel = overloadAttempts === 0 ? entryLabel : 'overload_fallback'
      // Audit SA-6 — consult the total budget BEFORE launching a model
      // call. On refusal, return the last completed pass result unchanged;
      // the post-layer checks in `runStreamPhase` promote exhaustion into
      // a typed `model_error` termination.
      if (!modelCallBudget.tryConsume(attemptLabel)) {
        console.warn(
          `[Agentic Loop] model-call budget exhausted (${modelCallBudget.used}/` +
            `${modelCallBudget.maxAttempts} this iteration; refused entry=` +
            `${attemptLabel}; breakdown: ${modelCallBudget.describeBreakdown()})`,
        )
        state.appendixReport('P2_Q_model_call_budget_exhausted', {
          iteration: state.iteration,
          maxAttempts: modelCallBudget.maxAttempts,
          refusedEntry: attemptLabel,
          breakdown: modelCallBudget.breakdown,
        })
        if (lastResult) return lastResult
        if (lastBudgetedPassResult) return lastBudgetedPassResult
        // Unreachable in practice: the budget is ≥ 1, so the very first
        // pass of the iteration always runs and populates
        // `lastBudgetedPassResult`. Fall through defensively rather than
        // crash the loop.
      }
      overloadRef.value = null
      // Each retry attempt gets its own clean withholding slot — an
      // overload-fallback round must not inherit the previous round's
      // captured error.
      state.withheldStreamError = null
      state.withheldStreamSignal = null
      const endStreamRetryCp = state.profiler.startCheckpoint(QUERY_PROFILER_LABELS.streamRetry, {
        model: iterationModel,
      })
      const r = await streamPass(overloadRef)
      endStreamRetryCp()
      lastResult = r
      lastBudgetedPassResult = r
      if (overloadRef.value) {
        const decision = decideOverloadRetry({
          currentModel: iterationModel,
          proposedFallbackModel: overloadRef.value,
          priorAttempts: overloadAttempts,
          maxAttempts: MAX_OVERLOAD_FALLBACK_ATTEMPTS,
        })
        if (decision.kind === 'break') {
          console.warn(
            `[Agentic Loop] overload fallback breaking out: reason=${decision.reason} ` +
              `(iteration=${state.iteration}, attempts=${overloadAttempts}, ` +
              `current=${iterationModel}, proposed=${overloadRef.value})`,
          )
          state.appendixReport('P2_Q_anthropic_overload_fallback', {
            iteration: state.iteration,
            fallbackModel: overloadRef.value,
            breakReason: decision.reason,
            attempts: overloadAttempts,
          })
          return r
        }
        overloadAttempts++
        iterationModel = decision.nextModel
        recordTransition(state, 'overload_fallback')
        state.appendixReport('P2_Q_anthropic_overload_fallback', {
          iteration: state.iteration,
          fallbackModel: iterationModel,
          attempts: overloadAttempts,
        })
        continue
      }
      return r
    }
    // Unreachable — the loop only exits via `return`. Reference
    // `lastResult` to satisfy "unused variable" lint without changing
    // semantics.
    void lastResult
  }

  // Audit SA-6 — terminal wrap-up for budget exhaustion. Mirrors the
  // max-output-exhausted branch below: typed `model_error` termination
  // whose detail carries the attempt distribution across recovery entry
  // points so operators can see WHICH layers burned the budget. Aborts
  // win — the post-stream abort guard owns that path.
  const maybeTerminateForExhaustedBudget = async (
    r: Awaited<ReturnType<typeof streamPass>>,
  ): Promise<StreamOutput | null> => {
    if (!modelCallBudget.exhausted || state.signal.aborted) return null
    const detail =
      `Model call retry budget exhausted: ${modelCallBudget.used}/` +
      `${modelCallBudget.maxAttempts} attempts in one iteration ` +
      `(attempt breakdown: ${modelCallBudget.describeBreakdown()}). ` +
      `Set ${MODEL_CALL_BUDGET_ENV_VAR} to override the budget.`
    state.callbacks.onError(detail)
    state.callbacks.onMessageEnd(state.totalUsage)
    state.terminationResult = createTerminalResult('model_error', {
      turnCount: state.iteration,
      totalUsage: state.totalUsage,
      errorDetail: detail,
    })
    await runTerminationCleanup(state.terminationResult)
    return {
      ...r,
      streamMaxOutTokens,
      iterationModel,
      maxOutputRecoveryCycles,
      totalUsage: state.totalUsage,
      lastStreamEndMs: r.lastStreamEndMs,
      useStreamingToolExecutor: false,
    }
  }

  let result = await runStreamWithRetry()
  {
    // Audit SA-6 — exhaustion during the initial pass / overload rounds.
    const budgetTerminal = await maybeTerminateForExhaustedBudget(result)
    if (budgetTerminal) return budgetTerminal
  }

  // ── Max-output recovery loop ──
  // Audit Bug 12 — earlier this only checked `accumulatedText` for content,
  // so an extended-thinking turn that produced thinking blocks but no
  // visible text was treated as "no output yet" and skipped recovery
  // entirely (falling through to the maxOutputExhausted branch on the
  // first hit). Count thinking blocks as output too, since a follow-up
  // turn that replays the assistant message still has something to
  // continue from.
  const hasRecoverableOutput = (
    r: typeof result,
  ): boolean =>
    r.accumulatedText.trim().length > 0 || r.thinkingBlocks.length > 0
  while (
    !result.contextLengthExceeded &&
    result.toolUseBlocks.length === 0 &&
    (result.lastStreamStopReason === 'max_tokens' || result.lastStreamStopReason === 'length') &&
    maxOutputRecoveryCycles < MAX_OUTPUT_TOKENS_RECOVERY_ATTEMPTS &&
    hasRecoverableOutput(result) &&
    // Audit SA-6 — stop scheduling further recovery rounds (and stop
    // mutating apiMessages with recovery meta-messages) once the total
    // model-call budget is spent.
    !modelCallBudget.exhausted &&
    !state.signal.aborted
  ) {
    state.appendixReport('P2_Q_max_output_recovery', {
      iteration: state.iteration,
      cycle: maxOutputRecoveryCycles + 1,
      stopReason: result.lastStreamStopReason,
    })

    const poleSnap =
      result.lastStreamUsageForPole && getTokenCountFromUsage(result.lastStreamUsageForPole) > 0
        ? { [POLE_CONTEXT_USAGE_MESSAGE_KEY]: result.lastStreamUsageForPole }
        : {}

    const recoveryContent: Array<Record<string, unknown>> = []
    for (const tb of result.thinkingBlocks) {
      recoveryContent.push({
        type: 'thinking',
        thinking: tb.thinking,
        ...(tb.signature ? { signature: tb.signature } : {}),
      })
    }
    if (result.accumulatedText.length > 0) {
      recoveryContent.push({ type: 'text', text: result.accumulatedText })
    }

    // 2026-05 audit — upstream-main parity (`src/query.ts:1224-1230`)
    // collapses both recovery cycles onto the same single message.
    // The previous astra-specific "switching to summary mode"
    // fallback explicitly handed remaining work off to a follow-up
    // turn ("List the concrete steps that remain so the user (or a
    // follow-up turn) can pick up cleanly"), which was one of the
    // four root causes of long-run "narrate-only end_turn"
    // regressions: a cycle-2 max_output trip injected an instruction
    // that effectively asked the model to wrap up rather than continue
    // executing. upstream has no such fallback; its sole recovery
    // message keeps the model on "resume + break work smaller" the
    // whole way. The bounds / upper-limit computation is retained for
    // the cap-escalation branch below.
    const bounds = getModelMaxOutputTokensBounds(iterationModel)
    const atUpperLimit = streamMaxOutTokens >= bounds.upperLimit
    const recoveryUserMessage = MAX_OUTPUT_TRUNCATION_USER_MESSAGE
    void atUpperLimit // kept for clarity at the cap-escalation site below

    if (recoveryContent.length > 0) {
      state.apiMessages.push({ role: 'assistant', content: recoveryContent, ...poleSnap })
    }
    state.apiMessages.push({ role: 'user', content: recoveryUserMessage })
    state.syncConversation()

    maxOutputRecoveryCycles++

    // upstream parity (query.ts:1199-1221): the first-shot 8k→64k cap
    // escalation is a distinct transition from the subsequent meta-message
    // recovery rounds. We still inject a meta message on cycle 1 (upstream
    // skips it), but the *reason* the loop continues is "we lifted the
    // output cap" — the meta is belt-and-braces. Subsequent cycles
    // (2, 3) are pure recovery: the cap is already at its ceiling and
    // we're nudging the model to summarise / resume verbatim.
    const willEscalateCap =
      maxOutputRecoveryCycles === 1 &&
      process.env.POLE_MAX_OUTPUT_RECOVERY_ESCALATE !== '0' &&
      streamMaxOutTokens < bounds.upperLimit
    if (willEscalateCap) {
      streamMaxOutTokens = Math.min(bounds.upperLimit, Math.max(streamMaxOutTokens, 64_000))
      recordTransition(state, 'max_output_escalate')
    } else {
      recordTransition(state, 'max_output_recovery')
    }

    result.accumulatedText = ''
    result.lastStreamUsageForPole = null
    result.toolUseBlocks.length = 0
    result.thinkingBlocks.length = 0
    state.loopContextManager.clearUsageSnapshot()
    result = await runStreamWithRetry('max_output_recovery')
  }
  {
    // Audit SA-6 — exhaustion during max-output recovery rounds.
    const budgetTerminal = await maybeTerminateForExhaustedBudget(result)
    if (budgetTerminal) return budgetTerminal
  }

  // ── Max-output recovery exhausted ──
  // Loop above exited with `maxOutputRecoveryCycles >= MAX_OUTPUT_TOKENS_RECOVERY_ATTEMPTS`,
  // no tool_use, and stop_reason still `max_tokens` / `length`. Without an explicit
  // termination here, the loop proceeds to noTools and ends as `completed`, which
  // hides a real failure. Promote it to `model_error` with a recovery-specific detail.
  const maxOutputExhausted =
    !result.contextLengthExceeded &&
    result.toolUseBlocks.length === 0 &&
    (result.lastStreamStopReason === 'max_tokens' || result.lastStreamStopReason === 'length') &&
    maxOutputRecoveryCycles >= MAX_OUTPUT_TOKENS_RECOVERY_ATTEMPTS &&
    !state.signal.aborted
  if (maxOutputExhausted) {
    const detail = `Model output truncated at max_tokens after ${MAX_OUTPUT_TOKENS_RECOVERY_ATTEMPTS} recovery attempts.`
    state.callbacks.onError(detail)
    state.callbacks.onMessageEnd(state.totalUsage)
    state.terminationResult = createTerminalResult('model_error', {
      turnCount: state.iteration,
      totalUsage: state.totalUsage,
      errorDetail: detail,
    })
    await runTerminationCleanup(state.terminationResult)
    return {
      ...result,
      streamMaxOutTokens,
      iterationModel,
      maxOutputRecoveryCycles,
      totalUsage: state.totalUsage,
      lastStreamEndMs: result.lastStreamEndMs,
      useStreamingToolExecutor: false,
    }
  }

  // ── Empty max-output truncation (audit F-7) ──
  // A `max_tokens` / `length` stop with NO recoverable output (no visible
  // text, no thinking, no tool_use) never enters the recovery loop above —
  // `hasRecoverableOutput` is false, so there is nothing to "continue from".
  // That left `maxOutputRecoveryCycles === 0`, so `maxOutputExhausted` (which
  // requires `>= MAX_OUTPUT_TOKENS_RECOVERY_ATTEMPTS`) stayed false and the
  // iteration fell through to the no-tool branch and ended as `completed` —
  // a SILENT empty "success" for a turn the model actually truncated before
  // emitting anything. Promote it to a real `model_error`. Disjoint from
  // `maxOutputExhausted` (that path requires the loop to have run, which
  // requires recoverable output).
  const maxOutputEmptyTruncation =
    !result.contextLengthExceeded &&
    result.toolUseBlocks.length === 0 &&
    (result.lastStreamStopReason === 'max_tokens' ||
      result.lastStreamStopReason === 'length') &&
    !hasRecoverableOutput(result) &&
    !state.signal.aborted
  if (maxOutputEmptyTruncation) {
    const detail =
      'Model hit the output token limit before producing any text, reasoning, or tool call (empty truncation). Try a shorter request or a model with a larger output budget.'
    state.callbacks.onError(detail)
    state.callbacks.onMessageEnd(state.totalUsage)
    state.terminationResult = createTerminalResult('model_error', {
      turnCount: state.iteration,
      totalUsage: state.totalUsage,
      errorDetail: detail,
    })
    await runTerminationCleanup(state.terminationResult)
    return {
      ...result,
      streamMaxOutTokens,
      iterationModel,
      maxOutputRecoveryCycles,
      totalUsage: state.totalUsage,
      lastStreamEndMs: result.lastStreamEndMs,
      useStreamingToolExecutor: false,
    }
  }

  // ── Refusal soft-recovery (P0.2) ──
  // `stop_reason: 'refusal'` is now synthesised into
  // `state.withheldStreamSignal` inside `onMessageEnd` above. The unified
  // withheld-signal promotion path at the end of this function handles
  // both outcomes:
  //   - producedSomething (text / thinking / tools) → discard the signal,
  //     iteration completes normally (upstream parity: refusal can co-exist
  //     with a user-visible "I cannot help with that" assistant reply).
  //   - nothing produced → promote to `model_error` terminal.
  // The dedicated hard-stop branch that used to live here was overly
  // aggressive — it forced `model_error` even when the model produced
  // a legitimate refusal message that the user should see.

  // P0-3 — drain-only layer. Free recovery for long-running sessions where
  // preModel's auto-fold has queued segments. Skips when nothing to drain;
  // falls through to reactive compact when drain didn't suffice.
  const drainOutcome = await tryDrainOnlyContextRecovery(
    state,
    result,
    () => runStreamWithRetry('drain_recovery'),
  )
  result = drainOutcome.result
  if (drainOutcome.kind === 'recovered' || drainOutcome.kind === 'aborted') {
    // Recovered: skip reactive compact entirely.
    // Aborted: let the post-stream guard handle it.
    // Both paths leave `result` ready for the rest of the phase.
  }
  {
    // Audit SA-6 — exhaustion during drain-only recovery. Checked before
    // reactive compact so an already-spent budget doesn't pay for the
    // compact's own LLM summarization call.
    const budgetTerminal = await maybeTerminateForExhaustedBudget(result)
    if (budgetTerminal) return budgetTerminal
  }

  // P2 — reactive compact extracted to ./stream/reactiveCompactRecovery.
  // `terminal` outcomes need the runStreamPhase-local mutable bag to
  // build the final StreamOutput shape, so the wrap-up happens here.
  // P0-3: this still runs when drain didn't recover (`fall_through`), in
  // which case `result` still has `contextLengthExceeded === true` and the
  // full reactive compact path takes over.
  const compactOutcome = await maybeRunReactiveCompactRecovery(
    state,
    result,
    systemPrompt,
    iterationModel,
    () => runStreamWithRetry('reactive_compact'),
  )
  result = compactOutcome.result
  if (compactOutcome.kind === 'terminal') {
    return {
      ...result,
      streamMaxOutTokens,
      iterationModel,
      maxOutputRecoveryCycles,
      totalUsage: state.totalUsage,
      lastStreamEndMs: result.lastStreamEndMs,
      useStreamingToolExecutor: false,
    }
  }

  // P2 — image strip-retry extracted to ./stream/stripImageRetry.
  result = await maybeRunImageStripRetry(state, result, () =>
    runStreamWithRetry('image_strip_retry'),
  )
  {
    // Audit SA-6 — exhaustion during reactive compact / strip-retry.
    const budgetTerminal = await maybeTerminateForExhaustedBudget(result)
    if (budgetTerminal) return budgetTerminal
  }

  // ── Final withheld-error promotion ──
  // Recovery paths above have all run. If the typed envelope is still
  // set AND the stream produced no content / no tool_use, the error is
  // genuinely terminal: emit the human-readable carrier via onError and
  // route to a typed termination reason derived from the envelope's
  // kind. Producing content (text or tools) means recovery succeeded —
  // discard both withheld slots in that case (the error was benign).
  //
  // Phase 3 (upstream alignment): kind-driven classification replaces the
  // `classifyStreamError(string)` regex. The envelope is populated at
  // the provider catch boundary (Phase 2 via `onLoopSignal`), so by the
  // time we get here the classification is already typed.
  //
  // The string carrier `withheldStreamError` is preserved as the
  // user-visible message — when absent (PTL ref-set path where the
  // provider returned without calling onError), fall back to
  // `signal.rawMessage` so the consumer still sees a non-empty
  // diagnostic.
  // P2 — withheld-signal promotion extracted to ./stream/withheldSignalPromotion.
  // Returns `terminated` when the signal classified to a terminal reason
  // and the stream produced no content; in that case we still need to
  // weave the runStreamPhase-local mutable bag (streamMaxOutTokens / etc)
  // into the StreamOutput shape, so the wrap-up happens here.
  // 2026-06 multi-turn degradation fix (Symptom 3) — thinking blocks NO
  // LONGER count as "produced something". A thinking-only stream (no
  // text, no tool_use) used to suppress withheld-signal promotion here:
  // the model reasoned through the task in its chain-of-thought, the
  // provider reported refusal / rate-limit / stream error, and the
  // benign-discard branch swallowed it → handleNoToolsBranch saw an
  // empty accumulatedText → row 13 `completed` — a silent, output-less
  // turn the user perceives as "AI 思考完就停了/说完成了". Reasoning is
  // not user-visible output; only text or tool_use proves the recovery
  // actually produced a reply.
  const producedSomething =
    result.accumulatedText.trim().length > 0 ||
    result.toolUseBlocks.length > 0
  if (process.env.POLE_DEBUG_INTEGRATION) {
    console.log(
      `[POLE-DBG-PROD] iteration=${state.iteration} ` +
      `text=${result.accumulatedText.trim().length > 0 ? 'YES' : 'NO'}(${result.accumulatedText.trim().length}) ` +
      `tools=${result.toolUseBlocks.length} ` +
      `thinking=${result.thinkingBlocks.length} ` +
      `producedSomething=${producedSomething}`,
    )
  }
  const promotion = await promoteOrRecoverWithheldSignal(state, {
    iteration: state.iteration,
    iterationModel,
    streamMaxOutTokens,
    maxOutputRecoveryCycles,
    resultProducedSomething: producedSomething,
  })
  if (promotion.kind === 'terminated') {
    return {
      ...result,
      streamMaxOutTokens,
      iterationModel,
      maxOutputRecoveryCycles,
      totalUsage: state.totalUsage,
      lastStreamEndMs: result.lastStreamEndMs,
      useStreamingToolExecutor: false,
    }
  }

  return {
    ...result,
    streamMaxOutTokens,
    iterationModel,
    maxOutputRecoveryCycles,
    totalUsage: state.totalUsage,
    lastStreamEndMs: result.lastStreamEndMs,
  }
}
