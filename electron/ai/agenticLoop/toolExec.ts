/**
 * Agentic loop — tool execution and result processing.
 * Extracted from agenticLoop.ts (§ build assistant content, § tool batch execution,
 * § skill discovery follow-up, § tool-use summary, § PTC shape guard).
 */


import { POLE_CONTEXT_USAGE_MESSAGE_KEY, getTokenCountFromUsage } from '../../context/tokenUsageAccounting'
import { buildToolUseAssistantContent } from '../agenticLoopBuilders'
import { buildDiscoveryQuery, buildSkillDiscoveryInjection } from '../../skills/skillDiscovery'
import { isSkillDiscoveryFollowUpEnabled } from '../../skills/discoveryBudget'
import { runAgenticToolUseBatch, type AgenticToolBatchCallbacks } from '../agenticToolBatch'
import {
  formatDeterministicToolLedgerForInjection,
  startToolUseSummaryInBackground,
  type ToolUseSummaryResult,
} from '../toolUseSummary'
import { yieldMissingToolResultBlocks } from '../queryTermination'
import type { StreamingToolExecutor } from '../streamingToolExecutor'
import { getAgentContext } from '../../agents/agentContext'
import { listCurrentReadIdHintsInCurrentScope } from '../../tools/readFileState'
import { takePendingHITL } from '../../orchestration/hitl'
import { getOrchestrationKernelForConversation } from '../../orchestration/activeKernelRegistry'
import {
  buildInterruptPhase,
  buildPermissionDeniedPhase,
  buildSchedulerBackpressurePhase,
  createTransportAdapter,
  emitPhaseEvent,
} from '../../orchestration/transport'
import { emitStreamEventForConversation } from '../interactionState'
import { resolveFallbackChatMode } from '../../orchestration/chatMode'
import { getToolScheduler, ToolPriority } from '../../orchestration/toolRuntime/scheduler'
import {
  getToolAdmissionCoordinator,
  type ToolInvocationLease,
} from '../../orchestration/toolRuntime/admission'
import { getPolicyEngine } from '../../orchestration/toolRuntime/policy'
import { getGlobalToolCallHistory } from '../../orchestration/toolRuntime/history'
import {
  getToolEntry,
  markToolAborted,
  markToolCompleted,
  markToolFailed,
} from '../../orchestration/toolRuntime/state'
import { toolRegistry } from '../../tools/registry'
import { asAgentId } from '../../tools/ids'
import { isAgenticWorkspaceFileMutationTool } from '../../tools/builtinToolAliases'
import {
  isInlineVerificationCommand,
  noteInlineVerification,
  noteWorkspaceMutation,
} from '../../planning/verificationGateState'
import { emitInnerPhase } from './innerPhaseEmit'
import type { LoopState, ToolExecInput, ToolExecOutput } from './loopShared'

export async function executeToolBatch(
  state: LoopState,
  input: ToolExecInput,
): Promise<ToolExecOutput> {
  const { accumulatedText, streamingToolExecutor, useStreamingToolExecutor } = input

  // Belt-and-suspenders dedup: DeepSeek's streaming transport can fire
  // onToolUse twice for the same ID (once during stream + once at flush).
  // This guard collapses duplicates so the content array never carries
  // the same tool_use id twice within a single assistant message.
  const seenIds = new Set<string>()
  const dedupedToolUses = state.toolUseBlocks.filter((tu) => {
    if (seenIds.has(tu.id)) {
      console.warn(`[ToolExec] Dropping duplicate tool_use id: ${tu.id} (${tu.name})`)
      return false
    }
    seenIds.add(tu.id)
    return true
  })

  // ── Build assistant message with tool_use blocks ──
  const poleUsageFields =
    state.lastStreamUsageForPole && getTokenCountFromUsage(state.lastStreamUsageForPole) > 0
      ? { [POLE_CONTEXT_USAGE_MESSAGE_KEY]: state.lastStreamUsageForPole }
      : {}

  const assistantContent = buildToolUseAssistantContent({
    thinkingBlocks: state.thinkingBlocks,
    accumulatedText,
    serverToolUseBlocks: state.serverToolUseBlocks,
    codeExecutionResultBlocks: state.codeExecutionResultBlocks,
    toolUseBlocks: dedupedToolUses,
  })

  state.apiMessages.push({
    role: 'assistant',
    content: assistantContent,
    ...poleUsageFields,
  })
  state.syncConversation()

  state.appendixReport('P2_Q_tools_partition_execute', {
    iteration: state.iteration,
    toolUseCount: dedupedToolUses.length,
    orchestrated: !!state.orchestratedToolExecution,
    streamingExecutor: !!streamingToolExecutor,
  })
  emitInnerPhase('RunToolBatch', state.iteration)

  // ── Execute tools ──
  let toolResults: Array<Record<string, unknown>>

  // `streamingToolExecutor` is typed as `unknown | null` in `LoopState` (the
  // shared loop types deliberately keep it opaque to avoid pulling the
  // executor type into the shared module).  Re-narrow once here so the
  // remaining usages in this branch are checked against the real shape.
  const streamingExec = streamingToolExecutor as StreamingToolExecutor | null

  if (streamingExec && useStreamingToolExecutor && !streamingExec.isEmpty()) {
    // StreamingToolExecutor path
    const streamingCtx = getAgentContext()
    const streamingAg = asAgentId(streamingCtx?.agentId ?? 'main')
    const streamingParent = streamingCtx?.parentAgentId
      ? asAgentId(streamingCtx.parentAgentId)
      : undefined
    const streamingScheduler = getToolScheduler()
    const streamingHistory = getGlobalToolCallHistory()
    // P1 (audit §5.1 wire-up) — register the streaming batch in the
    // ToolRuntimeState + scheduler + history-lineage maps BEFORE we start
    // draining results. PolicyEngine preflight (chat-mode / workspace
    // permission rules / default-mode / global rules) now runs per tool inside
    // `StreamingToolExecutor.executeToolUse` (audit fix SA-4 + chatMode wiring),
    // and emits `permission_denied_preflight` via `denyTool`. Plan/Ask turns
    // additionally take the orchestrated batch path entirely via
    // `shouldBypassStreamingExecutorForPolicy` (the executor stays empty). What
    // this branch surfaces to the cross-agent layer:
    //   - quota.snapshot()'s `activeShellChildren` / `activeMutationTools`
    //     etc. now see streaming tools
    //   - scheduler.cancelAgent / interruptTree cascades reach streaming tools
    //   - globalToolCallHistory.check sees streaming successes/failures so
    //     a sibling agent's repeated `npm install` failure (via streaming)
    //     is visible to a non-streaming agent's later attempt
    //   - per-tool `preemptController` is created so a higher-priority
    //     newcomer in any path can preempt a streaming tool's slot
    // addTool() already performed the unique RuntimeState + Scheduler
    // registration before execution began. Re-registering here would replace
    // the AbortController observed by the live tool and make preemption abort
    // the wrong signal.

    const results: Array<Record<string, unknown>> = []
    // P1-29: react to abort while draining streaming tool results. If the
    // user-signal aborts mid-batch, stop pulling new completions and
    // synthesize "interrupted" markers via the executor's own
    // `markInterrupted` + `getAbortedResults` plumbing instead of letting
    // them race against `yieldMissingToolResultBlocks`. The audit noted
    // those methods existed but had no consumer in the main loop.
    let aborted = false
    const onAbort = (): void => {
      aborted = true
      try {
        streamingExec.markInterrupted()
      } catch {
        /* non-fatal */
      }
    }
    if (state.signal.aborted) {
      onAbort()
    } else {
      state.signal.addEventListener('abort', onAbort, { once: true })
    }
    try {
      for await (const item of streamingExec.getRemainingResults()) {
        if (item.type === 'tool_result') results.push(item.data)
        if (aborted) break
      }
    } finally {
      state.signal.removeEventListener('abort', onAbort)
    }
    if (aborted) {
      const seenIds = new Set(
        results.map((r) => String((r as { tool_use_id?: string }).tool_use_id ?? '')).filter(Boolean),
      )
      for (const block of streamingExec.getAbortedResults()) {
        const id = String((block as { tool_use_id?: string }).tool_use_id ?? '')
        if (!id || seenIds.has(id)) continue
        results.push(block)
        seenIds.add(id)
      }
    }
    if (results.length < dedupedToolUses.length) {
      const completedIds = new Set(
        results.map((r) => String((r as { tool_use_id?: string }).tool_use_id ?? '')).filter(Boolean),
      )
      const missing = yieldMissingToolResultBlocks(dedupedToolUses, completedIds)
      results.push(...missing)
    }

    // P1 (audit §5.1) — record outcomes into ToolRuntimeState / scheduler /
    // globalToolCallHistory. Mirrors `DefaultToolRuntimePort`'s
    // `trackedCallbacks.onToolResult`. Errors swallowed: bookkeeping must
    // never break the loop.
    //
    // Failure heuristic is inlined (not via `toolResultBlockIndicatesFailure`
    // from `../agenticToolBatch`) to avoid expanding the mock surface that
    // the per-branch unit tests in `toolExec.test.ts` set up; semantics are
    // identical to that exported helper (`is_error: true` OR content starts
    // with "Error:").
    const toolUseById = new Map(dedupedToolUses.map((tu) => [tu.id, tu]))
    const streamingAgentType = streamingCtx?.sessionAgentType
    for (const block of results) {
      const tid = String((block as { tool_use_id?: string }).tool_use_id ?? '')
      if (!tid) continue
      const tu = toolUseById.get(tid)
      if (!tu) continue
      const content = (block as { content?: unknown }).content
      const isErrorMarker =
        (block as { is_error?: unknown }).is_error === true ||
        (typeof content === 'string' && content.trimStart().startsWith('Error:'))
      const errSummary =
        typeof content === 'string'
          ? content.slice(0, 200)
          : 'tool failed (streaming)'
      try {
        if (isErrorMarker) {
          markToolFailed(tid, errSummary)
          streamingScheduler.markFailed(tid)
        } else {
          markToolCompleted(tid)
          streamingScheduler.markCompleted(tid)
        }
      } catch (e) {
        console.warn('[toolExec.streaming] state/scheduler outcome threw:', e)
      }
      try {
        streamingHistory.record(tu.name, tu.input, {
          success: !isErrorMarker,
          ...(isErrorMarker ? { errorSummary: errSummary } : {}),
          agentId: streamingAg,
          ...(streamingParent ? { parentAgentId: streamingParent } : {}),
          ...(streamingAgentType ? { agentType: streamingAgentType } : {}),
        })
      } catch (e) {
        console.warn('[toolExec.streaming] history.record threw:', e)
      }
    }
    // Sweep: any registered entry that didn't reach a terminal state
    // (e.g. the synthesised `missing` block landed in `results` but the
    // map didn't have a tool_use_id, or aborted mid-stream and not all
    // ids matched). Mark aborted so quota frees up rather than waiting
    // 120s for the cleanup timer.
    for (const tu of dedupedToolUses) {
      const entry = getToolEntry(tu.id)
      if (!entry) continue
      if (
        entry.status === 'queued' ||
        entry.status === 'preparing' ||
        entry.status === 'running' ||
        entry.status === 'paused' ||
        entry.status === 'blocked'
      ) {
        try {
          markToolAborted(
            tu.id,
            aborted ? 'streaming batch aborted' : 'batch ended without result',
          )
          streamingScheduler.markFailed(tu.id)
        } catch (e) {
          console.warn('[toolExec.streaming] sweep threw:', e)
        }
      }
    }

    toolResults = results
  } else if (state.orchestratedToolExecution) {
    toolResults = (
      await state.orchestratedToolExecution.port.executeToolBatch({
        state: state.orchestratedToolExecution.getKernelState(),
        toolUses: dedupedToolUses.map((tu) => ({
          id: tu.id,
          name: tu.name,
          input: tu.input,
          ...(typeof tu.thoughtSignature === 'string' && tu.thoughtSignature.length > 0
            ? { thoughtSignature: tu.thoughtSignature }
            : {}),
        })),
        signal: state.signal,
        diffPermissionMode: state.diffPermissionMode as 'default' | 'bypassPermissions',
        permissionDefaultMode: state.permissionDefaultMode as 'allow' | 'ask' | 'deny',
        permissionRules: state.permissionRules,
        discoveryExclude: state.discoveryExclude,
        inlineSkillSession: {
          get: () => state.activeInlineSkillSession,
          set: (s) => { state.activeInlineSkillSession = s },
        },
        toolCallbacks: {
          onToolStart: state.callbacks.onToolStart,
          onToolResult: state.callbacks.onToolResult,
        },
        noteToolInvocation: state.orchestratedToolExecution.noteToolInvocation,
        ...(state.orchestratedToolExecution.resolveToolSignal
          ? { resolveToolSignal: state.orchestratedToolExecution.resolveToolSignal }
          : {}),
      })
    ).toolResultBlocks
  } else {
    // Fallback path — kernel didn't provide a `orchestratedToolExecution.port`
    // (e.g. teammate / hook-LLM / skill fork / bundle-handler / direct
    // sub-agent invocation). We still need the ToolRuntimeState + scheduler +
    // quota wire-in so this batch contributes to cross-agent visibility,
    // counts against global resource quotas, and gets cleaned up by
    // `unspawnAndUntrackAgent`. The wire-in mirrors `DefaultToolRuntimePort`
    // but is inlined here so we can keep passing `toolCallHistory`,
    // `appendixAFlow`, and `onLoopSignal` through to `runAgenticToolUseBatch`
    // — fallback callers depend on those features and the kernel port
    // currently doesn't surface them through its `executeToolBatch` signature.
    toolResults = await executeFallbackBatchWithWiring(state, dedupedToolUses)
  }

  // Gap A (silent-stop audit): record whether the WHOLE batch failed so the
  // no-tool branch on the next iteration can nudge instead of silently
  // routing a failed batch to a `completed` termination. A batch with at
  // least one success clears the flag. Empty batch leaves it false.
  const isErroredResult = (b: unknown): boolean => {
    const content = (b as { content?: unknown }).content
    return (
      (b as { is_error?: unknown }).is_error === true ||
      (typeof content === 'string' && content.trimStart().startsWith('Error:'))
    )
  }
  if (toolResults.length > 0) {
    state.lastToolBatchAllErrors = toolResults.every(isErroredResult)
  } else {
    state.lastToolBatchAllErrors = false
  }

  // Verification closed loop — when the MAIN chat lands at least one
  // SUCCESSFUL workspace file mutation in this batch, record that the
  // conversation now has unverified work. The `verification_gate` no-tool
  // guard (row 12d) reads this on a would-be `completed` and nudges the
  // model to run independent verification before claiming done. Main-chat
  // only: sub-agents have their own verification discipline and the parent
  // re-verifies their delivered work. See `planning/verificationGateState.ts`.
  if (toolResults.length > 0) {
    const ctxForMutation = getAgentContext()
    const convForMutation = ctxForMutation?.streamConversationId?.trim()
    const isMainChatMutation = !ctxForMutation?.agentId || ctxForMutation.agentId === 'main'
    if (convForMutation && isMainChatMutation) {
      const erroredIds = new Set(
        toolResults
          .filter(isErroredResult)
          .map((b) => (b as { tool_use_id?: unknown }).tool_use_id)
          .filter((id): id is string => typeof id === 'string'),
      )
      // Count successful mutation tool calls (not batches) so the gate's
      // threshold tracks edits the way the Verification agent means them:
      // one assistant message with `edit_file ×3` advances the count by 3.
      const successfulMutations = dedupedToolUses.filter(
        (tu) =>
          isAgenticWorkspaceFileMutationTool(tu.name) && !erroredIds.has(tu.id),
      ).length
      if (successfulMutations > 0) {
        try {
          noteWorkspaceMutation(convForMutation, successfulMutations)
        } catch (e) {
          console.warn('[toolExec] noteWorkspaceMutation threw:', e)
        }
      }

      // Inline verification recognition (verification-gate row 12d). A
      // SUCCESSFUL build / test / typecheck / lint command run by the MAIN
      // chat counts as the independent verification the gate asks for
      // (directive option (b)), so it clears the gate. Without this the gate
      // only ever cleared on a Verification *sub-agent* PASS verdict, and a
      // model that verified inline kept getting force-nudged to re-verify
      // AFTER it had already declared the work done. Runs AFTER the mutation
      // note above so an edit+verify-in-one-turn batch ends up cleared.
      const ranInlineVerification = dedupedToolUses.some((tu) => {
        if (erroredIds.has(tu.id)) return false
        if (!/^(?:bash|powershell|pwsh|power_shell|powershelltool)$/i.test(tu.name)) {
          return false
        }
        const cmd = (tu.input as { command?: unknown } | undefined)?.command
        return isInlineVerificationCommand(typeof cmd === 'string' ? cmd : undefined)
      })
      if (ranInlineVerification) {
        try {
          noteInlineVerification(convForMutation)
        } catch (e) {
          console.warn('[toolExec] noteInlineVerification threw:', e)
        }
      }
    }
  }

  // ── P2.1 follow-up: HITL pause detection ──
  // Any tool that threw `InterruptForHITL` will have recorded itself in the per-conversation
  // registry (see `runAgenticToolUse.ts`). Surface that pause now so the kernel can:
  //   1. emit an `interrupt` phase event tagged with `interruptReason: 'hitl'` carrying the
  //      question payload — renderers route this into the AskUserQuestion dialog;
  //   2. abort the kernel signal so the iteration exits without a follow-up model call.
  // The tool_use ↔ tool_result pairing is already preserved by the placeholder block the
  // batch synthesised, so the persisted transcript stays Anthropic-API-valid for resume.
  const conversationId = getAgentContext()?.streamConversationId
  const pendingHitl = takePendingHITL(conversationId)
  if (pendingHitl && conversationId) {
    const kernel = getOrchestrationKernelForConversation(conversationId)
    // Route both events through interactionState's main-process-wide sender
    // instead of `state.callbacks` (tool-batch callbacks do not expose
    // `onStreamEvent`). Otherwise the typed phase event and AskUserQuestion UX
    // bridge are silently dropped.
    const emitStream: (ev: import('../streamHandler').StreamEvent) => void = (ev) =>
      emitStreamEventForConversation(
        conversationId,
        ev as unknown as Record<string, unknown>,
      )
    const transport = createTransportAdapter(emitStream)
    // 1. Phase event — kernel-level signal for renderers that subscribe to phase
    //    transitions (P1.1 sink). Bug B fix — pass the HITL payload through the
    //    typed `hitlPending` field on `OrchestrationPhasePayload` so
    //    `buildPhaseStreamEvent` propagates it to the renderer. The legacy
    //    `_hitl` cast was silently dropped by the adapter.
    // P2 §6.3 migration — strict builder enforces hitlPending field shape.
    emitPhaseEvent(
      transport,
      buildInterruptPhase({
        iteration: state.iteration,
        innerIteration: state.iteration,
        conversationId,
        interruptReason: 'hitl',
        hitlPending: {
          toolUseId: pendingHitl.toolUseId,
          question: pendingHitl.question,
          kind: pendingHitl.kind,
        },
      }),
    )
    // 2. UX bridge — when the HITL came from `AskUserQuestion`, ALSO emit the standard
    //    `ask_user_question` StreamEvent the renderer already subscribes to. Using the
    //    `toolUseId` as `requestId` so the answer flow round-trips back through the
    //    standard `respondAskUserQuestion` IPC (which we extend below to fall back to
    //    `enqueueHumanResume` when no in-memory pending entry matches the requestId).
    //    Skipped for `permission_ask`: that path already has its own renderer UI and
    //    answering via AskUserQuestion's dialog would render the wrong shape.
    if (pendingHitl.kind === 'ask_user_question') {
      const q = pendingHitl.question as {
        questions?: unknown
        metadata?: { source?: string }
      }
      if (q && q.questions) {
        try {
          emitStream({
            type: 'ask_user_question',
            requestId: pendingHitl.toolUseId,
            questions: q.questions,
            ...(q.metadata ? { metadata: q.metadata } : {}),
            // Marker so the renderer can distinguish HITL-resumed dialogs from
            // legacy in-memory promise-backed ones (e.g. show a "will survive restart"
            // badge). Renderers that don't read it are unaffected.
            _hitlResumable: true,
          } as unknown as import('../streamHandler').StreamEvent)
        } catch (e) {
          console.warn('[toolExec] ask_user_question emit threw:', e)
        }
      }
    }
    if (kernel) {
      try {
        kernel.interrupt('hitl' as Parameters<typeof kernel.interrupt>[0])
      } catch (e) {
        console.warn('[toolExec] kernel.interrupt(hitl) failed:', e)
      }
    }
  }

  // ── Audit Bug 3 / Bug 6: post-execution abort guard ──
  // If the user aborted while tools were running, the orchestrator will
  // terminate the loop on the next iteration boundary. Don't pay for skill
  // discovery, the PTC shape guard, or — most importantly — the
  // `startToolUseSummaryInBackground` HTTP request whose result will never
  // be awaited (resource leak). We still pair the assistant tool_use blocks
  // with a tool_result user message so the persisted transcript is API-valid
  // for any future resume.
  const shouldAttachReadIdMap = dedupedToolUses.some((toolUse) =>
    ['read_file', 'edit_file', 'multi_edit_file', 'write_file'].includes(
      toolUse.name.trim().toLowerCase(),
    ),
  )
  const deterministicLedger = formatDeterministicToolLedgerForInjection({
    toolUseBlocks: dedupedToolUses.map((tu) => ({
      id: tu.id,
      name: tu.name,
      input: tu.input,
    })),
    toolResults,
    readReceiptHints: shouldAttachReadIdMap
      ? listCurrentReadIdHintsInCurrentScope(6)
      : undefined,
  })

  if (state.signal.aborted) {
    state.apiMessages.push({
      role: 'user',
      content: deterministicLedger
        ? [...toolResults, { type: 'text', text: deterministicLedger }]
        : [...toolResults],
    })
    state.syncConversation()
    state.appendixReport('P2_Q_tool_results_user_message', {
      iteration: state.iteration,
      toolResultBlockCount: toolResults.length,
      followUpDiscovery: false,
    })
    return {
      toolResults,
      apiMessages: state.apiMessages,
      activeInlineSkillSession: state.activeInlineSkillSession,
      discoveryExclude: state.discoveryExclude,
      pendingToolUseSummary: null,
    }
  }

  // ── Skill discovery follow-up ──
  // Audit fix S-5 (2026-05) — gate this with the same kind of env flag
  // as the turn-1 prefetch. Default still ON to preserve current
  // behaviour; operators who want zero auto-discovery can disable it
  // (the explicit `DiscoverSkills` tool remains available either way).
  const followUpEnabled = isSkillDiscoveryFollowUpEnabled()
  const toolResultTexts = toolResults.map((tr) => {
    const c = (tr as { content?: unknown }).content
    return typeof c === 'string' ? c : ''
  })
  const discoveryQuery = followUpEnabled
    ? buildDiscoveryQuery(state.apiMessages, {
        assistantText: accumulatedText,
        toolResultTexts,
      })
    : ''
  const { injection: followUpDiscovery, surfacedNames: followUpSurfaced } =
    followUpEnabled
      ? buildSkillDiscoveryInjection(discoveryQuery, { excludeNames: state.discoveryExclude })
      : { injection: '', surfacedNames: [] as string[] }
  for (const n of followUpSurfaced) state.discoveryExclude.add(n)

  // ── PTC shape guard ──
  const batchHasPtcToolUse = dedupedToolUses.some(
    (t) => t.caller && t.caller.type === 'code_execution_20260120',
  )

  const toolResultUserContent: Array<Record<string, unknown>> = [...toolResults]
  if (deterministicLedger) {
    toolResultUserContent.push({ type: 'text', text: deterministicLedger })
  }
  if (followUpDiscovery && !batchHasPtcToolUse) {
    toolResultUserContent.push({ type: 'text', text: followUpDiscovery })
  }

  state.apiMessages.push({ role: 'user', content: toolResultUserContent })

  if (followUpDiscovery && batchHasPtcToolUse) {
    state.apiMessages.push({ role: 'user', content: [{ type: 'text', text: followUpDiscovery }] })
  }

  state.syncConversation()
  state.appendixReport('P2_Q_tool_results_user_message', {
    iteration: state.iteration,
    toolResultBlockCount: toolResults.length,
    followUpDiscovery: Boolean(followUpDiscovery),
  })
  emitInnerPhase('ApplyToolResults', state.iteration)

  // ── Tool-use summary (fire-and-forget) ──
  //
  // 2026-06 long-run hallucination fix — default flipped OFF (opt-in via
  // `POLE_TOOL_USE_SUMMARY=1`). The haiku recap was injected into the
  // model context as a `<system-reminder>` user message whose label is
  // an explicitly PAST-TENSE completion claim ("Fixed X", "Created Y").
  // Over long multi-turn runs these host-authored completion sentences
  // accumulate (one per tool batch) and out-weigh the system prompt's
  // anti-action-hallucination rule, priming the model to emit its own
  // "全部修正完毕"-style completion text BEFORE invoking the tools.
  // upstream never shows this summary to the model (UI-only), and the
  // deterministic tool-batch ledger already covers the "don't repeat
  // successful actions" recall need — so dropping the injection loses
  // nothing factual.
  let pendingToolUseSummary: Promise<ToolUseSummaryResult | null> | null = null
  if (process.env.POLE_TOOL_USE_SUMMARY === '1' && dedupedToolUses.length > 0) {
    const resultsById = new Map<string, Record<string, unknown>>()
    for (const r of toolResults) {
      const id = (r as { tool_use_id?: string }).tool_use_id
      if (typeof id === 'string' && id.length > 0) resultsById.set(id, r)
    }
    const alignedResults = dedupedToolUses.map((tu, idx) =>
      resultsById.get(tu.id) ?? toolResults[idx] ?? {
        type: 'tool_result',
        tool_use_id: tu.id,
        content: '(no result captured)',
      },
    )
    pendingToolUseSummary = startToolUseSummaryInBackground({
      config: state.config,
      model: state.iterationModel,
      toolUseBlocks: dedupedToolUses.map((tu) => ({ name: tu.name, input: tu.input })),
      toolResults: alignedResults,
      signal: state.signal,
    })
  }

  return {
    toolResults,
    apiMessages: state.apiMessages,
    activeInlineSkillSession: state.activeInlineSkillSession,
    discoveryExclude: state.discoveryExclude,
    pendingToolUseSummary,
  }
}

/**
 * Wire-in helper for the fallback batch path — used when the agentic loop
 * runs WITHOUT a kernel-provided `orchestratedToolExecution.port` (teammate,
 * hook LLM, skill fork, bundle-handler test runs, and most sub-agent
 * invocations). Mirrors what `DefaultToolRuntimePort.executeToolBatch` does
 * for the kernel path but inlined so we can pass `toolCallHistory`,
 * `appendixAFlow`, and `onLoopSignal` through (the kernel port doesn't
 * surface those today, and fallback callers depend on them).
 *
 * Responsibilities:
 *   1. Register every tool in {@link ToolRuntimeState} so `quota.snapshot()`
 *      and `abortAllToolsForAgent` / `unspawnAndUntrackAgent` see them.
 *   2. Enqueue the batch into {@link ToolScheduler} so `cancelAgent`,
 *      cross-agent visibility, and the DAG node state cover this path.
 *   3. Apply `quota.admit()` per tool; synthesize a denial tool_result for
 *      rejected tools (same shape as `DefaultToolRuntimePort` denials).
 *   4. Wrap the loop callbacks so `onToolStart` → `markToolRunning` and
 *      `onToolResult` → `markCompleted`/`markFailed` (state + scheduler).
 *   5. Sweep on exit: any tool that didn't reach a terminal state is marked
 *      aborted in both state and scheduler so neither leaks 'running'/'ready'
 *      entries until the 120s cleanup timer.
 *
 * The returned `toolResults` preserves the original `toolUses` order so the
 * caller-side merging in `executeToolBatch` stays the same.
 */
async function executeFallbackBatchWithWiring(
  state: LoopState,
  dedupedToolUses: LoopState['toolUseBlocks'],
): Promise<Array<Record<string, unknown>>> {
  const ctx = getAgentContext()
  const ag = asAgentId(ctx?.agentId ?? 'main')
  const parent = ctx?.parentAgentId ? asAgentId(ctx.parentAgentId) : undefined
  const convId = ctx?.streamConversationId?.trim() || undefined

  // P1-2 (audit Bug-1 fix) — mirror DefaultToolRuntimePort's priority
  // threading on the fallback path so sub-agents that don't have a
  // kernel-provided `orchestratedToolExecution.port` (legacy teammate /
  // hook-LLM / skill-fork / bundle-handler / session-memory-internal
  // / dream) still get their declared `AgentContext.priority` (set from
  // `AgentDefinition.defaultPriority` in subAgentRunner) honored by
  // `quota.admit`'s preemption hunt and by `scheduler.enqueueBatch`.
  //
  // Without this threading, a `BACKGROUND` sub-agent (e.g. session-memory-
  // internal) goes through fallback and lands at NORMAL — `quota.admit`'s
  // findPreemptionVictim never picks it as a victim for a main-chat
  // HIGH-priority newcomer, and the cross-agent priority guarantees the
  // INVARIANTS.md claims fail in practice.
  const effectivePriority: number = (() => {
    const declared = ctx?.priority
    if (typeof declared === 'number') return declared
    return ag === ('main' as typeof ag) ? ToolPriority.HIGH : ToolPriority.NORMAL
  })()
  const isPreemptible = effectivePriority < ToolPriority.HIGH

  const leases = new Map<string, ToolInvocationLease>()

  // Denial map shared by every pre-flight pass below.
  const fallbackDenied = new Map<string, string>()
  const fallbackDeniedMatches = new Map<string, string>()

  // Phase-event sink for `permission_denied_preflight` — mirrors
  // `DefaultToolRuntimePort` so the renderer surfaces fallback-path denials
  // (sub-agent, teammate, skill-fork) the same way it surfaces orchestrated
  // main-chat denials. Falls back to noop when the caller didn't wire one.
  const onStreamEventRaw =
    (state.callbacks as { onStreamEvent?: (ev: unknown) => void }).onStreamEvent
  const transport =
    typeof onStreamEventRaw === 'function'
      ? createTransportAdapter(onStreamEventRaw)
      : null

  const emitDenial = (
    toolName: string,
    toolUseId: string,
    reason: string,
    matchedRule: string,
  ): void => {
    if (!transport) return
    try {
      // P2 §6.3 migration — strict builder.
      // iteration=0 sentinel: mirrors `DefaultToolRuntimePort`. Emitted
      // during preflight, before any phase boundary; renderer groups
      // by `permissionDenial.toolUseId`.
      emitPhaseEvent(
        transport,
        buildPermissionDeniedPhase({
          iteration: 0,
          ...(convId ? { conversationId: convId } : {}),
          permissionDenial: {
            toolName,
            toolUseId,
            reason,
            matchedRule,
          },
        }),
      )
    } catch (e) {
      console.warn('[toolExec.fallback] emit permission_denied_preflight threw:', e)
    }
  }

  const markDenied = (
    toolUseId: string,
    reasonText: string,
    matchedRule: string,
  ): void => {
    fallbackDenied.set(toolUseId, reasonText)
    fallbackDeniedMatches.set(toolUseId, matchedRule)
  }

  // 2.5a. PolicyEngine preflight — closes the audit gap where the fallback
  // path (sub-agent / teammate / skill-fork / bundle-handler) skipped
  // chat-mode, workspace-permission-rule, agent allowlist/denylist, and
  // global-rule enforcement that `DefaultToolRuntimePort` runs through
  // `createPolicyEnginePermissionPort`. The engine's quota/history checks
  // are read-only snapshots (`quota.ts:128-176`, `history.ts:check`) so the
  // additional pass introduces no double-charging — it mirrors the same
  // double-admission shape `port.ts` already has.
  //
  // P1-5 (security) — plumb chatMode into the fallback preflight so the
  // sub-agent / teammate / skill-fork path enforces plan mode the same way
  // the orchestrated main-chat PEP does.
  //
  // Why this closes a real gap: `subAgentToolResolver` only INJECTS
  // `ExitPlanMode` for plan-mode sub-agents — it does NOT strip mutating
  // tools. So PolicyEngine is the sole enforcement point for "no mutations
  // in plan mode", exactly as it is for the main agent (the kernel wires
  // `getChatMode` into `createPolicyEnginePermissionPort`). Without this the
  // fallback path let a plan-mode sub-agent write/edit/run freely.
  //
  // Resolution is the sub-agent's ALS-bound `permissionModeOverride` — the
  // HIGHEST-precedence signal in `isPlanModeForSubAgent` (subAgentToolResolver),
  // captured at spawn by `resolveSubAgentPermissionOverride` (parent's plan
  // mode flows in via `bubble` / `default`+`inherit`). Reading the override
  // directly (not `getPermissionMode()`):
  //   - is worker-thread safe (AgentContext is ALS-bound in the sub-agent
  //     worker; the per-conversation permission Map is main-process only), and
  //   - is precise: internal forks (session-memory-internal / dream) that
  //     capture `dontAsk` / `bypassPermissions` at spawn are NOT swept into
  //     plan-blocking just because the parent conversation is in plan mode,
  //     so their sandboxed writes keep working.
  // Only `'plan'` maps to a blocking chatMode; 'ask' is enforced upstream by
  // disabling tools, not by this gate. Mapping lives in `resolveFallbackChatMode`
  // (chatMode.ts) so the parity contract is unit-testable in one place.
  const fallbackChatMode = resolveFallbackChatMode(ctx?.permissionModeOverride)
  const policyEngine = getPolicyEngine()
  for (const tu of dedupedToolUses) {
    let decision
    try {
      decision = policyEngine.evaluate({
        toolName: tu.name,
        toolInput: tu.input,
        toolUseId: tu.id,
        context: {
          agentId: ag,
          ...(parent ? { parentAgentId: parent } : {}),
          ...(convId ? { conversationId: convId } : {}),
          ...(fallbackChatMode ? { chatMode: fallbackChatMode } : {}),
          ...(state.permissionRules ? { permissionRules: state.permissionRules } : {}),
          ...(state.permissionDefaultMode
            ? { permissionDefaultMode: state.permissionDefaultMode }
            : {}),
        },
        isReadOnly: toolRegistry.get(tu.name)?.isReadOnly ?? false,
        // Audit SA-1 (P0) — was hardcoded NORMAL, which dropped the declared
        // AgentContext.priority computed into `effectivePriority` above and
        // broke the cross-agent priority guarantees (a BACKGROUND sub-agent
        // evaluated as NORMAL was never picked as a preemption victim).
        priority: effectivePriority,
        // Audit SA-1 (P1) — same shape as the orchestrated preflight
        // (`policyEnginePermissionPort`): the AUTHORITATIVE quota admission
        // runs in pass 3 below (with backpressure wait, mirroring
        // `DefaultToolRuntimePort` Phase 8). Without skipQuota the engine's
        // inline quota check instant-denies before the backpressure loop is
        // ever reached, keeping the fallback/main asymmetry.
        skipQuota: true,
      })
    } catch (e) {
      // Fail-closed by default (matches `policyEnginePermissionPort`).
      if (process.env.POLE_PREFLIGHT_FAIL_OPEN === '1') {
        console.warn('[toolExec.fallback] policyEngine.evaluate threw (fail-open):', e)
        continue
      }
      const reasonText = `Policy engine evaluation failed: ${e instanceof Error ? e.message : String(e)}`
      console.warn('[toolExec.fallback] policyEngine.evaluate threw (fail-closed):', e)
      markDenied(tu.id, reasonText, 'policyEngine:engine-error')
      emitDenial(tu.name, tu.id, reasonText, 'policyEngine:engine-error')
      continue
    }
    if (!decision.allowed) {
      const reasonText = decision.reason?.trim() || 'Denied by policy engine.'
      const matched =
        decision.matchedRules && decision.matchedRules.length > 0
          ? decision.matchedRules.join(',')
          : 'policyEngine'
      markDenied(tu.id, reasonText, matched)
      emitDenial(tu.name, tu.id, reasonText, matched)
    }
  }

  // 2.5b. Cross-agent global history — keep parity with `port.ts:218-238`.
  // PolicyEngine.evaluate already runs `history.check` (block level), but
  // hint-level advisories are not propagated by `evaluate`. Surface them
  // here so the operator console sees the same warn that the orchestrated
  // path produces.
  const history = getGlobalToolCallHistory()
  for (const tu of dedupedToolUses) {
    if (fallbackDenied.has(tu.id)) continue
    let advice
    try {
      // Audit fix H4 — pass caller's agent id so sibling agents'
      // failures don't bubble in as hints on the fallback path either.
      // `ag` was already resolved at the top of this function from
      // `getAgentContext()?.agentId`.
      advice = history.check(tu.name, tu.input, {
        callerAgentId: ag,
        // Audit fix H-1 — conversation-scope (parity with the orchestrated
        // Phase-7 check and PolicyEngine.evaluate's internal check above).
        ...(convId ? { conversationId: convId } : {}),
      })
    } catch (e) {
      console.warn('[toolExec.fallback] history.check threw:', e)
      continue
    }
    if (advice.level === 'block') {
      // PolicyEngine.evaluate should already have caught this, but if it
      // didn't (e.g. a future evaluate refactor disables history), defence
      // in depth.
      markDenied(
        tu.id,
        advice.message,
        `global_history:${advice.previousFailures}_failures`,
      )
      emitDenial(
        tu.name,
        tu.id,
        advice.message,
        `global_history:${advice.previousFailures}_failures`,
      )
    } else if (advice.level === 'hint') {
      console.warn(`[ToolRuntime] ${tu.name} advisory: ${advice.message}`)
    }
  }

  // Unique RuntimeState + Scheduler admission starts only after policy and
  // cross-agent history allow the invocation.
  for (const tu of dedupedToolUses) {
    if (fallbackDenied.has(tu.id)) continue
    const isReadOnly = toolRegistry.get(tu.name)?.isReadOnly ?? false
    const admission = await getToolAdmissionCoordinator().acquire({
        toolUseId: tu.id,
        toolName: tu.name,
        agentId: ag,
        ...(parent ? { parentAgentId: parent } : {}),
        ...(convId ? { conversationId: convId } : {}),
        input: tu.input,
        isReadOnly,
        priority: effectivePriority,
        preemptible: isPreemptible,
        signal: state.signal,
        quotaMode: 'wait',
        logTag: 'toolExec.fallback',
        onBackpressure: (event) => {
          if (!transport) return
          emitPhaseEvent(
            transport,
            buildSchedulerBackpressurePhase({
              iteration: 0,
              ...(convId ? { conversationId: convId } : {}),
              schedulerBackpressure: {
                toolName: tu.name,
                toolUseId: tu.id,
                kind: event.kind,
                ...(event.reason ? { reason: event.reason } : {}),
                ...(typeof event.waitedMs === 'number'
                  ? { waitedMs: event.waitedMs }
                  : {}),
              },
            }),
          )
        },
      })
    if (admission.admitted) {
      leases.set(tu.id, admission.lease)
    } else {
      const matchedRule = admission.ruleId ?? 'tool_admission'
      markDenied(tu.id, admission.reason, matchedRule)
      emitDenial(tu.name, tu.id, admission.reason, matchedRule)
    }
  }

  // 3. Quota admission per tool. Denied entries get a synthesized error
  // tool_result without executing.
  const allowed = dedupedToolUses.filter((tu) => !fallbackDenied.has(tu.id))

  // Audit GAP-5 / BUG-5 — per-tool metadata for the global-history record in
  // the wrapped result callback below. The fallback path historically did NOT
  // write tool outcomes to `GlobalToolCallHistory`, so sub-agent / teammate
  // results never populated the cross-agent anti-repeat cache (only the
  // kernel path did, via its own callback). Build an id → {name,input} map so
  // the result callback can record with the same shape the kernel uses.
  const fallbackToolMetaById = new Map<string, { name: string; input: Record<string, unknown> }>(
    dedupedToolUses.map((tu) => [
      tu.id,
      { name: tu.name, input: (tu.input ?? {}) as Record<string, unknown> },
    ]),
  )

  // 4. Wrapped callbacks for state + scheduler sync.
  const wrappedCallbacks: AgenticToolBatchCallbacks = {
    onToolStart: (tu) => {
      try {
        leases.get(tu.id)?.start()
      } catch (e) {
        console.warn('[toolExec.fallback] lease.start threw:', e)
      }
      try {
        state.callbacks.onToolStart(tu)
      } catch (e) {
        console.warn('[toolExec.fallback] onToolStart delegate threw:', e)
      }
    },
    onToolResult: (r) => {
      try {
        leases.get(r.id)?.finish(r.success ? 'completed' : 'failed', r.error)
      } catch (e) {
        console.warn('[toolExec.fallback] lease.finish threw:', e)
      }
      // Audit GAP-5 / BUG-5 — record the outcome in the cross-agent history
      // so a sibling/sub-agent's repeated failing call can be hinted/blocked.
      try {
        const meta = fallbackToolMetaById.get(r.id)
        if (meta) {
          getGlobalToolCallHistory().record(meta.name, meta.input, {
            success: r.success,
            ...(r.success ? {} : { errorSummary: r.error ?? 'tool failed' }),
            agentId: ag,
            // Audit fix H-1 — record under conversation scope so the
            // matching scoped `check` finds it within this conversation only.
            ...(convId ? { conversationId: convId } : {}),
          })
        }
      } catch (e) {
        console.warn('[toolExec.fallback] history.record threw:', e)
      }
      try {
        state.callbacks.onToolResult(r)
      } catch (e) {
        console.warn('[toolExec.fallback] onToolResult delegate threw:', e)
      }
    },
    // Note: `onLoopSignal` is part of `AgenticToolBatchCallbacks` but NOT
    // of `AgenticLoopCallbacks`, so there's nothing to forward from
    // `state.callbacks` here — parity with the legacy direct call shape
    // (`callbacks: state.callbacks`) which only honoured onToolStart/onToolResult.
  }

  // 5. Execute (with finally-sweep cleanup).
  let executedBlocks: Array<Record<string, unknown>> = []
  try {
    executedBlocks =
      allowed.length > 0
        ? await runAgenticToolUseBatch({
            toolUseBlocks: allowed,
            signal: state.signal,
            beforeToolStart: async (toolUse) => {
              await leases.get(toolUse.id)?.waitUntilGranted()
            },
            resolveToolSignal: (_toolName, _input, toolUseId) =>
              toolUseId ? leases.get(toolUseId)?.effectiveSignal : state.signal,
            callbacks: wrappedCallbacks,
            diffPermissionMode: state.diffPermissionMode as 'default' | 'bypassPermissions',
            permissionDefaultMode: state.permissionDefaultMode as 'allow' | 'ask' | 'deny',
            permissionRules: state.permissionRules,
            discoveryExclude: state.discoveryExclude,
            getInlineSkillSession: () => state.activeInlineSkillSession,
            setInlineSkillSession: (s) => { state.activeInlineSkillSession = s },
            appendixAFlow: state.appendAppendixAFlow,
            toolCallHistory: state.toolCallHistory,
          })
        : []
  } finally {
    for (const tu of allowed) {
      const entry = getToolEntry(tu.id)
      if (!entry) continue
      if (
        entry.status === 'queued' ||
        entry.status === 'preparing' ||
        entry.status === 'running' ||
        entry.status === 'paused' ||
        entry.status === 'blocked'
      ) {
        try {
          leases.get(tu.id)?.finish(
            'aborted',
            state.signal.aborted ? 'signal aborted' : 'batch ended without result',
          )
        } catch (e) {
          console.warn('[toolExec.fallback] sweep lease.finish threw:', e)
        }
      }
    }
  }

  // Merge denied + executed preserving original toolUses order (mirror port.ts).
  if (fallbackDenied.size === 0) return executedBlocks

  const mergedById = new Map<string, Record<string, unknown>>()
  for (const [toolUseId, reasonText] of fallbackDenied) {
    const matched = fallbackDeniedMatches.get(toolUseId)
    mergedById.set(toolUseId, {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: `Error: ${reasonText}${matched ? ` (matched: ${matched})` : ''}`,
      is_error: true,
    })
    // Fire `onToolResult` for denied tools so the renderer's per-tool
    // result handler observes the failure, mirroring `port.ts:352-360`.
    // Previously fallback silently skipped this — the renderer only saw
    // the `tool_use` block on the next assistant message but no matching
    // `tool_result` callback, which left UI badges in 'pending' state.
    const tu = dedupedToolUses.find((x) => x.id === toolUseId)
    if (tu) {
      try {
        state.callbacks.onToolResult?.({
          id: tu.id,
          name: tu.name,
          success: false,
          error: reasonText,
        })
      } catch (e) {
        console.warn('[toolExec.fallback] onToolResult (denied) threw:', e)
      }
    }
  }
  for (const b of executedBlocks) {
    const id = String((b as { tool_use_id?: string }).tool_use_id ?? '')
    if (id) mergedById.set(id, b)
  }
  const ordered: Array<Record<string, unknown>> = []
  for (const tu of dedupedToolUses) {
    const b = mergedById.get(tu.id)
    if (b) ordered.push(b)
  }
  // Defensive: include any blocks without matching ids (shouldn't normally happen).
  for (const b of executedBlocks) {
    const id = String((b as { tool_use_id?: string }).tool_use_id ?? '')
    if (!id || !dedupedToolUses.some((tu) => tu.id === id)) {
      ordered.push(b)
    }
  }
  return ordered
}
