import type { PermissionMode } from './permissions'
import type {
  AskQuestionItemDisplay,
  DiffPreview,
  PlanTodo,
  SubAgentStructuredSummary,
} from './chatDisplay'
import type { ToolUseBlock } from './core'
import type { TerminationReason } from '../../../shared/terminationReasons'

export type StreamEventType =
  | 'text_delta'
  | 'thinking_start'
  | 'thinking_delta'
  | 'thinking_complete'
  /**
   * Emitted once per completed Anthropic-Messages `type:'thinking'` content
   * block on the wire, with the canonical whole-block text + optional
   * cryptographic `signature`. The renderer stashes the signature on the
   * matching `ChatBlock` so the next turn's
   * `chatMessageToAgentApiRows` can round-trip it — DeepSeek's Anthropic-
   * compat endpoint returns `HTTP 400 "content[].thinking in the thinking
   * mode must be passed back to the API"` and Anthropic native rejects
   * requests that drop previously-returned thinking blocks when the same
   * assistant also had a `tool_use` block.
   *
   * Payload lives in {@link StreamEvent.thinkingBlock}.
   */
  | 'thinking_block_complete'
  /**
   * Plan Phase 4 — Anthropic `redacted_thinking` 块到位。Payload 在
   * {@link StreamEvent.redactedThinkingBlock}，含加密 `data` blob。
   * 渲染端只显示 "✻ Thinking (私密推理已加密)" 占位但必须把 data 存
   * 进 ChatMessage.blocks 以便 `chatMessageToAgentApiRows` 回灌。
   */
  | 'redacted_thinking_block'
  /** Sub-agent mirror of {@link redacted_thinking_block}. */
  | 'subagent_redacted_thinking_block'
  /**
   * Per-delta token of an OpenAI Responses API reasoning *summary* —
   * the safe-to-show TL;DR of the chain of thought. Distinct from
   * `thinking_delta` because summaries have different cross-turn
   * semantics (no signature, output-only) and surface as their own
   * ChatBlock kind (`reasoning_summary`) rather than being merged into
   * the regular thinking row. Sourced from
   * `response.reasoning_summary_text.delta` events via the
   * `claudeToOpenAI2.ts` transformer; providers without a summary
   * channel (Anthropic native, Chat Completions, DeepSeek) never fire
   * these.
   */
  | 'reasoning_summary_delta'
  /**
   * Fires after all `reasoning_summary_delta` events for one block have
   * arrived. Payload lives on {@link StreamEvent.reasoningSummaryBlock}.
   */
  | 'reasoning_summary_block_complete'
  | 'tool_start'
  /**
   * Fires while a `tool_use` block is still streaming its JSON arguments
   * (upstream alignment — IDE-style live writing). Payload carries the
   * accumulated `partialJson` buffer for the in-flight tool plus
   * `toolUseId` / `toolName`. The renderer pulls in-progress
   * `content` / `newString` / `oldString` to drive a streaming diff view
   * for Write/Edit tools. Cleared once `tool_start` lands (the parsed
   * `input` is then authoritative).
   */
  | 'tool_input_delta'
  | 'tool_result'
  | 'subagent_start'
  | 'subagent_text'
  | 'subagent_thinking_delta'
  /** Sub-agent mirror of {@link thinking_block_complete}. */
  | 'subagent_thinking_block_complete'
  /** Sub-agent mirror of {@link reasoning_summary_delta}. */
  | 'subagent_reasoning_summary_delta'
  /** Sub-agent mirror of {@link reasoning_summary_block_complete}. */
  | 'subagent_reasoning_summary_block_complete'
  | 'subagent_tool_start'
  /**
   * Mirror of {@link tool_input_delta} scoped to a sub-agent. Lets the
   * IDE-style Write/Edit live-writing card render inside an
   * {@link AgentBlock} the same way it does for the main chat. Payload:
   * `agentId`, `toolUseId`, `toolName`, `partialJson`.
   */
  | 'subagent_tool_input_delta'
  | 'subagent_tool_result'
  | 'subagent_complete'
  | 'subagent_error'
  /**
   * Phase D (granularity uplift): per-iteration "model end" signal
   * forwarded from the sub-agent's agentic loop. Mirrors the
   * parent-chat per-stream usage hook but scoped to a sub-agent.
   * Useful for surfacing per-iteration token spend in the AgentBlock
   * before `subagent_complete` arrives. Carries an optional
   * `usage` payload — providers that don't report token usage on
   * stream end omit it.
   */
  | 'subagent_message_end'
  /**
   * Phase D — sub-agent ContextManager fired a compaction this turn.
   * Mirrors the parent-chat `context_compact` event but scoped to a
   * sub-agent run. UI may surface a compact pill on the AgentBlock.
   */
  | 'subagent_context_compact'
  /**
   * Phase D — sub-agent agentic loop reached `maxIterations`. Distinct
   * from `subagent_error` (which the legacy `onMaxIterationsReached`
   * branch also emits for back-compat). UI may render a "reached
   * limit (N/M)" badge instead of treating it as a generic failure.
   */
  | 'subagent_max_iterations'
  /**
   * Graceful wind-down fired — the sub-agent crossed a soft budget line
   * (read-only tool/token pressure, or approaching the iteration cap) and was
   * forced into ONE tool-free "write your report now" turn. UI may render a
   * "winding down (N/M)" badge so the forced report turn isn't mistaken for an
   * ordinary reply. Routed as a no-op passthrough until a visual consumer
   * wires up (same as `subagent_max_iterations`).
   */
  | 'subagent_winddown'
  | 'permission_request'
  | 'team_permission_request'
  /**
   * P0-2 (upstream §6.2): teammate worker called ExitPlanMode and is
   * blocked awaiting team-lead approval. Carries `teamRequestId`,
   * `workerAgentId`, `teamName`, `planMarkdown` (truncated). The
   * leader-side reply rides through the existing inter-agent mailbox
   * protocol (`SendMessage` with `schema:"plan_approval_response"`).
   */
  | 'team_plan_approval_request'
  /**
   * the IDE `create_plan`-style structured plan gate for the **main chat**
   * agent. Fires when `ExitPlanMode` is called outside a teammate /
   * TeamFile delegation context: the user IS the approver. Carries
   * `requestId`, `planMarkdown` (truncated to 24 KB) and an optional
   * `planEnvelope` with `name`, `overview`, `isProject`, `todos[]`,
   * `phases[]`. The renderer surfaces a `PlanApprovalCard` with three
   * buttons — Approve / Reject / Cancel — and replies via IPC
   * `ai:respond-plan-approval`, which calls
   * {@link resolveMainChatPlanApprovalResponse} in the main-process bridge.
   * Cancel additionally fires `cancelStream` to abort the current turn.
   */
  | 'plan_approval_request'
  | 'ask_user_question'
  | 'mode_changed'
  | 'file_change_applied'
  | 'context_compact'
  | 'context_compact_start'
  | 'tool_progress'
  | 'memory_recall'
  /**
   * P1-6 — post-stream retrieval citations. `workspace_recall` carries the
   * workspace-index code snippets that were auto-injected into this turn's
   * context; `attachment_recall` carries snippets recalled from earlier
   * attachments. Both are emitted once, after `message_stop`, mirroring
   * `memory_recall`. Payload on {@link StreamEvent.workspaceRetrieval} /
   * {@link StreamEvent.attachmentRetrieval}; surfaced by `RetrievalCitation`.
   */
  | 'workspace_recall'
  | 'attachment_recall'
  | 'error'
  | 'message_stop'
  | 'stream_fallback_reset'
  | 'subagent_stream_fallback_reset'
  | 'buddy_event'
  | 'debug_log'
  | 'user_message'
  | 'subagent_notification'
  | 'subagent_progress'
  | 'task:output-chunk'
  /**
   * V2 TaskManager lifecycle delta — `electron/tools/TaskManager.ts`
   * emits `{type, task}` on subscribe; the main process forwards
   * each event through `ai:stream-event` so the renderer's
   * `useTaskListV2Store` can merge it in real time. Payload lives
   * on {@link StreamEvent.taskV2Event} / {@link StreamEvent.taskV2Task}.
   */
  | 'task-v2:lifecycle'
  | 'tool_use_summary'
  | 'orchestration_phase'
  /**
   * Layer-E — emitted exactly once per `runAgenticLoop` invocation, *after*
   * `message_stop`, with the canonical {@link TerminationReason} (e.g.
   * `'max_turns'`, `'model_error'`, `'aborted_streaming'`,
   * `'output_budget_exhausted'`). Lets the renderer surface a one-click recovery
   * affordance when the loop ended in a way that likely left the user's
   * task incomplete. Carries `terminationReason`, `turnCount`,
   * `terminationDetail` (optional human-readable error string) and
   * `maxTurnsLimit` (when reason is `max_turns`).
   */
  | 'task_terminated'
  /**
   * Plan tab lifecycle (ExitPlanMode UX). `plan:active` fires when a plan
   * is approved + persisted to `.cursor/plans/*.plan.md`; `plan:updated`
   * fires each time `planRuntime.syncFileFromTasks` rewrites it as task
   * status changes. Payload on {@link StreamEvent.planFilePath} /
   * {@link StreamEvent.planContent}; consumed by `ensurePlanTabStream`.
   */
  | 'plan:active'
  | 'plan:updated'
  /**
   * Emitted ONCE when a genuinely backgrounded task (`isBackgrounded`) reaches
   * `completed`. The renderer's `autoResumeBackgroundTasks` controller uses this
   * as the precise auto-resume trigger — never inferred from raw
   * `task:output-chunk` (foreground commands + kills also produce those).
   */
  | 'background-task-completed'
  /**
   * Emitted by `electron/agents/mainAgentWakeup.ts` when a background
   * sub-agent reaches a terminal state (status: completed | failed) or a
   * team member finishes its current work and enters the idle mailbox
   * wait (status: idle). Same consumer as `background-task-completed`:
   * the renderer's `autoResumeBackgroundTasks` controller wakes an idle
   * main conversation so finished sub-agent / team work gets picked up
   * without a user message.
   */
  | 'subagent-terminal-wake'

export interface StreamEvent {
  type: StreamEventType
  /** Present when main process routes multi-conversation streams */
  conversationId?: string
  text?: string
  toolUse?: ToolUseBlock
  toolUseId?: string
  /** `tool_input_delta` payload — running accumulated JSON buffer for the in-flight tool_use. */
  partialJson?: string
  toolResult?: {
    id: string
    name: string
    success: boolean
    output?: string
    error?: string
    /**
     * Structured failure fields — see `ToolResult` in
     * `electron/tools/types.ts` and `buildToolFailure(...)` in
     * `electron/tools/toolErrorFormat.ts`. Optional; legacy tools that
     * only emit a flattened `error` string still work, the renderer
     * falls back to rendering it as a plain `<pre>`.
     */
    toolErrorClass?: string
    errorWhat?: string
    errorTried?: string[]
    errorContext?: Record<string, string | number | null | undefined>
    errorNext?: string[]
  }
  agentId?: string
  /**
   * `subagent-terminal-wake` only — number of background agents STILL actively
   * working (registry `running` and not parked in the idle mailbox wait) after
   * this wake. The auto-resume controller gates on this: it resumes the main
   * agent only when the cohort has settled (`=== 0`), so it is not woken
   * mid-flight while sibling sub-agents are still producing results. See
   * `electron/agents/mainAgentWakeup.ts` + `src/stores/chat/autoResumeBackgroundTasks.ts`.
   */
  outstandingActiveAgents?: number
  /** Agent 工具 tool_use.id：子智能体事件携带，用于把 UI 挂到对应工具卡片下 */
  parentToolUseId?: string
  agentType?: string
  description?: string
  result?: unknown
  error?: string
  requestId?: string
  /** §7.9 teammate → leader permission (paired with {@link team_permission_request}). */
  teamRequestId?: string
  workerAgentId?: string
  teamName?: string
  /**
   * P0-2: paired with `team_plan_approval_request`. The truncated plan
   * markdown the worker is asking the leader to approve. May be empty
   * when the worker called `ExitPlanMode` without a `planMarkdown`
   * argument — the leader should treat that as "trust me, ready to
   * implement" and decide based on chat context.
   */
  planMarkdown?: string
  /** P0-2: optional `allowedPrompts` from worker's ExitPlanMode call. */
  allowedPrompts?: Array<Record<string, unknown>>
  /**
   * Structured the IDE `create_plan`-style envelope carried by
   * `plan_approval_request` events. All optional — when omitted, the
   * renderer's `PlanApprovalCard` falls back to rendering just
   * `planMarkdown`.
   */
  planEnvelope?: {
    name?: string
    overview?: string
    isProject?: boolean
    todos?: Array<PlanTodo>
    phases?: Array<{ name: string; todos: Array<PlanTodo> }>
  }
  toolName?: string
  input?: Record<string, unknown>
  isDestructive?: boolean
  mode?: PermissionMode
  diffPreview?: DiffPreview
  questions?: AskQuestionItemDisplay[]
  /** When set (from main `TAICHU_ASK_USER_QUESTION_PREVIEW_FORMAT`), Ask UI may show option previews. */
  previewFormat?: 'markdown' | 'html'
  metadata?: Record<string, unknown>
  /**
   * `tool_progress` lifecycle phase.
   * - `start` / `end`: emitted by `runAgenticToolUseBody` (lifecycle markers).
   * - `chunk`: emitted via `ToolUseContext.emitToolProgress` from inside a
   *   running tool. Payload lives on the sibling `data` field (free-form
   *   per-tool JSON; see `ToolProgressEvent` in `electron/tools/toolExecContext.ts`).
   *   upstream alignment stage 2: replaces `setToolJSX` for streaming progress.
   */
  phase?: 'start' | 'chunk' | 'end'
  /** Main-process kernel FSM (`orchestration_phase`) — safe to ignore in UI */
  orchestrationPhase?: string
  orchestrationIteration?: number
  /** 附录 A 数据流阶段（`orchestrationPhase === 'appendix_a'`） */
  appendixAStage?: string
  appendixADocRef?: string
  appendixADetail?: Record<string, unknown>
  /** `tool_progress` end / `tool_use_summary` */
  success?: boolean
  filePath?: string
  originalContent?: string
  modifiedContent?: string
  /** When true, agent wrote without file diff permission gate — renderer should not open inline review. */
  autoCommitted?: boolean
  /** When true, user already approved via permission_request flow — do not add a second pending diff. */
  alreadyReviewedViaPermissionUi?: boolean
  thinkingTimeMs?: number
  /**
   * Present on `thinking_block_complete` / `subagent_thinking_block_complete`:
   * the canonical complete thinking-block payload from the provider, with an
   * optional cryptographic `signature` that must be round-tripped on the
   * next turn when the same assistant also had a `tool_use` block.
   */
  thinkingBlock?: { thinking: string; signature?: string; thinkingTimeMs?: number; thinkingTokens?: number }
  /**
   * Plan Phase 4 — present on `redacted_thinking_block` /
   * `subagent_redacted_thinking_block`: encrypted chain-of-thought blob.
   * Renderer stores verbatim into `ChatMessage.blocks` so the next turn's
   * `chatMessageToAgentApiRows` can echo it back (Anthropic 服务端要求
   * trajectory 连续）。
   */
  redactedThinkingBlock?: { data: string; startedAtMs?: number }
  /**
   * Present on `reasoning_summary_block_complete`: the canonical complete
   * summary payload from the provider. Distinct from
   * {@link thinkingBlock} — no signature (summaries don't round-trip),
   * shorter, semantically a TL;DR not the raw chain of thought.
   */
  reasoningSummaryBlock?: { text: string; thinkingTimeMs?: number; thinkingTokens?: number }
  /** Proactive message text from BriefTool / SendUserMessage */
  message?: string
  /** Status for notification events (completed/failed/killed) */
  status?: string
  /** §11.4 — e.g. `stream_fallback_reset` / sub-agent 529 tombstone */
  reason?: string
  /** Progress payload for subagent_progress events */
  progress?: {
    toolUseCount: number
    tokenCount: number
    lastToolName?: string
    durationMs: number
  }
  structuredSummary?: SubAgentStructuredSummary
  taskId?: string
  /** `plan:active` / `plan:updated` payload — absolute path of the persisted plan file. */
  planFilePath?: string
  /** `plan:active` / `plan:updated` payload — current full markdown content of the plan file. */
  planContent?: string
  stream?: 'stdout' | 'stderr' | 'text' | 'meta'
  timestamp?: number
  /**
   * `task-v2:lifecycle` payload — discriminator for the underlying
   * TaskManager lifecycle event kind. upstream parity: matches the
   * union shape returned by `TaskManager.subscribe()`.
   */
  taskV2Event?: 'created' | 'started' | 'completed' | 'failed' | 'cancelled' | 'output' | 'removed'
  /** `task-v2:lifecycle` payload — the affected task snapshot. */
  taskV2Task?: {
    taskId: string
    subject: string
    description?: string
    activeForm?: string
    status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled'
    owner?: string
    source?: string
    blockedBy: string[]
    metadata: Record<string, unknown>
    createdAt: number
    updatedAt: number
    startedAt?: number
    finishedAt?: number
    error?: string
    summary?: string
    runtimeKind?: string
    agentId?: string
    conversationId?: string
    parentTaskId?: string
  }
  // context_compact fields
  level?: string
  compactCount?: number
  lastCompactSummary?: string
  /** Structured memories injected into system prompt this turn (main → renderer citation UI). */
  recalledMemories?: Array<{
    filename: string
    name: string
    type: string
    matchSnippet: string
  }>
  /** P1-6 — workspace-index snippets auto-recalled into this turn's context (citation UI). */
  workspaceRetrieval?: Array<{
    filePath: string
    startLine: number
    endLine: number
    score?: number
    namespace?: string
    text: string
  }>
  /** P1-6 — attachment snippets auto-recalled into this turn's context (citation UI). */
  attachmentRetrieval?: Array<{
    namespace?: string
    score?: number
    text: string
    meta?: Record<string, unknown>
  }>
  // sub-agent fields
  name?: string
  // debug_log fields
  source?: string
  data?: unknown
  // ── Layer-E (`task_terminated`) ────────────────────────────────────────
  /**
   * Canonical termination reason from `electron/ai/queryTermination.ts`.
   * Renderer maps this to recoverable / non-recoverable buckets to decide
   * whether to show a one-click "继续未完成的任务" / retry affordance.
   */
  terminationReason?: TerminationReason
  /** When the loop ended on `max_turns`, the limit it was capped at. */
  maxTurnsLimit?: number
  /** Optional human-readable detail (e.g. provider error message). */
  terminationDetail?: string
  /** Iterations consumed before termination. */
  turnCount?: number
}
