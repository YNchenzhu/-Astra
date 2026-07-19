import type { PermissionMode, StreamEvent } from '../tool'

export interface ElectronAiApi {
  sendMessage: (params: {
    messages: { role: 'user' | 'assistant'; content: string | Array<Record<string, unknown>> }[]
    model?: string
    maxTokens?: number
    conversationId?: string
    workspacePath?: string
    providerId?: string
    apiKey?: string
    baseUrl?: string
    anthropicThinkingCapability?: 'auto' | 'supported' | 'unsupported'
    awsRegion?: string
    projectId?: string
    autoDetectFormat?: boolean
    outputStyle?: 'default' | 'concise' | 'explanatory'
    language?: string
    enableTools?: boolean
    permissionMode?: PermissionMode
    /** Stage 3.3 — renderer chat-input mode forwarded to kernel's chat-mode permission port. */
    chatInteractionMode?: 'agent' | 'plan' | 'ask'
    diffPermissionMode?: 'default' | 'bypassPermissions'
    permissionDefaultMode?: 'allow' | 'ask' | 'deny'
    permissionRules?: Array<{ id: string; pattern: string; mode: 'allow' | 'ask' | 'deny' }>
    agentType?: string
    alwaysThinking?: boolean
    thinkingBudgetTokens?: number
    effortLevel?: 'low' | 'medium' | 'high' | 'max'
    fastMode?: boolean
    hooks?: Array<{ id: string; event: string; command: string; enabled: boolean; matcher?: string; async?: boolean; asyncRewake?: boolean; builtInId?: string }>
    disableAllHooks?: boolean
    envVars?: Array<{ id: string; key: string; value: string; enabled: boolean }>
    defaultShell?: 'bash' | 'powershell' | 'cmd' | 'zsh'
    autoMemoryEnabled?: boolean
    autoMemoryDirectory?: string
    /** When set, replaces default layered system prompt (main-process orchestrationContext) */
    systemPrompt?: string
    userRulesPrompt?: string
    autoTaskRouting?: boolean
  }) => Promise<void>
  cancel: (conversationId?: string) => Promise<void>
  /**
   * M2 (2026-07) — deliver REAL user text typed while a main stream is in
   * flight to the running turn (kernel inbox, instruction-level
   * `kernel_user_input` delivery). On `ok: false` the caller must fall
   * back to the local replay queue — never drop user input.
   */
  enqueueMidTurnInput: (params: {
    conversationId: string
    text: string
  }) => Promise<{ ok: true; inboxItemId: string } | { ok: false; reason: string }>
  stopTask: (taskId: string) => Promise<{ success: boolean; error?: string }>
  retryTask: (taskId: string) => Promise<{ success: boolean; taskId?: string; error?: string }>
  onStreamEvent: (callback: (event: StreamEvent) => void) => () => void
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
   * P0-2 follow-up: leader-side approval card resolves a pending
   * teammate `team_plan_approval_request`. Closes both the TeamFile
   * mailbox path and the renderer-spawned chat-leader path through
   * the shared resolver map (upstream §6.2).
   */
  /**
   * the IDE `create_plan`-style main-chat plan-approval resolver
   * (tri-state). `cancelled` aborts the turn — the tool side fires
   * `cancelStream` after the bridge unblocks.
   */
  respondPlanApproval: (params: {
    requestId: string
    outcome: 'accepted' | 'rejected' | 'cancelled'
    detail?: string
  }) => Promise<{ resolved: boolean }>
  respondTeamPlanApproval: (params: {
    requestId: string
    approve: boolean
    detail?: string
  }) => Promise<{ resolved: boolean }>
  respondAskUserQuestion: (params: {
    requestId: string
    answers: Record<string, string>
    annotations?: Record<string, { preview?: string; notes?: string }>
    conversationId?: string
  }) => Promise<boolean>
  permissionRelayReply: (line: string) => Promise<{ applied: boolean }>
  /**
   * 热切换 diff 权限(变更审核 ↔ 自动写入),AI 正在跑任务时也能生效。
   * P1-30: 可选地传入 `conversationId` 仅覆盖该会话的模式;不传则更新全局默认。
   */
  setDiffPermissionMode?: (
    mode: 'default' | 'bypassPermissions',
    conversationId?: string,
  ) => Promise<
    | { ok: true; mode: 'default' | 'bypassPermissions' }
    | { ok: false; error: string }
  >
  onCronFire?: (
    callback: (payload: {
      taskId: string
      cron: string
      prompt: string
      agentId?: string
    }) => void,
  ) => () => void
}
