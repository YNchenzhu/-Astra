/**
 * API configurations slice.
 *
 * Owns:
 *   - the saved `apiConfigs` list + `activeConfigId` selector
 *   - manual-mode fallback (`manualConfig`, `manualProviderId`, `manualModel`,
 *     `manualMaxTokens`, `manualAutoDetectFormat`)
 *   - derived runtime values (`providerId`, `model`, `maxTokens`,
 *     `autoDetectFormat`) that downstream code reads instead of re-deriving
 *     from the active config each time
 *   - runtime getters: `getApiKey` / `getBaseUrl` / `getAwsRegion` /
 *     `getProjectId` / `getActiveConfig` / `isManualMode`
 *
 * Updates that mutate the active-vs-manual relationship are the only place
 * that has to touch the derived tuple atomically; every other slice reads
 * the derived fields directly.
 */
import type { StateCreator } from 'zustand'
import { DEFAULT_MANUAL_CONFIG, generateId } from '../defaults'
import { persistFromState } from '../persistSnapshot'
import { resolveProviderBaseUrl } from '../../../utils/resolveProviderBaseUrl'
import { getDefaultModel } from '../providers'
import { normalizeAnthropicThinkingCapability } from '../../../types/providerCapabilities'
import type { ApiConfig, SettingsState } from '../types'

export type ApiConfigsSlice = Pick<SettingsState,
  | 'providerId' | 'model' | 'maxTokens' | 'autoDetectFormat'
  | 'apiConfigs' | 'activeConfigId'
  | 'manualConfig' | 'manualProviderId' | 'manualModel'
  | 'manualMaxTokens' | 'manualAutoDetectFormat'
  | 'getApiKey' | 'getBaseUrl' | 'getAwsRegion' | 'getProjectId'
  | 'getAnthropicThinkingCapability'
  | 'getActiveConfig' | 'isManualMode'
  | 'setManualProvider' | 'setManualModel' | 'setManualField'
  | 'setManualMaxTokens' | 'setManualAutoDetectFormat' | 'applyManualConfig'
  | 'addApiConfig' | 'updateApiConfig' | 'deleteApiConfig'
  | 'setActiveConfig' | 'clearActiveConfig'
>

export const createApiConfigsSlice: StateCreator<
  SettingsState, [], [], ApiConfigsSlice
> = (set, get) => ({
  providerId: 'anthropic',
  model: 'claude-sonnet-4-20250514',
  maxTokens: 64000,
  apiConfigs: [],
  activeConfigId: null,
  manualConfig: { ...DEFAULT_MANUAL_CONFIG },
  manualProviderId: 'anthropic',
  manualModel: 'claude-sonnet-4-20250514',
  manualMaxTokens: 64000,
  manualAutoDetectFormat: false,

  getApiKey: () => {
    const state = get()
    if (state.activeConfigId) {
      const cfg = state.apiConfigs.find((c) => c.id === state.activeConfigId)
      if (cfg) return cfg.apiKey
    }
    return state.manualConfig.apiKey
  },

  getBaseUrl: () => {
    const state = get()
    if (state.activeConfigId) {
      const cfg = state.apiConfigs.find((c) => c.id === state.activeConfigId)
      if (cfg) return resolveProviderBaseUrl(cfg.providerId, cfg.baseUrl)
    }
    return resolveProviderBaseUrl(state.manualProviderId, state.manualConfig.baseUrl)
  },

  getAwsRegion: () => {
    const state = get()
    if (state.activeConfigId) {
      const cfg = state.apiConfigs.find((c) => c.id === state.activeConfigId)
      if (cfg) return cfg.awsRegion
    }
    return state.manualConfig.awsRegion
  },

  getProjectId: () => {
    const state = get()
    if (state.activeConfigId) {
      const cfg = state.apiConfigs.find((c) => c.id === state.activeConfigId)
      if (cfg) return cfg.projectId
    }
    return state.manualConfig.projectId
  },

  getAnthropicThinkingCapability: () => {
    const state = get()
    if (state.activeConfigId) {
      const cfg = state.apiConfigs.find((c) => c.id === state.activeConfigId)
      if (cfg) return normalizeAnthropicThinkingCapability(cfg.anthropicThinkingCapability)
    }
    return normalizeAnthropicThinkingCapability(
      state.manualConfig.anthropicThinkingCapability,
    )
  },

  getActiveConfig: () => {
    const { activeConfigId, apiConfigs } = get()
    if (!activeConfigId) return null
    return apiConfigs.find((c) => c.id === activeConfigId) || null
  },

  isManualMode: () => !get().activeConfigId,

  setManualProvider: (providerId) => {
    const state = get()
    // 手动模式下切换 provider 时自动选第一个模型
    if (state.activeConfigId) return // 有活跃配置时不允许操作手动模式
    const newModel = getDefaultModel(providerId)
    const update = {
      manualProviderId: providerId,
      manualModel: newModel,
      providerId,
      model: newModel,
    }
    set(update)
    persistFromState({ ...get(), ...update })
  },

  setManualModel: (model) => {
    if (get().activeConfigId) return
    const update = { manualModel: model, model }
    set(update)
    persistFromState({ ...get(), ...update })
  },

  setManualField: (field, value) => {
    if (get().activeConfigId) return
    const update = { manualConfig: { ...get().manualConfig, [field]: value } }
    set(update)
    persistFromState({ ...get(), ...update })
  },

  setManualMaxTokens: (tokens) => {
    if (get().activeConfigId) return
    const update = { manualMaxTokens: tokens, maxTokens: tokens }
    set(update)
    persistFromState({ ...get(), ...update })
  },

  setManualAutoDetectFormat: (enabled) => {
    if (get().activeConfigId) return
    const update = { manualAutoDetectFormat: enabled, autoDetectFormat: enabled }
    set(update)
    persistFromState({ ...get(), ...update })
  },

  applyManualConfig: ({ providerId, model, maxTokens, manualConfig }) => {
    if (get().activeConfigId) return
    const update = {
      manualProviderId: providerId,
      manualModel: model,
      manualMaxTokens: maxTokens,
      manualConfig,
      providerId,
      model,
      maxTokens,
    }
    set(update)
    persistFromState({ ...get(), ...update })
  },

  addApiConfig: async (config) => {
    const newConfig: ApiConfig = { ...config, id: generateId() }
    const apiConfigs = [...get().apiConfigs, newConfig]
    const update = {
      apiConfigs,
      activeConfigId: newConfig.id,
      providerId: newConfig.providerId,
      model: newConfig.model,
      maxTokens: newConfig.maxTokens,
      autoDetectFormat: newConfig.autoDetectFormat,
    }
    set(update)
    persistFromState({ ...get(), ...update })
  },

  updateApiConfig: async (id, partial) => {
    const apiConfigs = get().apiConfigs.map((c) => (c.id === id ? { ...c, ...partial } : c))
    const update: Partial<SettingsState> = { apiConfigs }
    if (id === get().activeConfigId) {
      if (partial.providerId) update.providerId = partial.providerId
      if (partial.model) update.model = partial.model
      if (partial.maxTokens !== undefined) update.maxTokens = partial.maxTokens
      if (partial.autoDetectFormat !== undefined) update.autoDetectFormat = partial.autoDetectFormat
    }
    set(update)
    persistFromState({ ...get(), ...update })
  },

  deleteApiConfig: async (id) => {
    const { apiConfigs, activeConfigId, manualProviderId, manualModel, manualMaxTokens } = get()
    const updatedConfigs = apiConfigs.filter((c) => c.id !== id)
    const update: Partial<SettingsState> = { apiConfigs: updatedConfigs }
    if (id === activeConfigId) {
      update.activeConfigId = null
      update.providerId = manualProviderId
      update.model = manualModel
      update.maxTokens = manualMaxTokens
    }
    set(update)
    persistFromState({ ...get(), ...update })
  },

  setActiveConfig: (id) => {
    const { apiConfigs } = get()
    const cfg = apiConfigs.find((c) => c.id === id)
    if (!cfg) return
    const update = {
      activeConfigId: id,
      providerId: cfg.providerId,
      model: cfg.model,
      maxTokens: cfg.maxTokens,
      autoDetectFormat: cfg.autoDetectFormat,
    }
    set(update)
    persistFromState({ ...get(), ...update })
  },

  clearActiveConfig: () => {
    const { manualProviderId, manualModel, manualMaxTokens, manualAutoDetectFormat } = get()
    const update = {
      activeConfigId: null,
      providerId: manualProviderId,
      model: manualModel,
      maxTokens: manualMaxTokens,
      autoDetectFormat: manualAutoDetectFormat,
    }
    set(update)
    persistFromState({ ...get(), ...update })
  },
})
