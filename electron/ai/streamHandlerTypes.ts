/**
 * Stream handler types — shared across streamHandler, streamHandlerRegistry,
 * and any downstream modules that need to construct or consume stream events.
 */

import type { PermissionRulePayload } from './permissionRuleMatch'
import type { HookExecutionKind } from '../tools/hooks/types'
import type { ProviderId } from './client'
import type { PermissionMode } from './interactionState'
import type { TerminationReason } from './queryTermination'
import type { AnthropicThinkingCapability } from '../../src/types/providerCapabilities'

export interface SendMessageParams {
  /** `content` may be Anthropic-style string or multimodal block array from the renderer. */
  messages: { role: 'user' | 'assistant'; content: string | unknown }[]
  model?: string
  maxTokens?: number
  systemPrompt?: string
  workspacePath?: string
  providerId?: ProviderId
  apiKey?: string
  baseUrl?: string
  anthropicThinkingCapability?: AnthropicThinkingCapability
  awsRegion?: string
  projectId?: string
  outputStyle?: 'default' | 'concise' | 'explanatory'
  language?: string
  enableTools?: boolean
  /**
   * Per-turn permission-mode override (P0-1 fix: was previously typed as
   * the narrow legacy union `'allow' | 'ask' | 'deny'`, but the renderer
   * already passes `'plan'` and `'bypassPermissions'` for the input-bar
   * Plan / Bypass modes — `setPermissionMode` accepts the full union at
   * runtime, but TS callers either cast around it or never observed the
   * mismatch). Now uses the canonical {@link PermissionMode} so the
   * Plan-mode systemPrompt overlay (P1-2) and other consumers can
   * compare against `'plan'` without a cast.
   */
  permissionMode?: PermissionMode
  /**
   * Renderer chat-input mode (Agent / Plan / Ask). Forwarded to the orchestration
   * kernel's `getChatMode` so `PolicyEngine.evaluate` (the single PEP since Chunk 6)
   * can deny mutating tools at preflight under Plan mode and disable tools entirely
   * under Ask mode. Independent of {@link permissionMode}, which is the lower-level
   * permission policy; this one captures the user's product-level intent.
   * Defaults to `'agent'` when omitted.
   */
  chatInteractionMode?: 'agent' | 'plan' | 'ask'
  /** Diff / review: auto-apply file writes (see `runAgenticToolUse`). */
  diffPermissionMode?: 'default' | 'bypassPermissions'
  /** Settings → Permissions global tool policy for this turn. */
  permissionDefaultMode?: 'allow' | 'ask' | 'deny'
  /**
   * Inject passive LSP diagnostics into system prompt (default from settings `injectLspPassiveDiagnostics`).
   */
  injectLspPassiveDiagnostics?: boolean | 'full' | 'errors-only' | 'off'
  permissionRules?: PermissionRulePayload[]
  /** When \`Coordinator\`, main chat appends coordinator role prompt + worker tool surface (upstream coordinator mode parity). */
  agentType?: string
  /** Current chat id — drives ALS `streamConversationId` + context-collapse key. */
  conversationId?: string
  /** Settings → 深度思考 (extended reasoning). */
  alwaysThinking?: boolean
  /** Optional override for thinking budget tokens (Gemini / compatible Claude); 0 or omit uses disk + heuristics. */
  thinkingBudgetTokens?: number
  /** Settings → 快速模式（Anthropic fast-mode beta，见 client §12.4） */
  fastMode?: boolean
  /** Settings → 执行深度（映射到 Anthropic output_config.effort） */
  effortLevel?: string
  /** Settings → 自动任务路由（system prompt 注入子 Agent 建议） */
  autoTaskRouting?: boolean
  /** Settings → auto memory */
  autoMemoryEnabled?: boolean
  autoMemoryDirectory?: string
  /** Renderer settings → main-process hook registry for this turn (§9). */
  hooks?: Array<{
    id: string
    event: string
    command: string
    enabled: boolean
    matcher?: string
    async?: boolean
    asyncRewake?: boolean
    executionKind?: HookExecutionKind
  }>
  disableAllHooks?: boolean
  envVars?: Array<{ id: string; key: string; value: string; enabled: boolean }>
  /** Settings → Rules panel: merged via {@link buildMainSystemPromptLayersFromOrchestration} */
  userRulesPrompt?: string

  // Audit P1-2 (2026-05): `retrievalAttachments?: Array<{ sha256, kind }>`
  // was declared here but every IPC caller and in-process caller of
  // `handleSendMessage` left it undefined. Attachment semantic RAG runs in
  // the renderer via `retrieveWithBudget` / `retrieveAttachmentChunks` and
  // is folded into the API message body by `contextBuilder.ts`; the main-
  // process `startRetrievalPrefetch` path is reserved for memory + workspace
  // code only. Field removed to stop the dead branch.

  // ─── Workbench primary-agent overlay ───
  //
  // Renderer 的 `storeCompose.sendMessage` 会从激活 bundle 的 primary agent
  // 上读这些字段填过来,让主对话遵守 bundle 里配的"人设+规则+技能+钩子"。
  // 任一字段为 undefined 表示"沿用 settings / 默认"。
  /** 追加到 systemPrompt 最前面的 "critical reminder" 段落(最高优先级)。 */
  primaryAgentCriticalReminder?: string
  /** 追加到 systemPrompt 末尾的 "initial prompt" 段落(会话启动上下文)。 */
  primaryAgentInitialPrompt?: string
  /** 主智能体预加载的 skill id 列表,展开成 `## Preloaded skills` 区段附加到 systemPrompt。 */
  primaryAgentSkills?: string[]
  /** 只读模式:为 permissionRules 追加 Write/Edit/NotebookEdit/Bash 的 deny 规则。 */
  primaryAgentIsReadOnly?: boolean
  /** 主智能体级钩子,前置拼入 params.hooks(相同 matcher 下优先触发)。 */
  primaryAgentHooks?: SendMessageParams['hooks']
  /** 省略 CLAUDE.md/memory 注入(主智能体声明 omitClaudeMd 时)。 */
  primaryAgentOmitClaudeMd?: boolean
  /** 主智能体的工具白名单。非空/非 `['*']` 时,主对话只暴露交集。 */
  primaryAgentTools?: string[]
  /** 主智能体的工具黑名单(与白名单互斥,白名单优先)。 */
  primaryAgentDisallowedTools?: string[]
  /** 主智能体的 MCP 服务器白名单(名字数组)。非空时过滤 `mcp__*` 工具。 */
  primaryAgentMcpServers?: string[]
  /** 主智能体的 memory scope(暂时只透传,未来给主对话 memory 召回过滤用)。 */
  primaryAgentMemoryScope?: 'user' | 'project' | 'local'
}

/** Content shape accepted by {@link AgenticLoopParams.messages} and `streamText`. */
export type ApiMessageContent = string | Array<Record<string, unknown>>

export function normalizeMessageContentForApi(content: string | unknown): ApiMessageContent {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content as Array<Record<string, unknown>>
  if (content !== null && typeof content === 'object') {
    return [content as Record<string, unknown>]
  }
  return String(content ?? '')
}

export type ApiChatMessage = { role: 'user' | 'assistant'; content: ApiMessageContent }

export function toApiChatMessages(msgs: SendMessageParams['messages']): ApiChatMessage[] {
  return msgs.map((m) => ({
    role: m.role,
    content: normalizeMessageContentForApi(m.content),
  }))
}

export type StreamEventType =
  | 'text_delta'
  | 'thinking_delta'
  /**
   * Emitted once when a `type:'thinking'` content block fully completes on the
   * wire (after all `thinking_delta` + `signature_delta` SSE frames arrive).
   * The payload carries the canonical, whole-block text and, on providers that
   * produce it (Anthropic native / DeepSeek Anthropic-compat / Claude-via-
   * Bedrock/Vertex/Foundry), a cryptographic `signature` string that the
   * renderer must round-trip on subsequent requests whenever the assistant
   * message also contains a `tool_use` block — otherwise the next request
   * returns `HTTP 400 "content[].thinking in the thinking mode must be passed
   * back to the API"` (DeepSeek wording) / `"thinking blocks must appear
   * exactly as provided by Anthropic"` (Anthropic native wording).
   *
   * The renderer overwrites the currently-streaming `ChatBlock` thinking.text
   * with this canonical payload and stores the signature on the block so the
   * next turn's {@link chatMessageToAgentApiRows} can forward it.
   */
  | 'thinking_block_complete'
  /**
   * Plan Phase 4 — `redacted_thinking` 块（启用 REDACT_THINKING beta 时，
   * Anthropic 返回的加密 chain-of-thought）已经在 wire 上到位。Payload
   * 携带的是 `data` blob（无 model-visible 文本）— 渲染端只显示 "✻
   * Thinking (私密推理已加密)" 占位，但必须把 data 存进 `ChatMessage.blocks`
   * 以便 `chatMessageToAgentApiRows` 下一轮原样回灌（否则服务端 trajectory
   * 不连续报错）。
   *
   * 与 `thinking_block_complete` 的差异：
   *   - 没有 `signature`（redacted blob 本身就是加密信封）
   *   - 没有 `thinking` 文本字段
   *   - UI 不允许展开（因为没东西可读）
   */
  | 'redacted_thinking_block'
  /** Sub-agent mirror of {@link redacted_thinking_block}. */
  | 'subagent_redacted_thinking_block'
  /**
   * Per-delta token of an OpenAI Responses API reasoning *summary* —
   * the safe-to-show TL;DR of the chain of thought, distinct from raw
   * `thinking_delta`. The pseudo-Claude SSE delta type
   * `reasoning_summary_delta` (see `claudeToOpenAI2.ts`) is translated
   * out of the provider stream into this event by `streamHandler.ts`.
   *
   * Surfaced in the renderer as its own ChatBlock kind
   * (`reasoning_summary`) — NOT merged into the `thinking` block.
   * Differences in semantics:
   *   - no `signature`, no cross-turn echo invariant
   *   - typically short (a few sentences)
   *   - presented as a separate collapsible row with distinct chrome
   */
  | 'reasoning_summary_delta'
  /** Fires after all `reasoning_summary_delta` for one block arrive. */
  | 'reasoning_summary_block_complete'
  | 'message_start'
  | 'message_stop'
  | 'orchestration_phase'
  | 'stream_fallback_reset'
  | 'error'
  | 'tool_start'
  /**
   * Fires while a `tool_use` content block is still streaming its JSON
   * arguments (anthropic-compat `input_json_delta`). Lets the renderer
   * surface the model's in-progress `content` / `newString` for
   * Write/Edit tools before the tool executes — IDE-style live
   * diff view. Cleared by the natural arrival of `tool_start` once the
   * parsed `input` becomes authoritative.
   */
  | 'tool_input_delta'
  | 'tool_result'
  | 'subagent_start'
  | 'subagent_text'
  | 'subagent_thinking_block_complete'
  /** Sub-agent mirror of {@link reasoning_summary_delta}. */
  | 'subagent_reasoning_summary_delta'
  /** Sub-agent mirror of {@link reasoning_summary_block_complete}. */
  | 'subagent_reasoning_summary_block_complete'
  | 'subagent_tool_start'
  /** Mirror of {@link tool_input_delta} scoped to a sub-agent. */
  | 'subagent_tool_input_delta'
  | 'subagent_tool_result'
  | 'subagent_complete'
  | 'subagent_error'
  | 'permission_request'
  | 'ask_user_question'
  | 'mode_changed'
  | 'context_compact'
  | 'context_compact_start'
  | 'tool_progress'
  | 'tool_use_summary'
  | 'memory_recall'
  | 'workspace_recall'
  | 'attachment_recall'
  /**
   * Layer-E — emitted exactly once per `runAgenticLoop` invocation,
   * *after* `message_stop`, with the canonical
   * {@link TerminationReason}. Wired by `streamHandler.ts` through a
   * scoped `registerTerminationCleanup` callback. Renderer chat store
   * stashes the reason so {@link TerminationRecoveryBanner} can offer
   * a one-click "继续未完成的任务" affordance for recoverable failures.
   */
  | 'task_terminated'
  /**
   * Audit P0-2c (2026-05): companion / buddy reaction sourced from
   * `electron/buddy/service.ts#buildBuddyEventFromStream`. Carries `mood` +
   * bubble `text` + a `state` snapshot so the renderer
   * (`src/stores/chat/mainStreamRouter.ts → useBuddyStore.applyStreamEvent`)
   * can move the on-screen sprite without polling. Mirrors the renderer-side
   * `StreamEventType` union in `src/types/tool.ts`.
   */
  | 'buddy_event'

export interface StreamEvent {
  type: StreamEventType
  text?: string
  usage?: { inputTokens: number; outputTokens: number }
  status?: string
  reason?: string
  error?: string
  toolUse?: { id: string; name: string; input: Record<string, unknown> }
  toolResult?: { id: string; name: string; success: boolean; output?: string; error?: string }
  /** `tool_input_delta` payload — id of the in-flight tool_use block. */
  toolUseId?: string
  /** `tool_input_delta` payload — tool name (mirrors the upcoming `tool_start.toolUse.name`). */
  toolName?: string
  /** `tool_input_delta` payload — accumulated JSON args buffer (not the per-event delta). */
  partialJson?: string
  /**
   * Present on `thinking_block_complete` / `subagent_thinking_block_complete`:
   * the complete thinking-block payload the model produced, including its
   * cryptographic signature when applicable. See {@link StreamEventType} for
   * the full rationale.
   */
  thinkingBlock?: { thinking: string; signature?: string; thinkingTimeMs?: number; thinkingTokens?: number }
  /**
   * Plan Phase 4 — present on `redacted_thinking_block` /
   * `subagent_redacted_thinking_block`: encrypted chain-of-thought blob to
   * be stored verbatim and echoed back on the next turn.
   */
  redactedThinkingBlock?: { data: string; startedAtMs?: number }
  /**
   * Present on `reasoning_summary_block_complete`: the canonical complete
   * summary text the provider emitted. See {@link StreamEventType} for
   * the cross-turn semantics (output-only, no signature).
   */
  reasoningSummaryBlock?: { text: string; thinkingTimeMs?: number; thinkingTokens?: number }
  level?: string
  /**
   * `context_compact` event payload — pre/post `estimatedTokens` snapshot
   * around the host-side compaction action. Best-effort: callers that can
   * compute the delta set them; legacy / fallback emissions may omit.
   * Surfaced in the UI boundary divider as "freed Nt".
   */
  preTokens?: number
  postTokens?: number
  reclaimedTokens?: number
  /** Multi-tab routing when main emits kernel telemetry */
  conversationId?: string
  /** `orchestration_phase` — kernel FSM (renderer may ignore) */
  orchestrationPhase?: string
  orchestrationIteration?: number
  /** 阶段 2.1 — inner model-call counter within the current outer turn (0-based, reset per turn). */
  orchestrationInnerIteration?: number
  /**
   * 阶段 2.4 — emitted when the PermissionPort pre-flight denies a tool_use. Renderer can surface
   * "blocked by policy" badges. Present only when `orchestrationPhase === 'permission_denied_preflight'`.
   */
  permissionDenial?: {
    toolName: string
    toolUseId: string
    reason: string
    matchedRule?: string
  }
  /** 阶段 2.5 — reason supplied to `OrchestrationKernel.interrupt(reason)`. */
  interruptReason?: string
  /**
   * Bug B fix — HITL pause payload. Present when `orchestrationPhase === 'interrupt'`
   * AND `interruptReason === 'hitl'`. Carries the toolUseId / question / kind
   * the kernel paused on, so the renderer's `mainStreamRouter` can populate
   * `ChatState.hitlPaused` and `AskUserQuestionDialog` can show the
   * "可重启续接" durable badge.
   */
  hitlPending?: {
    toolUseId: string
    question: unknown
    kind: 'ask_user_question' | 'permission_ask'
  }
  /**
   * P2-1 — HITL persistence-failure payload. Present when
   * `orchestrationPhase === 'hitl_persistence_failed'`. Carries the
   * disk-write failure reason + the count of `pending_human_resume`
   * inbox items at risk of being lost on the next process crash. Renderer
   * surfaces this as a toast prompting the user to re-submit their last
   * AskUserQuestion answer.
   */
  hitlPersistenceFailed?: {
    reason: 'disk_error' | 'cleanup_failed'
    error: string
    pendingHumanResumeCount: number
  }
  /** 阶段 4.5 — consolidated artifact manifest emitted at Terminal. */
  artifactManifest?: {
    turn: number
    entries: Array<{
      id: string
      kind: string
      label?: string
      producer: string
      producerTurn?: number
      producerInnerTurn?: number
      payload: Record<string, unknown>
      at: number
    }>
  }
  /**
   * Audit P2-1 — kernel outer-loop telemetry. Present only when
   * `orchestrationPhase === 'outer_loop_complete'`. One event per
   * `runDriveMainChat` exit; dashboards can plot the `iterations`
   * distribution and alarm on `overflowed: true`.
   */
  outerLoopStats?: {
    iterations: number
    overflowed: boolean
    exitReason: 'completed' | 'aborted' | 'overflow' | 'error'
    terminationReason?: TerminationReason
    inboxRemaining: number
    maxOuterIterations: number
  }
  /**
   * Audit P2-2 — transcript clone degradation signal. Present only when
   * `orchestrationPhase === 'transcript_clone_degraded'`.
   */
  transcriptCloneDegraded?: {
    mode: 'json' | 'frozen-shared'
    error: string
    secondaryError?: string
    messageCount: number
  }
  /**
   * Contract audit (2026-07) — Terminal-commit dual-source divergence.
   * Present only when `orchestrationPhase === 'transcript_drift'`. Emitted
   * when `AgentContext.messages` and the kernel transcript disagree on length
   * at Terminal commit (commit resolves in favour of AgentContext).
   */
  transcriptDrift?: {
    agentContextLength: number
    kernelTranscriptLength: number
    agentContextFingerprintPrefix?: string
    kernelFingerprintPrefix?: string
    resolvedWith: 'agent_context' | 'kernel'
    checkpoint?: 'terminal_commit' | 'iteration_boundary'
  }
  transcriptConflict?: {
    source: 'renderer_seed' | 'agent_loop' | 'inbox' | 'compaction' | 'rewind'
    expectedRevision: number
    actualRevision: number
    incomingFingerprintPrefix: string
    currentFingerprintPrefix: string
  }
  /**
   * P1 (audit §5.2) — preemption telemetry. Present only when
   * `orchestrationPhase === 'tool_preempted'`. Lets the renderer surface a
   * "X paused so Y could run" badge instead of silently dropping the
   * victim's tool_result.
   */
  preemption?: {
    victimToolUseId: string
    victimToolName?: string
    incomingToolUseId: string
    incomingToolName: string
    resource: 'shell' | 'network' | 'mutation'
    victimPriority?: number
    incomingPriority: number
  }
  /**
   * Contract audit (2026-07) — scheduler hold / quota backpressure wait.
   * Present only when `orchestrationPhase === 'scheduler_backpressure'`.
   */
  schedulerBackpressure?: {
    toolName: string
    toolUseId: string
    kind: 'scheduler_hold' | 'quota_backpressure'
    reason?: string
    waitedMs?: number
  }
  /** 附录 A 数据流阶段（`orchestrationPhase === 'appendix_a'` 时） */
  appendixAStage?: string
  appendixADocRef?: string
  appendixADetail?: Record<string, unknown>
  /** P0 memory recall prefetch result (non-blocking, arrives mid/post-stream). */
  recalledMemories?: Array<{
    filename: string
    name: string
    type: string
    matchSnippet: string
  }>
  /**
   * Workspace code semantic top-K from the retrieval prefetch pipeline.
   * Emitted as a `workspace_recall` event when the workspace branch
   * settles mid/post-stream.
   */
  workspaceRetrieval?: Array<{
    filePath: string
    startLine: number
    endLine: number
    score: number
    namespace: string
    text: string
  }>
  /**
   * Attachment RAG top-K hits (PDF / Office / CSV / text). Emitted as an
   * `attachment_recall` event when the attachment branch settles.
   */
  attachmentRetrieval?: Array<{
    namespace: string
    score: number
    text: string
    meta?: Record<string, unknown>
  }>
  // ── Layer-E (`task_terminated`) ──────────────────────────────────────
  /** Canonical {@link TerminationReason} from `queryTermination.ts`. */
  terminationReason?: TerminationReason
  /** When the loop ended on `max_turns`, the limit it was capped at. */
  maxTurnsLimit?: number
  /** Optional human-readable detail (e.g. provider error message). */
  terminationDetail?: string
  /** Iterations consumed before termination. */
  turnCount?: number
}
