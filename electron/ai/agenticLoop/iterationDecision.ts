/**
 * P1 — Unified iteration decision function.
 *
 * upstream-inspired refactor: the agentic loop's "should we continue or
 * terminate?" decision used to live in 9 separate `if (…) return { kind:
 * 'terminate', … }` sites scattered across `iteration.ts`, `stream.ts`,
 * `postModel.ts`, and `noTools.ts`. Each site read different state slots
 * and emitted different terminal/continuation paths, which made the
 * combined decision impossible to audit and prone to "should continue but
 * stops / should stop but continues" UX regressions.
 *
 * This module collapses all 9 decision points into one pure function:
 *
 *   `decideIterationOutcome(signals: IterationDecisionSignals): IterationOutcome`
 *
 * The function reads ONLY the signals passed in (no global / state /
 * env access). The callers populate the signal shape from their current
 * snapshot: `runAgenticIteration` fills the loop-level signals (aborts,
 * stream/preModel termination, blocking limit) and applies the returned
 * outcome via `applyOutcome`; `handleNoToolsBranch` fills the `noToolUse`
 * sub-signals (stop hooks, circuit breaker, stall, token budget, guards)
 * and acts on the outcome itself. See `iteration.ts` and `noTools.ts`.
 *
 * Priority table (first-match wins, in declared order):
 *
 *   1.  preStreamAbort       → terminate `aborted_streaming`
 *   2.  boundaryHookStop     → terminate `iteration_boundary_stopped`
 *   3.  preModelTerminated   → terminate (reason already on state)
 *   4.  blockingLimitHard    → terminate `blocking_limit`
 *   5.  phaseWroteTermination → terminate (reason already on state;
 *       stream OR postModel/compact phase wrote it)
 *   6.  postStreamAbort      → terminate `aborted_streaming`
 *   7.  noToolUse.stopHook === 'forceStop'         → terminate `stop_hook_prevented`
 *   8.  noToolUse.circuitBreakerWouldTrip          → terminate `stop_hook_circuit_breaker`
 *   8b. noToolUse.stallTripped (P1-1)              → terminate `iteration_stalled`
 *   9.  noToolUse.interAgentInjected               → continue `no_tool_use_continue`
 *   10. noToolUse.stopHook === 'blockingError'     → continue `stop_hook_continue` + inject
 *   11. noToolUse.stopHook === 'preventStop'       → continue `stop_hook_continue` + inject
 *   12. noToolUse.tokenBudgetReminder (non-empty)  → continue `no_tool_use_continue` + inject
 *   12a. noToolUse.activeTodoPanelGuard            → continue `no_tool_use_continue` + inject (星构Astra)
 *   12a2. noToolUse.planStepGuard                  → continue `no_tool_use_continue` + inject (plan-step driver)
 *   12a3. noToolUse.planlessImplementationGuard    → continue `no_tool_use_continue` + inject (force-plan, G1)
 *   12b. noToolUse.declaredIntentGuard             → continue `no_tool_use_continue` + inject (2026-06 P2 fix)
 *   12c. noToolUse.allToolsFailedGuard             → continue `no_tool_use_continue` + inject (2026-06 Gap A fix)
 *   12d. noToolUse.verificationGate                → continue `no_tool_use_continue` + inject (verification closed loop)
 *   12e. noToolUse.thinkingOnlySilentTurnGuard     → continue `no_tool_use_continue` + inject (2026-06 Gap B fix)
 *   12f. noToolUse.completionEvidenceGate          → continue `no_tool_use_continue` + inject (2026-07 evidence handshake)
 *   13. noToolUse present but none of 7-12f        → terminate `completed`
 *   14. postToolAbort.iterationExhausted           → terminate `aborted_tools`
 *       (SA-2 fix 3 — was `max_turns`; user cancellation now wins over
 *       max_turns even on the last allowed iteration)
 *   15. postToolAbort                              → terminate `aborted_tools`
 *   16. pendingHookStop                            → terminate `hook_stopped`
 *   17. (default — no recognised signal)           → continue `tool_use`
 *
 * Lines 14-16 reflect post-tool gates; lines 9-12f reflect noToolUse gates;
 * lines 7-8 are inside the noToolUse branch but are stop signals; lines
 * 1-6 are pre/post-stream gates.
 *
 * upstream reference: `src/query.ts` is the canonical fan-in body; every
 * `return { reason: 'X' }` site there maps to a row here. The pure-
 * function shape also matches upstream's preference for state-machine
 * predicates with explicit priority tables.
 */

import type { StopFamilyHookOutcome } from '../../tools/hooks/engine'
import { preventStopContinuationContent } from '../../tools/hooks/engine'
import { SIDE_CHANNEL_KIND, type SideChannelKind } from '../../constants/sideChannelKinds'
import type { LoopTransition } from '../loopEvents'
import type { TerminationReason } from '../queryTermination'

// ─────────────────────────────────────────────────────────────────────
// Signal shape
// ─────────────────────────────────────────────────────────────────────

/**
 * Per-iteration signal envelope. The caller populates only the fields
 * that fired in its current snapshot — undefined fields are "did not
 * happen" rather than "explicitly false".
 *
 * Signals are evaluated in priority order (see file-header table).
 */
export interface IterationDecisionSignals {
  // Pre-stream gates (run at the top of `runAgenticIteration`)
  /** Set when the abort signal was already true on iteration entry. */
  preStreamAbort?: { reason: 'aborted_streaming' }
  /** Set when the kernel's `iterationBoundaryHook` returned `stop: true`. */
  boundaryHookStop?: true
  /** Set when `runPreModelPhase` populated `state.terminationResult` itself. */
  preModelTerminated?: true
  /** Set when the hard blocking-limit gate (`POLE_BLOCKING_LIMIT_HARD=1`) tripped. */
  blockingLimitHard?: true

  // Post-stream gates (run AFTER runStreamPhase, BEFORE noTools / tools)
  /**
   * Set when a phase module itself wrote `state.terminationResult` AND ran
   * `runTerminationCleanup`. Two producers feed this signal:
   *   - `runStreamPhase` (max-output exhausted, refusal, reactive-compact
   *     failure, PTL-after-compact, withheld-signal promotion).
   *   - `runPostModelPhase` (post-tool compact failed past the soft-failure
   *     cap — see `iteration.ts` Phase 5).
   * The name is phase-agnostic on purpose: the routing here is identical for
   * both (always `phase_wrote_termination`, reason read from state), so the
   * fallback `reason` below must stay generic — do NOT specialise it to a
   * stream-only termination reason.
   */
  phaseWroteTermination?: true
  /** Set when the abort signal fired during streaming. */
  postStreamAbort?: { reason: 'aborted_streaming' }

  // No-tool-use branch (only populated when `toolUseBlocks.length === 0`)
  noToolUse?: {
    /** `injectPendingInterAgentQueue` already pushed a synthetic user turn. */
    interAgentInjected: boolean
    /** Outcome from `runStopHooks` / `runSubagentStopHooks`. */
    stopHook: StopFamilyHookOutcome
    /**
     * True when the per-hook recursion guard (`state.stopHookActive`)
     * suppressed every hook this turn — purely informational so the
     * decision body can be deterministic across legacy / new modes.
     * Today it does not change routing; reserved for future telemetry.
     */
    stopHookActiveSkipped: boolean
    /** Reminder string from `checkTokenBudget` when budget says continue. Empty / undefined ⇒ no continuation. */
    tokenBudgetReminder?: string
    /**
     * Set when `recordStopHookBlock(state.consecutiveStopHookBlocks)`
     * would trip the circuit breaker (the helper accounts for the current
     * block internally). Caller computes this in-line so the decision
     * function stays pure.
     */
    circuitBreakerWouldTrip: boolean
    /**
     * The hook name to associate with a circuit-breaker termination
     * outcome (for `hookName` on the terminal result). Optional — when
     * absent the outcome carries no hookName.
     */
    circuitBreakerHookName?: string
    /**
     * P1-1 — iteration-stall guard signal. Set when the per-conversation
     * stall guard's `record(...)` returned `{ stalled: true }` for the
     * current iteration: N+ consecutive iterations with no tool use, tiny
     * non-thinking text, and minimal token delta. When present and
     * truthy, dominates every continue branch in the no-tool table because
     * "model has spent its budget thinking but produced nothing" is a
     * harder stop than any single-iteration recovery signal.
     */
    stallTripped?: { message: string; consecutiveCount: number }
    /**
     * 星构Astra stop-prevention guard (V1 only). Set by `noTools.ts`
     * when the user's task panel still has `pending` / `in_progress`
     * `TodoWrite` items for the main chat and the iteration would
     * otherwise route to row 13 `completed`. The decision body
     * redirects to `continue` and emits the directive verbatim.
     *
     * Intentionally LOWER priority than:
     *   - row 7 `forceStop`: explicit external override wins.
     *   - row 8 `stop_hook_circuit_breaker`: safety net wins.
     *   - row 8b `iteration_stalled`: safety net wins.
     *   - rows 10/11 stop-hook continuations: hook context wins.
     *   - row 12 `tokenBudgetReminder`: budget message wins.
     *
     * Higher priority than row 13 `completed` only. This keeps the
     * existing loop-break safety nets authoritative; the guard merely
     * intercepts the benign "model gave up gracefully" path.
     */
    activeTodoPanelGuard?: { itemCount: number; directiveBody: string }
    /**
     * Plan-step driver (row 12a2). Set by `noTools.ts` when there is an
     * active plan (steps tracked as `source: 'plan'` TaskManager tasks) with
     * open steps and the iteration would otherwise route to row 13
     * `completed`. Work-package-neutral analogue of `activeTodoPanelGuard`
     * for the V2 / plan surface, which previously had NO completion guard.
     * The caller computes it only when `activeTodoPanelGuard` did NOT fire,
     * so the two never double-inject. Priority: just below the V1 todo guard
     * (same "tracked work unfinished" family) and above the weaker
     * declared-intent / all-tools-failed / verification / thinking guards.
     */
    planStepGuard?: { openCount: number; directiveBody: string }
    /**
     * Planless-implementation guard (row 12a3, audit G1). Set by `noTools.ts`
     * when the model is about to stop after SUBSTANTIAL workspace mutations
     * with NO active plan and NO TodoWrite list — a one-shot nudge to track
     * the work (TodoWrite / Plan mode) so large unplanned batches become
     * reviewable. Computed only when neither tracked-work guard fired (it
     * requires the absence of both), so no double-injection. Priority: below
     * the tracked-work guards, above the declared-intent guard.
     */
    planlessImplementationGuard?: { directiveBody: string }
    /**
     * 2026-06 multi-turn degradation fix (P2) — declared-intent guard.
     * Set by `noTools.ts` when the model's no-tool-use text ANNOUNCES an
     * imminent action ("我现在开始修改 X" / "Let me now run the tests")
     * and the per-turn nudge budget (one shot) is not yet spent. The
     * decision body redirects the would-be row 13 `completed` to a
     * continuation carrying the directive (side-channel wrapped by the
     * caller, like row 12a).
     *
     * Priority: strictly BELOW every existing row (safety nets, stop
     * hooks, token budget, todo guard win) and above `completed` only —
     * it intercepts exactly the benign "model said it would act, then
     * stopped" path. One-shot semantics live in the caller
     * (`state.declaredIntentNudgeCount`), keeping this function pure.
     */
    declaredIntentGuard?: { directiveBody: string }
    /**
     * 2026-06 silent-stop audit (Gap A) — all-tools-failed guard. Set by
     * `noTools.ts` when the PREVIOUS tool batch was entirely errors
     * (`state.lastToolBatchAllErrors`) and the model then stopped without a
     * tool call, with the one-shot budget unspent. Redirects the would-be
     * row 13 `completed` to a continuation carrying the directive. LOWEST-
     * priority continuation — strictly below every other row (including the
     * declared-intent guard) and above `completed` only.
     */
    allToolsFailedGuard?: { directiveBody: string }
    /**
     * Verification closed loop (row 12d) — set by `noTools.ts` when the
     * MAIN chat is about to `completed` after substantive, not-yet-PASS-
     * verified workspace edits (or an unaddressed `FAIL` verdict). Redirects
     * the would-be `completed` to a continuation carrying the directive
     * (side-channel wrapped by the caller, like row 12a). LOWEST-priority
     * continuation — strictly below every other row (including the
     * all-tools-failed guard) and above `completed` only. One-shot budget
     * lives in the caller (`state.verificationGateNudgeCount`); gate state
     * lives in `electron/planning/verificationGateState.ts`.
     */
    verificationGate?: { directiveBody: string }
    /**
     * The bounded verification continuation was already spent but the
     * code-verification state is still pending. This is a non-success
     * terminal, never a fall-through to row 13 `completed`.
     */
    verificationGateBlocked?: { detail: string }
    /**
     * 2026-06 silent-stop audit (Gap B) — thinking-only silent-turn guard.
     * Set by `noTools.ts` when the turn produced NO user-visible text and NO
     * tool use but DID produce thinking (the model reasoned — often ending in
     * a question — entirely inside the thinking block and stopped, leaving the
     * user with no readable reply). Redirects the would-be row 13 `completed`
     * to a continuation carrying the directive (side-channel wrapped by the
     * caller, like row 12a). LOWEST-priority continuation — strictly below
     * every other row (including the verification gate) and above `completed`
     * only. One-shot budget lives in the caller
     * (`state.thinkingOnlySilentTurnNudgeCount`).
     */
    thinkingOnlySilentTurnGuard?: { directiveBody: string }
    /**
     * Completion-evidence handshake (row 12f — 2026-07 "证据满足，正常结束").
     * Set by `noTools.ts` when a MAIN-chat turn that used tools is about to
     * route to row 13 `completed` WITHOUT a `<complete-evidence>` tag in its
     * final visible text (and no exempting question tail). Redirects the
     * would-be `completed` to a hidden challenge continuation (side-channel
     * wrapped by the caller, like row 12a). LOWEST-priority continuation —
     * strictly below every other row and above `completed` only: every
     * other guard's directive already forces a continuation that supersedes
     * the handshake. Challenge budget lives in the caller
     * (`state.completionEvidenceChallengeCount`, capped); evidence content
     * is deliberately NOT verified — see `completionEvidenceGate.ts`.
     */
    completionEvidenceGate?: { directiveBody: string }
  }

  // Post-tool-execution gates (after `executeToolBatch`)
  /**
   * Set when the abort signal fired during tool execution.
   *
   * SA-2 fix 3 — `iterationExhausted` no longer changes routing: a
   * post-tool abort always terminates as `aborted_tools`, because user
   * cancellation takes priority over `max_turns` even on the last allowed
   * iteration (pre-fix, the last-iteration abort was reclassified as
   * `max_turns`, hiding the cancel semantics from UI/telemetry). The flag
   * stays on the signal shape as informational context for callers/tests.
   */
  postToolAbort?: { iterationExhausted: boolean }
  /** Set when `executeToolBatch` reported a pending hook-stop (PreToolUse / PostToolUse continue:false). */
  pendingHookStop?: { reason: string; hookName?: string }
}

// ─────────────────────────────────────────────────────────────────────
// Outcome shape
// ─────────────────────────────────────────────────────────────────────

/**
 * What the caller should do after this iteration.
 *
 * For `terminate`, the caller:
 *   1. Calls `state.callbacks.onMessageEnd`.
 *   2. Writes `state.terminationResult = createTerminalResult(reason, …)`
 *      (unless `transition` says the phase already wrote it).
 *   3. Calls `runTerminationCleanup`.
 *   4. Returns `{ kind: 'terminate' }` from `runAgenticIteration`.
 *
 * For `continue`, the caller:
 *   1. Sets `state.transition = outcome.transition`.
 *   2. Pushes the synthesised assistant content (built externally from
 *      `accumulatedText` + thinking blocks) into `state.apiMessages`.
 *   3. If `injectUserContent` is set, pushes a user message with that
 *      content (the synthetic turn that drives the next iteration).
 *   4. Returns `{ kind: 'continue' }`.
 */
/**
 * P2-3 (2026-07 核心层做深) — which decision-table row produced a
 * `continue` outcome. Carried on the outcome so callers (one-shot budget
 * accounting in `noTools.ts`) can attribute the continuation by a typed
 * discriminator instead of comparing `injectUserContent` against each
 * guard's directive text by string identity — the string comparison
 * silently mis-attributes the moment any wrapper trims / decorates the
 * injected body.
 */
export type ContinueSourceRow =
  | '9' // inter-agent queue already injected
  | '10' // stop hook blockingError
  | '11' // stop hook preventStop
  | '12' // token budget reminder
  | '12a' // active todo panel guard
  | '12a2' // plan-step driver
  | '12a3' // planless implementation guard
  | '12b' // declared-intent guard
  | '12c' // all-tools-failed guard
  | '12d' // verification gate
  | '12e' // thinking-only silent-turn guard
  | '12f' // completion-evidence handshake
  | '17' // default tool_use advance

export type IterationOutcome =
  | {
      kind: 'terminate'
      reason: TerminationReason
      /** Optional message attached to the terminal record (and surfaced via `onError`). */
      errorDetail?: string
      /** When the offending hook has a name, propagate it for UI surfacing. */
      hookName?: string
      /**
       * When the caller wants the transition history to record a specific
       * value for this iteration's exit. Most terminal paths leave it
       * undefined and let the caller default to the current
       * `state.transition` value.
       */
      transition?: LoopTransition
      /**
       * Set to `'phase_wrote_termination'` when a phase module
       * (preModel / stream / postModel) already populated
       * `state.terminationResult` and ran `runTerminationCleanup`.
       * The caller should NOT re-run those side effects.
       */
      writeStrategy?: 'phase_wrote_termination' | 'caller_writes_termination'
    }
  | {
      kind: 'continue'
      transition: LoopTransition
      /**
       * P2-3 — typed attribution of WHICH row drove this continuation.
       * Always present on `continue` outcomes. One-shot budget accounting
       * in `noTools.ts` switches on this instead of string-comparing
       * `injectUserContent` against guard directive bodies.
       */
      sourceRow: ContinueSourceRow
      /**
       * Synthesised user message body to inject as the next iteration's
       * "go" signal (e.g. `[Stop hook reported an error — …]`).
       * Undefined ⇒ no injection (the apiMessages tail is already in
       * the shape the next iteration needs, e.g. inter-agent queue
       * already pushed something).
       */
      injectUserContent?: string
      /**
       * When present, the caller in `noTools.ts` MUST wrap
       * `injectUserContent` with `makeSideChannelUserMessage(kind, ...)`
       * instead of pushing it as a plain user message. Used by the
       * active-todo guard (row 12a) so the directive lands as a
       * `<system-reminder>` rather than as user-typed text — the smoosh
       * / compact passes and the model itself can then identify it as
       * host-injected context.
       */
      injectSideChannelKind?: SideChannelKind
    }

// ─────────────────────────────────────────────────────────────────────
// Pure decision function
// ─────────────────────────────────────────────────────────────────────

/**
 * Resolve the signal envelope into a single outcome by walking the
 * priority table at the top of this file. Pure / sync — no I/O, no
 * state mutation, no global reads. The whole point is testability:
 * each row in the table is a single test case in
 * `iterationDecision.test.ts`.
 *
 * Defensive on input: an entirely-empty signal envelope returns
 * `kind: 'continue', transition: 'tool_use'` because that's the
 * implicit "no exit gates fired, proceed to next iteration" baseline
 * the legacy `runAgenticIteration` used at its bottom.
 */
export function decideIterationOutcome(
  signals: IterationDecisionSignals,
): IterationOutcome {
  // 1. Pre-stream abort.
  if (signals.preStreamAbort) {
    return {
      kind: 'terminate',
      reason: 'aborted_streaming',
      writeStrategy: 'caller_writes_termination',
    }
  }

  // 2. Iteration boundary hook stop.
  if (signals.boundaryHookStop) {
    return {
      kind: 'terminate',
      reason: 'iteration_boundary_stopped',
      writeStrategy: 'caller_writes_termination',
    }
  }

  // 3. preModel phase already wrote terminationResult.
  if (signals.preModelTerminated) {
    return {
      kind: 'terminate',
      // Sentinel reason — the caller will read the actual reason off
      // `state.terminationResult` since the phase populated it. We
      // use 'model_error' as a defensive fallback only in the event
      // the phase forgot to set the result.
      reason: 'model_error',
      writeStrategy: 'phase_wrote_termination',
    }
  }

  // 4. Hard blocking-limit gate.
  if (signals.blockingLimitHard) {
    return {
      kind: 'terminate',
      reason: 'blocking_limit',
      errorDetail: 'Hard blocking threshold exceeded',
      writeStrategy: 'caller_writes_termination',
    }
  }

  // 5. A phase already wrote terminationResult: stream phase (refusal,
  //    max-output exhaustion, reactive-compact failure, withheld-signal
  //    promotion) OR postModel/compact phase (post-tool compact failure).
  //    Both route identically — reason is read from state; the literal
  //    below is only a defensive fallback and must remain phase-agnostic.
  if (signals.phaseWroteTermination) {
    return {
      kind: 'terminate',
      reason: 'model_error', // fallback; caller reads from state
      writeStrategy: 'phase_wrote_termination',
    }
  }

  // 6. Post-stream abort.
  if (signals.postStreamAbort) {
    return {
      kind: 'terminate',
      reason: 'aborted_streaming',
      writeStrategy: 'caller_writes_termination',
    }
  }

  // 7-13. No-tool-use branch routing.
  const ntu = signals.noToolUse
  if (ntu) {
    // 7. forceStop hook → hard terminal.
    if (ntu.stopHook.kind === 'forceStop') {
      const detail =
        ntu.stopHook.errorDetail?.trim() ||
        'Stop hook requested terminal stop.'
      const result: IterationOutcome = {
        kind: 'terminate',
        reason: 'stop_hook_prevented',
        errorDetail: detail,
        writeStrategy: 'caller_writes_termination',
      }
      if (ntu.stopHook.hookName) result.hookName = ntu.stopHook.hookName
      return result
    }

    // 8. Circuit breaker trip — note this beats interAgent / preventStop
    //    / decide / tokenBudget on purpose: a sustained spiral has to be
    //    breakable even when other recovery paths "want" to continue.
    if (ntu.circuitBreakerWouldTrip) {
      const result: IterationOutcome = {
        kind: 'terminate',
        reason: 'stop_hook_circuit_breaker',
        errorDetail:
          'Stop hook circuit breaker tripped — a hook kept asking to continue without forward progress.',
        writeStrategy: 'caller_writes_termination',
      }
      if (ntu.circuitBreakerHookName) result.hookName = ntu.circuitBreakerHookName
      return result
    }

    // 8b. P1-1 — Iteration stall guard. Beats every continue branch below
    //     because if the model has been spending tokens without producing
    //     anything actionable across N iterations, no single continuation
    //     signal can recover — we just keep paying. Distinct from
    //     `stop_hook_circuit_breaker` (which requires stop hooks to be
    //     active) and from `completed` (which is "no tool use + no
    //     continuation signal", a benign normal end).
    if (ntu.stallTripped) {
      return {
        kind: 'terminate',
        reason: 'iteration_stalled',
        errorDetail: ntu.stallTripped.message,
        writeStrategy: 'caller_writes_termination',
      }
    }

    // 9. Inter-agent queue already injected — continue without our own
    //    injectUserContent (the queue handler already pushed a message).
    if (ntu.interAgentInjected) {
      return { kind: 'continue', transition: 'no_tool_use_continue', sourceRow: '9' }
    }

    // 10. blockingError → inject the clamped error message, continue.
    if (ntu.stopHook.kind === 'blockingError') {
      const rawMsg =
        ntu.stopHook.errorMessage?.trim() ||
        'Stop hook reported an error.'
      return {
        kind: 'continue',
        transition: 'stop_hook_continue',
        sourceRow: '10',
        injectUserContent: rawMsg,
      }
    }

    // 11. preventStop → inject the appendUserContent, continue.
    //     Uses the shared `preventStopContinuationContent` helper so the
    //     trim / emptiness rule stays identical to the circuit-breaker
    //     would-trip pre-check in `noTools.ts`. `null` here means either a
    //     non-preventStop outcome or preventStop with blank content — both
    //     fall through to token-budget and finally to `completed` per the
    //     legacy semantics.
    const preventStopContent = preventStopContinuationContent(ntu.stopHook)
    if (preventStopContent) {
      return {
        kind: 'continue',
        transition: 'stop_hook_continue',
        sourceRow: '11',
        injectUserContent: preventStopContent,
      }
    }

    // 12. Token budget reminder — inject and continue.
    const reminder = ntu.tokenBudgetReminder?.trim()
    if (reminder && reminder.length > 0) {
      return {
        kind: 'continue',
        transition: 'no_tool_use_continue',
        sourceRow: '12',
        injectUserContent: reminder,
      }
    }

    // 12a. 星构Astra active-todo guard — intercept the would-be
    //      `completed` outcome when the V1 task panel still has items
    //      the user hasn't seen marked done. Caller is responsible for
    //      side-channel wrapping (signalled via `injectSideChannelKind`)
    //      so the directive renders as a host `<system-reminder>` and
    //      not as user-typed text. Strictly lower priority than every
    //      other no-tool row to keep the existing loop-break safety
    //      nets authoritative (see field doc on `activeTodoPanelGuard`).
    const guard = ntu.activeTodoPanelGuard
    if (guard && guard.directiveBody.trim().length > 0) {
      return {
        kind: 'continue',
        transition: 'no_tool_use_continue',
        sourceRow: '12a',
        injectUserContent: guard.directiveBody,
        injectSideChannelKind: SIDE_CHANNEL_KIND.genericConvertedSystem,
      }
    }

    // 12a2. Plan-step driver — there is an active plan with open steps and
    //       the V1 todo guard did not already force a continuation. Mirror
    //       the V1 todo guard: continue with the host directive surfacing the
    //       current step, wrapped as a `<system-reminder>` side-channel.
    //       Work-package-neutral (a "step" is just a tracked plan task).
    const planGuard = ntu.planStepGuard
    if (planGuard && planGuard.directiveBody.trim().length > 0) {
      return {
        kind: 'continue',
        transition: 'no_tool_use_continue',
        sourceRow: '12a2',
        injectUserContent: planGuard.directiveBody,
        injectSideChannelKind: SIDE_CHANNEL_KIND.genericConvertedSystem,
      }
    }

    // 12a3. Planless-implementation guard (audit G1) — substantial unplanned
    //       changes with no plan/todos. One-shot nudge to track the work.
    const planlessGuard = ntu.planlessImplementationGuard
    if (planlessGuard && planlessGuard.directiveBody.trim().length > 0) {
      return {
        kind: 'continue',
        transition: 'no_tool_use_continue',
        sourceRow: '12a3',
        injectUserContent: planlessGuard.directiveBody,
        injectSideChannelKind: SIDE_CHANNEL_KIND.genericConvertedSystem,
      }
    }

    // 12b. Declared-intent guard (2026-06 P2 fix) — the model announced
    //      an imminent action but produced no tool_use. Continue once
    //      with the host directive; the caller's one-shot budget keeps
    //      this from looping. Lowest-priority continuation by design —
    //      it must never mask a safety-net termination above.
    const intentGuard = ntu.declaredIntentGuard
    if (intentGuard && intentGuard.directiveBody.trim().length > 0) {
      return {
        kind: 'continue',
        transition: 'no_tool_use_continue',
        sourceRow: '12b',
        injectUserContent: intentGuard.directiveBody,
        injectSideChannelKind: SIDE_CHANNEL_KIND.genericConvertedSystem,
      }
    }

    // 12c. All-tools-failed guard (2026-06 Gap A fix) — the previous tool
    //      batch was entirely errors and the model stopped without acting.
    //      Continue once with the retry-or-explain directive. Lowest-
    //      priority continuation: it must never mask any termination or
    //      higher-priority continuation above. One-shot budget lives in the
    //      caller (`state.allToolsFailedNudgeCount`).
    const allFailedGuard = ntu.allToolsFailedGuard
    if (allFailedGuard && allFailedGuard.directiveBody.trim().length > 0) {
      return {
        kind: 'continue',
        transition: 'no_tool_use_continue',
        sourceRow: '12c',
        injectUserContent: allFailedGuard.directiveBody,
        injectSideChannelKind: SIDE_CHANNEL_KIND.genericConvertedSystem,
      }
    }

    // 12d. Verification gate (closed loop) — the main chat made
    //      substantive, not-yet-PASS-verified edits (or a FAIL it never
    //      addressed) and is about to stop. Continue once with the
    //      verify-or-explain directive. Lowest-priority continuation: it
    //      must never mask any termination or higher-priority continuation
    //      above. One-shot budget lives in the caller
    //      (`state.verificationGateNudgeCount`).
    const verificationGate = ntu.verificationGate
    if (verificationGate && verificationGate.directiveBody.trim().length > 0) {
      return {
        kind: 'continue',
        transition: 'no_tool_use_continue',
        sourceRow: '12d',
        injectUserContent: verificationGate.directiveBody,
        injectSideChannelKind: SIDE_CHANNEL_KIND.genericConvertedSystem,
      }
    }

    // 12d2. The model already received the bounded verification directive
    //       and stopped again without clearing the gate. End as explicitly
    //       incomplete rather than laundering the turn into `completed`.
    const verificationBlocked = ntu.verificationGateBlocked
    if (verificationBlocked) {
      return {
        kind: 'terminate',
        reason: 'verification_required',
        errorDetail:
          verificationBlocked.detail.trim() ||
          'Code changes remain unverified after the verification continuation.',
        writeStrategy: 'caller_writes_termination',
      }
    }

    // 12e. Thinking-only silent-turn guard (2026-06 Gap B fix) — the turn
    //      produced only thinking (no visible text, no tool use), so the user
    //      got no readable reply. Continue once with the surface-or-act
    //      directive. Lowest-priority continuation: it must never mask any
    //      termination or higher-priority continuation above. One-shot budget
    //      lives in the caller (`state.thinkingOnlySilentTurnNudgeCount`).
    const thinkingOnlyGuard = ntu.thinkingOnlySilentTurnGuard
    if (thinkingOnlyGuard && thinkingOnlyGuard.directiveBody.trim().length > 0) {
      return {
        kind: 'continue',
        transition: 'no_tool_use_continue',
        sourceRow: '12e',
        injectUserContent: thinkingOnlyGuard.directiveBody,
        injectSideChannelKind: SIDE_CHANNEL_KIND.genericConvertedSystem,
      }
    }

    // 12f. Completion-evidence handshake (2026-07) — a tool-using turn is
    //      about to complete without submitting the `<complete-evidence>`
    //      tag. Continue with the hidden challenge directive. Lowest-
    //      priority continuation: it must never mask any termination or
    //      higher-priority continuation above. Challenge cap lives in the
    //      caller (`state.completionEvidenceChallengeCount`).
    const evidenceGate = ntu.completionEvidenceGate
    if (evidenceGate && evidenceGate.directiveBody.trim().length > 0) {
      return {
        kind: 'continue',
        transition: 'no_tool_use_continue',
        sourceRow: '12f',
        injectUserContent: evidenceGate.directiveBody,
        injectSideChannelKind: SIDE_CHANNEL_KIND.genericConvertedSystem,
      }
    }

    // 13. No continuation signal — normal completion.
    return {
      kind: 'terminate',
      reason: 'completed',
      writeStrategy: 'caller_writes_termination',
    }
  }

  // 14-15. Post-tool abort. SA-2 fix 3 — user cancellation wins over
  //        max_turns: row 14 (abort on the last allowed iteration) used
  //        to be reclassified as `max_turns`, which hid the cancel
  //        semantics. Both rows now terminate as `aborted_tools`;
  //        `iterationExhausted` is informational only.
  if (signals.postToolAbort) {
    return {
      kind: 'terminate',
      reason: 'aborted_tools',
      writeStrategy: 'caller_writes_termination',
    }
  }

  // 16. Pending hook-stop from tool execution.
  if (signals.pendingHookStop) {
    const result: IterationOutcome = {
      kind: 'terminate',
      reason: 'hook_stopped',
      errorDetail:
        signals.pendingHookStop.reason?.trim() ||
        'Tool-execution hook stopped the loop.',
      writeStrategy: 'caller_writes_termination',
    }
    if (signals.pendingHookStop.hookName) result.hookName = signals.pendingHookStop.hookName
    return result
  }

  // 17. Default — no exit gate fired. Continue to the next iteration as
  //     the standard "tool_use produced and consumed" advance.
  return { kind: 'continue', transition: 'tool_use', sourceRow: '17' }
}
