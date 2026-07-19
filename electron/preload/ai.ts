/**
 * AI chat + output-bus bridges.
 *
 * Covers two namespaces:
 *   - `ai:*`              chat, stream subscription, permission / task
 *                         control, cron fires, diff-mode swap
 *   - `output:append`     generic channel-broadcast sink consumed by the
 *                         Output panel
 */
import { ipcRenderer, type IpcRendererEvent } from 'electron'
import type { AiStreamEventPayload } from './helpers'

/**
 * Stream events emitted by {@link AiApi.runTeammate}. Renderer must
 * dispatch by `runId` because multiple teammates can run in parallel.
 *
 * Mirrors the union in `electron/agents/teammateRunner.ts#TeammateStreamEvent`
 * with the addition of the routing `runId`.
 */
export type TeammateStreamEventPayload = {
  runId: string
} & (
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | {
      type: 'tool_start'
      toolUse: { id: string; name: string; input: Record<string, unknown> }
    }
  | {
      type: 'tool_result'
      toolResult: {
        id: string
        name: string
        success: boolean
        output?: string
        error?: string
      }
    }
  | {
      type: 'context_compact'
      level: string
      /** Pre-compaction token estimate (optional; absent on legacy paths). */
      preTokens?: number
      /** Post-compaction token estimate. */
      postTokens?: number
      /** `max(0, preTokens - postTokens)`. Surfaced in the UI boundary row. */
      reclaimedTokens?: number
    }
  | {
      /** Compaction is starting — drives the transient "正在压缩…" toast. */
      type: 'context_compact_start'
      level: string
    }
  | {
      type: 'message_end'
      usage?: { inputTokens: number; outputTokens: number }
    }
  | {
      type: 'done'
      success: boolean
      error?: string
      usage?: { inputTokens: number; outputTokens: number }
    }
  | { type: 'error'; error: string }
  | { type: 'max_iterations_reached'; maxIterations: number }
)

export interface AiApi {
  sendMessage: (params: {
    messages: { role: 'user' | 'assistant'; content: string | Array<Record<string, unknown>> }[]
    model?: string
    maxTokens?: number
    /** Overrides default layered system prompt (same as main `SendMessageParams.systemPrompt`) */
    systemPrompt?: string
    conversationId?: string
    workspacePath?: string
    providerId?: string
    apiKey?: string
    baseUrl?: string
    anthropicThinkingCapability?: 'auto' | 'supported' | 'unsupported'
    awsRegion?: string
    projectId?: string
    outputStyle?: 'default' | 'concise' | 'explanatory'
    language?: string
    enableTools?: boolean
    permissionMode?:
      | 'default'
      | 'plan'
      | 'bypassPermissions'
      | 'acceptEdits'
      | 'dontAsk'
      | 'auto'
      | 'bubble'
    diffPermissionMode?: 'default' | 'bypassPermissions'
    permissionDefaultMode?: 'allow' | 'ask' | 'deny'
    permissionRules?: Array<{ id: string; pattern: string; mode: 'allow' | 'ask' | 'deny' }>
    agentType?: string
    alwaysThinking?: boolean
    thinkingBudgetTokens?: number
    fastMode?: boolean
    injectLspPassiveDiagnostics?: boolean | 'full' | 'errors-only' | 'off'
    /** Settings → Rules: merged in main via orchestrationContext */
    userRulesPrompt?: string
    hooks?: Array<{
      id: string
      event: string
      command: string
      enabled: boolean
      matcher?: string
      async?: boolean
      asyncRewake?: boolean
    }>
    disableAllHooks?: boolean
    envVars?: Array<{ id: string; key: string; value: string; enabled: boolean }>
    /** Default true: inject task-routing / workflow hints into system prompt */
    autoTaskRouting?: boolean
    autoMemoryEnabled?: boolean
    autoMemoryDirectory?: string
    effortLevel?: 'low' | 'medium' | 'high' | 'max'
  }) => Promise<void>
  cancel: () => Promise<void>
  /**
   * M2 (2026-07) — deliver REAL user text typed while a main stream is in
   * flight to the running turn via the kernel inbox (instruction-level
   * `kernel_user_input` delivery). `ok: false` means the input was NOT
   * accepted (no kernel / empty payload) and the caller must fall back to
   * its local queue — never drop user input.
   */
  enqueueMidTurnInput: (params: {
    conversationId: string
    text: string
  }) => Promise<{ ok: true; inboxItemId: string } | { ok: false; reason: string }>
  onStreamEvent: (callback: (event: AiStreamEventPayload) => void) => () => void
  respondPermissionRequest: (params: {
    requestId: string
    behavior: 'allow' | 'deny'
    updatedInput?: Record<string, unknown>
  }) => Promise<boolean>
  teamPermissionReply: (params: {
    teamRequestId: string
    behavior: 'allow' | 'deny'
    updatedInput?: Record<string, unknown>
  }) => Promise<boolean>
  /**
   * P0-2 follow-up: resolve a pending teammate `team_plan_approval_request`.
   * Closes both the TeamFile mailbox path and the renderer-spawned chat-leader
   * path (they share a single pending Promise map keyed by requestId).
   */
  respondTeamPlanApproval: (params: {
    requestId: string
    approve: boolean
    detail?: string
  }) => Promise<{ resolved: boolean }>
  /**
   * the IDE `create_plan`-style main-chat plan-approval card resolver.
   * Tri-state outcome: `accepted` continues the turn, `rejected` keeps the
   * model in plan mode, `cancelled` aborts the entire turn (the tool side
   * additionally fires `cancelStream` after the resolver unblocks).
   */
  respondPlanApproval: (params: {
    requestId: string
    outcome: 'accepted' | 'rejected' | 'cancelled'
    detail?: string
  }) => Promise<{ resolved: boolean }>
  respondAskUserQuestion: (params: {
    requestId: string
    answers: Record<string, string>
    annotations?: Record<string, { preview?: string; notes?: string }>
  }) => Promise<boolean>
  stopTask: (taskId: string) => Promise<{ success: boolean; error?: string }>
  retryTask: (taskId: string) => Promise<{ success: boolean; taskId?: string; error?: string }>
  /** §8.5 中继答复行 `(y|yes|n|no) abcde` */
  permissionRelayReply: (line: string) => Promise<{ applied: boolean }>
  /**
   * 热切换 diff 权限(变更审核 ↔ 自动写入),AI 正在跑任务时也能生效。
   * P1-30: 可选地传入 `conversationId`,只覆盖该会话的模式;不传则更新全局默认。
   */
  setDiffPermissionMode: (
    mode: 'default' | 'bypassPermissions',
    conversationId?: string,
  ) => Promise<
    | { ok: true; mode: 'default' | 'bypassPermissions' }
    | { ok: false; error: string }
  >
  /** Cron-scheduled task fire notifications (for status/toast UI). */
  onCronFire: (
    callback: (payload: {
      taskId: string
      cron: string
      prompt: string
      agentId?: string
    }) => void,
  ) => () => void

  // ── In-process teammate runner ──
  // Replaces the old `src/services/agent/runAgent.ts` shim. The teammate
  // now runs through the main-process agentic loop, so all parity layers
  // (compaction, strip-retry, fallback, etc.) are inherited automatically.

  /**
   * Start a teammate sub-agent run in the main process. Returns the
   * `runId` the caller MUST use to subscribe to {@link onTeammateStreamEvent}
   * and to call {@link cancelTeammate}.
   */
  runTeammate: (params: {
    runId?: string
    taskId?: string
    prompt: string
    model: string
    systemPrompt?: string
    maxIterations?: number
    maxTokens?: number
    agentId?: string
    parentSessionId?: string
    history?: {
      role: 'user' | 'assistant'
      content: string | Array<Record<string, unknown>>
    }[]
    providerId?: string
    apiKey?: string
    baseUrl?: string
    awsRegion?: string
    projectId?: string
    /**
     * P0-2 follow-up: when true, the teammate boots in `plan` permission
     * mode and `ExitPlanMode` requires a human approval delivered to
     * {@link leaderConversationId}. Both fields must be supplied together.
     */
    planModeRequired?: boolean
    leaderConversationId?: string
  }) => Promise<{ runId: string }>

  cancelTeammate: (runId: string) => Promise<{ cancelled: boolean }>

  onTeammateStreamEvent: (
    callback: (event: TeammateStreamEventPayload) => void,
  ) => () => void
}

export function buildAiApi(): AiApi {
  return {
    sendMessage: (params) => ipcRenderer.invoke('ai:send-message', params),
    cancel: (conversationId?: string) => ipcRenderer.invoke('ai:cancel', conversationId),
    enqueueMidTurnInput: (params) => ipcRenderer.invoke('ai:enqueue-mid-turn-input', params),
    onStreamEvent: (callback) => {
      const handler = (_event: IpcRendererEvent, data: AiStreamEventPayload) => callback(data)
      ipcRenderer.on('ai:stream-event', handler)
      return () => ipcRenderer.removeListener('ai:stream-event', handler)
    },
    respondPermissionRequest: (params) =>
      ipcRenderer.invoke('ai:respond-permission-request', params),
    teamPermissionReply: (params) =>
      ipcRenderer.invoke('ai:team-permission-reply', params),
    respondTeamPlanApproval: (params) =>
      ipcRenderer.invoke('ai:respond-team-plan-approval', params),
    respondPlanApproval: (params) =>
      ipcRenderer.invoke('ai:respond-plan-approval', params),
    respondAskUserQuestion: (params) =>
      ipcRenderer.invoke('ai:respond-ask-user-question', params),
    stopTask: (taskId) => ipcRenderer.invoke('ai:stop-task', taskId),
    retryTask: (taskId) => ipcRenderer.invoke('ai:retry-task', taskId),
    permissionRelayReply: (line) => ipcRenderer.invoke('ai:permission-relay-reply', line),
    setDiffPermissionMode: (mode, conversationId) =>
      ipcRenderer.invoke('ai:set-diff-permission-mode', mode, conversationId),
    onCronFire: (callback) => {
      const handler = (
        _event: IpcRendererEvent,
        payload: { taskId: string; cron: string; prompt: string; agentId?: string },
      ) => callback(payload)
      ipcRenderer.on('ai:cron-fire', handler)
      return () => ipcRenderer.removeListener('ai:cron-fire', handler)
    },
    runTeammate: (params) => ipcRenderer.invoke('ai:run-teammate', params),
    cancelTeammate: (runId) => ipcRenderer.invoke('ai:cancel-teammate', runId),
    onTeammateStreamEvent: (callback) => {
      const handler = (_event: IpcRendererEvent, data: TeammateStreamEventPayload) =>
        callback(data)
      ipcRenderer.on('ai:teammate-stream-event', handler)
      return () => ipcRenderer.removeListener('ai:teammate-stream-event', handler)
    },
  }
}

/**
 * Generic output channel broadcast hook. Consumers can listen for
 * `output:append` events (channelId/message/type) which are then routed
 * into the renderer "Output" panel. Currently unused but wired so
 * TerminalPanel's subscription never hits `undefined`.
 */
export interface OutputApi {
  onAppend: (
    callback: (data: { channelId: string; message: string; type?: string }) => void,
  ) => () => void
}

export function buildOutputApi(): OutputApi {
  return {
    onAppend: (callback) => {
      const handler = (
        _event: IpcRendererEvent,
        data: { channelId: string; message: string; type?: string },
      ) => callback(data)
      ipcRenderer.on('output:append', handler)
      return () => ipcRenderer.removeListener('output:append', handler)
    },
  }
}
