import type {
  Attachment,
  ChatMessage,
  PermissionMode,
  PermissionRequestDisplay,
  AskUserQuestionRequestDisplay,
  TeamPlanApprovalRequestDisplay,
  PlanApprovalRequestDisplay,
  TodoItem,
  ConversationMeta,
} from '../../types'
import type { TerminationReason } from '../../../shared/terminationReasons'

/** Legacy: sub-agent / tool types; main chat uses {@link ChatInteractionMode} + fixed `general-purpose`. */
export type AgentType =
  | 'general-purpose'
  | 'Explore'
  | 'Plan'
  | 'Coordinator'
  | 'Debug'
  | 'Verification'
  | string

/**
 * Input bar mode → main-process behavior:
 * - **agent**: tools on, session {@link PermissionMode} from store (default / bypass)
 * - **plan**: tools on, `permissionMode: plan` (read-first / extra gating for mutating tools)
 * - **ask**: tools off, plain chat stream
 */
export type ChatInteractionMode = 'agent' | 'plan' | 'ask'

export const CHAT_MODE_OPTIONS: Array<{
  id: ChatInteractionMode
  label: string
  hint: string
}> = [
  { id: 'agent', label: 'Agent', hint: '工具与多步执行（权限见下方「标准 / Plan / 放行」）' },
  { id: 'plan', label: 'Plan', hint: '规划与调研为主，非只读工具更易触发确认' },
  { id: 'ask', label: 'Ask', hint: '仅对话，不调用工具' },
]

/**
 * Stage 3.1 — Single denial entry emitted by the kernel's PermissionPort preflight
 * (see `electron/orchestration/toolRuntime/defaultToolRuntimePort.ts`). Surfaced as a
 * red toast by `PreflightDenialToast`. `at` is `Date.now()` at receipt time, used both
 * for stable-key rendering and toast auto-dismiss timing.
 */
export interface OrchestrationPermissionDenial {
  toolUseId: string
  toolName: string
  reason: string
  matchedRule?: string
  at: number
}

/**
 * Stage 3.1 — Artifact manifest entry as serialised by the kernel's `ArtifactPort`
 * (see `electron/orchestration/artifact.ts`). The renderer's drawer pretty-prints
 * the payload; main process never sees it again after Terminal commit.
 */
export interface OrchestrationArtifactManifest {
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
 * Stage 3.1 — Checkpoint summary returned by `orchestration:list-checkpoints`.
 * Kernel state is intentionally stripped before crossing IPC (state would be
 * huge); the renderer only needs id/tag/at/parentId for the rewind menu.
 */
export interface OrchestrationCheckpointSummary {
  id: string
  tag: string
  at: number
  parentId?: string
}

/**
 * Stage 3.1 — Active HITL pause payload. Populated by the `interrupt` phase
 * event when `interruptReason === 'hitl'`, which carries the typed `hitlPending`
 * field (see `electron/ai/agenticLoop/toolExec.ts`). The renderer's
 * `AskUserQuestionDialog` reads this and presents the prompt; `enqueueHumanResume`
 * clears the slot on answer submission.
 */
export interface OrchestrationHitlPause {
  toolUseId: string
  question: unknown
  kind: string
}

/**
 * Audit P1 §5.2 — a running tool was preempted (its per-tool signal aborted)
 * so a higher-priority newcomer could claim a contended resource slot
 * (`shell` / `network` / `mutation`). Emitted by the kernel's
 * `DefaultToolRuntimePort.executeToolBatch`; surfaced as an amber info toast.
 * `id` is synthesized as `${victimToolUseId}->${incomingToolUseId}` for stable
 * keying + dismiss; `at` is `Date.now()` at receipt for auto-dismiss timing.
 */
export interface OrchestrationToolPreemption {
  id: string
  victimToolUseId: string
  victimToolName?: string
  incomingToolUseId: string
  incomingToolName: string
  resource: 'shell' | 'network' | 'mutation'
  victimPriority?: number
  incomingPriority: number
  at: number
}

/**
 * Audit P2-1 — the kernel failed to persist its inbox to disk while at least
 * one `pending_human_resume` HITL item was queued (the worst durable-HITL
 * failure: a user's AskUserQuestion answer is at risk of being lost on crash).
 * Emitted by `OrchestrationKernel.persistInbox()`; surfaced as a red error
 * toast so the user can re-submit. `id` is `${reason}:${at}` for stable keying.
 */
export interface OrchestrationHitlPersistenceFailure {
  id: string
  reason: 'disk_error' | 'cleanup_failed'
  error: string
  pendingHumanResumeCount: number
  at: number
}

/**
 * P0-3 — a non-HITL kernel interrupt fired (`user`, `timeout`, `superseded`,
 * `fork_replaced`, `shutdown`, `<reason>:hard`, `<reason>:grace_expired`).
 * Previously these `interrupt` phase events fell through silently; now they
 * surface as a lightweight transient toast so a mid-turn cancel / supersede
 * has a user-visible cause. HITL interrupts are excluded (they drive the
 * AskUserQuestion pause slot instead). `id` = `${reason}:${at}` for keying.
 */
export interface OrchestrationInterruptNotice {
  id: string
  reason: string
  at: number
}

/**
 * Audit P2-2 — the orchestration transcript clone degraded below
 * `structuredClone` (`json` = JSON round-trip fallback, `frozen-shared` = both
 * strategies failed and a frozen shared reference was returned). Diagnostic
 * only: stored as the latest snapshot for operators investigating
 * "kernel transcript drifted from AgentContext.messages".
 */
export interface OrchestrationTranscriptCloneDegradation {
  mode: 'json' | 'frozen-shared'
  error: string
  secondaryError?: string
  messageCount: number
  occurrenceCount?: number
  at: number
}

/**
 * Contract audit (2026-07) — user-visible kernel diagnostic notice. Unifies
 * previously store-only signals (transcript drift, clone degradation,
 * outer-loop overflow / error) into a transient toast entry so the user sees
 * "本轮内核出现了 X" instead of the signal dying in a store field.
 */
export interface OrchestrationKernelDiagnostic {
  id: string
  kind:
    | 'transcript_drift'
    | 'transcript_conflict'
    | 'transcript_clone_degraded'
    | 'outer_loop_overflow'
    | 'outer_loop_error'
    | 'pause_partial'
    | 'pause_failed'
    | 'scheduler_backpressure'
  /** Pre-rendered human-readable detail line (zh-CN). */
  detail: string
  at: number
}

/**
 * Audit P2-1 — per-turn snapshot of the kernel's outer-iteration FSM
 * (`runDriveMainChat`). One event per outer-loop exit. Diagnostic only:
 * stored as the latest snapshot so dashboards / debugging can read how many
 * outer iterations a turn took and why it exited.
 */
export interface OrchestrationOuterLoopStats {
  iterations: number
  overflowed: boolean
  exitReason: 'completed' | 'aborted' | 'overflow' | 'error'
  terminationReason?: TerminationReason
  inboxRemaining: number
  maxOuterIterations: number
  at: number
}

/** Snapshot for a chat session when it is not the active tab (parallel streams). */
export interface ChatSessionSlice {
  messages: ChatMessage[]
  todos: TodoItem[]
  isTyping: boolean
  pendingPermissionRequest: PermissionRequestDisplay | null
  pendingAskUserQuestion: AskUserQuestionRequestDisplay | null
  /**
   * P0-2 follow-up: a teammate spawned from this conversation has called
   * ExitPlanMode and is awaiting human approval. Rendered as an inline
   * card in {@link ChatPanel} so the user can review the plan and click
   * Approve/Deny without leaving the chat. Single-slot per conversation
   * — if a second teammate raises a request while one is pending, the
   * older request stays in flight (its Promise is still active in main
   * process) and the new one queues into the slot only after the first
   * resolves; mainStreamRouter logs the deferral.
   */
  pendingTeamPlanApproval: TeamPlanApprovalRequestDisplay | null
  /**
   * the IDE `create_plan`-style main-chat plan-approval slot. Filled by
   * `handlePlanApprovalRequestEvent` when the main agent calls
   * `ExitPlanMode` outside a teammate / TeamFile delegation context.
   * The `PlanApprovalCard` reads this and exposes three buttons (Approve
   * / Reject / Cancel). Resolved via `respondToPlanApproval`.
   */
  pendingPlanApproval: PlanApprovalRequestDisplay | null
  /**
   * Layer-E — last `task_terminated` reason emitted by the main process for
   * this conversation, or `null` when no failure flag is currently raised.
   * Cleared on the next `sendMessage` so a successful follow-up dismisses
   * the recovery affordance. Recoverable values: `'max_turns'`,
   * `'model_error'`, `'output_budget_exhausted'`, `'aborted_streaming'`,
   * `'aborted_tools'`, `'iteration_boundary_stopped'`. `'completed'` clears it.
   */
  latestTerminationReason?: TerminationReason | null
  /**
   * Stage 3.1 — OrchestrationKernel telemetry mirror for this session. Updated
   * by `mainStreamRouter` on every `orchestration_phase` event; the active
   * conversation's mirror lives at the top of {@link ChatState}.
   */
  orchestrationPhase?: string | null
  orchestrationIteration?: number
  orchestrationInnerIteration?: number
  orchestrationPaused?: boolean
  permissionDenials?: OrchestrationPermissionDenial[]
  artifactManifests?: OrchestrationArtifactManifest[]
  checkpointList?: OrchestrationCheckpointSummary[]
  hitlPaused?: OrchestrationHitlPause | null
  /** Audit P1 §5.2 — preemption notifications (transient toast strip). */
  toolPreemptions?: OrchestrationToolPreemption[]
  /** Audit P2-1 — durable-HITL persistence failures (transient error toast). */
  hitlPersistenceFailures?: OrchestrationHitlPersistenceFailure[]
  /** P0-3 — non-HITL interrupt notices (transient toast). */
  interruptNotices?: OrchestrationInterruptNotice[]
  /** Audit P2-2 — latest transcript-clone degradation (diagnostic, no UI). */
  lastTranscriptCloneDegradation?: OrchestrationTranscriptCloneDegradation | null
  /** Audit P2-1 — latest outer-loop telemetry snapshot (diagnostic, no UI). */
  lastOuterLoopStats?: OrchestrationOuterLoopStats | null
  /** Contract audit (2026-07) — user-visible kernel diagnostics (transient toast). */
  kernelDiagnostics?: OrchestrationKernelDiagnostic[]
}

/**
 * Lightweight status for the host-spawned `session-memory-internal` sub-agent.
 *
 * Rendered as a small header pill in `ChatPanel` rather than as a standalone
 * timeline bubble — this agent is an internal implementation detail (writes
 * `~/.claude/session-memory/<convId>.md`), not a user-facing turn. We only
 * track the minimum needed to drive a status indicator.
 */
export interface SessionMemoryStatus {
  agentId: string
  status: 'running' | 'completed' | 'failed'
  startedAt: number
  completedAt?: number
  totalDurationMs?: number
  totalTokens?: number
  errorMessage?: string
}

export interface ChatState {
  messages: ChatMessage[]
  /** In-flight / background sessions keyed by conversation id */
  sessionBuffers: Record<string, ChatSessionSlice>
  inputText: string
  isTyping: boolean
  referencedFiles: string[]
  enableTools: boolean
  permissionMode: PermissionMode
  diffPermissionMode: 'default' | 'bypassPermissions'
  pendingPermissionRequest: PermissionRequestDisplay | null
  pendingAskUserQuestion: AskUserQuestionRequestDisplay | null
  /** P0-2 follow-up: see {@link ChatSessionSlice.pendingTeamPlanApproval}. */
  pendingTeamPlanApproval: TeamPlanApprovalRequestDisplay | null
  /** See {@link ChatSessionSlice.pendingPlanApproval}. */
  pendingPlanApproval: PlanApprovalRequestDisplay | null
  currentConversationId: string | null
  /**
   * Layer-E — see {@link ChatSessionSlice.latestTerminationReason}. Active
   * conversation's mirror; updated by `mainStreamRouter` on
   * `task_terminated`, cleared by `sendMessage` / new conversation.
   */
  latestTerminationReason?: TerminationReason | null
  todos: TodoItem[]
  /** Main chat input bar: Agent / Plan / Ask — drives `permissionMode` + `enableTools` per send. */
  chatInteractionMode: ChatInteractionMode
  pendingAttachments: Attachment[]
  recalledMemories: Array<{
    filename: string
    content: string
    score?: number
    name?: string
    type?: string
    matchSnippet?: string
  }>
  /**
   * P1-6 — workspace-index code snippets auto-recalled into the current turn's
   * context (semantic retrieval). Set by `mainStreamRouter` on `workspace_recall`,
   * cleared on the next turn boundary alongside `recalledMemories`. Surfaced by
   * `RetrievalCitation` so the user sees which files fed the assistant's context.
   */
  recalledWorkspaceHits: Array<{
    filePath: string
    startLine: number
    endLine: number
    score?: number
    namespace?: string
    text: string
  }>
  /**
   * P1-6 — attachment snippets auto-recalled into the current turn's context.
   * Set by `mainStreamRouter` on `attachment_recall`; cleared with the above.
   */
  recalledAttachmentHits: Array<{
    namespace?: string
    score?: number
    text: string
    meta?: Record<string, unknown>
  }>
  /**
   * Latest `session-memory-internal` run status, keyed by conversation id.
   * Updated by `subAgentStreamRouter` instead of inserting standalone bubbles
   * into `messages`. Surfaced by `SessionMemoryIndicator` in the chat header.
   */
  sessionMemoryStatus: Record<string, SessionMemoryStatus>
  /**
   * Persisted compact summary for the current conversation (written by the
   * main-process `context_compact` pipeline). Propagated into
   * `buildMessagesWithContext` so the renderer doesn't re-summarize an
   * already-compacted prefix on every send.
   */
  currentCompactSummary: string | null
  autoApproveRemainingDiffs: boolean
  setAutoApproveRemainingDiffs: (value: boolean) => void

  /**
   * Stage 3.1 — OrchestrationKernel telemetry mirror for the active conversation.
   * Wired by `mainStreamRouter` `case 'orchestration_phase'` dispatch. UI
   * components (`OrchestrationTimeline`, `PreflightDenialToast`,
   * `ArtifactDrawer`, etc.) subscribe directly to these fields.
   *
   * All fields are best-effort: undefined / empty array means "no signal yet"
   * (legacy `runAgenticLoop` path emits none of these; the kernel emits them
   * but only when the corresponding ports + flags are wired).
   */
  orchestrationPhase: string | null
  orchestrationIteration: number
  orchestrationInnerIteration: number
  orchestrationPaused: boolean
  permissionDenials: OrchestrationPermissionDenial[]
  artifactManifests: OrchestrationArtifactManifest[]
  checkpointList: OrchestrationCheckpointSummary[]
  hitlPaused: OrchestrationHitlPause | null
  /** Audit P1 §5.2 — preemption notifications for the active conversation. */
  toolPreemptions: OrchestrationToolPreemption[]
  /** Audit P2-1 — durable-HITL persistence failures for the active conversation. */
  hitlPersistenceFailures: OrchestrationHitlPersistenceFailure[]
  /** P0-3 — non-HITL interrupt notices for the active conversation. */
  interruptNotices: OrchestrationInterruptNotice[]
  /** Audit P2-2 — latest transcript-clone degradation (diagnostic). */
  lastTranscriptCloneDegradation: OrchestrationTranscriptCloneDegradation | null
  /** Audit P2-1 — latest outer-loop telemetry snapshot (diagnostic). */
  lastOuterLoopStats: OrchestrationOuterLoopStats | null
  /** Contract audit (2026-07) — user-visible kernel diagnostics for the active conversation. */
  kernelDiagnostics: OrchestrationKernelDiagnostic[]
  /** Contract audit (2026-07) — clear a kernel-diagnostic toast by id (UI dismiss). */
  dismissKernelDiagnostic: (id: string) => void
  /**
   * Contract audit (2026-07) — push a renderer-originated kernel diagnostic
   * (e.g. "pause only partially covered sub-agents" from the pause IPC
   * response). Stream-originated diagnostics land via the stream router.
   */
  pushKernelDiagnostic: (
    kind: OrchestrationKernelDiagnostic['kind'],
    detail: string,
  ) => void
  /** Stage 3.1 — clear a preflight-denial toast by toolUseId (UI dismiss). */
  dismissPermissionDenial: (toolUseId: string) => void
  /** Audit P1 §5.2 — clear a preemption toast by synthesized id (UI dismiss). */
  dismissToolPreemption: (id: string) => void
  /** Audit P2-1 — clear a HITL persistence-failure toast by id (UI dismiss). */
  dismissHitlPersistenceFailure: (id: string) => void
  /** P0-3 — clear a non-HITL interrupt-notice toast by id (UI dismiss). */
  dismissInterruptNotice: (id: string) => void
  /** Stage 3.1 — clear the HITL pause slot after the user submits an answer. */
  clearHitlPause: () => void
  /** Stage 3.1 — replace checkpoint list (caller fetched via orchestration:list-checkpoints). */
  setCheckpointList: (checkpoints: OrchestrationCheckpointSummary[]) => void

  setInputText: (text: string) => void
  setDiffPermissionMode: (mode: 'default' | 'bypassPermissions') => void
  setChatInteractionMode: (mode: ChatInteractionMode) => void
  addAttachment: (attachment: Attachment) => void
  removeAttachment: (index: number) => void
  updateAttachment: (
    matchPath: string,
    patch: Partial<Extract<Attachment, { type: 'file' }>>,
  ) => void
  sendMessage: () => Promise<void>
  cancelMessage: () => Promise<void>
  addMessage: (message: ChatMessage) => void
  setMessages: (messages: ChatMessage[]) => void
  setIsTyping: (typing: boolean) => void
  updateStreamingContent: (messageId: string, text: string) => void
  toggleReferencedFile: (file: string) => void
  clearReferencedFiles: () => void
  setEnableTools: (enabled: boolean) => void
  setPermissionMode: (mode: PermissionMode) => void
  respondToPermissionRequest: (params: {
    requestId: string
    behavior: 'allow' | 'deny'
    updatedInput?: Record<string, unknown>
  }) => Promise<boolean>
  respondToAskUserQuestion: (params: {
    requestId: string
    answers: Record<string, string>
    annotations?: Record<string, { preview?: string; notes?: string }>
    /** Optional override; defaults to the current conversation. */
    conversationId?: string
  }) => Promise<boolean>
  /**
   * P0-2 follow-up: resolve the pending teammate plan-approval card.
   * Calls IPC `ai:respond-team-plan-approval`, clears the slot, returns
   * `true` when the main process found a pending Promise to resolve.
   */
  respondToTeamPlanApproval: (params: {
    requestId: string
    approve: boolean
    detail?: string
  }) => Promise<boolean>
  /**
   * the IDE `create_plan`-style main-chat plan-approval resolver
   * (tri-state). `cancelled` aborts the entire turn (the main-process
   * tool side fires `cancelStream` once the bridge unblocks).
   */
  respondToPlanApproval: (params: {
    requestId: string
    outcome: 'accepted' | 'rejected' | 'cancelled'
    detail?: string
  }) => Promise<boolean>

  // Conversation persistence
  saveCurrentConversation: () => Promise<void>
  loadConversationById: (convId: string) => Promise<void>
  startNewConversation: () => Promise<void>
  deleteConversationById: (convId: string) => Promise<void>
  loadRecentConversation: () => Promise<void>
  /** After opening or switching workspace: load latest saved chat or empty state; resets main-process session context. */
  hydrateAfterWorkspaceChange: () => Promise<void>
  getConversationList: () => Promise<ConversationMeta[]>
  currentConversationTitle: string
  /**
   * Resets renderer + main context. Session note: pass `endAllSessions` when switching/leaving workspace;
   * pass `workspacePath` + `conversationId` to end one chat only; omit both to only reset context (no session IPC).
   */
  clearConversationContext: (
    opts?:
      | { workspacePath: string; conversationId: string }
      | { endAllSessions: true },
  ) => Promise<void>
  renameConversation: (convId: string, newTitle: string) => Promise<void>
  rewindToMessage: (messageId: string) => Promise<void>
  /**
   * Regenerate an assistant reply: truncate history back to (and including)
   * the user turn that produced `assistantMessageId`, restore that turn's
   * text / referenced files / attachments into the input state, and resend.
   */
  regenerateFromMessage: (assistantMessageId: string) => Promise<void>
  /**
   * Replace a user message's text and resend from that point. Everything
   * after (and including) the edited message is discarded — same
   * no-branching semantics as `rewindToMessage`.
   */
  editUserMessage: (messageId: string, newContent: string) => Promise<void>
  stopToolTask: (toolUseId: string) => Promise<void>
  retryToolTask: (toolUseId: string) => Promise<void>
  syncReferencedAfterDelete: (targetPath: string, isFolder: boolean) => void
  syncReferencedAfterRename: (oldPath: string, newPath: string, isFolder: boolean) => void
}

/** Appendix A phase-one style: queue user turns per conversation while a main stream is in flight. */
export type QueuedMainChatTurn = {
  inputText: string
  referencedFiles: string[]
  pendingAttachments: Attachment[]
}
