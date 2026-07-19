/**
 * Parse a raw `PersistedSettingsShape` (what `getSettings()` returns from
 * the main process) into a partial `SettingsState` that the store can
 * merge directly via `set({...})`.
 *
 * All the type coercion / clamping / default-fill logic lives here so each
 * slice file can stay focused on its actions.
 */
import { DEFAULT_UI_LOCALE, isUiLocale } from '../../i18n/locale'
import { normalizeAnthropicThinkingCapability } from '../../types/providerCapabilities'
import { DEFAULT_MANUAL_CONFIG, DEFAULT_SANDBOX_SETTINGS, DEFAULT_SHELL } from './defaults'
import { getDefaultModel, type ProviderId } from './providers'
import type {
  ApiConfig,
  CustomAgentScopeSetting,
  DefaultShell,
  DesktopNotificationMode,
  DiffPrecisionMode,
  EffortLevel,
  EnvVar,
  ExternalDiskChangeRefreshMode,
  HookConfig,
  ManualConfig,
  OutputStyleSetting,
  PermissionMode,
  PermissionRule,
  PersistedSettingsShape,
  SandboxSettings,
  SettingsState,
  UIThemeSetting,
  WorkspaceTrustModeSetting,
} from './types'

type LoadedSettingsSlice = Partial<
  Omit<SettingsState,
    | 'getApiKey' | 'getBaseUrl' | 'getAwsRegion' | 'getProjectId'
    | 'getAnthropicThinkingCapability'
    | 'getActiveConfig' | 'isManualMode'
    | 'loadSettings' | 'setShowSettings' | 'consumeSettingsEntryPanel'
    // setters excluded — only state fields are hydrated
  >
>

/**
 * Decode + clamp every field in the persisted JSON into store state.
 * Also computes the derived runtime tuple (providerId / model / maxTokens /
 * autoDetectFormat) from the active API config (or manual fallback).
 */
export function parsePersistedSettings(raw: PersistedSettingsShape): LoadedSettingsSlice {
  const apiConfigs: ApiConfig[] = (raw.apiConfigs || []).map((config) => ({
    ...config,
    anthropicThinkingCapability: normalizeAnthropicThinkingCapability(
      config.anthropicThinkingCapability,
    ),
  }))
  const activeConfigId: string | null = raw.activeConfigId || null
  const manualConfig: ManualConfig = {
    ...DEFAULT_MANUAL_CONFIG,
    ...(raw.manualConfig || {}),
    anthropicThinkingCapability: normalizeAnthropicThinkingCapability(
      raw.manualConfig?.anthropicThinkingCapability,
    ),
  }
  const manualProviderId = (raw.manualProviderId as ProviderId) || 'anthropic'
  const manualModel = raw.manualModel || getDefaultModel(manualProviderId)
  const manualMaxTokens = raw.manualMaxTokens || 8192
  const manualAutoDetectFormat = Boolean(raw.manualAutoDetectFormat)
  const theme = (raw.theme as UIThemeSetting) || 'dark'
  const outputStyle = (raw.outputStyle as OutputStyleSetting) || 'default'
  const language = typeof raw.language === 'string' ? raw.language : ''
  const uiLocale = isUiLocale(raw.uiLocale) ? raw.uiLocale : DEFAULT_UI_LOCALE

  // Missing-key fallbacks mirror the slice defaults in `behaviorSlice.ts`
  // (2026-07 quality uplift: effort 'medium', thinking on). Explicitly
  // persisted values always win — only absent keys pick up the new defaults.
  const effortLevel = (raw.effortLevel as EffortLevel) || 'medium'
  const fastMode = Boolean(raw.fastMode)
  const alwaysThinking = raw.alwaysThinking !== false
  const thinkingBudgetTokens =
    typeof raw.thinkingBudgetTokens === 'number' && raw.thinkingBudgetTokens >= 0
      ? Math.min(Math.floor(raw.thinkingBudgetTokens), 32768)
      : 0
  const showThinkingSummaries = Boolean(raw.showThinkingSummaries)
  const compactThinkingOnSave = Boolean(raw.compactThinkingOnSave)
  // 长会话兜底阈值：缺省/非数字 → 8（默认开）；显式 0 → 关闭机制。
  const thinkingAutoCollapseThreshold =
    typeof raw.thinkingAutoCollapseThreshold === 'number' &&
    Number.isFinite(raw.thinkingAutoCollapseThreshold)
      ? Math.min(Math.max(0, Math.floor(raw.thinkingAutoCollapseThreshold)), 9999)
      : 8
  const tabAutocompleteEnabled = raw.tabAutocompleteEnabled !== false
  const inlineDiffsEnabled = raw.inlineDiffsEnabled !== false
  const defaultDiffViewMode = (raw.defaultDiffViewMode as 'inline' | 'side-by-side') || 'inline'
  const externalDiskChangeRefreshMode: ExternalDiskChangeRefreshMode =
    raw.externalDiskChangeRefreshMode === 'always_reload' ? 'always_reload' : 'skip_if_dirty'
  const defaultShell = (raw.defaultShell as DefaultShell) || DEFAULT_SHELL
  const prefersReducedMotion = Boolean(raw.prefersReducedMotion)
  const promptSuggestionEnabled = raw.promptSuggestionEnabled !== false
  const autoTaskRouting = raw.autoTaskRouting !== false
  const spinnerTipsEnabled = raw.spinnerTipsEnabled !== false
  const desktopNotificationMode = (raw.desktopNotificationMode as DesktopNotificationMode) || 'minimized'
  const notifyOnAskUserQuestion = raw.notifyOnAskUserQuestion !== false
  const notifyOnSubagentCompleted = raw.notifyOnSubagentCompleted !== false
  const notifyOnSubagentFailed = raw.notifyOnSubagentFailed !== false
  const notifyOnSubagentStopped = raw.notifyOnSubagentStopped !== false
  const permissionDefaultMode = (raw.permissionDefaultMode as PermissionMode) || 'ask'
  const permissionRules: PermissionRule[] = raw.permissionRules || []
  const skipDangerousModePermissionPrompt = Boolean(raw.skipDangerousModePermissionPrompt)
  const workspaceTrustMode: WorkspaceTrustModeSetting =
    raw.workspaceTrustMode === 'strict' ? 'strict' : 'legacy'
  const diffPrecisionMode: DiffPrecisionMode =
    raw.diffPrecisionMode === 'dt' ? 'dt' : 'legacy'
  const customAgentsExtraDirs: string[] = Array.isArray(raw.customAgentsExtraDirs)
    ? (raw.customAgentsExtraDirs as unknown[]).filter(
        (d): d is string => typeof d === 'string' && d.trim() !== '',
      )
    : []
  const defaultNewAgentScope: CustomAgentScopeSetting = (() => {
    const v = raw.defaultNewAgentScope
    if (v === 'user-global' || v === 'user-app' || v === 'project' || v === 'extra') return v
    return 'user-global'
  })()
  const sandbox: SandboxSettings = raw.sandbox || { ...DEFAULT_SANDBOX_SETTINGS }
  const hooks: HookConfig[] = raw.hooks || []
  const disableAllHooks = Boolean(raw.disableAllHooks)
  const envVars: EnvVar[] = raw.envVars || []
  const autoMemoryEnabled = Boolean(raw.autoMemoryEnabled)
  const autoMemoryDirectory = raw.autoMemoryDirectory || ''
  const memoryAiRecallEnabled = raw.memoryAiRecallEnabled !== false
  const agentExperienceMemoryEnabled = Boolean(raw.agentExperienceMemoryEnabled)
  const memoryHybridRecallEnabled = raw.memoryHybridRecallEnabled !== false
  const memoryFreshnessWeight =
    typeof raw.memoryFreshnessWeight === 'number'
      ? Math.max(0, Math.min(1, raw.memoryFreshnessWeight))
      : 0.5
  // ── Recall tuning (clamped; mirrors electron/memory/recallTuning.ts) ──
  const clampNum = (v: unknown, lo: number, hi: number, fallback: number): number => {
    if (typeof v !== 'number' || !Number.isFinite(v)) return fallback
    return Math.max(lo, Math.min(hi, v))
  }
  const clampInt = (v: unknown, lo: number, hi: number, fallback: number): number => {
    if (typeof v !== 'number' || !Number.isFinite(v)) return fallback
    return Math.max(lo, Math.min(hi, Math.floor(v)))
  }
  const memoryRecallMinScore = clampNum(raw.memoryRecallMinScore, 0, 1, 0.30)
  const memoryRecallSkipShortQueryChars = clampInt(raw.memoryRecallSkipShortQueryChars, 0, 200, 8)
  const memoryRecallTopK = clampInt(raw.memoryRecallTopK, 1, 50, 5)
  const memoryRecallMaxBytes = clampInt(raw.memoryRecallMaxBytes, 1_000, 200_000, 24_000)
  const memoryRecallSessionBudgetBytes = clampInt(
    raw.memoryRecallSessionBudgetBytes, 1_000, 1_000_000, 32_000,
  )
  const workspaceContextEnabled = raw.workspaceContextEnabled !== false
  const workspaceContextTopK = clampInt(raw.workspaceContextTopK, 1, 50, 6)
  const workspaceContextMinScore = clampNum(raw.workspaceContextMinScore, 0, 1, 0.30)
  const attachmentContextTopK = clampInt(raw.attachmentContextTopK, 1, 50, 6)
  const attachmentContextMinScore = clampNum(raw.attachmentContextMinScore, 0, 1, 0.30)
  const embeddingProviderId =
    typeof raw.embeddingProviderId === 'string' ? raw.embeddingProviderId : ''
  const embeddingModel =
    typeof raw.embeddingModel === 'string' ? raw.embeddingModel : ''
  const embeddingApiKey =
    typeof raw.embeddingApiKey === 'string' ? raw.embeddingApiKey : ''
  const embeddingBaseUrl =
    typeof raw.embeddingBaseUrl === 'string' ? raw.embeddingBaseUrl : ''
  const embeddingDimensions =
    typeof raw.embeddingDimensions === 'number' && raw.embeddingDimensions > 0
      ? raw.embeddingDimensions
      : null
  const embeddingMode: 'local' | 'cloud' | 'auto' =
    raw.embeddingMode === 'local' || raw.embeddingMode === 'cloud'
      ? raw.embeddingMode
      : 'auto'
  const embeddingLocalModelId =
    typeof raw.embeddingLocalModelId === 'string' ? raw.embeddingLocalModelId : ''
  const rerankProviderId =
    typeof raw.rerankProviderId === 'string' ? raw.rerankProviderId : ''
  const rerankModel =
    typeof raw.rerankModel === 'string' ? raw.rerankModel : ''
  const rerankApiKey =
    typeof raw.rerankApiKey === 'string' ? raw.rerankApiKey : ''
  const rerankBaseUrl =
    typeof raw.rerankBaseUrl === 'string' ? raw.rerankBaseUrl : ''
  const dataStoragePath = raw.dataStoragePath || ''
  const agentStoragePath = raw.agentStoragePath || ''
  const webSearchBraveApiKey =
    typeof raw.webSearchBraveApiKey === 'string' ? raw.webSearchBraveApiKey : ''
  const webSearchBaiduApiKey =
    typeof raw.webSearchBaiduApiKey === 'string' ? raw.webSearchBaiduApiKey : ''
  const embeddedSearchTools = Boolean(raw.embeddedSearchTools)
  const disabledTools: string[] = Array.isArray(raw.disabledTools)
    ? raw.disabledTools.filter((x): x is string => typeof x === 'string' && x.trim() !== '')
    : []

  // 验证 activeConfigId 指向的配置是否仍存在
  const resolvedActiveConfigId = apiConfigs.find((c) => c.id === activeConfigId) ? activeConfigId : null

  // 派生运行时状态
  let providerId: ProviderId
  let model: string
  let maxTokens: number
  let autoDetectFormat: boolean | undefined

  if (resolvedActiveConfigId) {
    const cfg = apiConfigs.find((c) => c.id === resolvedActiveConfigId)!
    providerId = cfg.providerId
    model = cfg.model
    maxTokens = cfg.maxTokens
    autoDetectFormat = cfg.autoDetectFormat
  } else {
    providerId = manualProviderId
    model = manualModel
    maxTokens = manualMaxTokens
    autoDetectFormat = manualAutoDetectFormat
  }

  return {
    apiConfigs,
    activeConfigId: resolvedActiveConfigId,
    manualConfig,
    manualProviderId,
    manualModel,
    manualMaxTokens,
    manualAutoDetectFormat,
    providerId,
    model,
    maxTokens,
    autoDetectFormat,
    theme,
    outputStyle,
    language,
    uiLocale,
    effortLevel,
    fastMode,
    alwaysThinking,
    thinkingBudgetTokens,
    showThinkingSummaries,
    compactThinkingOnSave,
    thinkingAutoCollapseThreshold,
    tabAutocompleteEnabled,
    inlineDiffsEnabled,
    defaultDiffViewMode,
    externalDiskChangeRefreshMode,
    defaultShell,
    prefersReducedMotion,
    promptSuggestionEnabled,
    autoTaskRouting,
    spinnerTipsEnabled,
    desktopNotificationMode,
    notifyOnAskUserQuestion,
    notifyOnSubagentCompleted,
    notifyOnSubagentFailed,
    notifyOnSubagentStopped,
    permissionDefaultMode,
    permissionRules,
    skipDangerousModePermissionPrompt,
    workspaceTrustMode,
    diffPrecisionMode,
    customAgentsExtraDirs,
    defaultNewAgentScope,
    sandbox,
    hooks,
    disableAllHooks,
    envVars,
    autoMemoryEnabled,
    autoMemoryDirectory,
    memoryAiRecallEnabled,
    agentExperienceMemoryEnabled,
    memoryHybridRecallEnabled,
    memoryFreshnessWeight,
    memoryRecallMinScore,
    memoryRecallSkipShortQueryChars,
    memoryRecallTopK,
    memoryRecallMaxBytes,
    memoryRecallSessionBudgetBytes,
    workspaceContextEnabled,
    workspaceContextTopK,
    workspaceContextMinScore,
    attachmentContextTopK,
    attachmentContextMinScore,
    embeddingProviderId,
    embeddingModel,
    embeddingApiKey,
    embeddingBaseUrl,
    embeddingDimensions,
    embeddingMode,
    embeddingLocalModelId,
    rerankProviderId,
    rerankModel,
    rerankApiKey,
    rerankBaseUrl,
    dataStoragePath,
    agentStoragePath,
    webSearchBraveApiKey,
    webSearchBaiduApiKey,
    embeddedSearchTools,
    disabledTools,
  }
}
