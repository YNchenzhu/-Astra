/**
 * Agentic loop — shared types and parameter interfaces.
 */

import type { SkillEffort } from '../skills/skillEffort'
import type { PermissionRulePayload } from './permissionRuleMatch'
import type { ToolResultEventPayload } from './runAgenticToolUse'
import type { SystemPromptLayers } from './systemPrompt'
import type { ToolDefinition } from '../tools/types'
import type { QueryLoopPreModelPhase } from './queryLoopPreModel'
import type { AppendixAFlowReporter } from '../orchestration/appendixAFlow'
import type { KernelLoopState, TranscriptSnapshot } from '../orchestration/kernelTypes'
import type { ToolRuntimePort } from '../orchestration/ports'
import type { ChatMode } from '../orchestration/chatMode'

/**
 * Payload for {@link AgenticLoopCallbacks.onContextCompact}. Mirrored on
 * the wire as `StreamEvent { type: 'context_compact', level, preTokens?,
 * postTokens?, reclaimedTokens? }` in `electron/preload/ai.ts` and on the
 * `LoopEvent` union in `electron/ai/loopEvents.ts`.
 *
 * Token deltas are best-effort: callers that can read pre/post
 * `estimatedTokens` from the loopContextManager populate them; legacy
 * paths (e.g. reactive_compact / stripped_image inside stream.ts) may
 * only set `level`.
 */
export interface CompactDetail {
  level: string
  preTokens?: number
  postTokens?: number
  reclaimedTokens?: number
}

export interface AgenticLoopCallbacks {
  onTextDelta: (text: string) => void
  onThinkingDelta?: (text: string) => void
  /**
   * Fired once per completed `type:'thinking'` block on the wire (after all
   * `thinking_delta` + `signature_delta` SSE frames arrive). The host should
   * forward the canonical payload + optional signature to the renderer so
   * subsequent turns can round-trip it — DeepSeek's Anthropic-compat and
   * Anthropic native both 400 when a historical thinking block is missing
   * from an assistant that also had a `tool_use` block.
   *
   * The internal `thinkingBlocks` accumulator inside `runAgenticLoop` still
   * exists for intra-turn transcript replay; this callback is purely for
   * cross-turn wire plumbing and is independent of that accumulator.
   */
  onThinkingBlock?: (block: { thinking: string; signature?: string; thinkingTimeMs?: number; thinkingTokens?: number }) => void
  /**
   * Reasoning summary delta — the provider-emitted safe-to-show TL;DR of
   * the chain of thought. Currently sourced from OpenAI Responses API
   * (`response.reasoning_summary_text.delta`) via the `claudeToOpenAI2`
   * transformer. See {@link StreamCallbacks.onReasoningSummaryDelta} in
   * `electron/ai/client.ts` for the full rationale on why it's a separate
   * channel from `onThinkingDelta`.
   */
  onReasoningSummaryDelta?: (text: string) => void
  /**
   * Reasoning summary block-complete — fires after all
   * `reasoning_summary_delta` frames for one block have arrived (the
   * provider's `content_block_stop` event). Replaces the merged-delta
   * text with the canonical whole-block payload so a dropped / reordered
   * delta doesn't cause drift on the rendered ChatBlock.
   */
  onReasoningSummaryBlock?: (block: { text: string; thinkingTimeMs?: number; thinkingTokens?: number }) => void
  onToolStart: (toolUse: { id: string; name: string; input: Record<string, unknown> }) => void
  onToolResult: (toolResult: ToolResultEventPayload) => void
  /**
   * Fires while a `tool_use` block is still streaming its JSON arguments
   * (anthropic-compat `input_json_delta`). Lets the renderer show the
   * model's in-progress `content` / `newString` for Write/Edit tools
   * before the tool actually begins executing — IDE-style live
   * diff. `partialJson` is the cumulative buffer for the tool, not the
   * delta. Optional: not every provider path emits these.
   */
  onToolInputDelta?: (delta: { toolUseId: string; toolName: string; partialJson: string }) => void
  /** Internal per-model-call usage hook. Unlike onMessageEnd, this is not a UI "turn ended" signal. */
  onStreamUsage?: (usage: { inputTokens: number; outputTokens: number }) => void
  onMessageEnd: (usage?: { inputTokens: number; outputTokens: number }) => void
  onError: (error: string) => void
  /**
   * Fires when host-side context management ran (snip / micro / auto /
   * reactive / stripped image). `detail.level` is the action label;
   * pre/post/reclaimed are best-effort token deltas pulled from the
   * loopContextManager state around the action (when the caller can
   * compute them — legacy paths may only set `level`).
   */
  onContextCompact?: (detail: CompactDetail) => void
  /**
   * Fires the moment host-side context management has decided a compaction
   * WILL run, before the (possibly slow) work begins. `detail.level` is the
   * action tier. Lets the renderer show a transient "compacting…" toast that
   * the matching {@link onContextCompact} success callback resolves. Only the
   * proactive / threshold paths (via `ContextManager.handleContext`) fire it;
   * direct-recovery compactions skip it.
   */
  onContextCompactStart?: (detail: { level: string }) => void
  onMaxIterationsReached?: (maxIterations: number) => void
  /** §6.1 pre-model pipeline telemetry (tool budget → snip → ContextManager). */
  onQueryLoopPreModel?: (info: {
    iteration: number
    phases: QueryLoopPreModelPhase[]
    snippedCount: number
    wasContextManaged: boolean
    /** upstream §4.1.1 time-triggered tool_result clear (main chat only). */
    idleToolClearApplied?: boolean
  }) => void | { appendUserContent?: string; disableToolsForThisTurn?: boolean }
  /** Fires after a Stop-hook-driven continuation decision (preventStop / blockingError) resolves. */
  onQueryLoopStopHook?: (info: { iteration: number; action: 'end' | 'continue' }) => void
  /** §11.4 — Anthropic 529: partial stream discarded; UI should tombstone pending assistant / sub-agent output. */
  onStreamingFallback?: (info: { status: number; reason: string }) => void
}

export type AgentLoopInboxDrainResult =
  | { injected: false }
  | { injected: true; snapshot: TranscriptSnapshot }

/** Single versioned transcript hand-off between an AgentLoop and its Host. */
export interface AgentLoopTranscriptPort {
  commit(messages: Array<Record<string, unknown>>): void
  drainInbox?(): AgentLoopInboxDrainResult
}

export interface AgenticLoopParams {
  config: import('./client').ProviderConfig
  model: string
  messages: { role: 'user' | 'assistant'; content: string | Array<Record<string, unknown>> }[]
  systemPrompt?: string
  /** §7.2 — forwarded to `streamText` for Anthropic multi-block `system` (opt-in env). */
  systemPromptLayers?: SystemPromptLayers
  maxTokens?: number
  enableTools?: boolean
  /** Override tool definitions (used by sub-agents with filtered tool sets) */
  toolDefinitionsOverride?: ToolDefinition[]
  /** Override max iterations (used by sub-agents with custom maxTurns) */
  maxIterationsOverride?: number
  /**
   * Sub-agent continuation: start from this full API transcript instead of mapping `messages`.
   * When set, `messages` is typically `[]` and only supplies shape for callers that require it.
   */
  initialApiMessages?: Array<Record<string, unknown>>
  signal: AbortSignal
  /** Scoped output effort (e.g. forked skill); inline Skill session overrides when set */
  effort?: SkillEffort
  /** Settings → 深度思考 (Gemini `thinkingConfig` + thought / text 分流) */
  alwaysThinking?: boolean
  /** Settings → 快速模式：Anthropic 路径带 fast-mode beta（§12.4 退避 / 冷却由 client 处理） */
  fastMode?: boolean
  /**
   * Diff / review policy only (chat “变更审核” vs “自动写入”).
   * Affects **built-in file Write/Edit** pre-run prompts — not Bash, not Settings tool policy.
   */
  diffPermissionMode?: 'default' | 'bypassPermissions'
  /**
   * Settings → Permissions: global **tool** policy for this request (`allow` / `ask` / `deny`).
   * Independent of {@link diffPermissionMode}.
   */
  permissionDefaultMode?: 'allow' | 'ask' | 'deny'
  /** Per-tool overrides; first match wins (see `permissionRuleMatch.ts`). */
  permissionRules?: PermissionRulePayload[]
  /**
   * Renderer chat-input interaction mode (Agent / Plan / Ask), forwarded from
   * `streamHandler`'s `chatInteractionMode`. Mirrors what the orchestration
   * kernel feeds `PolicyEngine.evaluate` via `getChatMode`: `'ask'` denies all
   * tools and `'plan'` denies mutating tools at preflight. Threaded into the
   * inner loop so the streaming tool path enforces the same chat-mode gate as
   * the batch path (defaults to `'agent'` when omitted).
   */
  chatMode?: ChatMode
  /**
   * Orchestrated main chat: run tool batches through {@link ToolRuntimePort}
   * so the kernel `ports.tools` path stays live (inline Skill session + UI callbacks preserved).
   */
  orchestratedToolExecution?: {
    port: ToolRuntimePort
    getKernelState: () => KernelLoopState
    noteToolInvocation?: (toolName: string) => void
    /**
     * P0-2 — per-tool signal resolver provided by the kernel's CallModel phase.
     * Maps a tool name + input to its effective signal: soft (default `'cancel'`
     * semantics) or hard (long-running `'block'` tools that should survive a
     * single user interrupt). Forwarded to {@link ToolRuntimePort.executeToolBatch}.
     *
     * P1 (audit §5.2) — optional third positional `toolUseId` lets the
     * orchestration adapter merge each tool's per-tool preempt signal from
     * `ToolRuntimeState` so a high-priority newcomer's preempt fires only
     * on the victim. Legacy resolvers ignore the extra parameter.
     */
    resolveToolSignal?: (
      toolName: string,
      input: Record<string, unknown>,
      toolUseId?: string,
    ) => AbortSignal | undefined
  }
  /** Versioned transcript commit and atomic inbox-drain boundary supplied by the Host. */
  hostTranscript?: AgentLoopTranscriptPort
  /**
   * 阶段 3.2 — Inner-iteration boundary control point for the orchestration kernel.
   *
   * Called at the top of every inner iteration AFTER the iteration counter is incremented but
   * BEFORE any phase work (pre-model pipeline, stream, tools). This is the kernel's authoritative
   * "between iterations" checkpoint — the place where it can:
   *
   *   - Await its cooperative pause gate (drive-mode pause/resume).
   *   - Bail out cleanly when an interrupt fires mid-turn — return `{ stop: true }` and the loop
   *     terminates with `aborted_tools` (callbacks fired, profiler flushed, no `onError`).
   *   - Snapshot a checkpoint for rewind support.
   *   - Persist its own state for crash-survivability.
   *
   * Exceptions thrown by the hook are caught and warned; they do NOT terminate the loop. To stop
   * cleanly, return `{ stop: true }`.
   *
   * This is the smallest viable form of the "kernel-owned while" architecture: the loop keeps
   * living in `runAgenticLoop`, but every iteration boundary is now a kernel-controlled control
   * point. A future PR can flip the ownership by extracting `runAgenticIteration` and calling it
   * from a kernel-driven `while` — the observable behaviour would be identical.
   */
  iterationBoundaryHook?: (iteration: number) => Promise<{ stop?: boolean } | void>
  /**
   * 阶段 1 (kernel-loop deep integration) — injected typed port that replaces
   * the global `getOrchestrationKernelForConversation` service-locator the inner
   * iteration used to reach back into the kernel for mid-iteration persistence.
   * When set (drive mode / orchestrated sub-agents), the inner loop calls
   * `persistThrottled` at each iteration entry instead of looking the kernel up
   * from a module-level registry. Omitted for legacy / non-kernel callers — the
   * inner loop then simply skips mid-iteration persistence.
   */
  kernelLoopPort?: KernelLoopPort
  /** 附录 A 数据流遥测（见 `appendixAFlow.ts`） */
  appendixAFlow?: AppendixAFlowReporter
  /** Sampling temperature (0–2). Overrides bundle default when set. */
  temperature?: number
  /** Nucleus sampling top-p (0–1). Overrides bundle default when set. */
  topP?: number
  /**
   * P0 fix (audit §4.1) — seed values for `LoopState.maxOutputRecoveryCycles`
   * and `LoopState.consecutiveCompactFailures` at iteration start. Threaded
   * by the orchestration kernel's CallModel phase from `KernelLoopState` so
   * that a turn restarted after a crash (where the persisted blob carried
   * non-zero counters) resumes with the same soft caps it had before. When
   * omitted, both default to 0 (legacy / non-kernel callers).
   */
  seedMetaCounters?: {
    maxOutputRecoveryCycles?: number
    consecutiveCompactFailures?: number
  }
}

/**
 * 阶段 1 — typed port the orchestration kernel injects into the inner agentic
 * loop so per-iteration persistence no longer reaches back through the global
 * `getOrchestrationKernelForConversation` service-locator. `persistThrottled`
 * folds the previous two-step `syncMetaCounters` + `persist({ throttleMs })`
 * call the inner loop used to make on the looked-up kernel into one method, so
 * the loop ↔ kernel contract is explicit, injectable, and unit-testable.
 */
export interface KernelLoopPort {
  /**
   * Reflect the inner loop's soft-cap counters into kernel state and persist a
   * throttled snapshot (the implementation skips the disk write when the last
   * successful persist was < `throttleMs` ago). Best-effort: implementations
   * MUST NOT throw — the inner loop treats this as fire-and-forget.
   */
  persistThrottled(counters: {
    maxOutputRecoveryCycles: number
    consecutiveCompactFailures: number
  }): void
}
