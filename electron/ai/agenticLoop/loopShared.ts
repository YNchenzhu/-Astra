/**
 * Shared types for the agentic loop decomposition.
 *
 * Each phase module receives a focused input and returns structured output.
 * Mutable cross-phase state stays on the orchestrator's stack (agenticLoop.ts).
 */

import type { ContextManager } from '../../context/manager'
import type { SystemPromptLayers } from '../systemPrompt'
import type { AgenticLoopCallbacks, AgenticLoopParams } from '../agenticLoopTypes'
import type { InlineSkillSessionState } from '../runAgenticToolUse'
import type { TokenBudgetState } from '../../context/tokenBudget'
import type { AppendixARuntimeStageId } from '../../orchestration/appendixAFlow'
import type { ToolDefinition } from '../../tools/types'
import type { QueryProfiler } from '../queryProfiler'
import type { QueryTerminalResult } from '../queryTermination'
import type { LoopTransition } from '../loopEvents'
import type { QueryLoopPreModelPhase } from '../queryLoopPreModel'
import type { QueryConfig } from './queryConfig'
import type { QueryDeps } from './queryDeps'

// ── Setup phase ──

export interface LoopInitResult {
  /**
   * Immutable per-invocation snapshot of feature flags and identity
   * captured at {@link createInitialState} time. Phase modules should
   * prefer reading from {@link queryConfig} over re-reading env vars
   * mid-loop so a mid-flight settings flip can't toggle behaviour
   * within the same turn.
   *
   * Wired since 5-piece-set §A2. The current production consumer is
   * the `blockingLimitHard` flag (see the blocking-limit gate in
   * `electron/orchestration/phases/iteration.ts`) — additional fields
   * adopt incrementally as phase modules are refactored toward the
   * query/ contract layer.
   */
  queryConfig: Readonly<QueryConfig>
  /**
   * DI container for external effects the loop performs. upstream parity
   * (with deliberate divergence). Currently wired:
   *
   *   - `queryDeps.callModel` — production `streamText` reference,
   *     consumed by `stream.ts`. Tests override via
   *     {@link defaultQueryDeps} at state-init time.
   *   - `queryDeps.now` — wall-clock seam consumed by
   *     `preModel.ts#applyIdleToolClear` (read) and `stream.ts`
   *     (writes to `state.lastStreamEndMs`). Deterministic-clock tests
   *     pin both sides via `state.queryDeps.now`.
   *   - `queryDeps.signal` — passthrough of the outer abort signal.
   *
   * NO `microcompact` / `autocompact` slots. upstream's `query/deps.ts`
   * exposes them because upstream's loop calls them directly; our loop
   * reaches compaction only through `ContextManager.handleContext(...)`
   * — see `queryDeps.ts` for the full divergence rationale.
   */
  queryDeps: QueryDeps
  // Destructured params
  config: AgenticLoopParams['config']
  model: string
  enableTools: boolean
  diffPermissionMode: 'default' | 'bypassPermissions'
  permissionDefaultMode: 'allow' | 'ask' | 'deny'
  permissionRules: AgenticLoopParams['permissionRules']
  /** Chat interaction mode (Agent / Plan / Ask); defaults to `'agent'` at setup. */
  chatMode: 'agent' | 'plan' | 'ask'
  alwaysThinking: AgenticLoopParams['alwaysThinking']
  appendAppendixAFlow: AgenticLoopParams['appendixAFlow']
  temperature: AgenticLoopParams['temperature']
  topP: AgenticLoopParams['topP']
  effortFromParams: AgenticLoopParams['effort']
  // Settled values
  anthropicFastModeEnabled: boolean
  systemPromptLayers: SystemPromptLayers | undefined
  hasToolDefinitionsOverride: boolean
  baseToolDefinitions: ToolDefinition[]
  lastToolsetRevision: number
  maxIterations: number
  loopContextManager: ContextManager
  useOpenClaudeDerivedLoopThresholds: boolean
  // Mutable state holders (initialised here, mutated across iterations)
  apiMessages: Array<Record<string, unknown>>
  accumulatedText: string
  toolUseBlocks: Array<{
    id: string
    name: string
    input: Record<string, unknown>
    thoughtSignature?: string
    /** F1 — OpenAI Responses API 加密 reasoning 负载（回放用）。 */
    openai2Reasoning?: { id?: string; encrypted_content: string }
    caller?: { type: 'direct' } | { type: 'code_execution_20260120'; tool_id: string }
  }>
  thinkingBlocks: Array<{ thinking: string; signature?: string }>
  serverToolUseBlocks: Array<{ id: string; name: 'code_execution'; input: { code: string } }>
  codeExecutionResultBlocks: Array<{ toolUseId: string; stdout: string; stderr: string; returnCode: number }>
  iteration: number
  totalUsage: { inputTokens: number; outputTokens: number }
  lastStreamEndMs: number
  lastIdleClearMs: number
  activeInlineSkillSession: InlineSkillSessionState
  tokenBudgetState: TokenBudgetState | null
  pendingToolUseSummary: Promise<unknown> | null
  discoveryExclude: Set<string>
  toolCallHistory: ReturnType<typeof import('../toolCallHistory').createToolCallHistory> | undefined
  maxOutputRecoveryCycles: number
  lastStreamStopReason: string | undefined
  streamMaxOutTokens: number
  lastUserPlainBudgetSource: string | undefined
  terminationResult: QueryTerminalResult | null
  // Sub-state objects
  lastStreamUsageForPole: Record<string, unknown> | null
  lastStreamInputTokens: number
  iterationModel: string
  iterationToolDefs: ToolDefinition[]
  iterationEffort: AgenticLoopParams['effort']
  toolsForApi: ToolDefinition[] | undefined
  openAiStrictToolNames: string[] | undefined
  toolTokensForContext: number
  collapseConversationKey: string
  signal: AbortSignal
  callbacks: AgenticLoopCallbacks
  appendixReport: (stage: AppendixARuntimeStageId, detail?: Record<string, unknown>) => void
  syncConversation: () => void
  /** Accept a Host-authoritative snapshot without committing it back to the Host. */
  acceptHostTranscript: (messages: Array<Record<string, unknown>>) => void
  refreshMainChatContextHeader: (useApiMessagesOnly?: boolean) => void
  /**
   * Per-iteration timing collector. Always present, but a no-op unless
   * `POLE_QUERY_PROFILER=1`. Each phase module starts/ends checkpoints
   * via the canonical labels in `QUERY_PROFILER_LABELS`.
   */
  profiler: QueryProfiler
  /**
   * Stop-hook recursion guard.
   *
   * P0.4 — was previously a single `boolean` that, once set, made the next
   * iteration's noTools branch skip ALL Stop hooks. That was too coarse:
   * one broken hook would silence every OTHER hook in the system for a
   * turn, including hooks that may have wanted to legitimately fire.
   *
   * The new shape is a `Set<string>` keyed on each hook's `hookName` (the
   * field already set by `runStopFamilyHooks` on every non-neutral
   * outcome). When a hook returns `preventStop` / `blockingError` /
   * `decideAfterNoToolUse`-style continuation, only THAT hook's name is
   * added to the set; the next iteration's `runStopHooks` skips only the
   * named hooks and still evaluates everyone else.
   *
   * Cleared whenever the loop genuinely advances past the recovery point
   * (i.e. the model produces tool_use blocks or the user speaks again).
   *
   * The aggregate `consecutiveStopHookBlocks` circuit-breaker counter
   * stays unchanged — it counts any Stop-hook-driven continuation as a
   * single "block" regardless of which hook fired, so a sustained spiral
   * across MULTIPLE different hooks still trips the cap.
   */
  stopHookActive: Set<string>
  /**
   * Consecutive Stop-hook activations without genuine forward progress.
   *
   * Aligned with upstream's official `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`
   * semantics (8 consecutive blocks → hook is overridden; see
   * https://code.claude.com/docs/en/hooks-guide). When a Stop hook
   * blocks (`blockingError` injection or `preventStop` / `decide_after_no_tool_use`
   * continuation), this counter increments. When the loop genuinely
   * advances (tool execution succeeds), the orchestrator resets it to 0.
   *
   * Once the counter reaches {@link STOP_HOOK_BLOCK_CAP} the circuit
   * breaker in `noTools.ts` terminates the loop instead of letting the
   * hook spiral until `max_turns`.
   *
   * Previously a rolling 3-in-6 window — switched to consecutive count
   * to match upstream (upstream uses a single boolean `stopHookActive`;
   * upstream's official cap is 8 consecutive). Behaviour differences:
   *
   *   - Transient activation followed by genuine tool-execution recovery:
   *     consecutive resets to 0, rolling-window would still count it.
   *     → consecutive MORE permissive.
   *   - Sustained block-loop with no tool execution: consecutive trips
   *     at 8, rolling trips at 3 in 6.
   *     → consecutive MORE permissive (larger cap).
   *   - Widely-spaced isolated activations (e.g. iter 1, 20, 40): both
   *     no-op (rolling falls out of window each time; consecutive
   *     resets between via tool execution).
   *     → equivalent.
   *
   * Net: more permissive in every observed case, never stricter. The
   * tradeoff is that a genuinely-broken hook takes ~2.5× longer to trip,
   * but the upstream-aligned default is the safer ceiling — operators
   * can lower it via `POLE_STOP_HOOK_BLOCK_CAP` if needed.
   */
  consecutiveStopHookBlocks: number
  /**
   * 2026-06 multi-turn degradation fix (P2) — declared-intent nudges
   * already fired this turn. The guard in `noTools.ts` only computes its
   * signal while this is 0 (one shot per `runAgenticLoop` invocation):
   * if the model re-declares intent without acting AFTER the nudge, the
   * loop is allowed to end normally — endless re-nudging would just be a
   * different flavour of the stop-hook spiral the circuit breaker exists
   * to kill.
   */
  declaredIntentNudgeCount: number
  /**
   * Gap A fix (2026-06 silent-stop audit) — set by `toolExec` to `true`
   * when EVERY result in the most recent tool batch was an error (and the
   * batch was non-empty). Read by the no-tool branch on the NEXT iteration:
   * if the model then stops without a tool call, the all-tools-failed guard
   * nudges it once to retry or explain instead of silently routing to a
   * `completed` termination on a failed batch. Reset to `false` on any
   * batch that contained at least one success.
   */
  lastToolBatchAllErrors: boolean
  /**
   * One-shot budget for the all-tools-failed guard (mirrors
   * `declaredIntentNudgeCount`). The guard fires only while this is 0; the
   * counter resets on genuine forward progress (a tool-use iteration) in
   * `iteration.ts`, so a later genuine all-fail can nudge again, but an
   * unproductive model that keeps stopping after the nudge is allowed to end.
   */
  allToolsFailedNudgeCount: number
  /**
   * Verification-gate one-shot budget (row 12d). Mirrors
   * `allToolsFailedNudgeCount`: the `verification_gate` guard fires only
   * while this is 0, nudging a would-be `completed` once when the main
   * chat is about to end after substantive, not-yet-PASS-verified edits
   * (or an unaddressed `FAIL`). Resets on genuine forward progress (a
   * success-bearing tool batch) in `iteration.ts`, so a later round of
   * edits can re-arm it, but a model that keeps stopping after the nudge
   * is allowed to end. State lives in
   * `electron/planning/verificationGateState.ts`.
   */
  verificationGateNudgeCount: number
  /**
   * Gap B one-shot budget (row 12e — 2026-06 silent-stop audit). Mirrors
   * `declaredIntentNudgeCount`: the `thinking_only_silent_turn` guard fires
   * only while this is 0, nudging a would-be `completed` once when a turn
   * produced ONLY thinking (no visible text, no tool use) and the user got no
   * readable reply. Resets on genuine forward progress (a successful tool
   * batch) in `iteration.ts`, so a later thinking-only dead-end can re-arm it,
   * but a model that keeps producing nothing after the nudge is allowed to end.
   */
  thinkingOnlySilentTurnNudgeCount: number
  /**
   * Completion-evidence handshake challenge budget (row 12f — 2026-07
   * "证据满足，正常结束"). Counts hidden challenge rounds issued this stall
   * episode; the gate fires only while below
   * `completionEvidenceChallengeCap()` (default 2). Resets on a
   * success-bearing tool batch in `orchestration/phases/iteration.ts`
   * (same forward-progress signal as `verificationGateNudgeCount`), so a
   * later round of work re-arms the handshake, while a model that neither
   * continues nor submits the `<complete-evidence>` tag is allowed to end
   * once the cap is spent. See `completionEvidenceGate.ts`.
   */
  completionEvidenceChallengeCount: number
  /**
   * 2026-07 audit follow-up (§五.2, cc-haha observability parity) —
   * turn-level count of reactive-compact recovery attempts (PTL/413 →
   * LLM compact → stream retry). There is deliberately NO cross-iteration
   * "already attempted this turn" latch (each iteration may run the
   * recovery once; cost is bounded by max_iterations + per-iteration
   * modelCallBudget + the still-PTL hard termination), so a long turn can
   * legitimately burn several LLM compact calls. This counter makes that
   * visible: incremented in `maybeRunReactiveCompactRecovery` whenever the
   * recovery actually fires, and surfaced via the
   * `P2_Q_context_length_reactive` appendix event's `attempt` detail.
   * Telemetry only — never read by control flow.
   */
  reactiveCompactAttempts: number
  /**
   * P2-2 audit fix (2026-07) — adaptive-thinking anti-oscillation latch.
   *
   * Set to `true` by the stream phase the first time an iteration runs with
   * `lastToolBatchAllErrors` (i.e. the adaptive budget snapped back to
   * full). From then on `resolveAdaptiveThinkingBudget` receives
   * `latchedFullBudget: true` and never throttles again this run, so
   * `thinking.budget_tokens` changes at most once per run (the designed
   * full→routine downshift). Without the latch, alternating failure /
   * recovery iterations flipped the budget back and forth — and each flip
   * invalidates the Anthropic message-level prompt cache.
   */
  adaptiveThinkingFullBudgetLatched: boolean
  /**
   * P0.3 — Post-tool context-management circuit breaker.
   *
   * upstream parity: `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3` in
   * `services/compact/autoCompact.ts`. Upstream NEVER terminates the loop
   * on compact failure — it just stops trying. We're slightly more
   * conservative: after 3 consecutive failures we DO terminate, because
   * a Pole session that can't compact its context is going to OOM the
   * next API call regardless.
   *
   * Increments inside `runPostModelPhase` when `handleContext` throws.
   * Resets to 0 the next time a compact succeeds (`wasCompacted: true`).
   * Failures 1 and 2 → ok-with-warning (no `model_error` terminal).
   * Failure 3 → terminal `model_error` via the old hard-stop path.
   *
   * Before P0.3: a single transient compact failure killed the entire
   * session, even when the same compact would have succeeded on retry
   * (e.g. transient I/O error reading a side-attachment file). The
   * counter lets the loop ride through one or two flaky failures while
   * still bounding the worst case.
   */
  consecutiveCompactFailures: number
  /**
   * Withheld stream error: when the underlying provider reports a fatal
   * error mid-stream (auth, gateway, malformed media, etc.) we capture
   * it here instead of immediately propagating. The agentic loop decides
   * after the stream pass whether the error is recoverable (retried by
   * recovery paths) or terminal (route to `model_error` / `image_error`).
   *
   * Cleared at the top of each iteration's stream phase.
   *
   * Phase 3 (upstream alignment): this raw string is now the **carrier**
   * of the human-readable error for {@link AgenticLoopCallbacks.onError},
   * NOT the source of truth for classification. Routing decisions
   * (strip-retry, terminal reason) read {@link withheldStreamSignal}
   * instead — typed kind, no regex.
   */
  withheldStreamError: string | null
  /**
   * Phase 3 (upstream alignment) — typed counterpart to
   * {@link withheldStreamError}. Populated by `onLoopSignal` at the
   * provider catch boundary (see `loopSignalEmit.ts`). The agentic
   * loop's stream phase reads `.kind` for routing:
   *   - `'stream:image_too_large'` → image strip-retry
   *   - other `stream:*` (except `'stream:aborted'`) → terminal promotion
   *     via {@link import('../loopSignal').loopSignalToTerminationReason}
   *
   * Capture is **first-wins** (the first envelope of a streamPass
   * sequence is preserved; subsequent re-emits during retries don't
   * overwrite), matching {@link withheldStreamError}'s first-wins
   * semantics. Cleared at the same points (`runStreamWithRetry` top,
   * pre-strip-retry, and post-success).
   *
   * After Phase 4 deletes the regex modules, this becomes the SOLE
   * source for error classification in the loop.
   */
  withheldStreamSignal: import('../loopSignal').LoopSignal | null
  /**
   * upstream §11.2 — debug trail of "why did the loop continue from one iteration
   * to the next?". Phase modules update {@link transition} when they take a
   * recovery path or normal advance; the orchestrator pushes the resolved
   * value onto {@link transitionHistory} at the top of each iteration so
   * profiler / AppendixA can replay the full sequence.
   *
   * Initial value: `'init'`. After iter 1 the orchestrator overwrites this
   * based on iter 1's outcome (e.g. tool_use → `'tool_use'`); each phase
   * may override mid-iteration (e.g. stream phase setting `'reactive_compact'`
   * after a successful PTL recovery).
   */
  transition: LoopTransition
  /** Append-only history of {@link transition} values, one per iteration. */
  transitionHistory: LoopTransition[]
  /**
   * Last iteration where the runtime applied a phase-aware proactive compact.
   * This gives the policy a tiny cooldown so checkpoints do not compact every
   * turn during dense verification or delegation loops.
   */
  lastPhaseAwareCompactIteration: number
  /**
   * Set to true after the upstream-style `compaction_reminder` is injected
   * (once per session, main chat only). The reminder tells the model that
   * automatic context management is active so it shouldn't rush or wrap
   * up prematurely — opposite of the deleted 80%-iteration "wind down"
   * directive that contradicted upstream design and produced the
   * "stop vs continue" confusion under large context.
   *
   * See `messages.ts` in upstream (case `'compaction_reminder'`):
   *   "Auto-compact is enabled. […] There is no need to stop or rush
   *    — you have unlimited context through automatic compaction."
   */
  _compactionReminderInjected?: boolean
  // Orchestration hooks
  orchestratedToolExecution: AgenticLoopParams['orchestratedToolExecution']
  hostTranscript: AgenticLoopParams['hostTranscript']
  kernelLoopPort: AgenticLoopParams['kernelLoopPort']
}

export type LoopState = LoopInitResult

/**
 * P2-4 (2026-07 核心层做深) — the SINGLE write point for
 * {@link LoopState.transition}.
 *
 * `state.transition` used to be assigned directly from 7 call sites
 * (iteration body, noTools, stream + 3 recovery submodules), with the
 * timing contract ("history records the PREVIOUS iteration's resolved
 * value; the live slot is overwritten mid-iteration by recovery paths")
 * living only in comments. Funnelling every write through this helper:
 *
 *   1. gives future telemetry / assertions one seam instead of seven;
 *   2. makes the writer inventory greppable (`recordTransition(state,`),
 *      which the dead-value audit in `loopEvents.test.ts` also scans;
 *   3. documents the push-timing contract next to the write.
 *
 * The history push itself stays where it is (top of `runAgenticIteration`
 * + `finaliseTransitionHistory`) — that timing IS the contract, not an
 * accident.
 */
export function recordTransition(
  state: Pick<LoopState, 'transition'>,
  t: LoopTransition,
): void {
  state.transition = t
}

// ────────────────────────────────────────────────────────────────────────
// Field-layer annotations (upstream parity, type-only)
//
// upstream's `type State` in `src/query.ts:205-218` is 11 fields, all
// turn-level mutable. Setup fields live in `QueryParams` (separate type).
// Our `LoopInitResult` collapses both into one struct (67+ fields) for
// historical reasons.
//
// Refactoring the runtime struct is a multi-month project (every phase
// module reads/writes state.X directly). Instead, we provide TYPE-ONLY
// layer annotations that:
//   1. Document each field's lifetime (setup / turn / iteration).
//   2. Give phase modules a way to express "I only need turn-level state"
//      via `Pick<LoopState, LoopTurnFields>` for narrower function sigs.
//   3. Catch unannotated fields at compile time via exhaustiveness checks.
//
// Definitions:
//   - 'setup'     : Frozen at `initialiseLoopState` time, never mutated
//                   afterwards. Includes the immutable QueryConfig snapshot,
//                   port-style hooks (callbacks / appendixReport /
//                   syncConversation), and shared infrastructure
//                   (loopContextManager / profiler).
//   - 'turn'      : Persists across iterations within a single agentic loop
//                   run. apiMessages, iteration counter, totalUsage,
//                   recovery counters, stop-hook recursion guards,
//                   transitionHistory.
//   - 'iteration' : Reset / overwritten on each iteration boundary. Stream
//                   pass artifacts (accumulatedText / toolUseBlocks /
//                   thinkingBlocks / withheldStreamError), per-iter model
//                   overrides (iterationModel / iterationToolDefs),
//                   the live transition value (overwritten by phase
//                   modules; transitionHistory keeps the trail).
// ────────────────────────────────────────────────────────────────────────

/**
 * Field names that live in the 'setup' layer — frozen at
 * {@link initialiseLoopState} time and never written to thereafter.
 * Phase modules that only need to READ stable config can narrow to
 * `Pick<LoopState, LoopSetupFields>` to make the contract explicit.
 */
export type LoopSetupFields =
  | 'queryConfig'
  | 'queryDeps'
  | 'config'
  | 'model'
  | 'enableTools'
  | 'diffPermissionMode'
  | 'permissionDefaultMode'
  | 'permissionRules'
  | 'chatMode'
  | 'alwaysThinking'
  | 'appendAppendixAFlow'
  | 'temperature'
  | 'topP'
  | 'effortFromParams'
  | 'anthropicFastModeEnabled'
  | 'systemPromptLayers'
  | 'hasToolDefinitionsOverride'
  | 'baseToolDefinitions'
  | 'lastToolsetRevision'
  | 'maxIterations'
  | 'loopContextManager'
  | 'useOpenClaudeDerivedLoopThresholds'
  | 'signal'
  | 'callbacks'
  | 'appendixReport'
  | 'syncConversation'
  | 'refreshMainChatContextHeader'
  | 'profiler'
  | 'orchestratedToolExecution'
  | 'hostTranscript'
  | 'kernelLoopPort'

/**
 * Field names that live in the 'turn' layer — persist across iterations
 * within a single agentic loop run. The reducer-style continue sites
 * MUST preserve these (vs reset on each iteration boundary).
 */
export type LoopTurnFields =
  | 'apiMessages'
  | 'iteration'
  | 'totalUsage'
  | 'lastStreamEndMs'
  | 'lastIdleClearMs'
  | 'activeInlineSkillSession'
  | 'tokenBudgetState'
  | 'discoveryExclude'
  | 'toolCallHistory'
  | 'maxOutputRecoveryCycles'
  | 'lastUserPlainBudgetSource'
  | 'terminationResult'
  | 'collapseConversationKey'
  | 'stopHookActive'
  | 'consecutiveStopHookBlocks'
  | 'declaredIntentNudgeCount'
  | 'lastToolBatchAllErrors'
  | 'allToolsFailedNudgeCount'
  | 'verificationGateNudgeCount'
  | 'thinkingOnlySilentTurnNudgeCount'
  | 'completionEvidenceChallengeCount'
  | 'reactiveCompactAttempts'
  | 'adaptiveThinkingFullBudgetLatched'
  | 'consecutiveCompactFailures'
  | 'transitionHistory'
  | 'lastPhaseAwareCompactIteration'
  | '_compactionReminderInjected'

/**
 * Field names that live in the 'iteration' layer — reset or overwritten on
 * each iteration boundary. Phase modules may freely overwrite these
 * mid-iteration without violating the turn-level invariants.
 */
export type LoopIterationFields =
  | 'accumulatedText'
  | 'toolUseBlocks'
  | 'thinkingBlocks'
  | 'serverToolUseBlocks'
  | 'codeExecutionResultBlocks'
  | 'pendingToolUseSummary'
  | 'lastStreamStopReason'
  | 'streamMaxOutTokens'
  | 'lastStreamUsageForPole'
  | 'lastStreamInputTokens'
  | 'iterationModel'
  | 'iterationToolDefs'
  | 'iterationEffort'
  | 'toolsForApi'
  | 'openAiStrictToolNames'
  | 'toolTokensForContext'
  | 'withheldStreamError'
  | 'withheldStreamSignal'
  | 'transition'

/** Narrowed view: only the setup-layer fields. */
export type LoopSetupView = Pick<LoopState, LoopSetupFields>

/** Narrowed view: only the turn-layer fields. */
export type LoopTurnView = Pick<LoopState, LoopTurnFields>

/** Narrowed view: only the iteration-layer fields. */
export type LoopIterationView = Pick<LoopState, LoopIterationFields>

// ── Compile-time exhaustiveness check ────────────────────────────────────
//
// If a new field is added to `LoopInitResult` without being categorised
// into one of the three layers above, `_LoopUnannotatedField` resolves
// to that field name (a non-`never` string literal). Assigning a value of
// type `never` to it fails the compile, with the error message naming
// the missing field.
//
// Symmetrically, if a layer union references a key that no longer exists
// on `LoopInitResult` (e.g. someone deletes a field but forgets to remove
// it from `LoopSetupFields`), `_LoopOrphanedFieldName` catches that.
//
// Both checks are zero-runtime: `as never` is type-only assertion.

type _LoopUnannotatedField = Exclude<
  keyof LoopState,
  LoopSetupFields | LoopTurnFields | LoopIterationFields
>
type _LoopOrphanedFieldName = Exclude<
  LoopSetupFields | LoopTurnFields | LoopIterationFields,
  keyof LoopState
>

// These two const assignments fail to compile when the corresponding type
// resolves to anything other than `never`. The error message TS produces
// names the offending field, pointing the offender at exactly which union
// to update.
const _loopUnannotatedAssert: _LoopUnannotatedField = '' as never
const _loopOrphanedAssert: _LoopOrphanedFieldName = '' as never
void _loopUnannotatedAssert
void _loopOrphanedAssert

// ── Pre-model phase ──

export interface PreModelInput {
  state: LoopState
  systemPrompt: string
  isIterationOne: boolean
  hasInitialApiMessages: boolean
}

export interface PreModelOutput {
  apiMessages: Array<Record<string, unknown>>
  wasPreModelCompacted: boolean
  contextLevelAfter: string | undefined
  snippedCount: number
  /**
   * §6.1 pipeline phases that actually fired this iteration (e.g.
   * `tool_result_budget`, `history_snip`, `auto_compact`, …). Sourced
   * from {@link runQueryLoopPreModelSteps} and forwarded to
   * {@link AgenticLoopCallbacks.onQueryLoopPreModel} so consumers see
   * a real per-iteration phase list instead of the historical
   * `phases: []` placeholder. Always present (empty array when no
   * pipeline ran, e.g. terminated branches).
   */
  pipelinePhases: QueryLoopPreModelPhase[]
  /**
   * §4.1.1 main-chat idle tool-result clear actually fired this
   * iteration. Mirrors the `applied` return from `applyIdleToolClear`
   * so the callback's `idleToolClearApplied` field reflects reality
   * (the legacy implementation hard-coded `false`).
   */
  idleToolClearApplied: boolean
  /** true if `blocking_limit` terminated the loop */
  terminated: boolean
}

// ── Stream phase ──

export interface StreamInput {
  state: LoopState
  systemPrompt: string
}

export interface StreamOutput {
  contextLengthExceeded: boolean
  streamMaxOutTokens: number
  iterationModel: string
  accumulatedText: string
  toolUseBlocks: LoopState['toolUseBlocks']
  thinkingBlocks: LoopState['thinkingBlocks']
  serverToolUseBlocks: LoopState['serverToolUseBlocks']
  codeExecutionResultBlocks: LoopState['codeExecutionResultBlocks']
  lastStreamStopReason: string | undefined
  lastStreamUsageForPole: Record<string, unknown> | null
  lastStreamInputTokens: number
  maxOutputRecoveryCycles: number
  totalUsage: { inputTokens: number; outputTokens: number }
  lastStreamEndMs: number
  streamingToolExecutor: unknown | null
  useStreamingToolExecutor: boolean
}

// ── No-tools phase ──

export interface NoToolsInput {
  accumulatedText: string
  streamingToolExecutor: unknown | null
  useStreamingToolExecutor: boolean
}

export type NoToolsOutput =
  | {
      action: 'continue'
      /**
       * Reference to the continuation-directive message that
       * `handleNoToolsBranch` pushed onto `state.apiMessages` (if any), so a
       * downstream collector pass can lift/re-append it BY OBJECT IDENTITY —
       * robust against the `<system-reminder>` wrapping / clamping applied to
       * its `content`, unlike a fragile exact-content string match. `undefined`
       * when this continue path appended no directive (e.g. inter-agent drain).
       */
      appendedDirective?: Record<string, unknown>
    }
  | { action: 'end' }
  | { action: 'aborted' }

// ── Tool-execution phase ──

export interface ToolExecInput {
  accumulatedText: string
  streamingToolExecutor: unknown | null
  useStreamingToolExecutor: boolean
}

export interface ToolExecOutput {
  toolResults: Array<Record<string, unknown>>
  apiMessages: Array<Record<string, unknown>>
  activeInlineSkillSession: InlineSkillSessionState
  discoveryExclude: Set<string>
  pendingToolUseSummary: Promise<unknown> | null
}
