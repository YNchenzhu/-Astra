/**
 * Type-safe wrapper around window.electronAPI.
 * Returns null for non-Electron environments (dev in browser).
 */
import type { PermissionMode, StreamEvent } from '../types'
import type { PromptDiagnosticsRecordCompact } from '../types/workspaceModels'
import { getMessages } from '../i18n'
import { useSettingsStore } from '../stores/useSettingsStore'

function getAPI() {
  return typeof window !== 'undefined' && window.electronAPI ? window.electronAPI : null
}

/** Localized `electronApi` strings for the current UI locale (non-React context). */
function electronApiMessages() {
  return getMessages(useSettingsStore.getState().uiLocale).settings.electronApi
}

export function isElectron(): boolean {
  return !!getAPI()
}

export async function showItemInFolder(fullPath: string): Promise<{ success: boolean; error?: string }> {
  const api = getAPI()
  if (!api?.fs?.showItemInFolder) {
    return { success: false, error: electronApiMessages().openInFolderUnsupported }
  }
  return api.fs.showItemInFolder(fullPath)
}

export async function renameInWorkspace(
  workspaceRoot: string,
  fromRelative: string,
  toRelative: string,
): Promise<{ success: boolean; error?: string }> {
  const api = getAPI()
  if (!api?.fs?.renameInWorkspace) {
    return { success: false, error: electronApiMessages().renameUnsupported }
  }
  return api.fs.renameInWorkspace(workspaceRoot, fromRelative, toRelative)
}

export async function openPathInOS(fullPath: string): Promise<{ success: boolean; error?: string }> {
  const api = getAPI()
  if (!api?.fs?.openPath) {
    return { success: false, error: electronApiMessages().openPathUnsupported }
  }
  return api.fs.openPath(fullPath)
}

/** Payload for `sendMessage` / `window.electronAPI.ai.sendMessage` (renderer → main). */
export type SendAIMessageParams = {
  messages: Array<{
    role: 'user' | 'assistant'
    content: string | Array<Record<string, unknown>>
  }>
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
  /** When set, replaces default layered system prompt on main */
  systemPrompt?: string
  injectLspPassiveDiagnostics?: boolean | 'full' | 'errors-only' | 'off'
  outputStyle?: 'default' | 'concise' | 'explanatory'
  language?: string
  enableTools?: boolean
  permissionMode?: PermissionMode
  /**
   * Stage 3.3 — renderer chat-input mode (Agent / Plan / Ask). Forwarded to
   * the kernel's `getChatMode` so the orchestration-layer plan/ask permission
   * port can deny mutating / all tools at preflight. Independent of
   * {@link permissionMode}. Defaults to `'agent'` when omitted.
   */
  chatInteractionMode?: 'agent' | 'plan' | 'ask'
  diffPermissionMode?: 'default' | 'bypassPermissions'
  /** Settings → Permissions (tool policy); separate from diffPermissionMode */
  permissionDefaultMode?: 'allow' | 'ask' | 'deny'
  /** Per-tool overrides; first matching pattern wins */
  permissionRules?: Array<{ id: string; pattern: string; mode: 'allow' | 'ask' | 'deny' }>
  agentType?: string
  alwaysThinking?: boolean
  /** 0 = auto (when 深度思考 on: maxTokens×4 capped); >0 overrides thinking budget tokens */
  thinkingBudgetTokens?: number
  hooks?: Array<{ id: string; event: string; command: string; enabled: boolean; matcher?: string; async?: boolean; asyncRewake?: boolean }>
  disableAllHooks?: boolean
  envVars?: Array<{ id: string; key: string; value: string; enabled: boolean }>
  defaultShell?: 'bash' | 'powershell' | 'cmd' | 'zsh'
  effortLevel?: 'low' | 'medium' | 'high' | 'max'
  fastMode?: boolean
  autoMemoryEnabled?: boolean
  autoMemoryDirectory?: string
  /** Settings → Rules panel: injected into main-process system prompt */
  userRulesPrompt?: string
  /** Supervisor-style routing hints in system prompt (default on in settings) */
  autoTaskRouting?: boolean

  // ─── 工作包主智能体覆盖(Workbench primary-agent overlay) ───
  //
  // 这些字段由 `src/stores/chat/storeCompose.ts:sendMessage` 根据当前激活
  // bundle 的 primary agent 填入,让主对话的行为跟主智能体配置保持一致。
  // 任何一个为 undefined 表示 "走默认 / settings"。对应消费端在
  // `electron/ai/streamHandler.ts` 的 `handleSendMessage` 内。
  /** 追加到 systemPrompt 顶部的"关键提醒"(高优先级,模型首轮就必读) */
  primaryAgentCriticalReminder?: string
  /** 追加到 systemPrompt 底部的"初始提示词"(会话启动上下文) */
  primaryAgentInitialPrompt?: string
  /** 工作包主智能体预加载的 skill id 列表,正文注入到 systemPrompt 末尾 */
  primaryAgentSkills?: string[]
  /** 只读模式:为主 AI 注入 Write/Edit/NotebookEdit/Bash(写) 的 deny rules */
  primaryAgentIsReadOnly?: boolean
  /** 主智能体级别的 hook 列表,会和 settings.hooks 合并(bundle hooks 优先) */
  primaryAgentHooks?: Array<{
    id: string
    event: string
    command: string
    enabled: boolean
    matcher?: string
    async?: boolean
    asyncRewake?: boolean
  }>
  /** 省略 CLAUDE.md 注入(如主智能体声明了 omitClaudeMd) */
  primaryAgentOmitClaudeMd?: boolean
  /**
   * 主智能体声明的工具白名单(如 `['Read', 'Grep']`)。非空 / 非 `['*']`
   * 时,主对话只暴露这些工具 + mcpServers 允许的 MCP 工具。
   */
  primaryAgentTools?: string[]
  /** 主智能体声明的工具黑名单(与白名单互斥,白名单优先)。 */
  primaryAgentDisallowedTools?: string[]
  /**
   * 主智能体声明的 MCP 服务器白名单(名字数组)。非空时主对话只暴露这些
   * server 下的 `mcp__*` 工具;未声明则不过滤(全量 MCP 可见)。
   */
  primaryAgentMcpServers?: string[]
  /** 主智能体的 memory scope ('user' | 'project' | 'local'),下传给子 agent 读记忆用。 */
  primaryAgentMemoryScope?: 'user' | 'project' | 'local'
}

export async function sendMessage(params: SendAIMessageParams): Promise<void> {
  const api = getAPI()
  if (!api) throw new Error('Not running in Electron')
  return api.ai.sendMessage(params)
}

export async function respondPermissionRequest(params: {
  requestId: string
  behavior: 'allow' | 'deny'
  updatedInput?: Record<string, unknown>
}): Promise<boolean> {
  // Previously returned `false` when the bridge was missing, which the
  // permission dialog UI could not distinguish from an explicit deny → user
  // sees the prompt freeze forever. Throw so the caller's error path runs.
  const api = getAPI()
  if (!api) {
    throw new Error(
      'respondPermissionRequest: window.electronAPI is not available (preload bridge missing).',
    )
  }
  return api.ai.respondPermissionRequest(params)
}

/** upstream §7.9 — leader resolves teammate tool permission wait (`tperm-*`). */
export async function respondTeamPermissionRequest(params: {
  teamRequestId: string
  behavior: 'allow' | 'deny'
  updatedInput?: Record<string, unknown>
}): Promise<boolean> {
  const api = getAPI()
  if (!api?.ai.teamPermissionReply) {
    throw new Error(
      'respondTeamPermissionRequest: api.ai.teamPermissionReply is not available (preload bridge missing or outdated).',
    )
  }
  return api.ai.teamPermissionReply(params)
}

export async function respondAskUserQuestion(params: {
  requestId: string
  answers: Record<string, string>
  annotations?: Record<string, { preview?: string; notes?: string }>
  /** Durable-HITL routing hint when the IPC handler has no ALS context. */
  conversationId?: string
}): Promise<boolean> {
  const api = getAPI()
  if (!api) {
    throw new Error(
      'respondAskUserQuestion: window.electronAPI is not available (preload bridge missing).',
    )
  }
  return api.ai.respondAskUserQuestion(params)
}

/**
 * P0-2 follow-up: resolve a pending teammate plan-approval request
 * (upstream §6.2). Closes both the TeamFile mailbox path and the
 * renderer-spawned chat-leader path through the shared resolver map.
 */
export async function respondTeamPlanApproval(params: {
  requestId: string
  approve: boolean
  detail?: string
}): Promise<boolean> {
  const api = getAPI()
  if (!api) {
    throw new Error(
      'respondTeamPlanApproval: window.electronAPI is not available (preload bridge missing).',
    )
  }
  const r = await api.ai.respondTeamPlanApproval(params)
  return r.resolved === true
}

/**
 * the IDE `create_plan`-style main-chat plan-approval resolver (tri-state).
 * `cancelled` aborts the turn; the tool side fires `cancelStream` after
 * the bridge unblocks.
 */
export async function respondPlanApproval(params: {
  requestId: string
  outcome: 'accepted' | 'rejected' | 'cancelled'
  detail?: string
}): Promise<boolean> {
  const api = getAPI()
  if (!api) {
    throw new Error(
      'respondPlanApproval: window.electronAPI is not available (preload bridge missing).',
    )
  }
  const r = await api.ai.respondPlanApproval(params)
  return r.resolved === true
}

/** Must match `CANCEL_ALL_MAIN_STREAMS` in electron/ai/streamHandler.ts */
const IPC_CANCEL_ALL_MAIN_STREAMS = '__ALL_MAIN_STREAMS__'

/**
 * M2 (2026-07) — deliver REAL user text typed while a main stream is in
 * flight to the RUNNING turn via the kernel inbox (instruction-level
 * `kernel_user_input` delivery). Returns `ok: false` when the bridge or
 * kernel is unavailable — the caller MUST fall back to its local replay
 * queue (never drop user input).
 */
export async function enqueueMidTurnInput(params: {
  conversationId: string
  text: string
}): Promise<{ ok: true; inboxItemId: string } | { ok: false; reason: string }> {
  const api = getAPI()
  if (!api?.ai?.enqueueMidTurnInput) return { ok: false, reason: 'bridge_unavailable' }
  try {
    return await api.ai.enqueueMidTurnInput(params)
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

/** Cancel the main-process stream for one chat session. No-op if id is empty. */
export async function cancelStream(conversationId: string): Promise<void> {
  const id = String(conversationId).trim()
  if (!id) return
  const api = getAPI()
  if (!api) {
    throw new Error(
      'cancelStream: window.electronAPI is not available (preload bridge missing).',
    )
  }
  await api.ai.cancel(id)
}

/** Cancel every in-flight main chat stream (workspace switch, full reset). */
export async function cancelAllMainStreams(): Promise<void> {
  const api = getAPI()
  if (!api) {
    throw new Error(
      'cancelAllMainStreams: window.electronAPI is not available (preload bridge missing).',
    )
  }
  await api.ai.cancel(IPC_CANCEL_ALL_MAIN_STREAMS)
}

export async function stopTask(taskId: string): Promise<{ success: boolean; error?: string }> {
  const api = getAPI()
  if (!api) return { success: false, error: 'Not running in Electron' }
  return api.ai.stopTask(taskId)
}

export async function retryTask(taskId: string): Promise<{ success: boolean; taskId?: string; error?: string }> {
  const api = getAPI()
  if (!api) return { success: false, error: 'Not running in Electron' }
  return api.ai.retryTask(taskId)
}

export function onStreamEvent(callback: (event: StreamEvent) => void): () => void {
  const api = getAPI()
  if (!api) return () => {}
  return api.ai.onStreamEvent(callback)
}

export type CronFirePayload = {
  taskId: string
  cron: string
  prompt: string
  agentId?: string
}

/** Cron scheduler fire (main → renderer, `ai:cron-fire`). Returns an unsubscribe fn. */
export function onCronFire(callback: (payload: CronFirePayload) => void): () => void {
  const api = getAPI()
  if (!api?.ai?.onCronFire) return () => {}
  return api.ai.onCronFire(callback)
}

export type LifecycleLogPayload = {
  channelId: string
  message: string
  type?: 'info' | 'warning' | 'error'
}

/** Main-process lifecycle / EventDrivenNetwork lines → renderer (e.g. Output → 应用日志). */
export function onLifecycleLog(callback: (payload: LifecycleLogPayload) => void): () => void {
  const api = getAPI()
  if (!api?.onLifecycleLog) return () => {}
  return api.onLifecycleLog(callback)
}

export type DesktopNotifyMode = 'off' | 'minimized' | 'background' | 'always'

export async function notifyDesktop(params: {
  title: string
  body?: string
  silent?: boolean
  /** @deprecated Prefer `mode: 'minimized'`. */
  onlyWhenMinimized?: boolean
  /** When set, main decides whether to show based on window focus / minimize. */
  mode?: DesktopNotifyMode
}): Promise<{ success: boolean; skipped?: boolean; error?: string }> {
  const api = getAPI()
  if (!api?.system?.notify) return { success: false, error: 'Desktop notification API unavailable' }
  return api.system.notify(params)
}

export async function getSettings(): Promise<Record<string, unknown>> {
  const api = getAPI()
  if (!api) return { providerId: 'anthropic', apiKey: '', model: '', baseUrl: '', maxTokens: 64000 }
  return api.settings.get()
}

export async function saveSettings(settings: Record<string, unknown>): Promise<void> {
  const api = getAPI()
  if (!api) {
    // Old behavior silently returned, so settings-save looked successful even
    // when the preload bridge was missing. Throw so the Settings UI surfaces
    // the failure like every other save path now does.
    throw new Error(
      'saveSettings: window.electronAPI is not available (preload bridge missing).',
    )
  }
  const result = await api.settings.set(settings)
  if (!result.success) {
    throw new Error(result.error || 'Failed to save settings')
  }
}

/**
 * Active plan status (counts + file path) for the chat header `计划 N/M`
 * indicator. Returns `null` when no plan is active or when the preload
 * bridge isn't yet exposed (older builds).
 */
export async function getPlanningStatus(): Promise<null | {
  planFilePath: string
  total: number
  pending: number
  inProgress: number
  completed: number
}> {
  const api = getAPI()
  if (!api?.planning?.getStatus) return null
  return api.planning.getStatus()
}

// ========== Context Management ==========

export interface ContextState {
  estimatedTokens: number
  level: string
  compactCount: number
  consecutiveCompactFailures: number
  lastCompactSummary?: string
  /** Input estimate as % of model context window when main passes `evaluateModel`. */
  usagePercentOfWindow?: number
  breakdown?: {
    totalTokens: number
    heuristicTokens: number
    generatedAt: number
    accuracy: 'heuristic' | 'anchored'
    cache?: {
      inputTokens: number
      outputTokens: number
      cacheCreationInputTokens: number
      cacheReadInputTokens: number
      cachedInputTokens: number
      cacheHitRate: number
    }
    categories: Array<{
      id: string
      label: string
      tokens: number
      percentOfTotal: number
    }>
  }
}

export interface ContextThresholds {
  warningTokens: number
  errorTokens: number
  /** History-snip tier (upstream §9.1 layer 1). Optional for backward compat. */
  historySnipTokens?: number
  microCompactTokens: number
  autoCompactTokens: number
  blockingTokens: number
  anchorBudgetChars: number
}

export async function getContextState(conversationId?: string): Promise<ContextState> {
  const api = getAPI()
  if (!api?.context?.getState) {
    return {
      estimatedTokens: 0,
      level: 'ok',
      compactCount: 0,
      consecutiveCompactFailures: 0,
    }
  }
  return api.context.getState(conversationId) as Promise<ContextState>
}

export async function getPromptDiagnostics(
  options: { limit?: number; conversationId?: string } = {},
): Promise<PromptDiagnosticsRecordCompact[]> {
  const api = getAPI()
  if (!api?.context?.getPromptDiagnostics) return []
  return api.context.getPromptDiagnostics({
    limit: options.limit ?? 20,
    ...(options.conversationId ? { conversationId: options.conversationId } : {}),
  }) as Promise<PromptDiagnosticsRecordCompact[]>
}

/**
 * Render the most recent prompt-diagnostics records into a markdown
 * baseline report. The main process holds the renderer (pure) so the
 * formatting stays consistent between IPC consumers and future CLI use.
 */
export async function renderBaselineReport(payload: {
  title?: string
  prompt: string
  notes?: string
  limit?: number
  conversationId?: string
}): Promise<string> {
  const api = getAPI()
  if (!api?.context?.renderBaselineReport) {
    throw new Error(
      'renderBaselineReport: window.electronAPI is not available (preload bridge missing).',
    )
  }
  return api.context.renderBaselineReport(payload)
}

/**
 * Render the Phase H baseline-vs-current comparison report. Inputs are
 * two arrays of {@link PromptDiagnosticsRecordCompact} captured before
 * and after the alignment work — typically the renderer pre-collected
 * them via {@link getPromptDiagnostics}.
 */
export async function renderBaselineComparison(payload: {
  title?: string
  baselineLabel?: string
  currentLabel?: string
  baseline: PromptDiagnosticsRecordCompact[]
  current: PromptDiagnosticsRecordCompact[]
}): Promise<string> {
  const api = getAPI()
  if (!api?.context?.renderBaselineComparison) {
    throw new Error(
      'renderBaselineComparison: window.electronAPI is not available (preload bridge missing).',
    )
  }
  return api.context.renderBaselineComparison({
    title: payload.title,
    baselineLabel: payload.baselineLabel,
    currentLabel: payload.currentLabel,
    baseline: payload.baseline as unknown as Array<Record<string, unknown>>,
    current: payload.current as unknown as Array<Record<string, unknown>>,
  })
}

/** Main notifies after {@link updateConversationContextDisplay} (throttled). */
export function onContextDisplayUpdated(
  callback: (payload: { conversationId: string | null }) => void,
): () => void {
  const api = getAPI()
  if (!api?.context?.onDisplayUpdated) return () => {}
  return api.context.onDisplayUpdated(callback)
}

export async function getContextThresholds(): Promise<ContextThresholds> {
  const api = getAPI()
  if (!api) {
    return {
      warningTokens: 52_000,
      errorTokens: 64_000,
      microCompactTokens: 76_000,
      autoCompactTokens: 88_000,
      blockingTokens: 102_000,
      anchorBudgetChars: 4000,
    }
  }
  return api.context.getThresholds()
}

export async function setContextThresholds(thresholds: Partial<ContextThresholds>): Promise<boolean> {
  const api = getAPI()
  if (!api) {
    throw new Error(
      'setContextThresholds: window.electronAPI is not available (preload bridge missing).',
    )
  }
  const result = await api.context.setThresholds(thresholds)
  return result.success
}

/**
 * Push the `providerRegistry.ts` model→contextWindow map to the main
 * process once at app boot. Idempotent — calling twice replaces the
 * registry layer wholesale (user overrides are unaffected).
 */
export async function setRegistryContextWindows(
  map: Record<string, number>,
): Promise<{ success: boolean; count?: number; error?: string }> {
  const api = getAPI()
  if (!api?.context?.setRegistryWindows) return { success: false, error: 'no electronAPI' }
  return api.context.setRegistryWindows(map)
}

/** Snapshot of registry-declared windows (after boot push). For Settings UI. */
export async function getRegistryContextWindows(): Promise<Record<string, number>> {
  const api = getAPI()
  if (!api?.context?.getRegistryWindows) return {}
  return api.context.getRegistryWindows()
}

/** Snapshot of user-edited overrides. For Settings UI. */
export async function getUserContextWindowOverrides(): Promise<Record<string, number>> {
  const api = getAPI()
  if (!api?.context?.getUserWindowOverrides) return {}
  return api.context.getUserWindowOverrides()
}

/** Persist a single user override (or update existing). */
export async function setUserContextWindowOverride(
  modelId: string,
  tokens: number,
): Promise<{ success: boolean; error?: string }> {
  const api = getAPI()
  if (!api?.context?.setUserWindowOverride) return { success: false, error: 'no electronAPI' }
  return api.context.setUserWindowOverride({ modelId, tokens })
}

/** Drop a single user override. */
export async function clearUserContextWindowOverride(
  modelId: string,
): Promise<{ success: boolean; error?: string }> {
  const api = getAPI()
  if (!api?.context?.clearUserWindowOverride) return { success: false, error: 'no electronAPI' }
  return api.context.clearUserWindowOverride({ modelId })
}

export async function resetContext(payload?: { conversationId?: string }): Promise<boolean> {
  const api = getAPI()
  if (!api) {
    throw new Error(
      'resetContext: window.electronAPI is not available (preload bridge missing).',
    )
  }
  const result = await api.context.reset(payload)
  return result.success
}

export async function analyzeContext(input: {
  model: string
  systemPrompt: string
  messages: Array<Record<string, unknown>>
  toolDefinitions?: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>
  memoryTokens?: number
  skillTokens?: number
}): Promise<import('../types').ContextAnalysisResult | null> {
  const api = getAPI()
  if (!api?.context?.analyze) return null
  return api.context.analyze(input)
}

export async function analyzeContextLive(): Promise<import('../types').ContextAnalysisResult | null> {
  const api = getAPI()
  if (!api?.context?.analyzeLive) return null
  return api.context.analyzeLive()
}

export async function analyzeContextFormatted(input: {
  model: string
  systemPrompt: string
  messages: Array<Record<string, unknown>>
  toolDefinitions?: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>
  memoryTokens?: number
  skillTokens?: number
}): Promise<string | null> {
  const api = getAPI()
  if (!api?.context?.analyzeFormatted) return null
  return api.context.analyzeFormatted(input)
}

export async function restartTypeScriptServer(): Promise<{ success: boolean; error?: string }> {
  // `lsp:restart-typescript-server` is a global restart in main — it
  // does not take a workspace path. The earlier signature accepted one
  // but the preload + main both dropped it; keeping the arg on the
  // renderer side was misleading.
  const api = getAPI()
  if (!api?.lsp?.restartTypeScriptServer) {
    return { success: false, error: 'TypeScript server restart API unavailable' }
  }
  return api.lsp.restartTypeScriptServer()
}

// ========== Tool Registry ==========

export async function listTools(): Promise<{ tools: string[]; definitions: unknown[] }> {
  const api = getAPI()
  if (!api) return { tools: [], definitions: [] }
  return api.tools.list()
}

export async function executeTool(
  toolName: string,
  input: Record<string, unknown>
): Promise<{ success: boolean; output?: string; error?: string }> {
  const api = getAPI()
  if (!api) return { success: false, error: 'Not running in Electron' }
  return api.tools.execute(toolName, input)
}
