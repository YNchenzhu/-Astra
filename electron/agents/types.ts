/**
 * Agent type system — definitions for built-in and custom agents.
 *
 * Agents are specialized sub-processes that the main AI can spawn via the
 * Agent tool. Each agent type has its own system prompt, tool access, and
 * model preference.
 */

import type { HookEvent, HookExecutionKind } from '../tools/hooks/types'
import type { SkillEffort } from '../skills/skillEffort'
import type { AgentId } from '../tools/ids'
import type { ToolResultEventPayload } from '../ai/runAgenticToolUse'
import { isTodoV1Enabled, isTodoV2Enabled } from '../tools/todoMode'

/** Sub-agent permission hint (mirrors chat {@link PermissionMode} without importing interactionState). */
export type AgentDefinitionPermissionMode =
  | 'default'
  | 'plan'
  | 'bypassPermissions'
  | 'acceptEdits'
  | 'dontAsk'
  | 'auto'
  | 'bubble'

export type AgentMemoryScope = 'user' | 'project' | 'local'
export type AgentIsolationMode = 'worktree' | 'remote'

/**
 * Coordinator-style workflow phases (orchestration metadata; stage 3 wiring).
 *
 * The four canonical literals drive the default `runCoordinatorWorkflow`
 * pipeline used by the built-in Coordinator agent. The `stage-${number}`
 * template tier is consumed by the team-auto-launcher (sequential /
 * parallel-group ordering from `Bundle.teams`) — it lets us synthesize an
 * arbitrary number of ordered phases without losing type safety at the
 * consumer sites that only switch on the canonical four.
 */
export type CoordinatorPhase =
  | 'research'
  | 'synthesis'
  | 'implementation'
  | 'verification'
  | `stage-${number}`

/**
 * The agent's role inside an orchestration pipeline. Used by both the
 * Workbench UI ("编排角色" selector) and the runtime contract injector
 * ({@link buildOrchestrationContractAppend}).
 *
 * - `solo`              — explicit opt-out; no auto-injected contract.
 * - `readonly-worker`   — discovery / planning; read-only; not a coordinator.
 * - `writing-worker`    — implementation; may Edit/Write; not a coordinator.
 * - `coordinator`       — delegates via Agent tool; doesn't execute work itself.
 * - `verifier`          — read-only; final reply must start with `VERDICT: ...`.
 */
export type OrchestrationRole =
  | 'solo'
  | 'readonly-worker'
  | 'writing-worker'
  | 'coordinator'
  | 'verifier'

export const ORCHESTRATION_ROLES: readonly OrchestrationRole[] = [
  'solo',
  'readonly-worker',
  'writing-worker',
  'coordinator',
  'verifier',
] as const

/** Per-agent hook (frontmatter / JSON); evaluated in addition to global hooks. */
export interface AgentHookSpec {
  event: HookEvent
  matcher: string
  command: string
  async?: boolean
  executionKind?: HookExecutionKind
}

/** upstream-style MCP entry: named server, optional inline config (subset parity). */
export interface AgentMcpServerSpec {
  name: string
  config?: Record<string, unknown>
}

export type AgentMcpServerRef = string | AgentMcpServerSpec

// ========== Agent Definition ==========

export interface AgentDefinition {
  /** Unique identifier, e.g. "general-purpose", "Explore", "Plan" */
  agentType: string

  /** Human-readable description of when to use this agent (shown to the main AI) */
  whenToUse: string

  /**
   * Optional concrete "功能是..." capability slot. Populated primarily by the
   * Settings UI form so the Agent listing can show both a routing sentence
   * (`whenToUse`) and a specific capability bullet on the same line.
   *
   * Unlike `whenToUse`, this is **not** guaranteed to be action-oriented; it
   * is a free-form description that hints at what the agent can do. The
   * router uses both.
   */
  capability?: string

  /** Tool name whitelist (undefined or ['*'] = all tools) */
  tools?: string[]

  /** Tool name blacklist */
  disallowedTools?: string[]

  /** Model for this agent ('inherit' = use parent's model) */
  model?: string

  /** Whether this agent is read-only (cannot modify files) */
  isReadOnly?: boolean

  /** Maximum agentic loop iterations */
  maxTurns?: number

  /** When true, Agent tool defaults to background if caller omits run_in_background */
  background?: boolean

  /** Injected before the agent body system prompt (sub-agents only) */
  criticalReminder?: string

  /** UI / metadata (optional) */
  color?: string

  /**
   * MCP allowlist: string **names** (saved connection / preset) or `{ name, config? }` inline
   * specs (upstream `AgentMcpServerSpec[]`). Tool filtering and `ensureMcpServersConnected`
   * use resolved **names** only; optional `config` is reserved for future dynamic registration.
   */
  mcpServers?: AgentMcpServerRef[]

  /**
   * Per-agent hook commands (upstream `hooks` in frontmatter / JSON maps here after parse).
   * Same shape as report `HooksSettings` flattened to hook entries.
   */
  agentHooks?: AgentHookSpec[]

  /** Max total tokens (input+output) for this agent run (enforced in the sub-agent runner). */
  maxTokenBudget?: number

  /** Custom run budget in ms before automatic abort (default 5 minutes). */
  timeout?: number

  /**
   * Provider thinking budget (tokens) for Gemini structured thoughts / compatible Claude `thinking.budget_tokens`.
   * When omitted on a sub-agent, inherits parent ALS {@link AgentContext.thinkingBudgetTokens} (§7.5).
   */
  thinkingBudgetTokens?: number

  /**
   * Sub-agent isolation vs parent: `inherit` (default), `restricted` (Settings "allow" still
   * prompts for mutating tools in the sub-agent loop), `isolated` (no forked parent transcript /
   * no inherited team unless explicitly passed).
   */
  parentPolicy?: 'inherit' | 'restricted' | 'isolated'

  /** Coordinator workflow phase tag for strict spawn ordering + persisted orchestration state. */
  coordinatorPhase?: CoordinatorPhase

  /**
   * Path B (Workbench UI): the agent's role inside the orchestration pipeline.
   * Drives auto-injected "Orchestration Contract" appendix at runtime
   * (see {@link buildOrchestrationContractAppend}). When omitted, the
   * runtime infers a role from {@link isReadOnly}, {@link coordinatorPhase},
   * and the resolved tool surface — so existing bundles keep working
   * without changes. `'solo'` is an explicit opt-out: no contract injected.
   */
  orchestrationRole?: OrchestrationRole

  /** Preload skill names (metadata; full preload wiring may consume in later phases). */
  skills?: string[]

  /** API output effort when the provider supports it. */
  effort?: SkillEffort

  /** Override chat permission behavior for this sub-agent run (best-effort; global chat mode may still apply). */
  permissionMode?: AgentDefinitionPermissionMode

  /** Injected before the first user turn body (after fork inheritance, if any). */
  initialPrompt?: string

  /** upstream-style durable memory scope label. */
  memory?: AgentMemoryScope

  /** Isolation hint for worktree / remote agents. */
  isolation?: AgentIsolationMode

  /** When true, omit CLAUDE.md-style project memory injection (best-effort; product may still inject). */
  omitClaudeMd?: boolean

  /**
   * upstream §7.1 `filterToolsForAgent` analogue when the agent otherwise receives a broad tool set (`*`).
   * - `async_agent`: intersect with {@link ASYNC_AGENT_ALLOWED_TOOLS} (+ MCP).
   * - `in_process_teammate`: global deny applies except `Agent` remains allowed (upstream teammate exception).
   */
  subagentToolProfile?: 'default' | 'async_agent' | 'in_process_teammate'

  /** Sampling temperature (0–2 for most providers). Overrides bundle-level default. */
  temperature?: number

  /** Nucleus sampling top-p (0–1 for most providers). Overrides bundle-level default. */
  topP?: number

  /**
   * P1-2 — default tool-scheduling priority for runs of this agent type.
   *
   * Higher values are scheduled first when the orchestration `ToolScheduler`
   * picks the next wave (see `electron/orchestration/toolRuntime/scheduler.ts`).
   * The runtime threads this into `AgentContext.priority`, which
   * `DefaultToolRuntimePort` reads when enqueuing batches.
   *
   * When omitted, main chat defaults to `ToolPriority.HIGH` (70) and sub-agents
   * fall back to `ToolPriority.NORMAL` (50). Set this explicitly for background
   * agents (memory extract, dream, session-memory) so user-facing main chat
   * tools jump ahead of their batches.
   *
   * Allowed numeric range follows the `ToolPriority` constants in `scheduler.ts`:
   *   - CRITICAL = 100  (user-initiated explicit commands)
   *   - HIGH     = 70   (main chat default)
   *   - NORMAL   = 50   (generic sub-agent)
   *   - LOW      = 30   (background reads, proactive exploration)
   *   - BACKGROUND = 10 (telemetry, memory extract, dream, session-memory)
   */
  defaultPriority?: number
}

export interface BuiltInAgentDefinition extends AgentDefinition {
  source: 'built-in'
  getSystemPrompt: () => string
}

export interface CustomAgentDefinition extends AgentDefinition {
  source: 'custom'
  getSystemPrompt: () => string
  filename?: string
}

/** Agent contributed by a plugin bundle (upstream `source: plugin`). */
export interface PluginAgentDefinition extends AgentDefinition {
  source: 'plugin'
  /** Owning plugin id / package name. */
  pluginName: string
  getSystemPrompt: () => string
}

export type AgentDefinitionUnion =
  | BuiltInAgentDefinition
  | CustomAgentDefinition
  | PluginAgentDefinition

// ========== Sub-Agent Execution ==========

export interface SubAgentParams {
  description: string
  prompt: string
  subagentType?: string
  model?: string
  runInBackground?: boolean
  name?: string
}

export interface SubAgentResult {
  success: boolean
  agentId: AgentId
  /** Parent Agent/REPL tool_use id — use as TaskOutput `task_id` (same as runtime store key). */
  taskOutputTaskId?: string
  agentType: string
  output: string
  totalTokens: number
  totalDurationMs: number
  totalToolUses: number
  /** Per-turn usage summed over the sub-agent run (when the provider reports usage). */
  tokenUsage?: { input: number; output: number }
  /** True when stopped due to token budget over {@link AgentDefinition.maxTokenBudget}. */
  truncated?: boolean
  /**
   * True when {@link output} was capped to the trailing
   * `SUBAGENT_OUTPUT_FALLBACK_MAX_CHARS` window because the underlying
   * report exceeded it. Distinct from {@link truncated} (token-budget
   * abort) — this is purely about the body length the parent receives
   * inline. The parent can call `TaskOutput` on this agent's task id to
   * page through the full untruncated stream.
   */
  outputCharTruncated?: boolean
  /** Untruncated length of the source body when {@link outputCharTruncated} is true. */
  outputOriginalCharCount?: number
  /** True when the agentic loop reached max iterations (not a failure, just a limit). */
  reachedMaxIterations?: boolean
  /**
   * True when the run ended because the sub-agent {@link AbortSignal} fired (wall-clock timeout
   * from {@link registerActiveAgent} / user stop). Partial {@link output} may still be valuable
   * for the parent model.
   */
  aborted?: boolean
  /** Human-readable reason for {@link aborted}, when known. */
  abortReason?: string
  /** Terminal error string surfaced by runner/registry paths. */
  error?: string
  /**
   * Typed termination class from the in-loop {@link QueryTerminalResult.reason}.
   * Optional — older callers that only need `success` / `aborted` /
   * `reachedMaxIterations` can ignore it. upstream parity: their
   * `Terminal.reason` enum exposes the same 12-way discriminator
   * (`completed` | `max_turns` | `prompt_too_long` | `image_error` |
   * `model_error` | `stop_hook_prevented` | `hook_stopped` |
   * `aborted_streaming` | `aborted_tools` | `blocking_limit` |
   * `iteration_boundary_stopped` | `output_budget_exhausted`).
   *
   * Populated by the in-process runner via the `onTerminate` hook on
   * `runAgenticLoop`; the worker-process runner already had access via
   * `AgenticLoopResult.terminationResult`.
   */
  terminationReason?: import('../ai/queryTermination').TerminationReason
  /** Last transcript snapshot acknowledged by the worker parent. */
  transcriptSnapshot?: import('../orchestration/kernelTypes').TranscriptSnapshot
  /**
   * Tool name → invocation count. Surfaced to the parent agent via the
   * `Agent` tool_result so it can reason about retries / wasted work.
   */
  toolUseCounts?: Record<string, number>
  /**
   * Compact list of failed tool calls (capped at ~8 entries). Each entry is
   * `{ name, error }`. Lets the parent model see what specifically broke
   * inside the sub-agent without parsing the event stream.
   */
  toolFailures?: Array<{ name: string; error: string }>
  /**
   * Final-summary rescue metadata.
   *
   * When the loop ends abnormally (`reachedMaxIterations` or `aborted`)
   * without ever producing a tool-free final assistant turn, the runner
   * may execute ONE extra non-tool model call to extract a summary
   * (see `subAgentFinalSummary.ts`). When that happens, `output` is the
   * rescue text, and this struct lets the parent / telemetry observe
   * that the recovery path fired.
   */
  finalSummaryRescue?: {
    /** 'completed' | 'timeout' | 'error' — `skipped` is never reported. */
    outcome: 'completed' | 'timeout' | 'error'
    chars: number
    durationMs: number
  }
  /**
   * Set when the graceful wind-down fired during the run — the agent crossed a
   * soft budget line (read-only tool/token pressure, or approaching the
   * iteration cap) and was forced into ONE tool-free "write your report now"
   * turn BEFORE the hard cutoff. Symmetric with {@link finalSummaryRescue}
   * (the post-mortem backstop): both mean "the output below is a
   * budget-driven report, not a self-chosen final reply", so the digest and
   * telemetry can surface that to the parent. Distinct from `finalSummaryRescue`
   * — wind-down happens WHILE the agent is still alive (proactive), the rescue
   * happens AFTER it already died (reactive).
   */
  windDown?: {
    /** Which soft budget dimension tripped the wind-down. */
    trigger: 'tools' | 'tokens' | 'iterations'
    /** 1-based iteration when it fired (iteration trigger only). */
    iteration?: number
    /** Effective iteration cap (iteration trigger only). */
    maxIterations?: number
  }
}

// ========== Events ==========

export interface SubAgentEventStart {
  type: 'subagent_start'
  agentId: AgentId
  agentType: string
  description: string
  name?: string
  runInBackground: boolean
}

export interface SubAgentEventText {
  type: 'subagent_text'
  agentId: AgentId
  text: string
}

/** Thinking / reasoning stream — UI only; excluded from {@link SubAgentResult.output} for the parent model. */
export interface SubAgentEventThinkingDelta {
  type: 'subagent_thinking_delta'
  agentId: AgentId
  text: string
}

/**
 * Fired once per completed `type:'thinking'` block on the sub-agent's wire.
 * Carries the canonical whole-block text + optional `signature` so the
 * renderer can round-trip it on cross-turn replay (mirrors the parent-chat
 * `thinking_block_complete` event — see StreamEventType in
 * `electron/ai/streamHandler.ts`).
 *
 * `thinkingTimeMs` is the wall-clock duration the provider's `thinking`
 * content block was open (stamped by `consumeAnthropicStream` in
 * `anthropicCompatHttp.ts` from `Date.now() - startedAtMs`). Mirrors the
 * parent-chat payload so the renderer's `<ThinkingBlock>` inside
 * `AgentBlock` can authoritatively snap to the true elapsed time once
 * streaming ends, instead of relying only on its in-component tick which
 * resets to 0.0s on the next React remount.
 */
export interface SubAgentEventThinkingBlockComplete {
  type: 'subagent_thinking_block_complete'
  agentId: AgentId
  thinkingBlock: { thinking: string; signature?: string; thinkingTimeMs?: number; thinkingTokens?: number }
}

/**
 * Plan Phase 4 — sub-agent mirror of `redacted_thinking_block`. Carries the
 * Anthropic-encrypted chain-of-thought blob; renderer stores it verbatim in
 * SubAgentDisplay.blocks so the sub-agent's next turn can echo it back.
 */
export interface SubAgentEventRedactedThinkingBlock {
  type: 'subagent_redacted_thinking_block'
  agentId: AgentId
  redactedThinkingBlock: { data: string; startedAtMs?: number }
}

/**
 * Per-delta token of an OpenAI Responses API reasoning *summary* —
 * the safe-to-show TL;DR of the sub-agent's chain of thought. Mirrors
 * the parent-chat {@link reasoning_summary_delta} event but scoped to
 * a sub-agent run. UI-only; never round-tripped to the parent model in
 * tool results.
 */
export interface SubAgentEventReasoningSummaryDelta {
  type: 'subagent_reasoning_summary_delta'
  agentId: AgentId
  text: string
}

/**
 * Fires once per completed reasoning-summary block on the sub-agent's
 * wire (after all delta frames arrive). Replaces the merged-delta text
 * with the canonical payload + optional cost / duration meta so the
 * renderer's `<ReasoningSummaryBlock>` inside `AgentBlock` can snap to
 * the authoritative numbers.
 */
export interface SubAgentEventReasoningSummaryBlockComplete {
  type: 'subagent_reasoning_summary_block_complete'
  agentId: AgentId
  reasoningSummaryBlock: { text: string; thinkingTimeMs?: number; thinkingTokens?: number }
}

export interface SubAgentEventToolStart {
  type: 'subagent_tool_start'
  agentId: AgentId
  toolUse: { id: string; name: string; input: Record<string, unknown> }
}

/**
 * Sub-agent mirror of the main-chat `tool_input_delta` event. Carries
 * the throttled partial-JSON buffer for an in-flight `tool_use` block
 * so the AgentBlock can render IDE-style live writing for Write /
 * Edit tools executed inside the sub-agent. `partialJson` is the
 * **accumulated** buffer (not the per-event delta), matching the
 * shared throttle contract used by every provider.
 */
export interface SubAgentEventToolInputDelta {
  type: 'subagent_tool_input_delta'
  agentId: AgentId
  toolUseId: string
  toolName: string
  partialJson: string
}

export interface SubAgentEventToolResult {
  type: 'subagent_tool_result'
  agentId: AgentId
  toolResult: ToolResultEventPayload
}

export interface SubAgentEventComplete {
  type: 'subagent_complete'
  agentId: AgentId
  result: SubAgentResult
}

export interface SubAgentEventError {
  type: 'subagent_error'
  agentId: AgentId
  error: string
}

/** §11.4 — discard partial streamed sub-agent output before non-stream replay (Anthropic 529). */
export interface SubAgentEventStreamFallbackReset {
  type: 'subagent_stream_fallback_reset'
  agentId: AgentId
  reason?: string
}

/** Resume / background completion toast-style signal (UI may show without full stream). */
export interface SubAgentEventNotification {
  type: 'subagent_notification'
  agentId: AgentId
  agentType: string
  description: string
  status: 'completed' | 'failed'
  result?: SubAgentResult
  error?: string
}

/**
 * Phase D (granularity uplift) — per-model-call "iteration ended" signal.
 *
 * Fires once per inner iteration the sub-agent's agentic loop completes
 * (i.e. mirrors `LoopEvent.message_end` from the worker side, and the
 * in-process `AgenticLoopCallbacks.onMessageEnd` callback). Lets the
 * renderer track per-iteration token spend before `subagent_complete`
 * arrives at the end of the whole run.
 *
 * `iteration` is optional because worker-path runs don't currently
 * forward the iteration number across the worker boundary — only the
 * in-process path can populate it. Treat missing as "unknown".
 *
 * UI is free to ignore this event today; the renderer's whitelist
 * accepts it so the signal is reachable without further plumbing.
 */
export interface SubAgentEventMessageEnd {
  type: 'subagent_message_end'
  agentId: AgentId
  usage?: { inputTokens: number; outputTokens: number }
  iteration?: number
}

/**
 * Phase D — sub-agent context manager fired a compaction this turn.
 * Mirrors the parent-chat `context_compact` LoopEvent and the
 * `AgenticLoopCallbacks.onContextCompact(level)` callback. Useful for
 * the AgentBlock to surface "compacted at iteration N" without waiting
 * for the final `subagent_complete` summary.
 */
export interface SubAgentEventContextCompact {
  type: 'subagent_context_compact'
  agentId: AgentId
  level: string
}

/**
 * Phase D — sub-agent agentic loop reached `maxIterations`. Distinct
 * from `subagent_error` (which the legacy `onMaxIterationsReached`
 * branch also emitted for back-compat). Carrying the limit as a typed
 * field lets the renderer render a "reached limit (N/M)" badge instead
 * of parsing the error string. The legacy `subagent_error` event is
 * still emitted alongside this one to avoid breaking existing UI
 * state-machines that key off `subagent_error` to release agent block
 * slots; consumers wanting the cleaner signal can prefer this one and
 * ignore the paired error.
 */
export interface SubAgentEventMaxIterations {
  type: 'subagent_max_iterations'
  agentId: AgentId
  maxIterations: number
}

/**
 * Graceful wind-down fired — the run crossed a soft budget line (read-only
 * tool/token pressure, or approaching the iteration cap) and the host forced
 * ONE tool-free "write your final report now" turn so the run self-finishes
 * with a complete report instead of a truncated / max-turns fragment.
 *
 * Typed so the AgentBlock can surface a "winding down (N/M)" badge instead of
 * the forced report turn looking like an ordinary reply. Emitted from BOTH
 * spawn paths: in-process (`subAgentLoopCallbacks.onQueryLoopPreModel`) and
 * worker (`subAgentWorker` fan-out → `winddown` WorkerMessage → client). Like
 * `subagent_max_iterations`, the renderer currently routes it as a no-op
 * passthrough until a visual consumer wires up — the point is that the signal
 * is now structured and not lost.
 */
export interface SubAgentEventWindDown {
  type: 'subagent_winddown'
  agentId: AgentId
  /** Which soft budget dimension tripped the wind-down. */
  trigger: 'tools' | 'tokens' | 'iterations'
  /** 1-based current iteration when the wind-down fired (when known). */
  iteration?: number
  /** Effective iteration cap for the run (when known). */
  maxIterations?: number
}

/**
 * upstream parity: sub-agent retry signal. Emitted whenever the runner
 * decides — via {@link decideSubagentRetry} in
 * `./subAgentRetryPolicy` — that a terminal `model_error` warrants
 * another `runAgenticLoop` attempt before giving up. Currently the
 * only retried termination reason is `model_error` (transient API
 * issue); `prompt_too_long` remains `no_retry` because the inner
 * reactive-compact recovery already ran one compact pass before
 * surfacing the error.
 *
 * `attemptsSoFar` is 1-indexed: the value emitted is the attempt
 * number that is **about to start** (so `attemptsSoFar: 2` means
 * "first retry, second total attempt").
 */
export interface SubAgentEventRetry {
  type: 'subagent_retry'
  agentId: AgentId
  attemptsSoFar: number
  /** Termination reason from the previous attempt that triggered the retry. */
  terminationReason: import('../ai/queryTermination').TerminationReason
  /** Human-readable rationale produced by {@link decideSubagentRetry}. */
  reason: string
  /** Backoff applied before the next attempt, in milliseconds. */
  backoffMs: number
}

export type SubAgentEvent =
  | SubAgentEventStart
  | SubAgentEventText
  | SubAgentEventThinkingDelta
  | SubAgentEventThinkingBlockComplete
  | SubAgentEventRedactedThinkingBlock
  | SubAgentEventReasoningSummaryDelta
  | SubAgentEventReasoningSummaryBlockComplete
  | SubAgentEventToolStart
  | SubAgentEventToolInputDelta
  | SubAgentEventToolResult
  | SubAgentEventComplete
  | SubAgentEventError
  | SubAgentEventStreamFallbackReset
  | SubAgentEventNotification
  | SubAgentEventMessageEnd
  | SubAgentEventContextCompact
  | SubAgentEventMaxIterations
  | SubAgentEventWindDown
  | SubAgentEventRetry

// ========== Active Agent Tracking ==========

export interface ActiveAgent {
  agentId: AgentId
  agentType: string
  agentDef: AgentDefinitionUnion
  description: string
  name?: string
  /** TeamCreate name — SendMessage also writes TeamFile mailbox. */
  teamName?: string
  messages: Array<Record<string, unknown>>
  pendingMessages: string[]
  /** Number of unread mailbox lines dropped because the per-agent queue was full. */
  mailboxDroppedCount?: number
  /** Wall-clock timestamp of the most recent mailbox drop. */
  lastMailboxDropAt?: number
  abortController: AbortController
  startTime: number
  status: 'running' | 'completed' | 'failed' | 'killed'
  resolve: (result: SubAgentResult) => void
  /** Resume / orchestration metadata */
  parentAgentId?: string
  /** Chat session id for renderer routing (parallel streams + resumed sub-agents). */
  streamConversationId?: string
  result?: SubAgentResult
  notified?: boolean
  /** @internal Main-process timeout handle */
  timeoutHandle?: ReturnType<typeof setTimeout>
  /**
   * Derived effective token usage = {@link latestInputTokens} + {@link cumulativeOutputTokens}.
   * Updated by {@link recordAgentTokenUsage}.
   *
   * **Semantics fix (upstream §10.8 parity)** — Anthropic returns `input_tokens` as a
   * per-turn cumulative value (it already includes the entire conversation prefix).
   * The previous implementation accumulated input on every turn, double-counting the
   * prefix N times for an N-turn run and tripping `maxTokenBudget` early. The corrected
   * accounting takes the **max** of input across turns (latest cumulative value) and
   * **sums** output (per-turn delta), matching the API's actual cost model.
   */
  tokenCount?: number
  /**
   * Per-turn cumulative input tokens (max across all turns observed). Anthropic API
   * semantics: each `message_start.usage.input_tokens` includes the full conversation
   * prefix, so the largest value across turns is the effective input count.
   */
  latestInputTokens?: number
  /**
   * Sum of per-turn `output_tokens` across all turns observed. Anthropic API semantics:
   * each turn reports only the tokens generated *in that turn*, so summing is correct.
   */
  cumulativeOutputTokens?: number
  /** Set when {@link recordAgentTokenUsage} aborts the run for budget. */
  tokenBudgetExceeded?: boolean
  /** Wall-clock when the agent entered a terminal status (completed/failed/killed). */
  endedAt?: number
  /**
   * Streamed assistant text for this agent (for parent poll via TeamStatus).
   * For agents spawned from the main chat (`parentAgentId === 'main'`), new text is also
   * appended into the **next** main `ai:send-message` turn (see mainSubAgentContextInjection).
   */
  latestTextOutput?: string
  /** Bytes of {@link latestTextOutput} already injected into a main chat turn (delta delivery). */
  mainContextDeliveryOffset?: number
  /**
   * C9 — set after the agent's terminal state (completed / failed / killed)
   * has been surfaced to the parent main loop at least once via
   * {@link injectPendingSubAgentOutputsForMainTurn}. Without this flag, a
   * background sub-agent that fails before producing any text would never
   * trigger the next-turn injection (the prior `if (!delta.trim())` skip
   * silently dropped it), leaving the parent unaware its child crashed.
   */
  terminalNotifiedToMain?: boolean
  /** Last error observed by the runner — surfaced into terminal-state notice for the parent. */
  terminalError?: string
  /**
   * Report §7.7 — last `shutdown_request` team protocol observed when draining SendMessage queue
   * ({@link injectPendingInterAgentQueue} in agentic loop).
   */
  pendingTeamShutdown?: { requestId: string; receivedAt: number }
  /**
   * P1-1 (upstream §3.1 visibility): permission mode this agent is running
   * under, captured at spawn time from `permissionModeOverride` (i.e. the
   * effective mode the resolver chose: agent-def's `permissionMode`, the
   * parent's elevated mode for `acceptEdits`/`bypassPermissions`/`auto`,
   * or `'default'`). Surfaced through `agents:list-active` so the Running
   * Agents panel can show *which* sub-agent is restricted (`plan` /
   * read-only) versus which is auto-applying edits — critical when several
   * sub-agents run in parallel and the user needs to triage one.
   *
   * NOT mutated after registration: this is a *snapshot*. The live
   * permission state can drift via ALS overrides or mid-run kill-switch
   * downgrades, but for a panel diagnostic the spawn-time value is the
   * useful one (it's what the user originally consented to).
   *
   * A snapshot of `'plan'` doubles as the "plan-mode-required teammate"
   * indicator (upstream §6 — teammate launched with plan approval gate).
   */
  permissionModeSnapshot?: AgentDefinitionPermissionMode
}

// ========== Shared constants (tests + orchestration docs) ==========

/**
 * Sub-agents must not see these tools (upstream `constants/tools` §7.1, adapted to registry names).
 * Coordinator builds from an explicit allowlist and skips this deny pass; MCP `mcp__*` tools always pass.
 *
 * - `Agent`: nested delegation off (non–internal-user parity with the report).
 * - `TaskOutput` / `TaskStop`: parent/runtime task control.
 * - Plan mode / `AskUserQuestion`: main-session UX.
 */
export const ALL_AGENT_DISALLOWED_TOOLS = new Set([
  'EnterPlanMode',
  'ExitPlanMode',
  'ExitPlanModeV2',
  'AskUserQuestion',
  'TaskOutput',
  'TaskStop',
  'Agent',
  /** upstream `Workflow` / nested orchestration — not registered here but blocked by name parity (§7.1). */
  'Workflow',
])

/**
 * "Runtime-protocol" tools that every sub-agent should get for free regardless
 * of its domain tool whitelist. These are orthogonal to industry capabilities
 * (用户工作包通常把 `tools` 配成 `[read_file, grep, bash, ...]` 这种领域能力清单;
 * 这里列出的工具属于协作协议 —— 与行业无关,不应该要求每个 bundle 作者手动纳入)。
 *
 * Injected by {@link injectAlwaysAvailableTools} **after** the normal
 * allow/deny pipeline, so:
 *   - A curated whitelist like `tools: ['read_file', 'grep']` still gets the
 *     mode-appropriate task tool(s) (V1 → `TodoWrite`; V2 → `TaskCreate` +
 *     `TaskUpdate` + `TaskList` + `TaskGet`).
 *   - Users can opt out per-agent via `disallowedTools`.
 *   - Coordinator strict upstream mode ({@link isCoordinatorStrictOpenClaudeToolSurface})
 *     skips injection to preserve the report §7.3 four-tool surface.
 *   - `subagentToolProfile: 'in_process_teammate'` also skips so the teammate
 *     surface stays minimal (user-facing teammates don't need progress tracking).
 *
 * Phase D + 星构Astra coexist extension: the membership reflects the
 * currently-enabled surfaces. In the default `'coexist'` mode BOTH
 * tool families are made available to sub-agents, matching the main
 * agent's surface and letting the model pick ephemeral vs durable per
 * task. The legacy single-surface modes still narrow to the matching
 * family (upstream parity for `ASYNC_AGENT_ALLOWED_TOOLS` /
 * `IN_PROCESS_TEAMMATE_ALLOWED_TOOLS`). The function form is required
 * because the gates read settings at call time (tests need to flip
 * the mode mid-process); a frozen `Set` exported at module init would
 * lock the wrong shape into place.
 */
export function getAlwaysAvailableSubagentTools(): Set<string> {
  const tools = new Set<string>()
  if (isTodoV1Enabled()) tools.add('TodoWrite')
  if (isTodoV2Enabled()) {
    tools.add('TaskCreate')
    tools.add('TaskUpdate')
    tools.add('TaskList')
    tools.add('TaskGet')
  }
  return tools
}

/**
 * @deprecated Use {@link getAlwaysAvailableSubagentTools} instead — the
 * frozen-at-import Set cannot reflect mode flips (`ASTRA_TODO_V1`)
 * made after this module loaded. Kept for backwards compatibility with
 * direct `.has(name)` introspection callers; new code should call the
 * function so the V1 / V2 split is honoured.
 */
export const ALWAYS_AVAILABLE_SUBAGENT_TOOLS = getAlwaysAvailableSubagentTools()

export const CUSTOM_AGENT_DISALLOWED_TOOLS = new Set([...ALL_AGENT_DISALLOWED_TOOLS])

/**
 * Intersection filter for `subagentToolProfile: async_agent` (upstream §7.1 analogue).
 *
 * - **TaskOutput / SyntheticOutput**: upstream lists `SyntheticOutput` for async reads of delegated
 *   output; this host uses a single `TaskOutput` implementation. Sub-agents still must not hold
 *   `TaskOutput` (see {@link ALL_AGENT_DISALLOWED_TOOLS} + {@link applyGlobalSubagentDenylist} in
 *   subAgentRunner) — only the main session / Coordinator-style paths resolve parent output.
 *   Do not add `TaskOutput` here; it would be stripped by the global deny pass anyway.
 * - **MemdirScan**: product extension; read-only workspace memory listing (always-load tool since 2026-05).
 */
export const ASYNC_AGENT_ALLOWED_TOOLS = new Set([
  'Read',
  'read_file',
  'Write',
  'write_file',
  'Edit',
  'edit_file',
  'MultiEdit',
  'multi_edit_file',
  'FileEdit',
  'FileWrite',
  'Glob',
  'glob',
  'GlobFileSearch',
  'glob_file_search',
  'Grep',
  'grep',
  'Bash',
  'bash',
  'PowerShell',
  'powershell',
  'WebFetch',
  'web_fetch',
  'WebSearch',
  'web_search',
  'list_files',
  'TodoWrite',
  'NotebookEdit',
  'Skill',
  'ToolSearch',
  'MemdirScan',
  'EnterWorktree',
  'ExitWorktree',
])

/**
 * upstream §7.1 — teammate surface (plus `Agent` via denylist exception). Cron tools optional via env (AGENT_TRIGGERS).
 */
export const IN_PROCESS_TEAMMATE_ALLOWED_TOOLS = new Set([
  'TaskCreate',
  'TaskGet',
  'TaskList',
  'TaskUpdate',
  'SendMessage',
  'CronCreate',
  'CronDelete',
  'CronList',
  'TeamStatus',
  'TeamCreate',
  'Read',
  'read_file',
  'Grep',
  'grep',
  'Glob',
  'glob',
])

/**
 * upstream COORDINATOR_MODE core surface (§7.3).
 * `TaskOutput` is this host’s analogue of report **`SyntheticOutput`** (read delegated / background output).
 */
export const COORDINATOR_OC_CORE_TOOL_NAMES = [
  'Agent',
  'TaskStop',
  'SendMessage',
  'TaskOutput',
] as const

/** Default coordinator extensions: mailbox UX + light repo peek (not in upstream minimal four). */
export const COORDINATOR_EXTENDED_TOOL_NAMES = ['TeamStatus', 'Read', 'Grep', 'Glob'] as const

const COORDINATOR_STRICT_OC_ENV_KEYS = [
  'ASTRA_COORDINATOR_STRICT_OC_TOOLS',
  'CLAUDE_CODE_COORDINATOR_STRICT_TOOLS',
] as const

function envTruthy(v: string | undefined): boolean {
  if (!v) return false
  const s = v.trim().toLowerCase()
  return s === '1' || s === 'true' || s === 'yes'
}

/**
 * Cross-tsconfig safe env read.
 *
 * `electron/agents/types.ts` is reachable from the renderer project (via
 * `electron/agents/bundles/types.ts ← src/...`), and tsconfig.app.json
 * intentionally does NOT include `@types/node` to keep the bundle lean.
 * Referencing the `process` *global* directly would force every renderer
 * file that transitively imports this module to satisfy node typings.
 *
 * Reading through `globalThis` typed as `unknown` keeps this module
 * compatible with both projects: at runtime electron's main process and
 * preload have `process.env` populated; the renderer falls back to
 * `undefined` (which the callers already treat as "flag off").
 */
function readEnvVarSafe(key: string): string | undefined {
  const g = globalThis as { process?: { env?: Record<string, string | undefined> } }
  return g.process?.env?.[key]
}

/** When true, {@link getCoordinatorModeAllowedToolNames} returns only {@link COORDINATOR_OC_CORE_TOOL_NAMES}. */
export function isCoordinatorStrictOpenClaudeToolSurface(): boolean {
  for (const k of COORDINATOR_STRICT_OC_ENV_KEYS) {
    if (envTruthy(readEnvVarSafe(k))) return true
  }
  return false
}

/** Runtime coordinator allowlist (strict env → upstream core four only; else core + extensions). */
export function getCoordinatorModeAllowedToolNames(): string[] {
  const core = [...COORDINATOR_OC_CORE_TOOL_NAMES]
  if (isCoordinatorStrictOpenClaudeToolSurface()) return core
  return [...core, ...COORDINATOR_EXTENDED_TOOL_NAMES]
}

/**
 * Default coordinator allowlist (core + extensions). **Not** affected by strict env — for that use
 * {@link getCoordinatorModeAllowedToolNames}.
 */
export const COORDINATOR_MODE_ALLOWED_TOOLS = new Set<string>([
  ...COORDINATOR_OC_CORE_TOOL_NAMES,
  ...COORDINATOR_EXTENDED_TOOL_NAMES,
])

// ========== Task notification XML (buddy / hooks) ==========

export interface AgentNotification {
  agentId: AgentId
  agentType: string
  description: string
  status: 'completed' | 'failed' | 'stopped'
  summary: string
  result?: SubAgentResult
}

export function buildTaskNotificationXml(notification: AgentNotification): string {
  const lines = [
    '<task-notification>',
    `  <task_id>${escapeXml(notification.agentId)}</task_id>`,
    `  <agent_type>${escapeXml(notification.agentType)}</agent_type>`,
    `  <description>${escapeXml(notification.description)}</description>`,
    `  <status>${escapeXml(notification.status)}</status>`,
    `  <summary>${escapeXml(notification.summary)}</summary>`,
  ]
  const r = notification.result
  if (r) {
    lines.push('  <result>')
    lines.push(`    <success>${r.success}</success>`)
    lines.push(`    <output>${escapeXml(r.output || '')}</output>`)
    lines.push(`    <total_tokens>${r.totalTokens}</total_tokens>`)
    lines.push(`    <total_tool_uses>${r.totalToolUses}</total_tool_uses>`)
    lines.push(`    <total_duration_ms>${r.totalDurationMs}</total_duration_ms>`)
    lines.push('  </result>')
  }
  lines.push('</task-notification>')
  return lines.join('\n')
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// Re-export branded ID types for use by callers that create or validate agent/session IDs
export type { AgentId, SessionId } from '../tools/ids'
export { asAgentId, asSessionId, toAgentId, isValidSessionId } from '../tools/ids'
