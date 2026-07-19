import type { AgentId } from '../ids'
import type { PermissionMode } from './permissions'

// ============================================================================
// Todo Types
// ============================================================================

export type TodoItem = {
  content: string
  /**
   * Five-status union — `failed` / `cancelled` are projected from V2
   * `TaskManager` tasks (see `TodoPanel.tsx#taskV2ToTodoItem`). V1
   * `TodoWrite` only ever emits the first three (validated by the
   * tool's `call()`), but the renderer-side type carries the V2
   * superset so a single panel renders both modes coherently.
   */
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled'
  activeForm: string
  /** Task source — who created it */
  source?: 'user' | 'agent' | 'system' | 'todo_sync'
  /** Agent type executing this task */
  owner?: string
  /** User-readable current state */
  summary?: string
  /** Parent task for hierarchical display */
  parentTaskId?: string
}

// ============================================================================
// Chat UI Types
// ============================================================================

export type CodeBlock = {
  language: string
  fileName?: string
  code: string
}

export type ToolUseDisplay = {
  id: string
  name: string
  input: Record<string, unknown>
  status: 'running' | 'completed' | 'error' | 'failed' | 'stopped'
  result?: string
  error?: string
  /**
   * Structured failure fields, mirrored from `ToolResult.error*` via the
   * `tool_result` stream event. When present, the renderer surfaces the
   * headline / recovery hints as styled regions instead of grep-ing the
   * flattened `error` string. All optional — legacy tools omit them and
   * the UI falls back to rendering `error` verbatim.
   */
  toolErrorClass?: string
  errorWhat?: string
  errorTried?: string[]
  errorContext?: Record<string, string | number | null | undefined>
  errorNext?: string[]
  /**
   * Streaming progress accumulated from `tool_progress` (phase `chunk`) events.
   * Populated by `mainStreamRouter` while the tool is still running; cleared
   * (or simply ignored by the renderer) once `result` is set. upstream
   * alignment stage 2 — IPC-serialized replacement for `setToolJSX` mid-run.
   *
   * `text` is the running concatenation of textual chunks (when the tool emits
   * `{ type: 'text_chunk' \| 'stdout' \| 'stderr', data: { text } }`). `events`
   * keeps every chunk untouched for tools that ship richer JSON payloads (e.g.
   * partial web-search results, todo list deltas).
   */
  streamingProgress?: {
    text?: string
    events?: ToolProgressEvent[]
  }
  /**
   * Mid-block model-time streaming for `tool_use` arguments — populated by
   * `tool_input_delta` events while the provider is still emitting
   * `input_json_delta` chunks. `partialJson` is the cumulative accumulated
   * buffer (not the per-event delta) so consumers don't have to re-stitch
   * deltas themselves. Cleared once `tool_start` lands and `input` is
   * authoritative. Distinct from `streamingProgress` (which is
   * tool-execution-time progress emitted from inside the tool's
   * `call(...)`).
   */
  streamingInput?: {
    partialJson: string
  }
}

/**
 * Mirrors `electron/tools/toolExecContext.ts` — re-declared here so the
 * renderer's typed store and IPC payload share one shape without taking a
 * cross-process import dependency. Keep the two definitions in sync.
 */
export type ToolProgressEvent = {
  type: string
  data: unknown
}

export type SubAgentStructuredSummary = {
  completedWork: string[]
  evidence: string[]
  remaining: string[]
  nextStep?: string
}

export type SubAgentDisplay = {
  agentId: AgentId
  agentType: string
  description: string
  name?: string
  status: 'running' | 'completed' | 'failed'
  output?: string
  /** Provider thinking stream — shown in UI only; not sent to the parent model in tool results. */
  thinking?: string
  isThinking?: boolean
  /**
   * Wall-clock duration of the sub-agent's most recent `type:'thinking'`
   * content block, stamped from `subagent_thinking_block_complete`. Lets the
   * `<ThinkingBlock>` inside `AgentBlock` snap to the authoritative elapsed
   * time on streaming end instead of relying only on its in-component tick
   * (which resets to 0.0s on remount). Parent-chat blocks carry the same
   * field on their `ContentBlock<'thinking'>`.
   */
  thinkingTimeMs?: number
  /**
   * Approximate output-token cost of the sub-agent's most recent thinking
   * block. Sibling to {@link thinkingTimeMs} — surfaced together in the
   * `<ThinkingBlock>` meta strip as `· ~1.3k tok`. See
   * `electron/ai/anthropicCompatHttp.ts#estimateThinkingTokens` for the
   * heuristic; this is **not** a billing-accurate count.
   */
  thinkingTokens?: number
  /**
   * Provider-emitted reasoning summary (OpenAI Responses safe-to-show
   * TL;DR) for this sub-agent. Rendered as a separate
   * `<ReasoningSummaryBlock>` row inside `AgentBlock`, parallel to but
   * distinct from {@link thinking}. Never echoed back to the parent
   * model (output-only by API contract).
   */
  reasoningSummary?: string
  /** True while a summary stream is currently open on the sub-agent's wire. */
  isReasoningSummarising?: boolean
  /** Wall-clock duration of the most recent summary block on the wire. */
  reasoningSummaryTimeMs?: number
  /** Approximate output-token cost of the most recent summary block. */
  reasoningSummaryTokens?: number
  toolUses: ToolUseDisplay[]
  totalDurationMs?: number
  totalTokens?: number
  totalToolUses?: number
  lastToolName?: string
  structuredSummary?: SubAgentStructuredSummary
  /** ID of the parent tool_use block (agent tool) this sub-agent belongs to */
  parentToolId?: string
  /**
   * Latest `TodoWrite` snapshot from this sub-agent. Scoped to the sub-agent
   * (not merged into the main conversation's top-level todos) — the renderer
   * surfaces this as a mini task panel inside the sub-agent block.
   *
   * Populated by the `subagent_tool_result` handler in `storeCompose.ts` when
   * a `TodoWrite` call succeeds. Cleared implicitly when the sub-agent run
   * ends (the main-process `todoStore` is reset in `finalizeSubAgentLifecycle`).
   */
  todos?: TodoItem[]
}

// ============================================================================
// Attachment types for multimodal messages
// Keep in sync with `electron/attachments/types.ts`.
// ============================================================================

/** Coarse attachment category used by the ingest pipeline + renderer UI. */
export type AttachmentKind =
  | 'image'
  | 'pdf'
  | 'docx' | 'doc' | 'rtf'
  | 'xlsx' | 'xls' | 'csv' | 'tsv'
  | 'pptx' | 'ppt'
  | 'text' | 'markdown' | 'code' | 'json' | 'yaml' | 'xml' | 'html'
  | 'ipynb'
  | 'unknown'

/** Lifecycle of a file attachment ingested via drag-drop / paste / picker. */
export type AttachmentStatus = 'pending' | 'processing' | 'ready' | 'error'

/**
 * Extracted-text + sidecar payload for a `type:'file'` attachment. The
 * ingest pipeline fills this when the file content could be parsed into
 * plain text; non-parseable binaries leave it empty.
 */
export type FileAttachmentPayload = {
  pdf?: {
    /** Inline PDF bytes — only present for files ≤ MAX_PDF_BYTES. */
    base64?: string
    pageCount?: number
    sizeBytes?: number
    /** True when bytes skipped the provider-block cap; UI falls back to file://. */
    oversized?: boolean
  }
  text?: {
    content: string
    truncated: boolean
    originalChars: number
  }
  pageImages?: Array<{
    page: number
    base64: string
    mediaType: 'image/jpeg' | 'image/png'
    source?: 'pdftoppm' | 'pdfjs-canvas'
  }>
  sheets?: Array<{
    name: string
    rowCount: number
    colCount: number
    truncatedRows?: boolean
    truncatedCols?: boolean
    hasFormulas?: boolean
    mergeCount?: number
  }>
  /** Docx inline images (see electron/attachments/office.ts). */
  inlineImages?: Array<{ base64: string; mediaType: string; altText?: string }>
  /** Non-fatal remarks produced during ingest (e.g. "poppler not installed"). */
  notes?: string[]
}

export type Attachment =
  | {
      type: 'image'
      name: string
      base64: string
      mediaType: string
      size: number
      sha256?: string
    }
  | ({
      type: 'file'
      name: string
      path: string
      size: number
      kind?: AttachmentKind
      mimeType?: string
      sha256?: string
      status?: AttachmentStatus
      error?: string
    } & FileAttachmentPayload)

/**
 * Display-friendly record for a RAG retrieval hit. Persisted on the
 * `ChatMessage.retrievedChunks` array so the UI can render pills under
 * the user bubble that open `RetrievedChunkPreview` when clicked.
 */
export type RetrievedChunkDisplay = {
  id: string
  attachmentName: string
  attachmentKind?: AttachmentKind
  headingPath?: string
  text: string
  score: number
  attachmentSha?: string
  rank: number
}

// Ordered content block — preserves chronological interleaving of
// text, thinking, and tool calls within a single assistant message.
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; base64: string; mediaType: string }
  | {
      type: 'thinking'
      text: string
      isStreaming?: boolean
      thinkingTimeMs?: number
      /**
       * Approximate output tokens spent on this thinking block. Sourced from
       * a length-based heuristic (`Math.round(text.length / 4)`) at block
       * finalisation time when the provider doesn't carry a per-block
       * `thinking_tokens` field on the wire (Anthropic counts thinking under
       * `output_tokens` aggregate; OpenAI exposes it on Responses API only).
       *
       * Surfaced as `· ~1.3k tok` next to the timer so users can size up the
       * cost of a turn at a glance. Conservative rounding: we don't try to
       * be billing-accurate, just order-of-magnitude correct.
       */
      thinkingTokens?: number
      /**
       * Anthropic-Messages-style thinking block signature, captured from the
       * completed SSE block on providers that support it (Anthropic native /
       * DeepSeek Anthropic-compat). Required on subsequent requests when the
       * assistant also emits a `tool_use` block — DeepSeek's Anthropic-compat
       * gateway returns `HTTP 400 "content[].thinking in the thinking mode
       * must be passed back to the API"` if the thinking payload is missing
       * from an earlier turn's assistant message.
       *
       * Currently optional — not yet plumbed through the stream events; see
       * {@link chatMessageToAgentApiRows} which forwards it when present.
       */
      signature?: string
      /**
       * Timestamp (ms) at which this block's `text` was truncated by the
       * persistence-layer compaction pass (see settings flag
       * `compactThinkingOnSave` and
       * `conversationPersistence.ts#compactThinkingInMessages`). When
       * non-null:
       *
       *   - `text` no longer contains the full chain of thought; only a
       *     short preview prefix + an elided-count suffix.
       *   - `signature` is intentionally absent — truncating the text
       *     would invalidate any cryptographic signature on it.
       *   - `thinkingTimeMs` / `thinkingTokens` remain present so the UI
       *     can still surface the original cost / duration metadata.
       *
       * Renderer surfaces a subtle "(truncated)" hint when this is set.
       */
      compactedAt?: number
    }
  | {
      /**
       * Provider-emitted TL;DR of the reasoning. Distinct from `thinking`:
       *
       *   - **Source**: OpenAI Responses API `output[].type === 'reasoning'`
       *     produces a `summary[]` of `{type: 'summary_text', text}` parts.
       *     This is the model's *own* summary of its chain of thought,
       *     considered safe for end-user display (whereas raw o-series
       *     thinking is restricted by OpenAI's ToS).
       *   - **Rendering**: shorter than raw thinking; rendered as its own
       *     collapsible row with a distinct chrome (no structured sections
       *     parser — summaries are short by design).
       *   - **Cross-turn replay**: NOT echoed back to the model — summaries
       *     are output-only by API contract and don't carry signatures.
       *   - **Merge behaviour**: treated as a third soft-merge peer
       *     alongside `text` and `thinking` (see
       *     `applyBatchedDeltas.getBlockMergeKind`), so per-token
       *     interleaved deltas across all three channels collapse to ONE
       *     block of each kind per section.
       */
      type: 'reasoning_summary'
      text: string
      isStreaming?: boolean
      thinkingTimeMs?: number
      thinkingTokens?: number
    }
  | {
      /**
       * Plan Phase 4 — Anthropic `redacted_thinking` content block.
       *
       * 服务端把 chain-of-thought 加密封装：客户端读不到 model-visible 内容，
       * 但下一轮请求**必须**把 `data` 原样回灌（参见 `chatMessageToAgentApiRows`），
       * 否则 Anthropic 服务端会因为 trajectory 不连续而拒签。
       *
       * 收益：用户隐私（chain-of-thought 不落地）+ "主模型读不到自己的旧
       * 推理"从根本上消除"基于过时思考的幻觉"链路（upstream-main 早期就是
       * 用这条路径的默认配置）。
       *
       * 触发：服务端启用 `REDACT_THINKING` beta（由
       * `electron/ai/anthropicThinkingApiContext.ts#getAnthropicThinkingApiContext`
       * 在 `POLE_ANTHROPIC_REDACT_THINKING !== '0'` 时下发）。
       */
      type: 'redacted_thinking'
      /** Anthropic 加密后的 chain-of-thought blob；echo verbatim 即可。 */
      data: string
      /** True 仅在 streaming 期间；redacted 块通常一帧到位。 */
      isStreaming?: boolean
      /** Wall-clock when the block opened — parity with `thinking` metadata. */
      startedAtMs?: number
    }
  | {
      type: 'tool_use'
      id: string
      name: string
      input: Record<string, unknown>
      status: 'running' | 'completed' | 'error' | 'failed' | 'stopped'
      result?: string
      error?: string
      taskId?: string
      // Structured failure fields, mirrored from the `tool_result` stream
      // event onto the block (see `mainStreamRouter` tool_result handler) so
      // the blocks render path can surface the same headline / recovery hints
      // as `ToolUseDisplay`. All optional; legacy tools omit them.
      toolErrorClass?: string
      errorWhat?: string
      errorTried?: string[]
      errorContext?: Record<string, string | number | null | undefined>
      errorNext?: string[]
    }
  | {
      type: 'ask_user_question'
      requestId: string
      questions: AskQuestionItemDisplay[]
      metadata?: Record<string, unknown>
      previewFormat?: 'markdown' | 'html'
      status: 'pending' | 'answered'
      answers?: Record<string, string>
    }

/**
 * Metadata for a system-inserted compact boundary marker (see `kind`).
 *
 * Emitted by the host-side context manager when any compaction action
 * completes (`history_snip` / `soft_clear` / `micro_compact` /
 * `auto_compact` / `reactive_compact` / `stripped_image` / `block_micro`).
 * The renderer surfaces this as a non-interactive dim horizontal divider
 * so users can SEE that compression happened at this point in the
 * transcript — bridging the trust gap between "AI suddenly forgets
 * detail" and "host quietly compacted on iteration N".
 *
 * Token deltas are best-effort: `preTokens`/`postTokens` are pre- and
 * post-evaluation `estimatedTokens`, `reclaimedTokens = max(0, pre - post)`.
 * All three are optional — for paths that don't expose a delta (e.g.
 * legacy emissions) the divider still renders, just without the
 * "freed Nt" suffix.
 */
export type CompactBoundaryDetail = {
  level: string
  preTokens?: number
  postTokens?: number
  reclaimedTokens?: number
}

export type ChatMessage = {
  id: string
  role: 'user' | 'assistant'
  /**
   * Optional discriminator. When set, this message is a system-inserted
   * artifact (NOT a real conversational turn) and renders via a dedicated
   * branch in `ChatMessage.tsx`. Such entries are filtered out before
   * `apiMessageBuilder` ships history to the model — they exist purely
   * for the user-facing transcript.
   *
   * Current values:
   *   - 'compact_boundary' — see {@link CompactBoundaryDetail}
   */
  kind?: 'compact_boundary'
  /** Populated when `kind === 'compact_boundary'`. */
  compactBoundary?: CompactBoundaryDetail
  content: string
  timestamp: number
  isStreaming?: boolean
  /**
   * @deprecated G: legacy top-level thinking-text mirror, superseded by
   * `blocks[].type === 'thinking'`. New writes no longer populate this
   * field — see `applyBatchedDeltas.ts` and `mainStreamRouter.ts`. The
   * type still declares it so old conversation JSON loaded from disk
   * round-trips through the renderer; `ChatMessage.tsx`'s legacy
   * fallback branch reads it when `blocks` is empty so
   * pre-blocks history still renders. Plan: remove the type field
   * after one release window of clean writes confirms no consumer
   * regression.
   */
  thinking?: string
  /** @deprecated G: see {@link thinking}. Same lifecycle / removal plan. */
  isThinking?: boolean
  blocks?: ContentBlock[]
  toolUses?: ToolUseDisplay[]
  subAgents?: SubAgentDisplay[]
  codeBlocks?: CodeBlock[]
  referencedFiles?: string[]
  attachments?: Attachment[]
  /** RAG retrieval trace — pills rendered under user bubbles. */
  retrievedChunks?: RetrievedChunkDisplay[]
  /**
   * 2026-07 interruption-protocol fix — set by `sendSlice.cancelMessage`
   * when the user pressed Stop while THIS assistant message was still
   * streaming / had running tools. Consumed by
   * `contextBuilder.chatMessageToAgentApiRows`, which appends a
   * `[User interrupted during …]` user row after the message's API rows
   * so the NEXT turn's model knows the reply was cut off mid-flight
   * (upstream parity: cc-haha injects INTERRUPT_MESSAGE as a user turn
   * on every user cancel). Without this the model sees a truncated
   * assistant turn that looks like a deliberate, complete reply.
   */
  interruptedByUser?: boolean
  /**
   * Plan Phase 2.B — Streaming fallback 空壳治理标记。
   *
   * 设置场景：`mainStreamRouter#stream_fallback_reset` 在 Anthropic 529 触发
   * 非流式 fallback 时，把当前 assistant 消息清空（content/thinking/blocks/
   * toolUses 全部置空）以避免半截 thinking 被持久化。这个标记额外标识"消息
   * 壳本身已经废弃" — 下游消费者据此：
   *   1. `chatMessageToAgentApiRows` early return [] — 不把空壳回灌给模型
   *      （否则 history 里会出现一条 role=assistant content=[] 的占位 →
   *      `ensureNonEmptyAssistantContent` 会换成 '...' → 模型困惑模仿）
   *   2. `ChatMessage.tsx` 在 !isStreaming 时 return null — UI 不渲染
   *      已经废弃的空卡片
   *   3. `cleanMessagesForPersist` 整条丢弃 — 重启后历史里不会有空壳残留
   *
   * 命名约定：`_` 前缀 = 内部 metadata，绝不发到 API wire（与 `_virtual`、
   * `_compactBoundary` 等同类）。
   */
  _streamFallbackTombstone?: boolean
}

export type DiffPreview = {
  filePath: string
  originalContent: string
  modifiedContent: string
  riskWarnings?: string[]
}

export type DiffHunk = {
  id: string
  startLine: number
  endLine: number
  type: 'add' | 'delete' | 'modify'
  originalLines: string[]
  modifiedLines: string[]
}

export type PermissionRequestDisplay = {
  requestId: string
  toolName: string
  description: string
  input: Record<string, unknown>
  isDestructive?: boolean
  mode?: PermissionMode
  diffPreview?: DiffPreview
  /** When set, Allow/Deny calls `teamPermissionReply` (main §7.9 bridge), not `respondPermissionRequest`. */
  teamDelegated?: {
    teamRequestId: string
    workerAgentId: string
    teamName?: string
  }
}

export type AskQuestionOptionDisplay = {
  label: string
  description: string
  preview?: string
}

export type AskQuestionItemDisplay = {
  question: string
  header: string
  options: AskQuestionOptionDisplay[]
  multiSelect?: boolean
}

export type AskUserQuestionRequestDisplay = {
  requestId: string
  questions: AskQuestionItemDisplay[]
  metadata?: { source?: string }
  previewFormat?: 'markdown' | 'html'
}

/**
 * P0-2 follow-up: a teammate worker has called `ExitPlanMode` and is
 * blocked awaiting the leader's approval. Used by the inline approval
 * card component (`TeamPlanApprovalCard`). The slot is per-conversation
 * so multiple teammates spawned from different chats don't fight over
 * a single global UI surface.
 *
 * Resolution: `Approve` / `Deny` button → `ai:respond-team-plan-approval`
 * IPC, which fires the worker's pending `awaitChatLeaderPlanApproval`
 * Promise (or the team-mailbox `awaitTeamLeaderPlanApproval` Promise —
 * both share the same resolver map).
 */
/**
 * the IDE `create_plan`-style structured plan todo. Distinct from the
 * renderer's general-purpose {@link TodoItem} because the plan-approval
 * contract follows the IDE's spec (`pending | in_progress | completed |
 * cancelled` — note `cancelled` is not in `TodoItem.status`) and ids are
 * optional rather than implicit.
 */
export type PlanTodo = {
  id?: string
  content: string
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled'
}

/**
 * Inline plan-approval card for the **main chat** agent. Parked on
 * `pendingPlanApproval` in the chat slice by
 * `handlePlanApprovalRequestEvent`; resolved via the
 * `respondToPlanApproval(outcome, detail?)` store action which fires IPC
 * `ai:respond-plan-approval`.
 *
 * Tri-state outcomes follow the IDE's `cursor/create_plan` contract:
 *   - `accepted`  → continue implementation (plan-mode exit + restore).
 *   - `rejected`  → stay in plan mode, optionally pass `detail` back to
 *                   the model as the rejection reason.
 *   - `cancelled` → abort the current stream entirely.
 */
export type PlanApprovalRequestDisplay = {
  requestId: string
  /** Full plan markdown body, already truncated to ≤24 KB in the bridge. */
  planMarkdown: string
  /** Optional the IDE-style structured envelope. */
  name?: string
  overview?: string
  isProject?: boolean
  todos?: Array<PlanTodo>
  phases?: Array<{ name: string; todos: Array<PlanTodo> }>
  /** Permissions the agent is asking for during the implementation phase. */
  allowedPrompts?: Array<Record<string, unknown>>
  /** Wall-clock when the request was received (for the elapsed indicator). */
  receivedAt: number
}

export type TeamPlanApprovalRequestDisplay = {
  /**
   * The pending request id (matches `teamRequestId`/`requestId` on the
   * stream event). Used as the key for the IPC reply.
   */
  requestId: string
  /** Worker agent id (display only — `teammate-tm-xxxx` or `name@team`). */
  workerAgentId: string
  /** Optional team name (only set when the request came from the TeamFile path). */
  teamName?: string
  /** Plan markdown the worker submitted (already truncated to ≤24 KB upstream). */
  planMarkdown: string
  /** Optional `allowedPrompts` ferried through from `ExitPlanMode`. */
  allowedPrompts?: Array<Record<string, unknown>>
  /**
   * Wall-clock when the request was received. Used to show a "受理中…"
   * elapsed indicator while the user reads the plan; nothing else
   * depends on it being precisely accurate.
   */
  receivedAt: number
}
