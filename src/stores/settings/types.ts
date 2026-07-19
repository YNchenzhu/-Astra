/**
 * Shared types for the settings store.
 *
 * Extracted from `useSettingsStore.ts` so each slice under `./slices/*.ts`
 * can pull exactly the shape it needs without risking a circular import
 * with the store entry. `SettingsState` is intentionally kept as a single
 * flat interface — each slice derives its sub-shape via `Pick<SettingsState, …>`
 * to stay in lock-step with the final composed object.
 */

import type { UiLocale } from '../../i18n/locale'
import type { AnthropicThinkingCapability } from '../../types/providerCapabilities'
import type { ProviderId } from './providers'

// ─── Public value-type aliases ────────────────────────────────────────

export type { AnthropicThinkingCapability, UiLocale }

export type UIThemeSetting = 'dark' | 'light' | 'milk' | 'cursor' | 'system'
export type OutputStyleSetting = 'default' | 'concise' | 'explanatory'
export type EffortLevel = 'low' | 'medium' | 'high' | 'max'
export type DefaultShell = 'bash' | 'powershell' | 'cmd' | 'zsh'
export type DesktopNotificationMode = 'off' | 'minimized' | 'background' | 'always'
export type PermissionMode = 'allow' | 'deny' | 'ask'

/**
 * When the workspace file watcher reports an on-disk change for an open tab:
 * - `skip_if_dirty`: do not overwrite the editor buffer if the tab has unsaved edits (default).
 * - `always_reload`: always replace buffer from disk (may discard local edits).
 */
export type ExternalDiskChangeRefreshMode = 'skip_if_dirty' | 'always_reload'

/** Main-process `isWorkspaceTrusted`: legacy = missing trust file ⇒ treat all as trusted; strict = missing ⇒ none. */
export type WorkspaceTrustModeSetting = 'legacy' | 'strict'

/**
 * Where a custom agent definition lives on disk. Mirrored in the main
 * process by `electron/agents/customAgents.ts`.
 *
 * - `user-global` — `~/.claude/agents/*.md` (cross-device user agents)
 * - `user-app`    — `%APPDATA%/.../agents/*.md` (app-scoped user agents)
 * - `project`     — `<workspace>/.claude/agents/*.md`
 * - `extra`       — arbitrary directories the user has registered via
 *                   `customAgentsExtraDirs`.
 */
export type CustomAgentScopeSetting = 'user-global' | 'user-app' | 'project' | 'extra'

/**
 * How the diff approval UI is wired to backend state.
 *
 * - `legacy`: existing behaviour. Renderer optimistically removes `pendingChanges` the moment
 *   the user clicks accept and relies on the `file_change_applied` stream event to resync
 *   tab buffers.
 * - `dt`: DiffTransaction-authoritative. The user click only sends the permission IPC; the
 *   renderer keeps the diff visible until the main process broadcasts the DT transitioning
 *   into `Applied` / `Failed` / `Rejected`. Fixes flash-to-original + desync symptoms.
 */
export type DiffPrecisionMode = 'legacy' | 'dt'

/** 设置对话框左侧分类,与 `SettingsDialog` 中列表一致。
 *  注:agents / teammates 已移除 —— 这两类配置属于 Bundle 范畴,
 *  统一由智能体工作台(AgentWorkbench)承载。 */
export type SettingsCategoryId =
  | 'api' | 'manual' | 'model' | 'permissions' | 'sandbox'
  | 'hooks' | 'env' | 'appearance' | 'context' | 'buddy'
  | 'mcp' | 'rules' | 'memory' | 'skills' | 'tools' | 'storage'
  | 'lsp' | 'embedding' | 'h5' | 'im'

// ─── Structured shapes ────────────────────────────────────────────────

export interface ApiConfig {
  id: string
  name: string
  providerId: ProviderId
  model: string
  apiKey: string
  baseUrl: string
  awsRegion: string
  projectId: string
  maxTokens: number
  /** 自动检测 API 格式（OpenAI/OpenAI2/Gemini）并转换为 Claude 格式 */
  autoDetectFormat?: boolean
  anthropicThinkingCapability?: AnthropicThinkingCapability
}

export interface PermissionRule {
  id: string
  pattern: string  // tool name or pattern
  mode: PermissionMode
}

export interface EnvVar {
  id: string
  key: string
  value: string
  enabled: boolean
}

export interface HookConfig {
  id: string
  event: string  // PreToolUse, PostToolUse, PostToolUseFailure, PermissionRequest, FileChanged, etc.
  command: string
  enabled: boolean
  /** Match pattern: tool name, pipe-separated list, regex, or * for all */
  matcher?: string
  /** Run in background without blocking */
  async?: boolean
  /** Wait for completion but notify model on exit code 2 */
  asyncRewake?: boolean
  /** ID of the built-in preset this hook was created from */
  builtInId?: string
}

export interface ManualConfig {
  apiKey: string
  baseUrl: string
  awsRegion: string
  projectId: string
  anthropicThinkingCapability?: AnthropicThinkingCapability
}

/**
 * Persisted to disk; main process syncs into `electron/utils/sandbox/applyFromSettings.ts`.
 * Foreground Bash uses sandbox command path when enabled (Linux/macOS: optional bwrap / sandbox-exec).
 */
export interface SandboxSettings {
  enabled: boolean
  failIfUnavailable: boolean
  allowNetwork: boolean
  allowFilesystem: boolean
  allowedDirectories: string[]
}

/** Shape of the raw JSON loaded from disk (what the main process returns). */
export interface PersistedSettingsShape {
  apiConfigs?: ApiConfig[]
  activeConfigId?: string | null
  manualConfig?: ManualConfig
  manualProviderId?: ProviderId
  manualModel?: string
  manualMaxTokens?: number
  manualAutoDetectFormat?: boolean
  anthropicThinkingCapability?: AnthropicThinkingCapability
  theme?: UIThemeSetting
  outputStyle?: OutputStyleSetting
  language?: string
  /** 界面显示语言（BCP-47 locale code）。与 `language`（AI 回复语言）区分。 */
  uiLocale?: UiLocale
  effortLevel?: EffortLevel
  fastMode?: boolean
  alwaysThinking?: boolean
  /** 0 = auto when 深度思考: maxTokens×4 (capped); >0 fixed budget for main chat ALS */
  thinkingBudgetTokens?: number
  showThinkingSummaries?: boolean
  /**
   * Opt-in: when true, `cleanMessagesForPersist` truncates each
   * historical `thinking` block's text to a short preview at save time
   * (≤200 chars + elided suffix) and strips the cryptographic
   * `signature`. Drops conversation JSON size dramatically in long
   * agentic sessions (10 sub-agents × 5 turns × 8KB reasoning easily
   * accumulates 400 KB+/conv); reload is also cheaper since the
   * renderer doesn't have to re-mount the full ReactMarkdown tree per
   * block.
   *
   * Trade-off: a compacted block cannot be echoed back verbatim to the
   * model on a subsequent turn, so DeepSeek Anthropic-compat / Anthropic
   * native may 400 if the same conversation continues with extended
   * thinking still active. In practice this hits only when the user
   * stays on the SAME model + reopens the conversation + continues a
   * thinking-active turn; model swaps already strip signatures via
   * {@link stripThinkingSignaturesFromAssistantBlocks}.
   *
   * Default OFF — opt-in only.
   */
  compactThinkingOnSave?: boolean
  /**
   * 长会话兜底（plan Phase 3.B）：当前会话累积的 thinking 块总数超过该阈值时，
   * 所有"非 streaming 的"历史 thinking 块默认强制折叠（用户手动展开仍生效）。
   * 收益：长 agentic 任务中 thinking 块累积到几十甚至上百时，避免一屏全是
   * 默认展开的厚重 markdown 阻挡用户视线。
   *
   * 0 = 关闭该机制（保持原行为：仅 mount 时根据 isStreaming 决定，3.5s 后自动收）。
   * 默认 8。
   */
  thinkingAutoCollapseThreshold?: number
  tabAutocompleteEnabled?: boolean
  inlineDiffsEnabled?: boolean
  defaultDiffViewMode?: 'inline' | 'side-by-side'
  externalDiskChangeRefreshMode?: ExternalDiskChangeRefreshMode
  defaultShell?: DefaultShell
  prefersReducedMotion?: boolean
  promptSuggestionEnabled?: boolean
  /** When true, main process injects task-type routing + workflow hints into system prompt */
  autoTaskRouting?: boolean
  spinnerTipsEnabled?: boolean
  desktopNotificationMode?: DesktopNotificationMode
  notifyOnAskUserQuestion?: boolean
  notifyOnSubagentCompleted?: boolean
  notifyOnSubagentFailed?: boolean
  notifyOnSubagentStopped?: boolean
  permissionDefaultMode?: PermissionMode
  permissionRules?: PermissionRule[]
  skipDangerousModePermissionPrompt?: boolean
  workspaceTrustMode?: WorkspaceTrustModeSetting
  diffPrecisionMode?: DiffPrecisionMode
  customAgentsExtraDirs?: string[]
  defaultNewAgentScope?: CustomAgentScopeSetting
  sandbox?: SandboxSettings
  hooks?: HookConfig[]
  disableAllHooks?: boolean
  envVars?: EnvVar[]
  autoMemoryEnabled?: boolean
  autoMemoryDirectory?: string
  /**
   * Sprint 6 — 自动把 agent 的完成经验写进 agent-memory 目录,供
   * 下次同类型 agent 的 system prompt 自动读取。默认关闭。
   * 后端在 `activeAgentRegistry.unregisterActiveAgent` 里读这个字段。
   */
  agentExperienceMemoryEnabled?: boolean
  /** When false, recall uses keyword scoring only (no LLM side query). */
  memoryAiRecallEnabled?: boolean
  /** When false, memory recall falls back to the pre-hybrid pipeline (keyword / LLM). */
  memoryHybridRecallEnabled?: boolean
  /** 0..1 — how strongly recent memories are boosted in hybrid RRF fusion. */
  memoryFreshnessWeight?: number
  /**
   * Cosine floor for retrieval hits (memory vector / workspace / attachment).
   * Below this threshold a hit is dropped, not just demoted. 0 disables the
   * floor (legacy behaviour). Default 0.30 (BGE-M3 measured "relevant vs
   * noise" boundary).
   */
  memoryRecallMinScore?: number
  /** Skip the retrieval pipeline when trimmed query is shorter than this. Default 8. */
  memoryRecallSkipShortQueryChars?: number
  /** Final number of memories injected into the prompt. Default 5. */
  memoryRecallTopK?: number
  /** Per-recall character budget for the assembled section. Default 24_000. */
  memoryRecallMaxBytes?: number
  /** Per-conversation byte budget; once exceeded recall is silently skipped. Default 32_000. */
  memoryRecallSessionBudgetBytes?: number
  /** Workspace semantic context master switch. Default true. */
  workspaceContextEnabled?: boolean
  /** Workspace top-K. Default 6. */
  workspaceContextTopK?: number
  /** Workspace cosine floor. Default 0.30. */
  workspaceContextMinScore?: number
  /** Attachment top-K. Default 6. */
  attachmentContextTopK?: number
  /** Attachment cosine floor. Default 0.30. */
  attachmentContextMinScore?: number
  /**
   * Embedding config shared by attachment RAG retrieval + memory semantic recall.
   * OpenAI-compatible `/v1/embeddings` endpoint (OpenAI, Jina, SiliconFlow,
   * Ollama, LM Studio, etc.). Required only when `embeddingMode !== 'local'`.
   */
  embeddingProviderId?: string
  embeddingModel?: string
  embeddingApiKey?: string
  embeddingBaseUrl?: string
  embeddingDimensions?: number
  /** Local | Cloud | Auto dispatch. Default 'auto' (local-first, cloud fallback). */
  embeddingMode?: 'local' | 'cloud' | 'auto'
  /** Preferred local ONNX model id (matches a folder under resources/embeddings/). */
  embeddingLocalModelId?: string
  /** Reranker endpoint (Jina / Cohere / SiliconFlow compatible). Completely optional. */
  rerankProviderId?: string
  rerankModel?: string
  rerankApiKey?: string
  rerankBaseUrl?: string
  dataStoragePath?: string
  agentStoragePath?: string
  /** Brave Search API key for WebSearch / Brave MCP; main reads only this field (not `BRAVE_API_KEY`). */
  webSearchBraveApiKey?: string
  /**
   * Baidu AI Search API key (qianfan `bce-v3/ALTAK-...`). Used by the built-in
   * web_search tool when the query is CJK-biased or Brave is unavailable.
   * Main-process reads only this field; no env fallback.
   */
  webSearchBaiduApiKey?: string
  /** Omit Glob/Grep from model tool list (upstream embedded search mode); env `ASTRA_EMBEDDED_SEARCH` overrides. */
  embeddedSearchTools?: boolean
  /**
   * Tool names the user has explicitly disabled in Settings → 工具 panel.
   * Persisted here so renderer-side tool registry (`useToolRegistry.enabledTools`)
   * can be reconstructed on next launch. Tools NOT in this list default to enabled.
   */
  disabledTools?: string[]
  /**
   * User-edited per-model context-window overrides (Settings → 上下文 →
   * 模型窗口覆盖). Keys are lowercased model ids; values are positive
   * token counts. Wins over `providerRegistry.contextWindow` and the
   * regex tier in `electron/context/openClaudeParityConstants.ts`.
   * See `electron/context/modelWindowOverrides.ts` for the lookup chain.
   */
  modelContextWindowOverrides?: Record<string, number>
}

// ─── Flat composed store state ────────────────────────────────────────

export interface SettingsState {
  // 当前生效的运行时状态（只读派生，由 activeConfig 或 manual 模式驱动）
  providerId: ProviderId
  model: string
  maxTokens: number
  autoDetectFormat?: boolean
  theme: UIThemeSetting
  outputStyle: OutputStyleSetting
  language: string
  /** 界面显示语言（BCP-47 locale code）。驱动整个 UI 的 i18n 文案。 */
  uiLocale: UiLocale

  isLoaded: boolean
  showSettings: boolean
  /** 打开设置时可选：自动切换到该分类（一次性，由 consumeSettingsEntryPanel 消费） */
  settingsEntryPanel: SettingsCategoryId | null

  // ===== Data Storage Paths =====
  /** 应用数据存储路径（对话、会话、记忆等），默认为 userData */
  dataStoragePath: string
  /** 自定义智能体存储路径（项目本地路径），默认为安装路径下的 .agents */
  agentStoragePath: string

  // 持久化：已保存的 API 配置列表
  apiConfigs: ApiConfig[]
  // 持久化：当前激活的配置 ID（null = 手动模式）
  activeConfigId: string | null

  // 持久化：手动模式的凭证和 provider/model（当 activeConfigId 为 null 时使用）
  manualConfig: ManualConfig
  manualProviderId: ProviderId
  manualModel: string
  manualMaxTokens: number
  manualAutoDetectFormat?: boolean

  // 运行时获取器（总是返回当前生效的值）
  getApiKey: () => string
  getBaseUrl: () => string
  getAwsRegion: () => string
  getProjectId: () => string
  getAnthropicThinkingCapability: () => AnthropicThinkingCapability
  getActiveConfig: () => ApiConfig | null
  isManualMode: () => boolean

  // ===== Model & Behavior =====
  effortLevel: EffortLevel
  fastMode: boolean
  alwaysThinking: boolean
  thinkingBudgetTokens: number
  showThinkingSummaries: boolean
  /** See {@link UserSettings.compactThinkingOnSave} for full rationale. */
  compactThinkingOnSave: boolean
  /** 长会话兜底阈值（plan Phase 3.B）。0 = 关闭；默认 8。详见 PersistedSettingsShape 同名字段。 */
  thinkingAutoCollapseThreshold: number
  tabAutocompleteEnabled: boolean
  inlineDiffsEnabled: boolean
  defaultDiffViewMode: 'inline' | 'side-by-side'
  externalDiskChangeRefreshMode: ExternalDiskChangeRefreshMode
  defaultShell: DefaultShell
  prefersReducedMotion: boolean
  promptSuggestionEnabled: boolean
  autoTaskRouting: boolean
  spinnerTipsEnabled: boolean
  desktopNotificationMode: DesktopNotificationMode
  notifyOnAskUserQuestion: boolean
  notifyOnSubagentCompleted: boolean
  notifyOnSubagentFailed: boolean
  notifyOnSubagentStopped: boolean

  // ===== Permissions =====
  permissionDefaultMode: PermissionMode
  permissionRules: PermissionRule[]
  skipDangerousModePermissionPrompt: boolean
  workspaceTrustMode: WorkspaceTrustModeSetting

  // ===== Diff approval precision =====
  /**
   * Default `legacy` (existing behaviour, zero risk). Users can opt into `dt`
   * for the DiffTransaction-authoritative path. Runtime kill-switch is also
   * exposed on `window.__setDiffPrecisionMode(...)`.
   */
  diffPrecisionMode: DiffPrecisionMode

  // ===== Custom agents (scope prefs) =====
  /** Extra directories registered for custom `.md` agent definitions. */
  customAgentsExtraDirs: string[]
  /** Default save destination picked in the "new custom agent" form. */
  defaultNewAgentScope: CustomAgentScopeSetting

  // ===== Sandbox =====
  sandbox: SandboxSettings

  // ===== Hooks =====
  hooks: HookConfig[]
  disableAllHooks: boolean

  // ===== Environment =====
  envVars: EnvVar[]

  // ===== Memory =====
  autoMemoryEnabled: boolean
  autoMemoryDirectory: string
  /** Sprint 6: 跨会话经验沉淀开关(默认 false)。 */
  agentExperienceMemoryEnabled: boolean
  memoryAiRecallEnabled: boolean
  /** Hybrid recall (BM25 + vector + freshness + structured) on by default. */
  memoryHybridRecallEnabled: boolean
  /** 0..1 freshness weight used by RRF fusion; default 0.5. */
  memoryFreshnessWeight: number
  /** Cosine floor for retrieval results (memory/workspace/attachment); default 0.30. */
  memoryRecallMinScore: number
  /** Skip retrieval entirely when trimmed query is shorter than this; default 8. */
  memoryRecallSkipShortQueryChars: number
  /** Final memory entries injected into the prompt; default 5. */
  memoryRecallTopK: number
  /** Per-recall char budget for the assembled section; default 24_000. */
  memoryRecallMaxBytes: number
  /** Per-conversation byte budget; once exceeded recall is silently skipped; default 32_000. */
  memoryRecallSessionBudgetBytes: number
  /** Workspace semantic context master switch; default true. */
  workspaceContextEnabled: boolean
  /** Workspace top-K; default 6. */
  workspaceContextTopK: number
  /** Workspace cosine floor; default 0.30. */
  workspaceContextMinScore: number
  /** Attachment top-K; default 6. */
  attachmentContextTopK: number
  /** Attachment cosine floor; default 0.30. */
  attachmentContextMinScore: number
  /** Embedding cloud config (shared with RAG + memory). */
  embeddingProviderId: string
  embeddingModel: string
  embeddingApiKey: string
  embeddingBaseUrl: string
  /** Optional output-dim override. Null = use model native dim. */
  embeddingDimensions: number | null
  /** Local | Cloud | Auto dispatch (default 'auto'). */
  embeddingMode: 'local' | 'cloud' | 'auto'
  /** Which local model id to use (empty = pick first installed). */
  embeddingLocalModelId: string
  /** Cross-encoder reranker (optional). */
  rerankProviderId: string
  rerankModel: string
  rerankApiKey: string
  rerankBaseUrl: string

  /** Brave Search API key (persisted); main process uses only this for Brave Search. */
  webSearchBraveApiKey: string
  /** Baidu AI Search API key (persisted); main process uses only this for Baidu. */
  webSearchBaiduApiKey: string
  /** When true, Glob/Grep are hidden from the tool list (unless env overrides). */
  embeddedSearchTools: boolean
  /** Names of tools the user has disabled; renderer tool registry seeds from this list. */
  disabledTools: string[]

  // ─── Actions ────────────────────────────────────────────────────────

  // 初始化
  loadSettings: () => Promise<void>

  // 设置 Dialog 控制
  setShowSettings: (show: boolean, entryPanel?: SettingsCategoryId | null) => void
  consumeSettingsEntryPanel: () => SettingsCategoryId | null

  setTheme: (theme: UIThemeSetting) => void
  setOutputStyle: (style: OutputStyleSetting) => void
  setLanguage: (language: string) => void
  setUiLocale: (locale: UiLocale) => void

  // Model & Behavior
  setEffortLevel: (level: EffortLevel) => void
  setFastMode: (enabled: boolean) => void
  setAlwaysThinking: (enabled: boolean) => void
  setThinkingBudgetTokens: (n: number) => void
  setShowThinkingSummaries: (enabled: boolean) => void
  setCompactThinkingOnSave: (enabled: boolean) => void
  /** 长会话兜底：设置 thinking 块总数阈值（0 = 关闭）。默认 8。 */
  setThinkingAutoCollapseThreshold: (n: number) => void
  setTabAutocompleteEnabled: (enabled: boolean) => void
  setInlineDiffsEnabled: (enabled: boolean) => void
  setDefaultDiffViewMode: (mode: 'inline' | 'side-by-side') => void
  setExternalDiskChangeRefreshMode: (mode: ExternalDiskChangeRefreshMode) => void
  setDefaultShell: (shell: DefaultShell) => void
  setPrefersReducedMotion: (enabled: boolean) => void
  setPromptSuggestionEnabled: (enabled: boolean) => void
  setAutoTaskRouting: (enabled: boolean) => void
  setSpinnerTipsEnabled: (enabled: boolean) => void
  setDesktopNotificationMode: (mode: DesktopNotificationMode) => void
  setNotifyOnAskUserQuestion: (enabled: boolean) => void
  setNotifyOnSubagentCompleted: (enabled: boolean) => void
  setNotifyOnSubagentFailed: (enabled: boolean) => void
  setNotifyOnSubagentStopped: (enabled: boolean) => void

  // Permissions
  setPermissionDefaultMode: (mode: PermissionMode) => void
  addPermissionRule: (rule: Omit<PermissionRule, 'id'>) => void
  removePermissionRule: (id: string) => void
  updatePermissionRule: (id: string, partial: Partial<PermissionRule>) => void
  setSkipDangerousModePermissionPrompt: (enabled: boolean) => void
  setWorkspaceTrustMode: (mode: WorkspaceTrustModeSetting) => void

  // Diff approval precision
  /** Flip diff approval mode. Persisted via saveSettings; takes effect immediately. */
  setDiffPrecisionMode: (mode: DiffPrecisionMode) => void

  // Custom agents scope prefs
  /** Replace the list of extra directories scanned for custom agents. */
  setCustomAgentsExtraDirs: (dirs: string[]) => void
  /** Update the default save destination for new custom agents. */
  setDefaultNewAgentScope: (scope: CustomAgentScopeSetting) => void

  // Sandbox
  setSandboxSettings: (settings: Partial<SandboxSettings>) => void

  // Hooks
  addHook: (hook: Omit<HookConfig, 'id'>) => void
  removeHook: (id: string) => void
  updateHook: (id: string, partial: Partial<HookConfig>) => void
  setDisableAllHooks: (disabled: boolean) => void
  toggleBuiltInHook: (builtInId: string) => void
  isBuiltInHookEnabled: (builtInId: string) => boolean

  // Environment
  addEnvVar: (envVar: Omit<EnvVar, 'id'>) => void
  removeEnvVar: (id: string) => void
  updateEnvVar: (id: string, partial: Partial<EnvVar>) => void

  // Memory
  setAutoMemoryEnabled: (enabled: boolean) => void
  setMemoryHybridRecallEnabled: (enabled: boolean) => void
  setMemoryFreshnessWeight: (weight: number) => void
  setRecallTuning: (patch: Partial<{
    memoryRecallMinScore: number
    memoryRecallSkipShortQueryChars: number
    memoryRecallTopK: number
    memoryRecallMaxBytes: number
    memoryRecallSessionBudgetBytes: number
    workspaceContextEnabled: boolean
    workspaceContextTopK: number
    workspaceContextMinScore: number
    attachmentContextTopK: number
    attachmentContextMinScore: number
  }>) => void
  setEmbeddingConfig: (patch: Partial<{
    embeddingProviderId: string
    embeddingModel: string
    embeddingApiKey: string
    embeddingBaseUrl: string
    embeddingDimensions: number | null
    embeddingMode: 'local' | 'cloud' | 'auto'
    embeddingLocalModelId: string
  }>) => void
  setRerankConfig: (patch: Partial<{
    rerankProviderId: string
    rerankModel: string
    rerankApiKey: string
    rerankBaseUrl: string
  }>) => void
  setAutoMemoryDirectory: (dir: string) => void
  setMemoryAiRecallEnabled: (enabled: boolean) => void
  setAgentExperienceMemoryEnabled: (enabled: boolean) => void
  setWebSearchBraveApiKey: (key: string) => void
  setWebSearchBaiduApiKey: (key: string) => void
  setEmbeddedSearchTools: (enabled: boolean) => void
  /** Replace the full disabled-tools list (used by tool registry reconcile). */
  setDisabledTools: (names: string[]) => void
  /** Flip a single tool's disabled state and persist. */
  toggleDisabledTool: (name: string) => void

  // Data Storage Paths
  setDataStoragePath: (path: string) => void
  setAgentStoragePath: (path: string) => void

  // 手动模式：更新当前 provider/model/凭证（不保存为配置）
  setManualProvider: (providerId: ProviderId) => void
  setManualModel: (model: string) => void
  setManualField: (field: keyof ManualConfig, value: string) => void
  setManualMaxTokens: (tokens: number) => void
  setManualAutoDetectFormat: (enabled: boolean) => void
  applyManualConfig: (params: {
    providerId: ProviderId
    model: string
    maxTokens: number
    manualConfig: ManualConfig
  }) => void

  // API 配置 CRUD
  addApiConfig: (config: Omit<ApiConfig, 'id'>) => Promise<void>
  updateApiConfig: (id: string, partial: Partial<Omit<ApiConfig, 'id'>>) => Promise<void>
  deleteApiConfig: (id: string) => Promise<void>
  setActiveConfig: (id: string) => void
  clearActiveConfig: () => void
}
