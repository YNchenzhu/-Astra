/**
 * Teammate runner — main-process driver for in-process teammate sub-agents.
 *
 * Replaces the renderer-side `src/services/agent/runAgent.ts` shim that used
 * to call the Anthropic SDK directly with no compaction, no streaming, no
 * watchdog, no fallback model, no max-output recovery, no fork, no
 * stop-hooks. The renderer now invokes {@link runTeammateInMain} via IPC
 * (`ai:run-teammate`) and the teammate runs the SAME `runAgenticLoop` the
 * main chat does — meaning compaction, prompt cache, strip-retry, and every
 * other §1–§11 upstream parity layer is shared. No more two-implementations drift.
 *
 * Key differences vs. the main chat path (`streamHandler.handleSendMessage`):
 *   - Teammate streams flow on `ai:teammate-stream-event`, NOT `ai:stream-event`.
 *     Renderer subscribes by `runId` so multiple parallel teammates don't
 *     cross-contaminate their UI state.
 *   - Teammate has its own AbortController in {@link teammateRuns} so cancel
 *     never reaches into the active main chat's stream registry.
 *
 * Lifecycle:
 *
 *   1. Single-turn baseline — one `runAgenticLoop` pass against the user's
 *      original prompt, capped by `maxIterations` (default 20).
 *   2. **Team Active Loop (PR-3, opt-in via `POLE_TEAM_ACTIVE_LOOP=1`)** —
 *      when `teamName` + `leadAgentId` are provided AND the just-finished
 *      pass exited cleanly, the runner calls
 *      {@link tryClaimNextTask}: a pending task owned by this teammate
 *      (resume) or an unowned pending task (fresh) is flipped to
 *      `in_progress` and replayed as a synthetic next user turn so the
 *      teammate keeps working without a renderer round-trip. Capped at
 *      `DEFAULT_MAX_CONSECUTIVE_CLAIMS` (8) per run to prevent livelock.
 *   3. **Idle notifier (PR-2)** — on final exit, writes a
 *      `kind=idle_notification` envelope to the lead's mailbox (with
 *      `peerDmSummary` + `claimedTaskIds` metadata; field name reflects
 *      "tasks worked on this run", not "tasks completed" — see audit
 *      F-01 in `docs/plans/team-active-loop.md`) so the lead's next
 *      iteration can surface a `<team-inbox>` block. Failures are
 *      swallowed; the active-loop side effects never propagate up.
 *
 * Reference: see `docs/plans/team-active-loop.md` and `upstream-main`
 * `src/utils/swarm/inProcessRunner.ts:1317-1342` (idle trigger) +
 * `:595-652` (tryClaimNextTask).
 */

import { randomBytes } from 'node:crypto'
import {
  createInMemoryAgentLoopHost,
  runHostedAgentLoop,
} from '../orchestration/hostedAgentLoop'
import type { AgenticLoopParams } from '../ai/agenticLoopTypes'
import { getResourceQuotaManager } from '../orchestration/toolRuntime/quota'
import { recordToolResourceDelta } from '../orchestration/toolRuntime/state'
import { getToolUseIdFromStopScope } from '../ai/toolExecutionScope'
import { runWithAgentContextAsync, type AgentContext } from './agentContext'
import { asAgentId } from '../tools/ids'
import type { ProviderConfig } from '../ai/client'
import type { BrowserWindow } from 'electron'
import type { ToolResultEventPayload } from '../ai/runAgenticToolUse'
import { sendTeammateIdleNotification } from './teamIdleNotifier'
import { isTeamActiveLoopEnabled } from './teamActiveLoopFlag'
import {
  formatClaimPromptText,
  tryClaimNextTask,
  DEFAULT_MAX_CONSECUTIVE_CLAIMS,
} from './teamTaskAutoClaim'
import {
  shouldInjectIterationWindDown,
  buildIterationWindDownDirective,
} from './subAgentReadonlyBudget'
import {
  resolveFinalSummaryRescueBudgetMs,
  runSubAgentFinalSummaryRescue,
  shouldRunFinalSummaryRescue,
} from './subAgentFinalSummary'
import { subAgentProducedUsableReport } from './subAgentOutputResolver'
import { extractLastAssistantText } from './extractTranscriptText'

const TEAMMATE_STREAM_CHANNEL = 'ai:teammate-stream-event'
const DEFAULT_TEAMMATE_MAX_ITERATIONS = 20

export type TeammateRunParams = {
  /** Stable id per renderer task (so kill / progress survive restarts). */
  runId?: string
  prompt: string
  /** Provider config — fully resolved by the IPC handler before reaching us. */
  config: ProviderConfig
  model: string
  /**
   * System prompt; defaults to a minimal "helpful assistant" prompt so we
   * preserve the renderer-shim behaviour. Callers (e.g. Buddy / role-based
   * teammates) can override.
   */
  systemPrompt?: string
  /** Chat history to seed the run with (renderer's `task.messages`). */
  history?: Array<{ role: 'user' | 'assistant'; content: string | Array<Record<string, unknown>> }>
  /** Optional explicit agentId — defaults to `teammate-${runId}`. */
  agentId?: string
  /** Inherited renderer session id, for telemetry / sidechain transcripts. */
  parentSessionId?: string
  /** Cap on agentic-loop iterations (default 20). */
  maxIterations?: number
  /** Cap on per-iteration model output tokens (default 4096). */
  maxTokens?: number
  /** Provided so renderer can correlate which task this run belongs to. */
  taskId?: string
  /**
   * P0-2 follow-up: when true, the teammate boots in `plan` permission
   * mode (only read-only tools + ExitPlanMode), and `ExitPlanMode` is
   * routed for human approval through the renderer-teammate path
   * (`awaitChatLeaderPlanApproval`) instead of being self-approved by
   * the worker. Off by default — preserves the existing `planModeRequired:
   * false` behaviour where teammates run with full tool access.
   */
  planModeRequired?: boolean
  /**
   * P0-2 follow-up: when set, plan-approval requests from this teammate
   * are emitted into THIS chat conversation as `team_plan_approval_request`
   * stream events. Should be the renderer's `currentConversationId` at
   * spawn time — i.e. the chat the user spawned the teammate from.
   *
   * Required when {@link planModeRequired} is true; without it, ExitPlanMode
   * has nowhere to route approval and the worker hangs until timeout.
   */
  leaderConversationId?: string
  /**
   * Active-loop (PR-2): the TeamFile name this teammate belongs to. When
   * present together with {@link leadAgentId} and the
   * `POLE_TEAM_ACTIVE_LOOP` flag is on, the runner writes a
   * `kind=idle_notification` envelope to the lead's mailbox at the end of
   * the turn so the lead's next user-role attachment carries a
   * `<team-inbox>` block.
   *
   * Reference: upstream-main `src/utils/swarm/inProcessRunner.ts:1317-1342`.
   */
  teamName?: string
  /**
   * Active-loop (PR-2): the lead's stable id (mailbox addressee). Paired
   * with {@link teamName}; both must be present for idle notifications to
   * fire. The runner does NOT infer this — callers (renderer / IPC) own
   * the team identity binding.
   */
  leadAgentId?: string
  /**
   * Active-loop (PR-2): optional human name used as the sender attribution
   * on idle notifications (`from.agentType`). Falls back to `agentId` when
   * absent. Has no effect when the active-loop flag is off.
   */
  teammateName?: string
  /**
   * Active-loop (PR-2): optional sessionAgentType (e.g. `researcher`,
   * `coder`) for sender attribution. Has no effect when the active-loop
   * flag is off.
   */
  teammateAgentType?: string
}

type TeammateRunRecord = {
  runId: string
  abortController: AbortController
  agentId: string
}

/** Active teammate runs keyed by runId. */
const teammateRuns = new Map<string, TeammateRunRecord>()

let teammateWindow: BrowserWindow | null = null

export function setTeammateMainWindow(win: BrowserWindow | null): void {
  teammateWindow = win
}

/** Generate a runId — unprefixed by intent (the prefix lives in `createTaskId`). */
function generateRunId(): string {
  let n = 0n
  for (const b of randomBytes(8)) n = (n << 8n) | BigInt(b)
  return `tm-${n.toString(36)}`
}

function emitTeammateEvent(runId: string, event: TeammateStreamEvent): void {
  const win = teammateWindow
  if (!win || win.isDestroyed()) return
  win.webContents.send(TEAMMATE_STREAM_CHANNEL, { runId, ...event })
}

export type TeammateStreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | {
      type: 'tool_start'
      toolUse: { id: string; name: string; input: Record<string, unknown> }
    }
  | {
      type: 'tool_result'
      toolResult: ToolResultEventPayload
    }
  | { type: 'context_compact'; level: string }
  | { type: 'message_end'; usage?: { inputTokens: number; outputTokens: number } }
  | { type: 'done'; success: boolean; error?: string; usage?: { inputTokens: number; outputTokens: number } }
  | { type: 'error'; error: string }
  | { type: 'max_iterations_reached'; maxIterations: number }

/**
 * Run a single teammate sub-agent in the main process.
 *
 * Returns the runId immediately (after registering the AbortController) so
 * the renderer can later call {@link cancelTeammateRun}; the actual loop
 * runs as a background promise and reports completion via `done` event on
 * the teammate stream channel.
 */
export function runTeammateInMain(params: TeammateRunParams): {
  runId: string
  done: Promise<{
    success: boolean
    error?: string
    /**
     * Typed loop {@link import('../ai/queryTermination').TerminationReason}
     * captured via the agentic loop's `onTerminate` hook. Optional —
     * older callers can ignore it; new consumers can branch on the
     * 12-way discriminator (e.g. distinguish `prompt_too_long` from
     * `model_error` for retry policy).
     */
    terminationReason?: import('../ai/queryTermination').TerminationReason
  }>
} {
  const runId = (params.runId?.trim() || generateRunId())
  // P1-11: cancel any prior in-flight run that already owns this runId before
  // we replace its registry entry. Previously a re-issued runId silently
  // overwrote the old AbortController, leaving the original loop running
  // as a "ghost" with no way to abort it from the IPC layer.
  const prior = teammateRuns.get(runId)
  if (prior) {
    try {
      prior.abortController.abort()
    } catch {
      /* ignore — the loop's own teardown handles fallout */
    }
    console.warn(
      `[teammateRunner] runId "${runId}" reused; the prior AbortController has been signalled before being replaced.`,
    )
  }
  const abortController = new AbortController()
  const agentId = params.agentId?.trim() || `teammate-${runId}`
  teammateRuns.set(runId, { runId, abortController, agentId })

  // P0-2 follow-up: validate plan-approval delegation params. We REQUIRE a
  // leaderConversationId when the teammate is asked to run in plan mode —
  // otherwise ExitPlanMode would have nowhere to route approval and the
  // worker would idle for the full 10-minute timeout. Surface the error
  // immediately rather than silently demoting to a non-plan run; the
  // renderer's TeammatePanel checkbox would lie to the user.
  const planModeRequired = params.planModeRequired === true
  const leaderConversationId = params.leaderConversationId?.trim() || undefined
  if (planModeRequired && !leaderConversationId) {
    throw new Error(
      'runTeammateInMain: planModeRequired requires leaderConversationId — ' +
        'pass the renderer chat conversation id where the approval card should appear.',
    )
  }

  // Construct the AgentContext used by the agentic loop's ALS lookups.
  // `streamConversationId` is unique-per-run so prompt-cache break detector,
  // session-memory triggers, and conversation-display state don't collide
  // with the user's main chat.
  const ctx: AgentContext = {
    config: params.config,
    model: params.model,
    systemPrompt: params.systemPrompt || 'You are a helpful AI assistant.',
    messages: [],
    signal: abortController.signal,
    agentId: asAgentId(agentId),
    streamConversationId: `teammate:${runId}`,
    parentAgentId: undefined,
    // P0-2 follow-up — enforces plan-mode at the worker's tool gate
    // (subAgentToolResolver reads `permissionModeOverride` from the
    // ALS context) and tells `ExitPlanModeTool` where to route approval.
    ...(planModeRequired ? { permissionModeOverride: 'plan' as const } : {}),
    ...(leaderConversationId
      ? { planApprovalDelegateConversationId: leaderConversationId }
      : {}),
  }

  const userTurn = {
    role: 'user' as const,
    content: params.prompt,
  }
  const seededMessages = (params.history ?? []).concat([userTurn])

  const run = async (): Promise<{ success: boolean; error?: string; terminationReason?: import('../ai/queryTermination').TerminationReason }> => {
    let lastUsage: { inputTokens: number; outputTokens: number } | undefined
    // PR-3 active-loop: track tasks claimed this run so the idle notifier
    // can attach them as `claimedTaskIds` metadata (audit fix F-01:
    // previously misnamed `completedTaskIds` — the model may exit
    // without marking the task done, so "claimed" is the honest noun).
    // Cap consecutive claims at DEFAULT_MAX_CONSECUTIVE_CLAIMS (8) to
    // prevent livelock.
    const claimedTaskIds: string[] = []

    // Outer outcome — set after every loop iteration; final values are
    // what propagates to the caller and the idle notifier's `reason`.
    let success = false
    let resolvedError: string | undefined
    let lastTerminationReason:
      | import('../ai/queryTermination').TerminationReason
      | undefined

    // Per-iteration message buffer. The first iteration runs the user's
    // original prompt; subsequent iterations splice the post-loop
    // transcript (kept fresh by `syncAgentContextConversation`) and a
    // new user turn carrying the claimed task.
    let currentMessages: typeof seededMessages = seededMessages
    let claimAttempts = 0
    // Effective iteration cap for this run — drives BOTH the loop override and
    // the graceful iteration wind-down (mirrors the sub-agent path).
    const maxIterationsForRun = params.maxIterations ?? DEFAULT_TEAMMATE_MAX_ITERATIONS

    try {
      while (true) {
        // Per-round state — must reset every iteration, otherwise an
        // earlier `onError` would carry into the next round's success.
        let errorMsg: string | undefined
        // Audit fix (S0.2): track max-iterations as a structural state so the
        // run's `success` reflects truth — a teammate that exits via the
        // iteration cap is NOT a success (parent expected a real reply,
        // got a truncated mid-task report). upstream parity: their
        // `Terminal.reason === 'max_turns'` is observable; we mirror via
        // the existing `onMaxIterationsReached` callback.
        let reachedMaxIterations = false
        let maxIterationsLimit = 0
        // Output-aware success + wind-down bookkeeping (parity with the
        // sub-agent path). `outputText` accumulates streamed assistant text;
        // `lastFinalText` is the text of the terminating iteration when it made
        // NO tool call (the teammate's final deliverable); the per-iteration
        // tool count + output cursor let `onMessageEnd` isolate that final turn.
        // `windDownInjected` latches the one-shot iteration wind-down.
        let outputText = ''
        let lastFinalText = ''
        let iterationToolCount = 0
        let iterationStartOutputLen = 0
        let windDownInjected = false
        // Audit fix (S2.2): capture the typed loop terminationResult so the
        // teammate runner exposes the 12-way TerminationReason discriminator
        // instead of relying on stringified `errorMsg` + abort flag inference.
        // Symmetric with subAgentRunner's onTerminate capture.
        //
        // Ref-container shape: TypeScript flow analysis doesn't see writes
        // that happen inside the onTerminate closure, so `let x: T | null`
        // would narrow back to `null` at every outer use site.
        const terminationResultRef: {
          value: import('../ai/queryTermination').QueryTerminalResult | null
        } = { value: null }

        await runWithAgentContextAsync(ctx, async () => {
          const loopParams: AgenticLoopParams = {
              config: params.config,
              model: params.model,
              messages: currentMessages,
              systemPrompt: ctx.systemPrompt,
              signal: abortController.signal,
              enableTools: true,
              maxTokens: params.maxTokens ?? 4096,
              maxIterationsOverride: maxIterationsForRun,
              permissionDefaultMode: 'allow',
              diffPermissionMode: 'bypassPermissions',
              // Audit §3.2 wire-up — pre-iteration boundary check.
              // Teammates run without a kernel; this hook gives them the
              // same graceful early-exit behaviour drive mode gets inline.
              // If the abort signal fires between iterations the loop
              // exits with `iteration_boundary_stopped` instead of
              // pushing through to the next stream and bailing with
              // `aborted_streaming`.
              iterationBoundaryHook: async () => {
                if (abortController.signal.aborted) return { stop: true }
                return undefined
              },
            }
          await runHostedAgentLoop(
            createInMemoryAgentLoopHost(loopParams),
            loopParams,
            {
              // Iteration-limit graceful wind-down (parity with sub-agents).
              // Teammates are not read-only, so only the iteration trigger
              // applies. Firing a forced tool-free report turn as the cap
              // approaches makes the loop end `completed` (not `max_turns`),
              // so `reachedMaxIterations` stays false and the run is judged a
              // success — instead of being failed purely for hitting the cap.
              onQueryLoopPreModel: (info) => {
                iterationToolCount = 0
                iterationStartOutputLen = outputText.length
                if (
                  !windDownInjected &&
                  shouldInjectIterationWindDown({
                    iteration: info.iteration,
                    maxIterations: maxIterationsForRun,
                  })
                ) {
                  windDownInjected = true
                  const directive = buildIterationWindDownDirective({
                    iteration: info.iteration,
                    maxIterations: maxIterationsForRun,
                  })
                  return {
                    appendUserContent: directive.appendUserContent,
                    disableToolsForThisTurn: directive.disableToolsForThisTurn,
                  }
                }
                return undefined
              },
              onTextDelta: (text) => {
                outputText += text
                emitTeammateEvent(runId, { type: 'text_delta', text })
              },
              onThinkingDelta: (text) =>
                emitTeammateEvent(runId, { type: 'thinking_delta', text }),
              onToolStart: (toolUse) => {
                iterationToolCount++
                emitTeammateEvent(runId, { type: 'tool_start', toolUse })
              },
              onToolResult: (toolResult) =>
                emitTeammateEvent(runId, { type: 'tool_result', toolResult }),
              onMessageEnd: (usage) => {
                if (usage) lastUsage = usage
                // Terminating iteration with no tool call ⇒ the text emitted
                // this turn is the teammate's final deliverable.
                if (iterationToolCount === 0) {
                  const finalText = outputText.slice(iterationStartOutputLen).trim()
                  if (finalText) lastFinalText = finalText
                }
                emitTeammateEvent(runId, { type: 'message_end', usage })
                // Audit P0+ self-fix F-2 — teammate token usage now also
                // counts toward the global `maxTokenRatePerMinute` quota.
                // Before this hook only main-chat tokens were tracked.
                // Audit A-3 — also attribute per-tool to parent tool slot.
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
                    console.warn('[teammateRunner] quota.recordTokenUsage failed:', e)
                  }
                }
              },
              onError: (err) => {
                errorMsg = err
                emitTeammateEvent(runId, { type: 'error', error: err })
              },
              onContextCompact: (detail) =>
                emitTeammateEvent(runId, { type: 'context_compact', level: detail.level }),
              onMaxIterationsReached: (m) => {
                reachedMaxIterations = true
                maxIterationsLimit = m
                emitTeammateEvent(runId, { type: 'max_iterations_reached', maxIterations: m })
              },
            },
            {
              // Audit fix (S2.2): capture typed terminationResult for richer
              // outcome reporting (matches subAgentRunner's pattern).
              onTerminate: (r) => {
                terminationResultRef.value = r.terminationResult
              },
            },
          )
        })

        // ── Final-summary rescue (parity with the sub-agent path) ──
        // If the round hit the iteration cap WITHOUT ever producing a
        // tool-free final report, give the teammate ONE forced tool-free turn
        // to write it (streamed to the renderer like any other text). The
        // wind-down above prevents most max-iterations cases; this backstops a
        // single-turn overshoot. Skipped on a real abort (user cancel /
        // timeout) — `shouldRunFinalSummaryRescue` gates on `parentSignalAborted`
        // and the teammate's only signal IS the abort controller.
        const transcriptMessages = Array.isArray(ctx.messages)
          ? (ctx.messages as Array<Record<string, unknown>>)
          : []
        const transcriptLastAssistantText = extractLastAssistantText(transcriptMessages)
        const rescueBudgetMs = resolveFinalSummaryRescueBudgetMs()
        if (
          shouldRunFinalSummaryRescue({
            reachedMaxIterations,
            aborted: abortController.signal.aborted,
            lastFinalText,
            transcriptLastAssistantText,
            apiMessageCount: transcriptMessages.length,
            parentSignalAborted: abortController.signal.aborted,
            budgetMs: rescueBudgetMs,
          })
        ) {
          const rescueResult = await runWithAgentContextAsync(ctx, () =>
            runSubAgentFinalSummaryRescue({
              config: params.config,
              model: params.model,
              systemPrompt: ctx.systemPrompt,
              apiMessages: transcriptMessages.map((m) => ({ ...m })),
              reason: reachedMaxIterations ? 'max_iterations' : 'aborted',
              toolCallsMade: 0,
              parentSignal: abortController.signal,
              budgetMs: rescueBudgetMs,
              onTextDelta: (text) => {
                outputText += text
                emitTeammateEvent(runId, { type: 'text_delta', text })
              },
              onStreamUsage: (u) => {
                lastUsage = u
              },
            }),
          )
          if (rescueResult.text) lastFinalText = rescueResult.text
        }

        // P1-11: don't infer success purely from "no `onError` fired". An
        // abort or max-iterations exit reaches here without `errorMsg`; reflect
        // those terminal states in the result so `cancelTeammateRun` callers
        // see the truth instead of a fake `success:true`.
        let roundSuccess = !errorMsg
        let roundError = errorMsg
        if (roundSuccess && abortController.signal.aborted) {
          roundSuccess = false
          roundError = roundError ?? 'Teammate run aborted'
        }
        // Output-aware max-iterations rule (parity with sub-agents; supersedes
        // the older S0.2 "maxIter ⇒ always fail"). Hitting the cap is a failure
        // ONLY when the teammate produced no usable final report. If the
        // graceful wind-down or the rescue above delivered a report, the round
        // is a success despite reaching the cap — the parent got a real reply.
        const producedReport = subAgentProducedUsableReport({
          lastFinalText,
          transcriptLastAssistantText,
        })
        if (roundSuccess && reachedMaxIterations && !producedReport) {
          roundSuccess = false
          roundError =
            roundError ?? `Teammate run hit iteration limit (${maxIterationsLimit})`
        }
        success = roundSuccess
        resolvedError = roundError
        lastTerminationReason = terminationResultRef.value?.reason

        // PR-3 active-loop: if the round ended cleanly and we're in a
        // team context, try to claim the next task and re-enter the
        // loop with it as the new user turn. Cap at
        // DEFAULT_MAX_CONSECUTIVE_CLAIMS so a misbehaving task list
        // (e.g. owner perma-stuck on this teammate) can't livelock.
        if (!roundSuccess) break
        if (!isTeamActiveLoopEnabled()) break
        if (!params.teamName?.trim() || !params.leadAgentId?.trim()) break
        if (claimAttempts >= DEFAULT_MAX_CONSECUTIVE_CLAIMS) break
        if (abortController.signal.aborted) break

        const claim = tryClaimNextTask({
          teammateName: params.teammateName?.trim() || agentId,
          alreadyClaimedThisRun: claimAttempts,
        })
        if (!claim) break

        claimAttempts++
        claimedTaskIds.push(claim.taskId)

        // Rebuild messages: ctx.messages holds the post-loop transcript
        // (kept fresh by `syncAgentContextConversation`). Splicing the
        // claim prompt onto the tail mirrors how a follow-up user turn
        // arrives in the main chat path.
        const postLoop = Array.isArray(ctx.messages) ? ctx.messages : []
        currentMessages = [
          ...(postLoop as typeof seededMessages),
          { role: 'user' as const, content: formatClaimPromptText(claim) },
        ]
      }

      emitTeammateEvent(runId, { type: 'done', success, error: resolvedError, usage: lastUsage })
      return {
        success,
        error: resolvedError,
        ...(lastTerminationReason ? { terminationReason: lastTerminationReason } : {}),
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      emitTeammateEvent(runId, { type: 'error', error: message })
      emitTeammateEvent(runId, { type: 'done', success: false, error: message, usage: lastUsage })
      return {
        success: false,
        error: message,
        ...(lastTerminationReason ? { terminationReason: lastTerminationReason } : {}),
      }
    } finally {
      // Active-loop hook: write `idle_notification` to the lead's mailbox
      // after the teammate's last turn closes. Gated by env flag + team
      // identity; failures are swallowed (see teamIdleNotifier). The
      // transcript snapshot is read from the ALS context which
      // `syncAgentContextConversation` keeps in sync per turn. PR-3
      // additionally attaches `claimedTaskIds` (audit F-01: renamed from
      // the misleading `completedTaskIds`) so the lead's next
      // `<team-inbox>` block can highlight what this teammate worked on
      // — note these are claims, NOT proof of completion.
      if (
        isTeamActiveLoopEnabled() &&
        params.teamName?.trim() &&
        params.leadAgentId?.trim()
      ) {
        try {
          await sendTeammateIdleNotification({
            teammateAgentId: agentId,
            teammateName: params.teammateName,
            teammateAgentType: params.teammateAgentType,
            leadAgentId: params.leadAgentId.trim(),
            teamName: params.teamName.trim(),
            reason: claimedTaskIds.length > 0 ? 'no_more_tasks' : 'turn_complete',
            recentMessages: ctx.messages as Array<{ role: string; content: unknown }>,
            ...(claimedTaskIds.length > 0 ? { claimedTaskIds } : {}),
          })
        } catch (notifierErr) {
          // The notifier itself catches and returns; this guard exists
          // purely so any unexpected throw can't leak out of the runner.
          console.warn(
            '[teammateRunner] idle notifier raised unexpectedly:',
            notifierErr instanceof Error ? notifierErr.message : notifierErr,
          )
        }
      }
      teammateRuns.delete(runId)
    }
  }

  // Fire-and-track: return the in-flight promise so the caller can await it
  // if needed. We don't `void run()` because the IPC handler may want to
  // surface the final outcome.
  const done = run()
  return { runId, done }
}

/** Cancel an in-flight teammate run by id; returns true if a run was found. */
export function cancelTeammateRun(runId: string): boolean {
  const rec = teammateRuns.get(runId)
  if (!rec) return false
  rec.abortController.abort()
  return true
}

/** Cancel ALL in-flight teammate runs (used during workspace switch / shutdown). */
export function cancelAllTeammateRuns(): void {
  for (const rec of teammateRuns.values()) {
    rec.abortController.abort()
  }
  teammateRuns.clear()
}

/** Snapshot for diagnostics / tests. */
export function listActiveTeammateRunIds(): string[] {
  return [...teammateRuns.keys()]
}

/** Channel name re-export so the renderer-facing API can subscribe with a single source of truth. */
export const TEAMMATE_STREAM_EVENT_CHANNEL = TEAMMATE_STREAM_CHANNEL
