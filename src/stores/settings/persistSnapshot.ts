/**
 * Build the disk snapshot for the settings store and hand it to the shared
 * persistence queue.
 *
 * The queue + retry + schema validation live in `./persistence.ts`; here we
 * only describe *which* fields map to the persisted shape. That mapping is
 * store-specific and tightly coupled to the `SettingsState` interface.
 *
 * `persistFromState(store)` is a drop-in replacement for the in-file
 * `persist(store)` helper used by every slice's setter. It's intentionally
 * fire-and-forget — async errors propagate through the chain's own logger
 * and never crash the renderer.
 */
import { enqueuePersist } from './persistence'
import type { ProviderId } from './providers'
import type { SettingsState } from './types'

export function persistFromState(store: SettingsState): void {
  enqueuePersist(buildSnapshot(store))
}

function buildSnapshot(store: SettingsState): Record<string, unknown> {
  return {
    // Flat top-level mirror — main process + disk readers still depend on
    // `apiKey` / `providerId` / `model` / etc. being at the root.
    ...(store.activeConfigId
      ? (() => {
          const c = store.apiConfigs.find((x) => x.id === store.activeConfigId)
          return {
            apiKey: c?.apiKey ?? '',
            providerId: (c?.providerId as ProviderId) || store.providerId,
            model: c?.model ?? store.model,
            maxTokens: typeof c?.maxTokens === 'number' ? c.maxTokens : store.maxTokens,
            baseUrl: c?.baseUrl ?? '',
            awsRegion: c?.awsRegion ?? '',
            projectId: c?.projectId ?? '',
          }
        })()
      : {
          apiKey: store.manualConfig.apiKey,
          providerId: store.providerId,
          model: store.model,
          maxTokens: store.maxTokens,
          baseUrl: store.manualConfig.baseUrl,
          awsRegion: store.manualConfig.awsRegion,
          projectId: store.manualConfig.projectId,
        }),
    anthropicThinkingCapability: store.getAnthropicThinkingCapability(),
    apiConfigs: store.apiConfigs,
    activeConfigId: store.activeConfigId,
    manualConfig: store.manualConfig,
    manualProviderId: store.manualProviderId,
    manualModel: store.manualModel,
    manualMaxTokens: store.manualMaxTokens,
    manualAutoDetectFormat: store.manualAutoDetectFormat,
    theme: store.theme,
    outputStyle: store.outputStyle,
    language: store.language,
    uiLocale: store.uiLocale,
    effortLevel: store.effortLevel,
    fastMode: store.fastMode,
    alwaysThinking: store.alwaysThinking,
    thinkingBudgetTokens: store.thinkingBudgetTokens,
    showThinkingSummaries: store.showThinkingSummaries,
    compactThinkingOnSave: store.compactThinkingOnSave,
    thinkingAutoCollapseThreshold: store.thinkingAutoCollapseThreshold,
    tabAutocompleteEnabled: store.tabAutocompleteEnabled,
    inlineDiffsEnabled: store.inlineDiffsEnabled,
    defaultDiffViewMode: store.defaultDiffViewMode,
    externalDiskChangeRefreshMode: store.externalDiskChangeRefreshMode,
    defaultShell: store.defaultShell,
    prefersReducedMotion: store.prefersReducedMotion,
    promptSuggestionEnabled: store.promptSuggestionEnabled,
    autoTaskRouting: store.autoTaskRouting,
    spinnerTipsEnabled: store.spinnerTipsEnabled,
    desktopNotificationMode: store.desktopNotificationMode,
    notifyOnAskUserQuestion: store.notifyOnAskUserQuestion,
    notifyOnSubagentCompleted: store.notifyOnSubagentCompleted,
    notifyOnSubagentFailed: store.notifyOnSubagentFailed,
    notifyOnSubagentStopped: store.notifyOnSubagentStopped,
    permissionDefaultMode: store.permissionDefaultMode,
    permissionRules: store.permissionRules,
    skipDangerousModePermissionPrompt: store.skipDangerousModePermissionPrompt,
    workspaceTrustMode: store.workspaceTrustMode,
    diffPrecisionMode: store.diffPrecisionMode,
    customAgentsExtraDirs: store.customAgentsExtraDirs,
    defaultNewAgentScope: store.defaultNewAgentScope,
    sandbox: store.sandbox,
    hooks: store.hooks,
    disableAllHooks: store.disableAllHooks,
    envVars: store.envVars,
    autoMemoryEnabled: store.autoMemoryEnabled,
    memoryHybridRecallEnabled: store.memoryHybridRecallEnabled,
    memoryFreshnessWeight: store.memoryFreshnessWeight,
    memoryRecallMinScore: store.memoryRecallMinScore,
    memoryRecallSkipShortQueryChars: store.memoryRecallSkipShortQueryChars,
    memoryRecallTopK: store.memoryRecallTopK,
    memoryRecallMaxBytes: store.memoryRecallMaxBytes,
    memoryRecallSessionBudgetBytes: store.memoryRecallSessionBudgetBytes,
    workspaceContextEnabled: store.workspaceContextEnabled,
    workspaceContextTopK: store.workspaceContextTopK,
    workspaceContextMinScore: store.workspaceContextMinScore,
    attachmentContextTopK: store.attachmentContextTopK,
    attachmentContextMinScore: store.attachmentContextMinScore,
    embeddingProviderId: store.embeddingProviderId,
    embeddingModel: store.embeddingModel,
    embeddingApiKey: store.embeddingApiKey,
    embeddingBaseUrl: store.embeddingBaseUrl,
    embeddingDimensions: store.embeddingDimensions,
    embeddingMode: store.embeddingMode,
    embeddingLocalModelId: store.embeddingLocalModelId,
    rerankProviderId: store.rerankProviderId,
    rerankModel: store.rerankModel,
    rerankApiKey: store.rerankApiKey,
    rerankBaseUrl: store.rerankBaseUrl,
    autoMemoryDirectory: store.autoMemoryDirectory,
    memoryAiRecallEnabled: store.memoryAiRecallEnabled,
    agentExperienceMemoryEnabled: store.agentExperienceMemoryEnabled,
    dataStoragePath: store.dataStoragePath,
    agentStoragePath: store.agentStoragePath,
    webSearchBraveApiKey: store.webSearchBraveApiKey,
    webSearchBaiduApiKey: store.webSearchBaiduApiKey,
    embeddedSearchTools: store.embeddedSearchTools,
    disabledTools: store.disabledTools,
  }
}
