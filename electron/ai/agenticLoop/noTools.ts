/**
 * Agentic loop — no-tool-use termination branch.
 *
 * Extracted from agenticLoop.ts (§ toolUseBlocks.length === 0 path).
 *
 * P1 (2026-05) — the procedural if/else chain in this function was
 * rewritten as a "collect signals → call `decideIterationOutcome` →
 * apply side effects" pipeline. The behavioural decision now lives in
 * the pure function `decideIterationOutcome` (iterationDecision.ts);
 * this file owns only the I/O — running stop hooks, mutating
 * apiMessages, firing callbacks, computing the circuit-breaker counter.
 *
 * Migration note: the 4 decision branches in the legacy code
 * (`forceStop` / `blockingError` / `preventStop` / `tokenBudget`) all
 * map 1:1 to rows 7-13 of the priority table at the top of
 * `iterationDecision.ts`. Any future row addition (e.g. a new hook
 * kind) needs ONLY a table-row update, not a re-walk of the if/else
 * chain.
 */

import { getAgentContext } from '../../agents/agentContext'
import { getWorkspacePath } from '../../tools/workspaceState'
import { getIterationStallGuard } from '../../orchestration/iterationStallGuard'
import { emitInnerPhase } from './innerPhaseEmit'
import { runStopHooks, runSubagentStopHooks, preventStopContinuationContent } from '../../tools/hooks/engine'
import type { StopFamilyHookOutcome } from '../../tools/hooks/engine'
import { injectPendingInterAgentQueue } from '../agenticLoopHelpers'
import { checkTokenBudget, recordOutputTokens } from '../../context/tokenBudget'
import { buildNoToolUseAssistantContent } from '../agenticLoopBuilders'
import {
  POLE_CONTEXT_USAGE_MESSAGE_KEY,
  getTokenCountFromUsage,
} from '../../context/tokenUsageAccounting'
import { QUERY_PROFILER_LABELS } from '../queryProfiler'
import {
  createTerminalResult,
  createUserInterruptionMessage,
  runTerminationCleanup,
} from '../queryTermination'
import { decideIterationOutcome } from './iterationDecision'
import { recordTransition } from './loopShared'
import type { LoopState, NoToolsInput, NoToolsOutput } from './loopShared'
import type { InlineSkillSessionState } from '../runAgenticToolUse'
import {
  SIDE_CHANNEL_KIND,
  makeSideChannelUserMessage,
  wrapSideChannelBody,
} from '../../constants/sideChannelKinds'
import { hasGenuineHumanTurnSinceLastToolUse } from './hostAttachments/messageHistoryQueries'
import { getTodos, hasActiveTodos } from '../../tools/TodoWriteTool'
import { isTodoV1Enabled } from '../../tools/todoMode'
import {
  buildDeclaredIntentDirective,
  detectDeclaredIntentTail,
  hasExemptDeclaredIntentTail,
  isDeclaredIntentGuardEnabled,
  isUserQuestionTail,
} from './declaredIntentGuard'
import {
  buildAllToolsFailedDirective,
  isAllToolsFailedGuardEnabled,
} from './allToolsFailedGuard'
import { buildVerificationGateSignal } from './verificationGate'
import { buildPlanStepGuardSignal } from './planStepGuard'
import { buildPlanlessImplementationGuardSignal } from './planlessImplementationGuard'
import {
  buildThinkingOnlySilentTurnDirective,
  isThinkingOnlySilentTurnGuardEnabled,
} from './thinkingOnlySilentTurnGuard'
import {
  buildCompletionEvidenceDirective,
  classifyCompletionEvidenceOutcome,
  completionEvidenceChallengeCap,
  completionEvidenceHandshakeApplies,
  hasCompleteEvidenceTag,
  isCompletionEvidenceGateEnabled,
} from './completionEvidenceGate'

/**
 * Audit Bug 7 — clamp the in-band hook error payload before splicing it
 * into the transcript. A hook that emits a 10MB log used to land
 * verbatim in `apiMessages`, which then often blew the next request
 * past `context_length_exceeded` on its own.
 */
const STOP_HOOK_ERROR_INJECTION_MAX_CHARS = 2_000

function clampHookErrorMessage(raw: string): string {
  if (raw.length <= STOP_HOOK_ERROR_INJECTION_MAX_CHARS) return raw
  const truncatedSuffix = `\n\n[…truncated by agentic loop, original ${raw.length} chars]`
  const head = raw.slice(0, STOP_HOOK_ERROR_INJECTION_MAX_CHARS - truncatedSuffix.length)
  return `${head}${truncatedSuffix}`
}

/**
 * Stop-hook circuit breaker — consecutive-block cap.
 *
 * Aligned with upstream's official `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`:
 * after N consecutive blocks without forward progress, the loop overrides
 * the hook and terminates instead of letting it spiral until `max_turns`.
 *
 * Replaces the previous rolling 3-in-6 window. The new semantics are
 * strictly more permissive — a single transient activation that the
 * model recovers from no longer "counts" against an unrelated activation
 * many iterations later. The orchestrator resets the counter to 0
 * whenever genuine forward progress occurs (tool batch succeeded).
 *
 * Default cap of 8 matches the official upstream value. Tunable via
 * `POLE_STOP_HOOK_BLOCK_CAP` (operator override, no rebuild).
 */
export const STOP_HOOK_BLOCK_CAP = parseEnvInt(
  process.env.POLE_STOP_HOOK_BLOCK_CAP,
  8,
)

function parseEnvInt(raw: string | undefined, defaultValue: number): number {
  if (!raw) return defaultValue
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue
}

/**
 * Records a Stop-hook block (blockingError / preventStop /
 * decideAfterNoToolUse continuation) and reports whether the cap has
 * been reached.
 *
 * Pure function — mutates the passed-in counter via the returned value;
 * the caller assigns `state.consecutiveStopHookBlocks = result.count`.
 */
export function recordStopHookBlock(
  previousCount: number,
  cap: number = STOP_HOOK_BLOCK_CAP,
): { tripped: boolean; count: number } {
  const count = previousCount + 1
  return { tripped: count >= cap, count }
}

function lastStreamOutputTokens(state: LoopState): number {
  const v = state.lastStreamUsageForPole?.output_tokens
  return typeof v === 'number' && Number.isFinite(v) && v > 0
    ? Math.floor(v)
    : 0
}

/**
 * 星构Astra stop-prevention guard — produces the row 12a signal for
 * `decideIterationOutcome`. Returns `undefined` when the guard must not
 * fire so the caller can spread it conditionally.
 *
 * Gates (all required):
 *   1. `POLE_STOP_PREVENTION_GUARD` env var is NOT explicitly disabled
 *      (default ON — opt-out via `POLE_STOP_PREVENTION_GUARD=0`).
 *   2. V1 (`TodoWrite`) is enabled (`isTodoV1Enabled()`). Coexist mode
 *      qualifies. V2-only deployments skip the guard entirely because
 *      V2 tasks are cross-conversation by design and stopping a
 *      conversation does NOT abandon them.
 *   3. The active agent is the main chat (`agentId === 'main'`).
 *      Sub-agents are intentionally exempt: their `TodoWrite` store is
 *      keyed by sub-agent id and was meant to live and die inside the
 *      sub-agent run.
 *   4. The main chat has at least one `pending` / `in_progress` item
 *      (`hasActiveTodos('main')`).
 *
 * The directive itself is intentionally `hard_directive`-styled (per
 * the design pick): it tells the model the turn cannot end and what
 * the two acceptable next moves are. Renders as a `<system-reminder>`
 * once the caller applies `injectSideChannelKind`.
 */
const TODO_WRITE_TOOL_NAME = 'TodoWrite'

export function buildActiveTodoPanelGuardSignal(
  apiMessages: ReadonlyArray<Record<string, unknown>>,
  accumulatedText: string,
):
  | { itemCount: number; directiveBody: string }
  | undefined {
  const raw = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process?.env?.POLE_STOP_PREVENTION_GUARD?.trim().toLowerCase()
  if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') return undefined

  if (!isTodoV1Enabled()) return undefined

  const ctx = getAgentContext()
  const agentId = ctx?.agentId ?? 'main'
  if (agentId !== 'main') return undefined

  // Plan A (2026-06) — question-tail exemption. When the model's visible reply
  // is a genuine question / clarification request to the user, ending the turn
  // to await the answer is correct EVEN with open todos: forcing a continuation
  // here would swallow the question (the model never gets the input it asked
  // for, and may be pushed to guess or churn the list). Symmetric with the
  // declared-intent guard's question exemption. The open todos stay in the
  // panel for when the user replies. Completion-style tails are deliberately
  // NOT exempt (a "done" claim with open todos still warrants the nudge).
  if (isUserQuestionTail(accumulatedText)) return undefined

  if (!hasActiveTodos(agentId)) return undefined

  const todos = getTodos(agentId)
  const open = todos.filter((t) => t.status === 'pending' || t.status === 'in_progress')
  if (open.length === 0) return undefined

  const list = open
    .map((t, i) => `${i + 1}. [${t.status}] ${t.content}`)
    .join('\n')

  // Fix B (2026-05) — human-redirect SOFTENING (not suppression) for the
  // strongest forcing path. The guard's legitimate purpose is to stop the
  // model silently abandoning a real task list (work done, but the last
  // items never marked `completed`). We keep that purpose: the list is
  // always surfaced.
  //
  // The difference is the FRAMING. When a genuine human message has
  // arrived since the last TodoWrite, the human is steering and the open
  // items MIGHT be stale relative to the new instruction (the
  // "测完 MemdirScan 但被旧的 70-工具清单拽着继续" failure mode). In that
  // case the hard "turn CANNOT end" directive is wrong — it forces the
  // model to grind a possibly-obsolete list against a fresh request. We
  // emit a softer directive that still asks the model to reconcile the
  // list but explicitly permits ending the turn once the list reflects
  // reality. When NO human turn intervened (pure autonomous run), the
  // original hard directive stands — that is exactly the case the guard
  // was built for.
  const humanRedirected = hasGenuineHumanTurnSinceLastToolUse(apiMessages, [
    TODO_WRITE_TOOL_NAME,
  ])

  const directiveBody = humanRedirected
    ? `[Active TodoWrite items — reconcile before ending]\n\n` +
      `Your task panel still has ${open.length} item(s) from earlier, and the user has sent a new message since the last TodoWrite update. ` +
      `Before you end this turn:\n` +
      `  (a) if the user's latest message is still part of this work, continue it and mark finished items \`completed\` via TodoWrite; OR\n` +
      `  (b) if the latest message changed scope, call TodoWrite to remove / replace the items that no longer apply, then answer the new request.\n\n` +
      `Do NOT keep executing stale items the user did not ask for. Once the list reflects the current request, it is fine to end the turn.\n\n` +
      `Open items:\n\n${list}`
    : `[Active TodoWrite items — turn cannot end yet]\n\n` +
      `Your task panel still has ${open.length} unfinished item(s). ` +
      `You MUST NOT end this turn until you either:\n` +
      `  (a) make progress on the work and mark every remaining item ` +
      `\`completed\` via TodoWrite, OR\n` +
      `  (b) call TodoWrite to remove items that no longer apply (or ` +
      `replace them with the correct breakdown).\n\n` +
      `Open items:\n\n${list}`

  return { itemCount: open.length, directiveBody }
}

export async function handleNoToolsBranch(
  state: LoopState,
  input: NoToolsInput,
): Promise<NoToolsOutput> {
  const { accumulatedText } = input

  state.appendixReport('P2_Q_no_tools_branch', { iteration: state.iteration, appendixStep20: 'no_tool_use' })
  emitInnerPhase('ResolveStop', state.iteration)

  // Signal abort → terminate. This stays as a fast-path here because the
  // signals collected below (stop hooks, token budget) have meaningful
  // I/O cost and we never want to incur it on a cancelled turn.
  //
  // 2026-07 UI-jank audit — the check runs BEFORE the entry
  // `syncConversation()` / `refreshMainChatContextHeader()` below. Both are
  // synchronous main-process work that scales with transcript size (three
  // full deep clones per sync in kernel drive mode, plus a full-transcript
  // token estimate for the header), and a cancelled turn re-syncs anyway
  // after the marker push — paying them here first froze every window's
  // IPC for the clone duration right on the user's Stop click.
  if (state.signal.aborted) {
    // 2026-07 interruption-protocol fix — same marker the `applyOutcome`
    // abort path appends (see `iteration.ts`): the kernel transcript and
    // ALS conversation snapshot must record that the user cut this turn
    // off, or downstream consumers see a truncated-but-"complete" reply.
    // The single sync below captures everything the skipped entry sync
    // would have, plus the marker.
    state.apiMessages.push(createUserInterruptionMessage('aborted_streaming'))
    state.syncConversation()
    state.loopContextManager.clearUsageSnapshot()
    state.callbacks.onMessageEnd(state.totalUsage)
    state.terminationResult = createTerminalResult('aborted_streaming', {
      turnCount: state.iteration,
      totalUsage: state.totalUsage,
    })
    await runTerminationCleanup(state.terminationResult)
    return { action: 'aborted' }
  }

  state.syncConversation()
  state.refreshMainChatContextHeader()

  // ── Stage 1: signal collection ──
  // P1 (2026-05): instead of nested if/else branches, we gather every
  // input the decision table cares about up-front so the actual decision
  // is one pure call to `decideIterationOutcome`.

  // Stop-hook engine pass (per-hook recursion guard via P0.4 Set).
  const stopHookCtx = getAgentContext()
  const isMainChatStop = !stopHookCtx || stopHookCtx.agentId === 'main'
  const ws = getWorkspacePath()?.trim()
  const hookCwd = ws && ws.length > 0 ? ws : process.cwd()
  const inlineSkillScope =
    (state.activeInlineSkillSession as InlineSkillSessionState | null)?.skillName?.trim() || undefined

  state.appendixReport('P2_Q_stop_hooks', {
    iteration: state.iteration,
    isMainChatStop,
    ...(state.stopHookActive.size > 0
      ? { skippedHooks: Array.from(state.stopHookActive) }
      : {}),
  })
  emitInnerPhase('StopHooksOrContinue', state.iteration)
  const endStopHooksCp = state.profiler.startCheckpoint(QUERY_PROFILER_LABELS.stopHooks)
  let stopRes: StopFamilyHookOutcome
  try {
    stopRes = isMainChatStop
      ? await runStopHooks(accumulatedText, hookCwd, {
          ...(inlineSkillScope ? { inlineSkillScope } : {}),
          skipHooks: state.stopHookActive,
        })
      : await runSubagentStopHooks(accumulatedText, hookCwd, {
          ...(inlineSkillScope ? { inlineSkillScope } : {}),
          skipHooks: state.stopHookActive,
        })
  } finally {
    endStopHooksCp()
  }

  // Inter-agent queue (no-op for main chat; sub-agents drain pending msgs).
  const interAgentInjected = injectPendingInterAgentQueue(state.apiMessages)

  // Token budget continuation reminder (P0.1 upstream diminishing-returns).
  let tokenBudgetReminder: string | undefined
  const outputTokensThisStream = lastStreamOutputTokens(state)
  if (state.tokenBudgetState && outputTokensThisStream > 0) {
    recordOutputTokens(state.tokenBudgetState, outputTokensThisStream)
    const budgetCheck = checkTokenBudget(state.tokenBudgetState)
    if (budgetCheck.action === 'continue') {
      tokenBudgetReminder = budgetCheck.reminderMessage
      state.appendixReport('P2_Q_no_tools_branch', {
        iteration: state.iteration,
        tokenBudget: 'continue',
        reason: budgetCheck.reason,
      })
    }
  }

  // Circuit-breaker would-trip pre-computation. Only stop-hook-driven
  // continuations (`blockingError` / `preventStop` with non-blank content)
  // count toward the cap — interAgent / tokenBudget don't trip it.
  const stopHookWouldContinue =
    stopRes.kind === 'blockingError' ||
    preventStopContinuationContent(stopRes) !== null
  const wouldTrip = stopHookWouldContinue
    ? recordStopHookBlock(state.consecutiveStopHookBlocks).tripped
    : false
  const circuitBreakerHookName =
    stopRes.kind === 'blockingError' || stopRes.kind === 'preventStop'
      ? stopRes.hookName
      : undefined

  // P1-1 — iteration stall guard. Record this iteration's metrics; if N
  // consecutive iterations were all "low text + low token delta + no tool
  // use", trip and terminate. upstream parity: `tokenBudget.ts` "diminishing
  // returns" rule.
  //
  // We pass output tokens as `tokenDelta` because the stream produced this
  // many output tokens THIS iteration; that's the relevant "did the model
  // do real work?" signal. upstream also uses output-only delta.
  //
  // Per-conversation: ALS gives us the right scope for parallel sub-agents.
  // Sub-agents get their own conversation id (or no id, in which case the
  // guard returns `stalled: false` and no-ops — desired).
  let stallSignal: { message: string; consecutiveCount: number } | undefined
  const ctxForStall = getAgentContext()
  const cidForStall = ctxForStall?.streamConversationId?.trim() || ''
  if (cidForStall) {
    try {
      const advice = getIterationStallGuard().record(cidForStall, {
        hadToolUse: false,
        textLength: accumulatedText.length,
        tokenDelta: outputTokensThisStream,
      })
      if (advice.stalled && advice.message) {
        stallSignal = {
          message: advice.message,
          consecutiveCount: advice.consecutiveCount,
        }
      }
    } catch (e) {
      console.warn('[Agentic Loop] iteration stall guard threw:', e)
    }
  }

  // 星构Astra stop-prevention guard signal (row 12a). Computed once
  // here so the decision stays pure; the helper returns `undefined`
  // unless V1 + main-chat + active items all align (see its doc).
  const activeTodoPanelGuard = buildActiveTodoPanelGuardSignal(state.apiMessages, accumulatedText)
  if (activeTodoPanelGuard) {
    state.appendixReport('P2_Q_no_tools_branch', {
      iteration: state.iteration,
      nudge: 'active_todo_panel_guard',
      itemCount: activeTodoPanelGuard.itemCount,
    })
  }

  // Plan-step driver signal (row 12a2). Work-package-neutral analogue of the
  // V1 todo guard for the active plan / V2 surface. Computed only when the V1
  // todo guard did NOT fire (its directive already forces continuation), so
  // the two never double-inject. Fires while open plan steps remain; the
  // stall guard + circuit breaker stay the anti-spiral backstops.
  const planStepGuard =
    !activeTodoPanelGuard
      ? buildPlanStepGuardSignal(state.apiMessages, accumulatedText)
      : undefined
  if (planStepGuard) {
    state.appendixReport('P2_Q_no_tools_branch', {
      iteration: state.iteration,
      nudge: 'plan_step_guard',
      openCount: planStepGuard.openCount,
    })
  }

  // Planless-implementation guard signal (row 12a3, audit G1). Computed only
  // when neither tracked-work guard fired (it requires NO plan and NO todos),
  // so it never double-injects. One-shot per planless episode.
  const planlessImplementationGuard =
    !activeTodoPanelGuard && !planStepGuard
      ? buildPlanlessImplementationGuardSignal(accumulatedText)
      : undefined
  if (planlessImplementationGuard) {
    state.appendixReport('P2_Q_no_tools_branch', {
      iteration: state.iteration,
      nudge: 'planless_implementation_guard',
    })
  }

  // Declared-intent guard signal (row 12b — 2026-06 P2 fix). Only
  // computed when the cheaper / higher-priority todo guard did NOT fire
  // (its directive already forces continuation) and the one-shot budget
  // for this stall episode is unspent (the counter resets on genuine
  // forward progress — successful tool execution — in iteration.ts).
  // Detection is a pure tail-scan — see declaredIntentGuard.ts for the
  // heuristics and exemptions (questions / completion statements end
  // turns normally).
  //
  // Symptom 3 hardening: when the stream produced NO user-visible text
  // but DID produce thinking (the "model walks through the whole task in
  // its chain-of-thought, then silently stops" degeneration), scan the
  // tail of the LAST thinking block instead. A thinking-only turn that
  // ends with "我现在开始修改 X" deserves the same execute-or-explain
  // nudge as a text turn — arguably more, since the user saw no reply
  // at all.
  //
  // 2026-07 uplift #16 — the thinking tail is now ALSO scanned when the
  // visible text is non-empty but carries no intent phrase: a final
  // thought of "接下来我去改 X" followed by a plan-narrating reply and a
  // stop is the same dangling commitment. The `'thinking'` source applies
  // the reply-composition exemption ("让我组织一下回答" announces writing
  // the reply, not tool work) so chain-of-thought wrap-up phrasing does
  // not false-positive; visible-text scanning behaviour is unchanged.
  const lastThinkingTail =
    state.thinkingBlocks[state.thinkingBlocks.length - 1]?.thinking ?? ''
  // A visible reply that ends with a question / completion claim ends the
  // turn legitimately — a leftover commitment inside thinking must not
  // override it.
  const visibleTailEndsTurn = hasExemptDeclaredIntentTail(accumulatedText)
  const declaredIntentGuard =
    !activeTodoPanelGuard &&
    !planStepGuard &&
    !planlessImplementationGuard &&
    isDeclaredIntentGuardEnabled() &&
    state.declaredIntentNudgeCount === 0 &&
    (detectDeclaredIntentTail(accumulatedText) ||
      (!visibleTailEndsTurn && detectDeclaredIntentTail(lastThinkingTail, 'thinking')))
      ? { directiveBody: buildDeclaredIntentDirective() }
      : undefined
  if (declaredIntentGuard) {
    state.appendixReport('P2_Q_no_tools_branch', {
      iteration: state.iteration,
      nudge: 'declared_intent_guard',
    })
  }

  // All-tools-failed guard signal (row 12c — 2026-06 Gap A fix). Lowest-
  // priority continuation: only computed when neither higher-priority guard
  // fired, the one-shot budget is unspent, and the previous tool batch was
  // entirely errors. Converts a silent "give up on a failed batch" into a
  // single retry-or-explain nudge.
  const allToolsFailedGuard =
    !activeTodoPanelGuard &&
    !planStepGuard &&
    !planlessImplementationGuard &&
    !declaredIntentGuard &&
    isAllToolsFailedGuardEnabled() &&
    state.allToolsFailedNudgeCount === 0 &&
    state.lastToolBatchAllErrors
      ? { directiveBody: buildAllToolsFailedDirective() }
      : undefined
  if (allToolsFailedGuard) {
    state.appendixReport('P2_Q_no_tools_branch', {
      iteration: state.iteration,
      nudge: 'all_tools_failed_guard',
    })
  }

  // Verification gate signal (row 12d — verification closed loop). Lowest-
  // priority continuation: only computed when no higher-priority guard
  // fired, the one-shot budget is unspent, and the conversation is the
  // main chat with substantive not-yet-PASS-verified edits on record (or
  // an unaddressed FAIL). Converts a silent "edited code then claimed
  // done without verifying" into a single verify-or-explain nudge.
  // Sub-agents are exempt — `agentId !== 'main'` short-circuits below.
  const pendingVerificationGate =
    !activeTodoPanelGuard &&
    !planStepGuard &&
    !planlessImplementationGuard &&
    !declaredIntentGuard &&
    !allToolsFailedGuard &&
    isMainChatStop
      ? buildVerificationGateSignal(getAgentContext()?.streamConversationId)
      : undefined
  const verificationGate =
    state.verificationGateNudgeCount === 0 ? pendingVerificationGate : undefined
  const verificationGateBlocked =
    state.verificationGateNudgeCount > 0 && pendingVerificationGate
      ? {
          detail:
            'Code changes are still awaiting verification after the required verification continuation.',
        }
      : undefined
  if (verificationGate) {
    state.appendixReport('P2_Q_no_tools_branch', {
      iteration: state.iteration,
      nudge: 'verification_gate',
    })
  }

  // Thinking-only silent-turn guard signal (row 12e — 2026-06 Gap B fix).
  // Lowest-priority continuation: only computed when no higher-priority guard
  // fired, the one-shot budget is unspent, and this turn produced NO visible
  // text but DID produce thinking (the model reasoned — often ending in a
  // question — entirely inside the thinking block and stopped, leaving the
  // user with no readable reply). Converts that silent dead-end into a single
  // surface-or-act nudge. The `!accumulatedText.trim()` check guarantees the
  // normal "model replied in visible text then stopped" path is untouched.
  const thinkingOnlySilentTurnGuard =
    !activeTodoPanelGuard &&
    !planStepGuard &&
    !planlessImplementationGuard &&
    !declaredIntentGuard &&
    !allToolsFailedGuard &&
    !pendingVerificationGate &&
    isThinkingOnlySilentTurnGuardEnabled() &&
    state.thinkingOnlySilentTurnNudgeCount === 0 &&
    !accumulatedText.trim() &&
    state.thinkingBlocks.length > 0
      ? { directiveBody: buildThinkingOnlySilentTurnDirective() }
      : undefined
  if (thinkingOnlySilentTurnGuard) {
    state.appendixReport('P2_Q_no_tools_branch', {
      iteration: state.iteration,
      nudge: 'thinking_only_silent_turn_guard',
    })
  }

  // Completion-evidence handshake signal (row 12f — 2026-07 "证据满足，
  // 正常结束"). Lowest-priority continuation: only computed when no other
  // guard fired. Fires when a MAIN-chat turn that used tools is about to
  // route to row 13 `completed` without the `<complete-evidence>` tag in
  // its final visible text.
  //
  // Scope gates, in order:
  //   - work-package gate (2026-07 复审 N1 fix): only the default (no
  //     bundle) and code-verification work packages walk the host
  //     handshake — other domains are prompt-driven and owe no tag;
  //   - main chat only (sub-agents have their own result contract);
  //   - the turn must have USED TOOLS at some earlier iteration
  //     (`transitionHistory` records a 'tool_use' advance) — pure Q&A has
  //     nothing to prove and must not pay handshake latency;
  //   - a genuine question to the user ends the turn normally;
  //   - the challenge budget (cap, reset on success-bearing tool batches
  //     in `orchestration/phases/iteration.ts`) is unspent.
  //
  // Evidence content is deliberately NOT verified; presence of the tag is
  // sufficient. The tag itself never reaches the renderer — the stream
  // phase strips it from text deltas (see `createCompleteEvidenceStreamFilter`).
  //
  // M1 (2026-07 会话审计监控) — the handshake state is classified by a
  // single pure function; the telemetry event AND the row-12f gate both
  // derive from it, so the measured rate can never drift from the gate's
  // actual behaviour. `in_band_tag` vs `challenge_issued` vs
  // `cap_exhausted` frequencies are the before/after signal for the
  // tail-slot reorder's effect on tag compliance.
  const turnUsedTools = state.transitionHistory.includes('tool_use')
  const completionEvidenceOutcome = classifyCompletionEvidenceOutcome({
    enabled: isCompletionEvidenceGateEnabled(),
    applies: completionEvidenceHandshakeApplies(),
    isMainChat: isMainChatStop,
    turnUsedTools,
    questionTail: isUserQuestionTail(accumulatedText),
    hasTag: hasCompleteEvidenceTag(accumulatedText),
    challengeCount: state.completionEvidenceChallengeCount,
    cap: completionEvidenceChallengeCap(),
  })
  if (completionEvidenceOutcome !== 'not_applicable') {
    state.appendixReport('P2_Q_no_tools_branch', {
      iteration: state.iteration,
      completionEvidenceOutcome,
      ...(completionEvidenceOutcome === 'challenge_issued' ||
      completionEvidenceOutcome === 'cap_exhausted'
        ? { challengeCount: state.completionEvidenceChallengeCount }
        : {}),
    })
  }
  const completionEvidenceGate =
    !activeTodoPanelGuard &&
    !planStepGuard &&
    !planlessImplementationGuard &&
    !declaredIntentGuard &&
    !allToolsFailedGuard &&
    !pendingVerificationGate &&
    !thinkingOnlySilentTurnGuard &&
    completionEvidenceOutcome === 'challenge_issued'
      ? {
          directiveBody: buildCompletionEvidenceDirective(
            state.completionEvidenceChallengeCount,
          ),
        }
      : undefined
  if (completionEvidenceGate) {
    state.appendixReport('P2_Q_no_tools_branch', {
      iteration: state.iteration,
      nudge: 'completion_evidence_gate',
      challengeCount: state.completionEvidenceChallengeCount,
    })
  }

  // ── Stage 2: decide ──
  const outcome = decideIterationOutcome({
    noToolUse: {
      interAgentInjected,
      stopHook: stopRes,
      stopHookActiveSkipped: state.stopHookActive.size > 0,
      tokenBudgetReminder: tokenBudgetReminder ?? undefined,
      circuitBreakerWouldTrip: wouldTrip,
      ...(circuitBreakerHookName ? { circuitBreakerHookName } : {}),
      ...(stallSignal ? { stallTripped: stallSignal } : {}),
      ...(activeTodoPanelGuard ? { activeTodoPanelGuard } : {}),
      ...(planStepGuard ? { planStepGuard } : {}),
      ...(planlessImplementationGuard ? { planlessImplementationGuard } : {}),
      ...(declaredIntentGuard ? { declaredIntentGuard } : {}),
      ...(allToolsFailedGuard ? { allToolsFailedGuard } : {}),
      ...(verificationGate ? { verificationGate } : {}),
      ...(verificationGateBlocked ? { verificationGateBlocked } : {}),
      ...(thinkingOnlySilentTurnGuard ? { thinkingOnlySilentTurnGuard } : {}),
      ...(completionEvidenceGate ? { completionEvidenceGate } : {}),
    },
  })

  // ── Stage 3: apply side effects per outcome ──

  // Common helper: synthesise the assistant turn that pairs with any
  // continuation / completion. Built lazily on demand because both the
  // continue and the completed terminal need it (forceStop / circuit
  // breaker skip it).
  const buildAssistantContent = (): Array<Record<string, unknown>> =>
    buildNoToolUseAssistantContent({
      thinkingBlocks: state.thinkingBlocks,
      accumulatedText,
      serverToolUseBlocks: state.serverToolUseBlocks,
      codeExecutionResultBlocks: state.codeExecutionResultBlocks,
    })
  const poleUsageFields = (): Record<string, unknown> =>
    state.lastStreamUsageForPole && getTokenCountFromUsage(state.lastStreamUsageForPole) > 0
      ? { [POLE_CONTEXT_USAGE_MESSAGE_KEY]: state.lastStreamUsageForPole }
      : {}

  if (outcome.kind === 'terminate') {
    // Audit fix (post-P1): the previous implementation of these branches
    // called `onMessageEnd` + `runTerminationCleanup` directly here AND
    // returned `{ action: 'end' }`. The caller (iteration.ts) then
    // ALSO called `onMessageEnd` + `runTerminationCleanup` for the
    // `decision.action === 'end'` path, double-firing every registered
    // stop-hook (memory extract, dream, telemetry sinks). upstream
    // parity: in upstream `query.ts`, terminal branches only set the
    // `Terminal.reason` return value; the outer driver runs cleanup.
    //
    // New invariant: this function ONLY writes
    // `state.terminationResult` (and calls `onError` when there's a
    // user-visible detail). The caller in iteration.ts is responsible
    // for `onMessageEnd` + `runTerminationCleanup` — fired exactly
    // once per loop exit.
    switch (outcome.reason) {
      case 'stop_hook_prevented': {
        // forceStop hook: terminal, surface its detail through onError.
        const detail = outcome.errorDetail ?? 'Stop hook requested terminal stop.'
        state.callbacks.onError(detail)
        state.terminationResult = createTerminalResult('stop_hook_prevented', {
          turnCount: state.iteration,
          totalUsage: state.totalUsage,
          errorDetail: detail,
          ...(outcome.hookName ? { hookName: outcome.hookName } : {}),
        })
        return { action: 'end' }
      }
      case 'iteration_stalled': {
        // P1-1 — token-delta stall guard terminated the loop. Detail
        // string comes from the guard's `record()` advice (built once
        // there, threaded through the decision table verbatim).
        const detail =
          outcome.errorDetail ?? 'Iteration stall detector terminated the turn.'
        state.appendixReport('P2_Q_iteration_stalled', {
          iteration: state.iteration,
        })
        state.callbacks.onError(detail)
        state.terminationResult = createTerminalResult('iteration_stalled', {
          turnCount: state.iteration,
          totalUsage: state.totalUsage,
          errorDetail: detail,
        })
        return { action: 'end' }
      }
      case 'verification_required': {
        const detail =
          outcome.errorDetail ??
          'Code changes remain unverified; verification evidence is required before completion.'
        const finalContent = buildAssistantContent()
        if (finalContent.length > 0) {
          state.apiMessages.push({
            role: 'assistant',
            content: finalContent,
            ...poleUsageFields(),
          })
          state.syncConversation()
        }
        state.terminationResult = createTerminalResult('verification_required', {
          turnCount: state.iteration,
          totalUsage: state.totalUsage,
          errorDetail: detail,
        })
        return { action: 'end' }
      }
      case 'stop_hook_circuit_breaker': {
        // Counter would have tripped on this turn — produce a richer
        // detail than the decision function's generic one so operators
        // can see which hook + counter value triggered it.
        const counterPreview = state.consecutiveStopHookBlocks + 1
        const cbDetail =
          `Stop hook circuit breaker tripped: ${counterPreview} ` +
          `consecutive blocks without forward progress (cap=${STOP_HOOK_BLOCK_CAP}). ` +
          `Latest hook${outcome.hookName ? ` "${outcome.hookName}"` : ''} kept ` +
          `requesting continuation without forward progress.`
        state.appendixReport('P2_Q_stop_hooks', {
          iteration: state.iteration,
          isMainChatStop,
          circuitBreakerTripped: true,
          consecutiveBlocks: counterPreview,
          cap: STOP_HOOK_BLOCK_CAP,
          ...(outcome.hookName ? { hookName: outcome.hookName } : {}),
        })
        // The counter mutation happens here (on the trip-fire path)
        // rather than inside the would-trip pre-check so the legacy
        // "counter increments on each block" invariant holds even
        // when the cap is reached.
        state.consecutiveStopHookBlocks = counterPreview
        state.callbacks.onError(cbDetail)
        state.terminationResult = createTerminalResult('stop_hook_circuit_breaker', {
          turnCount: state.iteration,
          totalUsage: state.totalUsage,
          errorDetail: cbDetail,
          ...(outcome.hookName ? { hookName: outcome.hookName } : {}),
        })
        return { action: 'end' }
      }
      case 'completed':
      default: {
        // Normal "model said its piece and we're done" path. Push the
        // assistant content (if any), set terminationResult, return end.
        // The orchestrator fires onMessageEnd + runTerminationCleanup
        // AFTER this branch returns so the renderer sees
        // `task_terminated` exactly once per loop exit.
        const finalContent = buildAssistantContent()
        if (finalContent.length > 0) {
          state.apiMessages.push({
            role: 'assistant',
            content: finalContent,
            ...poleUsageFields(),
          })
          state.syncConversation()
        }
        state.terminationResult = createTerminalResult('completed', {
          turnCount: state.iteration,
          totalUsage: state.totalUsage,
        })
        return { action: 'end' }
      }
    }
  }

  // outcome.kind === 'continue' — figure out which side effects to fire.
  // The transition tag on `outcome` already encodes the case
  // ('stop_hook_continue' vs 'no_tool_use_continue'); the secondary cues
  // (`injectUserContent`, the stop-hook outcome shape) tell us whether
  // to clamp, wrap as side-channel, count toward circuit breaker, and
  // fire the onQueryLoopStopHook callback.
  recordTransition(state, outcome.transition)

  // One-shot budget accounting — P2-3 (2026-07 核心层做深): attribute the
  // continuation by the decision table's typed `sourceRow` discriminator.
  // The previous implementation compared `outcome.injectUserContent`
  // against each guard's directive body by string identity, which broke
  // silently the moment any layer wrapped or trimmed the injected text.
  // Only the row that ACTUALLY drove the continue spends its budget.
  switch (outcome.sourceRow) {
    case '12b':
      state.declaredIntentNudgeCount += 1
      break
    case '12c':
      state.allToolsFailedNudgeCount += 1
      break
    case '12d':
      state.verificationGateNudgeCount += 1
      break
    case '12e':
      state.thinkingOnlySilentTurnNudgeCount += 1
      break
    case '12f':
      state.completionEvidenceChallengeCount += 1
      break
    default:
      // Rows 9-12a3 / 17 carry no loop-state budget of their own (their
      // anti-spiral bounds are the circuit breaker + stall guard).
      break
  }

  const stopHookDriven =
    outcome.transition === 'stop_hook_continue' &&
    (stopRes.kind === 'blockingError' || stopRes.kind === 'preventStop')

  // Assistant content first (the model's reply, if any).
  const assistantContent = buildAssistantContent()
  if (assistantContent.length > 0) {
    state.apiMessages.push({
      role: 'assistant',
      content: assistantContent,
      ...poleUsageFields(),
    })
  }

  // User-side injection. We keep a reference to the pushed directive message
  // (not just its content) so the no_tools_continue collector pass can lift /
  // re-append it by object identity — see `NoToolsOutput.appendedDirective`.
  let appendedDirective: Record<string, unknown> | undefined
  if (outcome.injectUserContent !== undefined) {
    if (stopRes.kind === 'blockingError') {
      // Clamp + wrap as side-channel for blockingError specifically —
      // the model needs to see this as host-injected context rather
      // than a fresh user message. The decision function returned the
      // raw error string; we attach the formatting + the side-channel
      // metadata flags right here.
      const errMsg = clampHookErrorMessage(outcome.injectUserContent)
      const injectedBody =
        `[Stop hook reported an error — please review and address before continuing]\n\n${errMsg}`
      const wrapped = wrapSideChannelBody(SIDE_CHANNEL_KIND.stopHookError, injectedBody)
      const directiveMsg: Record<string, unknown> = {
        role: 'user',
        content: wrapped,
        _convertedFromSystem: true,
        _sideChannelKind: SIDE_CHANNEL_KIND.stopHookError,
      }
      state.apiMessages.push(directiveMsg)
      appendedDirective = directiveMsg
    } else if (outcome.injectSideChannelKind) {
      // Row 12a — active-todo guard (and any future continuation that
      // sets a side-channel kind explicitly). Wrap with the canonical
      // `<system-reminder>` envelope + typed metadata so smoosh /
      // compact / detection treat it as host context, not user text.
      const msg = makeSideChannelUserMessage(
        outcome.injectSideChannelKind,
        outcome.injectUserContent,
      )
      state.apiMessages.push(msg)
      appendedDirective = msg
    } else {
      // preventStop / tokenBudget — host nudges, not user speech. 2026-06
      // semantic-drift audit (F2): these used to be pushed as PLAIN user
      // messages, so smoosh / compact treated them as genuine user text and
      // the model could read a host continuation nudge as a fresh user
      // instruction. Route them through the canonical side-channel envelope
      // like every other host injection (stop-hook errors, todo guard,
      // stale-todo nudges).
      const msg = makeSideChannelUserMessage(
        SIDE_CHANNEL_KIND.genericConvertedSystem,
        outcome.injectUserContent,
      )
      state.apiMessages.push(msg)
      appendedDirective = msg
    }
  }

  // Stop-hook-driven continuations: fire the callback, register the
  // recursion guard, increment the circuit-breaker counter.
  if (stopHookDriven) {
    state.callbacks.onQueryLoopStopHook?.({
      iteration: state.iteration,
      action: 'continue',
    })
    if (stopRes.kind === 'blockingError') {
      state.appendixReport('P2_Q_stop_hooks', {
        iteration: state.iteration,
        isMainChatStop,
        blockingError: true,
        ...(stopRes.hookName ? { hookName: stopRes.hookName } : {}),
      })
    }
    // Hook name lives on blockingError / preventStop outcomes; fall
    // back to wildcard '*' so the recursion guard never silently
    // degrades on a future outcome shape that forgets the field.
    const hookKey =
      (stopRes.kind === 'blockingError' || stopRes.kind === 'preventStop')
        ? (stopRes.hookName ?? '*')
        : '*'
    state.stopHookActive.add(hookKey)
    state.consecutiveStopHookBlocks = recordStopHookBlock(
      state.consecutiveStopHookBlocks,
    ).count
  }

  state.syncConversation()
  state.refreshMainChatContextHeader(true)
  return { action: 'continue', appendedDirective }
}
