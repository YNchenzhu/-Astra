import React, { useState, useEffect, useRef, useCallback } from 'react'
import {
  X, Eye, EyeOff, Plus, Trash2, Edit3, Search, ArrowLeft, Info,
  ChevronDown, Brain,
} from 'lucide-react'
import { useSettingsStore, PROVIDERS, PROTOCOL_HINTS, BUILTIN_HOOKS, MODELS_BY_PROVIDER } from '../../stores/useSettingsStore'
import { useT } from '../../i18n'
import { UI_LOCALE_OPTIONS, type UiLocale } from '../../i18n/locale'
import { useChatStore } from '../../stores/useChatStore'
import { useConfirmDialog } from '../common/ConfirmDialog'
import { getBuiltinDefaultBaseUrl, resolveProviderBaseUrl, describeInvalidBaseUrl } from '../../utils/resolveProviderBaseUrl'
import type { ProviderId, ApiConfig, AnthropicThinkingCapability, UIThemeSetting, OutputStyleSetting, DefaultShell, PermissionMode, DesktopNotificationMode, SettingsCategoryId, ExternalDiskChangeRefreshMode, EffortLevel, WorkspaceTrustModeSetting } from '../../stores/useSettingsStore'
import { MCPPanel } from '../Settings/MCPPanel'
import { RulesPanel } from '../Settings/RulesPanel'
import { MemoryPanel } from '../Settings/MemoryPanel'
import { EmbeddingPanel } from '../Settings/EmbeddingPanel'
// Agent / Team / Bundle 相关的配置入口已统一迁移至智能体工作台
// (AgentWorkbench),Settings 内不再重复承载。
import { SkillsPanel } from '../Settings/SkillsPanel'
import { ToolsPanel } from '../Settings/ToolsPanel'
import { StoragePanel } from '../Settings/StoragePanel'
import { LspServersPanel } from '../Settings/LspServersPanel'
import { H5Panel } from '../Settings/H5Panel'
import { IMPanel } from '../Settings/IMPanel'
import { BuddyPanel } from './BuddyPanel'
import { ContextPanel } from './settings/ContextPanel'
import {
  CATEGORIES,
  getDefaultModel,
  LANGUAGE_OPTIONS,
  PROVIDER_PLACEHOLDERS,
  SHELL_OPTIONS,
} from './settingsConstants'
import {
  ChipGroup,
  InputField,
  IOSToggle,
  NumberField,
  SelectField,
  ToggleRow,
} from './settingsControls'
import './SettingsDialog.css'

function isCustomAnthropicEndpoint(providerId: ProviderId, baseUrl: string): boolean {
  const normalized = baseUrl.trim().toLowerCase()
  return providerId === 'anthropic' && normalized.length > 0 && !normalized.includes('api.anthropic.com')
}

// ==================== Main Component ====================

export const SettingsDialog: React.FC = () => {
  const store = useSettingsStore()
  const {
    showSettings, setShowSettings,
    apiConfigs, activeConfigId,
    manualProviderId, manualModel, manualMaxTokens, manualConfig, manualAutoDetectFormat,
    theme, outputStyle, language, uiLocale,
    effortLevel, fastMode, alwaysThinking, thinkingBudgetTokens, showThinkingSummaries,
    compactThinkingOnSave, thinkingAutoCollapseThreshold,
    tabAutocompleteEnabled, inlineDiffsEnabled, defaultDiffViewMode, externalDiskChangeRefreshMode,
    defaultShell, prefersReducedMotion, promptSuggestionEnabled, autoTaskRouting, spinnerTipsEnabled,
    desktopNotificationMode, notifyOnAskUserQuestion, notifyOnSubagentCompleted, notifyOnSubagentFailed, notifyOnSubagentStopped,
    permissionDefaultMode, permissionRules, skipDangerousModePermissionPrompt, workspaceTrustMode,
    sandbox, hooks, disableAllHooks,
    envVars,
    setTheme, setOutputStyle, setLanguage, setUiLocale,
    setEffortLevel, setFastMode, setAlwaysThinking, setThinkingBudgetTokens, setShowThinkingSummaries,
    setCompactThinkingOnSave, setThinkingAutoCollapseThreshold,
    setTabAutocompleteEnabled, setInlineDiffsEnabled, setDefaultDiffViewMode, setExternalDiskChangeRefreshMode,
    setDefaultShell, setPrefersReducedMotion, setPromptSuggestionEnabled, setAutoTaskRouting, setSpinnerTipsEnabled,
    setDesktopNotificationMode, setNotifyOnAskUserQuestion, setNotifyOnSubagentCompleted, setNotifyOnSubagentFailed, setNotifyOnSubagentStopped,
    setPermissionDefaultMode, addPermissionRule, removePermissionRule, updatePermissionRule,
    setSkipDangerousModePermissionPrompt, setWorkspaceTrustMode,
    setSandboxSettings,
    addHook, removeHook, updateHook, setDisableAllHooks, toggleBuiltInHook, isBuiltInHookEnabled,
    addEnvVar, removeEnvVar, updateEnvVar,
    addApiConfig, updateApiConfig, deleteApiConfig, setActiveConfig, clearActiveConfig,
    applyManualConfig, setManualAutoDetectFormat,
  } = store

  const t = useT()
  const categoryLabel = useCallback(
    (id: SettingsCategoryId) => t.settings.category[id],
    [t],
  )

  const [activeCategory, setActiveCategory] = useState<SettingsCategoryId>('model')
  const [searchQuery, setSearchQuery] = useState('')
  const searchInputRef = useRef<HTMLInputElement>(null)

  // 二次确认对话框（plan Phase 2.A 深度思考 mid-conversation toggle 用）。
  // useConfirmDialog 返回的 dialog 元素必须在 SettingsDialog tree 内挂出来，
  // 否则 askConfirm 的 promise 会永远 pending — 在 modal 根容器附近会渲染。
  const { dialog: confirmDialogElement, askConfirm } = useConfirmDialog()

  /**
   * 深度思考 toggle 的二次确认 wrapper（plan Phase 2.A）。
   *
   * 风险链路（upstream-main `ThinkingToggle.tsx` 描述）：
   *   - 会话中切换 thinking 模式让 prompt cache 失效（cache key 含 `thinking`
   *     字段）→ 下一轮所有 system prompt + tool defs 重发，巨大 token 浪费
   *   - 模型从"无思考"切到"有思考"或反过来会突然改风格 → 用户割裂感强
   *   - 已经累积的 thinking 块带签名，关闭 thinking 后下一轮还会带 → 可能
   *     被服务端拒绝（不同 thinking 配置下的签名校验路径不同）
   *
   * 仅在当前会话已经有 assistant 消息（mid-conversation）时弹确认；新会话直接生效。
   * `NODE_ENV === 'test'` 直接走原逻辑（避免测试卡在 confirm 弹窗上）。
   */
  const handleAlwaysThinkingChange = useCallback(
    async (next: boolean) => {
      if (next === alwaysThinking) return
      if (process.env.NODE_ENV === 'test') {
        setAlwaysThinking(next)
        return
      }
      const chatState = useChatStore.getState()
      const hasOngoing =
        Boolean(chatState.currentConversationId) &&
        Array.isArray(chatState.messages) &&
        chatState.messages.some((m) => m.role === 'assistant')
      if (hasOngoing) {
        const ok = await askConfirm({
          title: t.settings.model.thinkingConfirmTitle,
          message: t.settings.model.thinkingConfirmMessage,
          confirmText: t.settings.model.thinkingConfirmOk,
          cancelText: t.settings.model.thinkingConfirmCancel,
          variant: 'danger',
        })
        if (!ok) return
      }
      setAlwaysThinking(next)
    },
    [alwaysThinking, setAlwaysThinking, askConfirm, t],
  )

  // General tab local state — synced from store in an effect (avoids render-phase setState / focus loss)
  const [localManualProviderId, setLocalManualProviderId] = useState<ProviderId>(manualProviderId)
  const [localManualModel, setLocalManualModel] = useState(manualModel)
  const [localManualMaxTokens, setLocalManualMaxTokens] = useState(manualMaxTokens)
  const [localManualConfig, setLocalManualConfig] = useState(manualConfig)
  const [manualShowKey, setManualShowKey] = useState(false)

  useEffect(() => {
    const id = window.setTimeout(() => {
      setLocalManualProviderId(manualProviderId)
      setLocalManualModel(manualModel)
      setLocalManualMaxTokens(manualMaxTokens)
      setLocalManualConfig(manualConfig)
    }, 0)
    return () => window.clearTimeout(id)
  }, [manualProviderId, manualModel, manualMaxTokens, manualConfig])

  // Config editor state
  const [editingConfig, setEditingConfig] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<Omit<ApiConfig, 'id'>>({
    name: '', providerId: 'anthropic' as ProviderId, model: '', apiKey: '',
    baseUrl: '', awsRegion: '', projectId: '', maxTokens: 64000, autoDetectFormat: false,
    anthropicThinkingCapability: 'auto',
  })
  const [formShowKey, setFormShowKey] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null)
  /** 与 deleteConfirm 同步；handler 内读取，避免快速双击时 state 尚未提交导致两次都误判为「首次点击」 */
  const deleteConfirmRef = useRef<string | null>(null)
  /** DOM 定时器句柄为 number；与 Node `Timeout` 类型区分开，避免 TS 报错 */
  const deleteConfirmTimerRef = useRef<number | null>(null)

  // Rule editor state
  const [newRulePattern, setNewRulePattern] = useState('')
  const [newRuleMode, setNewRuleMode] = useState<PermissionMode>('ask')

  // Hook editor state
  const [newHookEvent, setNewHookEvent] = useState('PreToolUse')
  const [newHookCommand, setNewHookCommand] = useState('')
  const [newHookMatcher, setNewHookMatcher] = useState('')
  const [newHookAsync, setNewHookAsync] = useState(false)
  const [newHookAsyncRewake, setNewHookAsyncRewake] = useState(false)

  // Env editor state
  const [newEnvKey, setNewEnvKey] = useState('')
  const [newEnvValue, setNewEnvValue] = useState('')

  useEffect(() => {
    if (showSettings && searchInputRef.current) {
      searchInputRef.current.focus()
    }
  }, [showSettings])

  useEffect(() => {
    if (!showSettings) return
    const id = window.setTimeout(() => {
      const panel = useSettingsStore.getState().consumeSettingsEntryPanel()
      if (panel) setActiveCategory(panel)
    }, 0)
    return () => window.clearTimeout(id)
  }, [showSettings])

  useEffect(() => {
    if (showSettings) {
      if (deleteConfirmTimerRef.current !== null) {
        window.clearTimeout(deleteConfirmTimerRef.current)
        deleteConfirmTimerRef.current = null
      }
      deleteConfirmRef.current = null
      queueMicrotask(() => setDeleteConfirm(null))
      return
    }
    if (deleteConfirmTimerRef.current !== null) {
      window.clearTimeout(deleteConfirmTimerRef.current)
      deleteConfirmTimerRef.current = null
    }
    deleteConfirmRef.current = null
  }, [showSettings])

  if (!showSettings) return null

  const hasActiveConfig = !!activeConfigId
  const activeConfig = apiConfigs.find((c) => c.id === activeConfigId)
  const manualPlaceholderInfo = PROVIDER_PLACEHOLDERS[localManualProviderId]
  const manualNeedsAwsRegion = localManualProviderId === 'bedrock'
  const manualNeedsProjectId = localManualProviderId === 'vertex'
  const formNeedsAwsRegion = form.providerId === 'bedrock'
  const formNeedsProjectId = form.providerId === 'vertex'

  // Filter categories by search
  const filteredCategories = CATEGORIES.filter((cat) => {
    if (!searchQuery.trim()) return true
    const q = searchQuery.toLowerCase()
    return categoryLabel(cat.id).toLowerCase().includes(q)
  })

  // Handlers
  const handleManualProviderChange = (p: ProviderId) => {
    setLocalManualProviderId(p)
    setLocalManualModel(getDefaultModel(p))
    setManualShowKey(false)
  }

  const handleManualSave = () => {
    const invalid = describeInvalidBaseUrl(localManualConfig.baseUrl)
    if (invalid) {
      window.alert(t.settings.api.invalidBaseUrl(invalid))
      return
    }
    applyManualConfig({
      providerId: localManualProviderId, model: localManualModel,
      maxTokens: localManualMaxTokens, manualConfig: localManualConfig,
    })
  }

  const handleManualFieldChange = (field: string, value: string) => {
    setLocalManualConfig((prev) => ({ ...prev, [field]: value }))
  }

  const handleFormProviderChange = (p: ProviderId) => {
    setForm((prev) => ({ ...prev, providerId: p, model: getDefaultModel(p) }))
    setFormShowKey(false)
  }

  const handleSaveConfig = async () => {
    if (!form.name.trim()) return
    // 防止用户把 API Key 填到「接口地址」、或填了一个不带 https:// 的相对路径。
    // 没有这层校验时，这种配置会一路通到 fetch(`${baseUrl}/v1/responses`)
    // 抛出晦涩的 `TypeError: Failed to parse URL`，用户根本看不出来是
    // 哪个字段写错了（电子邮件式的报告 baseUrl 已经在 compatibleClient 里
    // 也有运行时兜底，但能在保存阶段拦下更友好）。
    const invalid = describeInvalidBaseUrl(form.baseUrl)
    if (invalid) {
      window.alert(t.settings.api.invalidBaseUrl(invalid))
      return
    }
    try {
      if (editingId) await updateApiConfig(editingId, form)
      else await addApiConfig(form)
      setEditingConfig(false)
    } catch (e) { console.error('Failed to save config:', e) }
  }

  const handleDeleteConfig = (id: string) => {
    if (deleteConfirmRef.current === id) {
      void deleteApiConfig(id)
      deleteConfirmRef.current = null
      setDeleteConfirm(null)
      if (deleteConfirmTimerRef.current !== null) {
        window.clearTimeout(deleteConfirmTimerRef.current)
        deleteConfirmTimerRef.current = null
      }
      return
    }
    if (deleteConfirmTimerRef.current !== null) {
      window.clearTimeout(deleteConfirmTimerRef.current)
    }
    deleteConfirmRef.current = id
    setDeleteConfirm(id)
    deleteConfirmTimerRef.current = window.setTimeout(() => {
      deleteConfirmTimerRef.current = null
      deleteConfirmRef.current = null
      setDeleteConfirm(null)
    }, 3000)
  }

  const handleAddRule = () => {
    if (!newRulePattern.trim()) return
    addPermissionRule({ pattern: newRulePattern.trim(), mode: newRuleMode })
    setNewRulePattern(''); setNewRuleMode('ask')
  }

  const handleAddHook = () => {
    if (!newHookCommand.trim()) return
    addHook({
      event: newHookEvent,
      command: newHookCommand.trim(),
      enabled: true,
      matcher: newHookMatcher.trim() || undefined,
      async: newHookAsync || undefined,
      asyncRewake: newHookAsyncRewake || undefined,
    })
    setNewHookCommand('')
    setNewHookMatcher('')
    setNewHookAsync(false)
    setNewHookAsyncRewake(false)
  }

  const handleAddEnvVar = () => {
    if (!newEnvKey.trim()) return
    addEnvVar({ key: newEnvKey.trim(), value: newEnvValue, enabled: true })
    setNewEnvKey(''); setNewEnvValue('')
  }

  const resetForm = () => {
    setForm({ name: '', providerId: 'anthropic', model: getDefaultModel('anthropic'), apiKey: '', baseUrl: '', awsRegion: '', projectId: '', maxTokens: 64000, autoDetectFormat: false, anthropicThinkingCapability: 'auto' })
    setFormShowKey(false)
  }

  const handleNewConfig = () => { setEditingId(null); resetForm(); setEditingConfig(true) }

  const handleEditConfig = (cfg: ApiConfig) => {
    setEditingId(cfg.id)
    setForm({ name: cfg.name, providerId: cfg.providerId, model: cfg.model, apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, awsRegion: cfg.awsRegion, projectId: cfg.projectId, maxTokens: cfg.maxTokens, autoDetectFormat: cfg.autoDetectFormat || false, anthropicThinkingCapability: cfg.anthropicThinkingCapability || 'auto' })
    setFormShowKey(false)
    setEditingConfig(true)
  }

  // Category content renderer
  const renderCategoryContent = () => {
    switch (activeCategory) {
      case 'api': return renderApiConfigs()
      case 'manual': return renderManualSetup()
      case 'model': return renderModelBehavior()
      case 'permissions': return renderPermissions()
      case 'sandbox': return renderSandbox()
      // 'hooks' / 'skills' / 'tools' / 'mcp' 这四类的**全局定义**保留在
      // Settings,纯粹编辑全局资源(不再带"去工作台"引导条)。bundle
      // 内启用哪些 → 去智能体工作台。
      case 'hooks': return renderHooks()
      case 'env': return renderEnvVars()
      case 'appearance': return renderAppearance()
      case 'context': return <ContextPanel />
      case 'buddy': return <BuddyPanel />
      case 'skills': return <SkillsPanel />
      case 'tools': return <ToolsPanel />
      case 'mcp': return <MCPPanel />
      case 'rules': return <RulesPanel />
      case 'memory': return <MemoryPanel />
      case 'embedding': return <EmbeddingPanel />
      case 'lsp': return <LspServersPanel />
      case 'h5': return <H5Panel />
      case 'im': return <IMPanel />
      case 'storage': return <StoragePanel />
      default: return null
    }
  }

  // ---- Category Renderers ----

  const renderApiConfigs = () => {
    const ta = t.settings.api
    if (editingConfig) {
      return (
        <div className="settings-form-body">
          <div className="settings-form-header">
            <button className="settings-form-back" onClick={() => setEditingConfig(false)}>
              <ArrowLeft size={14} /><span>{ta.back}</span>
            </button>
            <h3 className="settings-form-title">{editingId ? ta.editTitle : ta.newTitle}</h3>
          </div>

          <InputField label={ta.nameLabel} value={form.name} onChange={(v) => setForm((p) => ({ ...p, name: v }))} placeholder={ta.namePlaceholder} />

          <div className="settings-group">
            <label className="settings-label">{ta.protocolLabel}</label>
            <div className="settings-select-wrapper">
              <select className="settings-select" value={form.providerId} onChange={(e) => handleFormProviderChange(e.target.value as ProviderId)}>
                {PROVIDERS.map((p) => (<option key={p.id} value={p.id}>{p.name}</option>))}
              </select>
              <ChevronDown size={14} className="settings-select-icon" />
            </div>
            <p className="settings-hint settings-protocol-hint">{PROTOCOL_HINTS[form.providerId]}</p>
          </div>

          <InputField
            label={ta.baseUrlLabel}
            value={form.baseUrl}
            onChange={(v) => setForm((p) => ({ ...p, baseUrl: v }))}
            placeholder={getBuiltinDefaultBaseUrl(form.providerId) || 'https://your-endpoint.com'}
            hint={ta.baseUrlHint}
          />

          {isCustomAnthropicEndpoint(form.providerId, form.baseUrl) && (
            <div className="settings-group">
              <label className="settings-label">{ta.thinkingCapabilityLabel}</label>
              <div className="settings-select-wrapper">
                <select
                  className="settings-select"
                  value={form.anthropicThinkingCapability || 'auto'}
                  onChange={(event) => setForm((previous) => ({
                    ...previous,
                    anthropicThinkingCapability: event.target.value as AnthropicThinkingCapability,
                  }))}
                >
                  <option value="auto">{ta.thinkingCapabilityAuto}</option>
                  <option value="supported">{ta.thinkingCapabilitySupported}</option>
                  <option value="unsupported">{ta.thinkingCapabilityUnsupported}</option>
                </select>
                <ChevronDown size={14} className="settings-select-icon" />
              </div>
              <p className="settings-hint">{ta.thinkingCapabilityHint}</p>
            </div>
          )}

          <div className="settings-group">
            <label className="settings-label">{ta.apiKeyLabel}</label>
            <div className="settings-input-wrapper">
              <input type={formShowKey ? 'text' : 'password'} className="settings-input" value={form.apiKey} onChange={(e) => setForm((p) => ({ ...p, apiKey: e.target.value }))} placeholder="sk-ant-..., sk-..., AI..." />
              <button className="settings-input-btn" onClick={() => setFormShowKey(!formShowKey)}>
                {formShowKey ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>

          <InputField label={ta.modelIdLabel} value={form.model} onChange={(v) => setForm((p) => ({ ...p, model: v }))} placeholder={getDefaultModel(form.providerId) || 'e.g. claude-sonnet-4-20250514'} hint={ta.modelIdHint} />

          {formNeedsAwsRegion && <InputField label={ta.awsRegionLabel} value={form.awsRegion} onChange={(v) => setForm((p) => ({ ...p, awsRegion: v }))} placeholder="us-east-1" />}
          {formNeedsProjectId && <InputField label={ta.gcpProjectLabel} value={form.projectId} onChange={(v) => setForm((p) => ({ ...p, projectId: v }))} placeholder="my-gcp-project" />}

          <NumberField label={ta.maxTokensLabel} value={form.maxTokens} onChange={(v) => setForm((p) => ({ ...p, maxTokens: v }))} min={256} max={200000} />

          <div className="settings-group">
            <label className="settings-label">
              <input
                type="checkbox"
                checked={form.autoDetectFormat || false}
                onChange={(e) => setForm((p) => ({ ...p, autoDetectFormat: e.target.checked }))}
                className="settings-checkbox"
              />
              {ta.autoDetectLabel}
            </label>
            <p className="settings-hint">{ta.autoDetectHint}</p>
          </div>

          <div className="settings-form-actions">
            <button className="settings-btn settings-btn-secondary" onClick={() => setEditingConfig(false)}>{ta.cancel}</button>
            <button className="settings-btn settings-btn-primary" onClick={handleSaveConfig} disabled={!form.name.trim()}>{editingId ? ta.update : ta.create}</button>
          </div>
        </div>
      )
    }

    return (
      <div className="settings-form-body">
        <div className="settings-list-header">
          <span className="settings-list-title">{ta.savedConfigs}</span>
          <button className="settings-btn settings-btn-sm settings-btn-primary" onClick={handleNewConfig}><Plus size={14} /><span>{ta.addConfig}</span></button>
        </div>

        {activeConfig && (
          <div className="settings-active-banner">
            <Info size={14} />
            <span className="settings-active-label">{ta.activeLabel}</span>
            <span className="settings-active-name">{activeConfig.name}</span>
            <span className="settings-active-model">
              {PROVIDERS.find((p) => p.id === activeConfig.providerId)?.name} / {MODELS_BY_PROVIDER[activeConfig.providerId]?.find((m) => m.id === activeConfig.model)?.name}
            </span>
            <button className="settings-deactivate-btn" onClick={clearActiveConfig} title={ta.deactivateTitle}><X size={12} /></button>
          </div>
        )}

        {apiConfigs.length === 0 ? (
          <div className="settings-empty">
            <p>{ta.emptyText}</p>
            <p className="settings-empty-hint">{ta.emptyHint}</p>
          </div>
        ) : (
          <div className="settings-card-list">
            {apiConfigs.map((cfg) => {
              const provider = PROVIDERS.find((p) => p.id === cfg.providerId)
              const modelInfo = MODELS_BY_PROVIDER[cfg.providerId]?.find((m) => m.id === cfg.model)
              const isActive = cfg.id === activeConfigId
              const isDeleting = deleteConfirm === cfg.id
              return (
                <div key={cfg.id} className={`settings-card${isActive ? ' active' : ''}`}>
                  <div className="settings-card-info">
                    <div className="settings-card-top">
                      <span className="settings-card-name">{cfg.name}</span>
                      <span className="settings-card-provider">{provider?.name}</span>
                    </div>
                    <span className="settings-card-model">{modelInfo?.name || cfg.model}</span>
                    {cfg.apiKey && <span className="settings-card-key">{cfg.apiKey.slice(0, 6)}...{cfg.apiKey.slice(-4)}</span>}
                    {(() => {
                      const u = resolveProviderBaseUrl(cfg.providerId, cfg.baseUrl)
                      return u ? <span className="settings-card-url">{u}</span> : null
                    })()}
                    {cfg.autoDetectFormat && <span className="settings-card-tag">{ta.autoDetectTag}</span>}
                  </div>
                  <div className="settings-card-actions">
                    {!isActive && (
                      <button type="button" className="settings-card-btn settings-card-use-btn" onClick={() => void setActiveConfig(cfg.id)} title={ta.useBtnTitle}>
                        {ta.useBtn}
                      </button>
                    )}
                    <button type="button" className="settings-card-btn" onClick={() => handleEditConfig(cfg)} title={ta.editBtnTitle}>
                      <Edit3 size={13} />
                    </button>
                    <button
                      type="button"
                      className={`settings-card-btn settings-card-delete-btn${isDeleting ? ' confirming' : ''}`}
                      onClick={() => handleDeleteConfig(cfg.id)}
                      title={isDeleting ? ta.deleteConfirmTitle : ta.deleteBtnTitle}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    )
  }

  const renderManualSetup = () => {
    const ta = t.settings.api
    const tm = t.settings.manual
    return (
    <div className="settings-form-body">
      {hasActiveConfig && (
        <div className="settings-banner settings-banner-warning">
          <Info size={14} />
          <span>{tm.activeBannerPrefix}<strong>{activeConfig?.name}</strong>{tm.activeBannerSuffix}</span>
        </div>
      )}
      <div className={hasActiveConfig ? 'settings-locked' : ''}>
        <div className="settings-group">
          <label className="settings-label">{ta.protocolLabel}</label>
          <div className="settings-select-wrapper">
            <select className="settings-select" value={localManualProviderId} onChange={(e) => handleManualProviderChange(e.target.value as ProviderId)}>
              {PROVIDERS.map((p) => (<option key={p.id} value={p.id}>{p.name}</option>))}
            </select>
            <ChevronDown size={14} className="settings-select-icon" />
          </div>
          <p className="settings-hint settings-protocol-hint">{PROTOCOL_HINTS[localManualProviderId]}</p>
        </div>

        <div className="settings-group">
          <label className="settings-label">{tm.apiKeyLabel}</label>
          <div className="settings-input-wrapper">
            <input type={manualShowKey ? 'text' : 'password'} className="settings-input" value={localManualConfig.apiKey} onChange={(e) => handleManualFieldChange('apiKey', e.target.value)} placeholder={manualPlaceholderInfo.key} />
            <button className="settings-input-btn" onClick={() => setManualShowKey(!manualShowKey)}>
              {manualShowKey ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
          <p className="settings-hint">
            {manualPlaceholderInfo.link ? (<>{tm.apiKeyFromPrefix}<a href={manualPlaceholderInfo.link} target="_blank" rel="noreferrer">{new URL(manualPlaceholderInfo.link).hostname}</a>{tm.apiKeyFromSuffix}</>) : manualPlaceholderInfo.hint}
          </p>
        </div>

        <InputField
          label={ta.baseUrlLabel}
          value={localManualConfig.baseUrl}
          onChange={(v) => handleManualFieldChange('baseUrl', v)}
          placeholder={getBuiltinDefaultBaseUrl(localManualProviderId) || 'https://your-endpoint.com'}
          hint={tm.baseUrlHint}
        />

        {isCustomAnthropicEndpoint(localManualProviderId, localManualConfig.baseUrl) && (
          <div className="settings-group">
            <label className="settings-label">{ta.thinkingCapabilityLabel}</label>
            <div className="settings-select-wrapper">
              <select
                className="settings-select"
                value={localManualConfig.anthropicThinkingCapability || 'auto'}
                onChange={(event) => handleManualFieldChange(
                  'anthropicThinkingCapability',
                  event.target.value,
                )}
              >
                <option value="auto">{ta.thinkingCapabilityAuto}</option>
                <option value="supported">{ta.thinkingCapabilitySupported}</option>
                <option value="unsupported">{ta.thinkingCapabilityUnsupported}</option>
              </select>
              <ChevronDown size={14} className="settings-select-icon" />
            </div>
            <p className="settings-hint">{ta.thinkingCapabilityHint}</p>
          </div>
        )}

        <InputField label={ta.modelIdLabel} value={localManualModel} onChange={setLocalManualModel} placeholder={getDefaultModel(localManualProviderId) || 'e.g. claude-sonnet-4-20250514'} />

        {manualNeedsAwsRegion && <InputField label={ta.awsRegionLabel} value={localManualConfig.awsRegion} onChange={(v) => handleManualFieldChange('awsRegion', v)} placeholder="us-east-1" />}
        {manualNeedsProjectId && <InputField label={ta.gcpProjectLabel} value={localManualConfig.projectId} onChange={(v) => handleManualFieldChange('projectId', v)} placeholder="my-gcp-project" />}

        <NumberField label={ta.maxTokensLabel} value={localManualMaxTokens} onChange={setLocalManualMaxTokens} min={256} max={200000} />

        <ToggleRow
          label={ta.autoDetectLabel}
          description={tm.autoDetectDesc}
          checked={Boolean(manualAutoDetectFormat)}
          onChange={setManualAutoDetectFormat}
        />

        {!hasActiveConfig && (
          <div className="settings-form-actions">
            <button className="settings-btn settings-btn-primary" onClick={handleManualSave}>{tm.apply}</button>
          </div>
        )}
      </div>
    </div>
    )
  }

  const renderModelBehavior = () => {
    const tmb = t.settings.model
    // Locale-driven option tables (previously hardcoded zh-CN constants in
    // settingsConstants.ts — see the i18n audit 2026-07).
    const effortLevels: Array<{ value: EffortLevel; label: string; hint: string }> = [
      { value: 'low', label: tmb.effortLow, hint: tmb.effortLowHint },
      { value: 'medium', label: tmb.effortMedium, hint: tmb.effortMediumHint },
      { value: 'high', label: tmb.effortHigh, hint: tmb.effortHighHint },
      { value: 'max', label: tmb.effortMax, hint: tmb.effortMaxHint },
    ]
    const notificationModes: Array<{ value: DesktopNotificationMode; label: string; hint: string }> = [
      { value: 'off', label: tmb.notifyOff, hint: tmb.notifyOffHint },
      { value: 'minimized', label: tmb.notifyMinimized, hint: tmb.notifyMinimizedHint },
      { value: 'background', label: tmb.notifyBackground, hint: tmb.notifyBackgroundHint },
      { value: 'always', label: tmb.notifyAlways, hint: tmb.notifyAlwaysHint },
    ]
    return (
    <div className="settings-form-body">
      <ChipGroup label={tmb.effortLabel} hint={effortLevels.find((l) => l.value === effortLevel)?.hint} value={effortLevel} onChange={(v) => setEffortLevel(v as EffortLevel)} options={effortLevels} />
      <ToggleRow label={tmb.fastMode} description={tmb.fastModeDesc} checked={fastMode} onChange={setFastMode} />
      <ToggleRow label={tmb.thinking} description={tmb.thinkingDesc} checked={alwaysThinking} onChange={handleAlwaysThinkingChange} />
      <NumberField
        label={tmb.thinkingBudget}
        hint={tmb.thinkingBudgetHint}
        value={thinkingBudgetTokens}
        onChange={setThinkingBudgetTokens}
        min={0}
        max={32768}
      />
      <ToggleRow label={tmb.showThinking} description={tmb.showThinkingDesc} checked={showThinkingSummaries} onChange={setShowThinkingSummaries} />
      <ToggleRow
        label={tmb.compactThinking}
        description={tmb.compactThinkingDesc}
        checked={compactThinkingOnSave}
        onChange={setCompactThinkingOnSave}
      />
      <NumberField
        label={tmb.collapseThreshold}
        hint={tmb.collapseThresholdHint}
        value={thinkingAutoCollapseThreshold ?? 8}
        onChange={setThinkingAutoCollapseThreshold}
        min={0}
        max={9999}
      />
      <ToggleRow label={tmb.tabAutocomplete} description={tmb.tabAutocompleteDesc} checked={tabAutocompleteEnabled} onChange={setTabAutocompleteEnabled} />
      <ToggleRow label={tmb.inlineDiffs} description={tmb.inlineDiffsDesc} checked={inlineDiffsEnabled} onChange={setInlineDiffsEnabled} />
      <SelectField label={tmb.diffMode} hint={tmb.diffModeHint} value={defaultDiffViewMode} onChange={(v) => setDefaultDiffViewMode(v as 'inline' | 'side-by-side')} options={[{ value: 'inline', label: tmb.diffInline }, { value: 'side-by-side', label: tmb.diffSideBySide }]} />
      <SelectField
        label={tmb.externalRefresh}
        hint={tmb.externalRefreshHint}
        value={externalDiskChangeRefreshMode}
        onChange={(v) => setExternalDiskChangeRefreshMode(v as ExternalDiskChangeRefreshMode)}
        options={[
          { value: 'skip_if_dirty', label: tmb.externalSkipIfDirty },
          { value: 'always_reload', label: tmb.externalAlwaysReload },
        ]}
      />

      <SelectField
        label={tmb.defaultShell}
        hint={tmb.defaultShellHint}
        value={defaultShell}
        onChange={(v) => setDefaultShell(v as DefaultShell)}
        options={SHELL_OPTIONS}
      />

      <SelectField
        label={tmb.notifyMode}
        hint={notificationModes.find((m) => m.value === desktopNotificationMode)?.hint}
        value={desktopNotificationMode}
        onChange={(v) => setDesktopNotificationMode(v as DesktopNotificationMode)}
        options={notificationModes.map((m) => ({ value: m.value, label: m.label }))}
      />
      <ToggleRow label={tmb.notifyAsk} description={tmb.notifyAskDesc} checked={notifyOnAskUserQuestion} onChange={setNotifyOnAskUserQuestion} />
      <ToggleRow label={tmb.notifySubDone} description={tmb.notifySubDoneDesc} checked={notifyOnSubagentCompleted} onChange={setNotifyOnSubagentCompleted} />
      <ToggleRow label={tmb.notifySubFail} description={tmb.notifySubFailDesc} checked={notifyOnSubagentFailed} onChange={setNotifyOnSubagentFailed} />
      <ToggleRow label={tmb.notifySubStop} description={tmb.notifySubStopDesc} checked={notifyOnSubagentStopped} onChange={setNotifyOnSubagentStopped} />

      <ToggleRow label={tmb.promptSuggest} description={tmb.promptSuggestDesc} checked={promptSuggestionEnabled} onChange={setPromptSuggestionEnabled} />
      <ToggleRow
        label={tmb.autoRouting}
        description={tmb.autoRoutingDesc}
        checked={autoTaskRouting}
        onChange={setAutoTaskRouting}
      />
      <ToggleRow label={tmb.spinnerTips} description={tmb.spinnerTipsDesc} checked={spinnerTipsEnabled} onChange={setSpinnerTipsEnabled} />
      <ToggleRow label={tmb.reducedMotion} description={tmb.reducedMotionDesc} checked={prefersReducedMotion} onChange={setPrefersReducedMotion} />
    </div>
    )
  }

  const renderPermissions = () => {
    const tp = t.settings.permissionsPanel
    const permissionModes: Array<{ value: PermissionMode; label: string; hint: string }> = [
      { value: 'allow', label: tp.allow, hint: tp.allowHint },
      { value: 'ask', label: tp.ask, hint: tp.askHint },
      { value: 'deny', label: tp.deny, hint: tp.denyHint },
    ]
    const trustModes: Array<{ value: WorkspaceTrustModeSetting; label: string; hint: string }> = [
      { value: 'legacy', label: tp.trustLegacy, hint: tp.trustLegacyHint },
      { value: 'strict', label: tp.trustStrict, hint: tp.trustStrictHint },
    ]
    return (
    <div className="settings-form-body">
      <SelectField
        label={tp.defaultMode}
        hint={permissionModes.find((m) => m.value === permissionDefaultMode)?.hint}
        value={permissionDefaultMode}
        onChange={(v) => setPermissionDefaultMode(v as PermissionMode)}
        options={permissionModes.map((m) => ({ value: m.value, label: m.label }))}
      />

      <SelectField
        label={tp.trustMode}
        hint={trustModes.find((m) => m.value === workspaceTrustMode)?.hint}
        value={workspaceTrustMode}
        onChange={(v) => setWorkspaceTrustMode(v as WorkspaceTrustModeSetting)}
        options={trustModes.map((m) => ({ value: m.value, label: m.label }))}
      />

      <div className="settings-group">
        <label className="settings-label">{tp.rulesLabel}</label>
        <p className="settings-hint" style={{ marginTop: 0, marginBottom: 8 }}>
          {tp.rulesHintPrefix}<code>|</code>{tp.rulesHintMiddle}<code>*</code>{tp.rulesHintSuffix}
        </p>
        <div className="settings-rule-editor">
          <div className="settings-rule-inputs">
            <input className="settings-input settings-rule-input" value={newRulePattern} onChange={(e) => setNewRulePattern(e.target.value)} placeholder={tp.rulePlaceholder} onKeyDown={(e) => e.key === 'Enter' && handleAddRule()} />
            <select className="settings-select settings-rule-select" value={newRuleMode} onChange={(e) => setNewRuleMode(e.target.value as PermissionMode)}>
              {permissionModes.map((m) => (<option key={m.value} value={m.value}>{m.label}</option>))}
            </select>
            <button className="settings-rule-add-btn" onClick={handleAddRule} title={tp.addRuleTitle}><Plus size={14} /></button>
          </div>
          {permissionRules.length > 0 && (
            <div className="settings-rule-list">
              {permissionRules.map((rule) => (
                <div key={rule.id} className="settings-rule-item">
                  <div className="settings-rule-info">
                    <span className="settings-rule-pattern">{rule.pattern}</span>
                    <span className={`settings-rule-badge ${rule.mode}`}>{rule.mode === 'allow' ? tp.allow : rule.mode === 'ask' ? tp.ask : tp.deny}</span>
                  </div>
                  <div className="settings-rule-actions">
                    <button onClick={() => {
                      const next = rule.mode === 'ask' ? 'allow' : rule.mode === 'allow' ? 'deny' : 'ask'
                      updatePermissionRule(rule.id, { mode: next })
                    }} title={tp.toggleModeTitle}>
                      {rule.mode === 'allow' ? '✓' : rule.mode === 'deny' ? '✕' : '?'}
                    </button>
                    <button onClick={() => removePermissionRule(rule.id)} title={tp.deleteTitle}><Trash2 size={14} /></button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <ToggleRow label={tp.skipDangerous} description={tp.skipDangerousDesc} checked={skipDangerousModePermissionPrompt} onChange={setSkipDangerousModePermissionPrompt} />
    </div>
    )
  }

  const renderSandbox = () => {
    const ts = t.settings.sandboxPanel
    const allowedDirs = sandbox.allowedDirectories || []
    const handleAddAllowedDir = async () => {
      const api = (window as unknown as { electronAPI?: { fs?: { openDialog?: (opts: { title?: string; properties?: string[] }) => Promise<{ canceled: boolean; paths: string[] }> } } }).electronAPI?.fs?.openDialog
      if (!api) return
      const res = await api({ title: ts.pickDirTitle, properties: ['openDirectory'] })
      if (!res.canceled && res.paths.length > 0) {
        const next = Array.from(new Set([...allowedDirs, res.paths[0]]))
        setSandboxSettings({ allowedDirectories: next })
      }
    }
    const handleRemoveAllowedDir = (p: string) => {
      setSandboxSettings({ allowedDirectories: allowedDirs.filter((x) => x !== p) })
    }
    return (
      <div className="settings-form-body">
        <p className="settings-hint" style={{ marginTop: 0, marginBottom: 12, lineHeight: 1.5 }}>
          {ts.intro}
        </p>
        <ToggleRow
          label={ts.enable}
          description={ts.enableDesc}
          checked={sandbox.enabled}
          onChange={(v) => setSandboxSettings({ enabled: v })}
        />
        <ToggleRow label={ts.failClosed} description={ts.failClosedDesc} checked={sandbox.failIfUnavailable} onChange={(v) => setSandboxSettings({ failIfUnavailable: v })} />
        <ToggleRow label={ts.allowNetwork} description={ts.allowNetworkDesc} checked={sandbox.allowNetwork} onChange={(v) => setSandboxSettings({ allowNetwork: v })} />
        <ToggleRow label={ts.allowFs} description={ts.allowFsDesc} checked={sandbox.allowFilesystem} onChange={(v) => setSandboxSettings({ allowFilesystem: v })} />

        <div className="settings-group">
          <label className="settings-label">{ts.dirsLabel}</label>
          <p className="settings-hint" style={{ marginTop: 0, marginBottom: 8 }}>
            {ts.dirsHint}
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {allowedDirs.length === 0 && (
              <div className="settings-hint" style={{ opacity: 0.75 }}>{ts.dirsEmpty}</div>
            )}
            {allowedDirs.map((p) => (
              <div key={p} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input className="settings-input" readOnly value={p} style={{ flex: 1 }} title={p} />
                <button
                  type="button"
                  className="settings-btn"
                  onClick={() => handleRemoveAllowedDir(p)}
                  title={ts.removeDirTitle}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
            <button
              type="button"
              className="settings-btn"
              onClick={() => void handleAddAllowedDir()}
              style={{ alignSelf: 'flex-start' }}
            >
              <Plus size={14} /> {ts.addDir}
            </button>
          </div>
        </div>
      </div>
    )
  }

  const customHooks = hooks.filter((h) => !h.builtInId)

  const renderHooks = () => {
    const th = t.settings.hooksPanel
    return (
    <div className="settings-form-body">
      <ToggleRow label={th.disableAll} description={th.disableAllDesc} checked={disableAllHooks} onChange={setDisableAllHooks} />

      <div className="settings-group">
        <label className="settings-label">{th.builtinLabel}</label>
        <p className="settings-hint" style={{ marginTop: 0, marginBottom: 8 }}>{th.builtinHint}</p>
        <div className="builtin-hooks-grid">
          {BUILTIN_HOOKS.map((preset) => {
            const enabled = isBuiltInHookEnabled(preset.id)
            // i18n audit (2026-07) — preset.name/description in BUILTIN_HOOKS
            // are zh-CN data constants; display strings come from the locale
            // keyed by preset id (fall back to the constant for unknown ids).
            const localized = (th.builtin as Record<string, { name: string; desc: string } | undefined>)[preset.id]
            return (
              <div key={preset.id} className={`builtin-hook-card${enabled ? ' active' : ''}${disableAllHooks ? ' disabled' : ''}`}>
                <div className="builtin-hook-header">
                  <span className="builtin-hook-icon">{preset.icon}</span>
                  <span className="builtin-hook-name">{localized?.name ?? preset.name}</span>
                  <IOSToggle checked={enabled} onChange={() => toggleBuiltInHook(preset.id)} disabled={disableAllHooks} />
                </div>
                <p className="builtin-hook-desc">{localized?.desc ?? preset.description}</p>
                <div className="builtin-hook-tags">
                  <span className="builtin-hook-tag">{
                    (th.eventTags as Record<string, string>)[preset.event] || preset.event
                  }</span>
                  <span className="builtin-hook-tag">{
                    preset.matcher
                      ? ((th.matcherTags as Record<string, string>)[preset.matcher] || preset.matcher)
                      : th.allTools
                  }</span>
                  {preset.async && <span className="builtin-hook-tag async">{th.badgeAsyncSilent}</span>}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      <div className="settings-group">
        <label className="settings-label">{th.customLabel}</label>
        <p className="settings-hint" style={{ marginTop: 0, marginBottom: 8 }}>{th.customHint}</p>
        <div className="settings-rule-editor">
          <div className="settings-rule-inputs settings-rule-row">
            <select className="settings-select settings-rule-select settings-hook-event" value={newHookEvent} onChange={(e) => setNewHookEvent(e.target.value)}>
              {['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Notification', 'Subagent', 'PermissionRequest', 'FileChanged'].map((ev) => (<option key={ev} value={ev}>{ev}</option>))}
            </select>
            <input className="settings-input settings-rule-input settings-hook-matcher" value={newHookMatcher} onChange={(e) => setNewHookMatcher(e.target.value)} placeholder={th.matcherPlaceholder} />
          </div>
          <div className="settings-rule-inputs settings-rule-row">
            <input className="settings-input settings-rule-input settings-hook-input" value={newHookCommand} onChange={(e) => setNewHookCommand(e.target.value)} placeholder={th.commandPlaceholder} onKeyDown={(e) => e.key === 'Enter' && handleAddHook()} />
            <button className="settings-rule-add-btn" onClick={handleAddHook} title={th.addHookTitle}><Plus size={14} /></button>
          </div>
          <div className="settings-hook-flags">
            <label className="settings-hook-flag">
              <input type="checkbox" checked={newHookAsync} onChange={(e) => setNewHookAsync(e.target.checked)} />
              {th.flagAsync}
            </label>
            <label className="settings-hook-flag">
              <input type="checkbox" checked={newHookAsyncRewake} onChange={(e) => setNewHookAsyncRewake(e.target.checked)} />
              {th.flagRewake}
            </label>
          </div>
          {customHooks.length > 0 && (
            <div className="settings-rule-list">
              {customHooks.map((hook) => (
                <div key={hook.id} className="settings-rule-item">
                  <div className="settings-rule-info">
                    <span className="settings-rule-event-badge">{hook.event}</span>
                    {hook.matcher && <span className="settings-rule-matcher">{hook.matcher}</span>}
                    <code className="settings-rule-cmd">{hook.command}</code>
                    {hook.async && <span className="settings-rule-flag">{th.badgeAsync}</span>}
                    {hook.asyncRewake && <span className="settings-rule-flag">{th.badgeRewake}</span>}
                  </div>
                  <div className="settings-rule-actions">
                    <button onClick={() => updateHook(hook.id, { enabled: !hook.enabled })} title={hook.enabled ? th.disableTitle : th.enableTitle}>
                      {hook.enabled ? '✓' : '○'}
                    </button>
                    <button onClick={() => removeHook(hook.id)} title={th.deleteTitle}><Trash2 size={14} /></button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
    )
  }

  const renderEnvVars = () => {
    const te = t.settings.envPanel
    return (
    <div className="settings-form-body">
      <div className="settings-group">
        <label className="settings-label">{te.label}</label>
        <div className="settings-rule-editor">
          <div className="settings-rule-inputs">
            <input className="settings-input settings-rule-input" value={newEnvKey} onChange={(e) => setNewEnvKey(e.target.value)} placeholder={te.keyPlaceholder} />
            <input className="settings-input settings-rule-input" value={newEnvValue} onChange={(e) => setNewEnvValue(e.target.value)} placeholder={te.valuePlaceholder} onKeyDown={(e) => e.key === 'Enter' && handleAddEnvVar()} />
            <button className="settings-rule-add-btn" onClick={handleAddEnvVar} title={te.addTitle}><Plus size={14} /></button>
          </div>
          {envVars.length > 0 && (
            <div className="settings-rule-list">
              {envVars.map((envVar) => (
                <div key={envVar.id} className="settings-rule-item">
                  <div className="settings-rule-info">
                    <code className="settings-env-key">{envVar.key}</code>
                    <span className="settings-env-value">{envVar.enabled ? (envVar.value.length > 20 ? envVar.value.slice(0, 20) + '...' : envVar.value) : te.disabledValue}</span>
                  </div>
                  <div className="settings-rule-actions">
                    <button onClick={() => updateEnvVar(envVar.id, { enabled: !envVar.enabled })} title={envVar.enabled ? te.disableTitle : te.enableTitle}>
                      {envVar.enabled ? '✓' : '○'}
                    </button>
                    <button onClick={() => removeEnvVar(envVar.id)} title={te.deleteTitle}><Trash2 size={14} /></button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
    )
  }

  const renderAppearance = () => (
    <div className="settings-form-body">
      <SelectField label={t.settings.appearance.uiLanguageLabel} hint={t.settings.appearance.uiLanguageHint} value={uiLocale} onChange={(v) => setUiLocale(v as UiLocale)} options={UI_LOCALE_OPTIONS.map((o) => ({ value: o.value, label: o.label }))} />
      <SelectField label={t.settings.appearance.themeLabel} hint={t.settings.appearance.themeHint} value={theme} onChange={(v) => setTheme(v as UIThemeSetting)} options={[
        { value: 'dark', label: t.settings.appearance.themeDark },
        { value: 'cursor', label: t.settings.appearance.themeCursor },
        { value: 'light', label: t.settings.appearance.themeLight },
        { value: 'milk', label: t.settings.appearance.themeMilk },
        { value: 'system', label: t.settings.appearance.themeSystem },
      ]} />
      <SelectField label={t.settings.appearance.outputStyleLabel} hint={
        outputStyle === 'default' ? t.settings.appearance.outputStyleHintDefault :
        outputStyle === 'concise' ? t.settings.appearance.outputStyleHintConcise : t.settings.appearance.outputStyleHintExplanatory
      } value={outputStyle} onChange={(v) => setOutputStyle(v as OutputStyleSetting)} options={[
        { value: 'default', label: t.settings.appearance.outputStyleDefault },
        { value: 'concise', label: t.settings.appearance.outputStyleConcise },
        { value: 'explanatory', label: t.settings.appearance.outputStyleExplanatory },
      ]} />
      <SelectField label={t.settings.appearance.aiLanguageLabel} hint={t.settings.appearance.aiLanguageHint} value={language} onChange={setLanguage} options={LANGUAGE_OPTIONS.map((o) => ({ value: o.value, label: o.label }))} />
    </div>
  )

  const activeCat = CATEGORIES.find((c) => c.id === activeCategory)
  const ActiveIcon = activeCat?.icon || Brain

  return (
    <div className="settings-overlay" onClick={() => setShowSettings(false)}>
      <div className="settings-dialog" onClick={(e) => e.stopPropagation()}>
        {/* Left Sidebar */}
        <aside className="settings-sidebar">
          <div className="settings-sidebar-header">
            <h2 className="settings-sidebar-title">{t.settings.title}</h2>
            <button className="settings-sidebar-close" onClick={() => setShowSettings(false)}><X size={16} /></button>
          </div>
          <div className="settings-sidebar-search">
            <Search size={14} className="settings-search-icon" />
            <input
              ref={searchInputRef}
              className="settings-search-input"
              placeholder={t.settings.searchPlaceholder}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
          <nav className="settings-sidebar-nav">
            {filteredCategories.map((cat) => {
              const ItemIcon = cat.icon
              return (
                <button
                  key={cat.id}
                  className={`settings-sidebar-item${activeCategory === cat.id ? ' active' : ''}`}
                  onClick={() => { setActiveCategory(cat.id); setEditingConfig(false) }}
                >
                  <ItemIcon size={15} />
                  <span className="settings-sidebar-label">{categoryLabel(cat.id)}</span>
                </button>
              )
            })}
          </nav>
        </aside>

        {/* Right Content */}
        <main className="settings-content">
          <div className="settings-content-header">
            <ActiveIcon size={18} />
            <h3 className="settings-content-title">{activeCat ? categoryLabel(activeCat.id) : ''}</h3>
          </div>
          <div className="settings-form-area">
            {renderCategoryContent()}
          </div>
        </main>
      </div>
      {/* Phase 2.A — 深度思考 toggle 的 mid-conversation 二次确认。
          dialog 必须在 SettingsDialog tree 内挂出来，否则 askConfirm 的
          promise 会永远 pending。 */}
      {confirmDialogElement}
    </div>
  )
}

// Back-compat re-exports — consumers historically imported these constants
// from the SettingsDialog module path directly. The constants/components
// already live in dedicated sibling files; the re-exports here are a stable
// import surface, not new component definitions, so fast-refresh is moot.
/* eslint-disable react-refresh/only-export-components */
export {
  CATEGORIES,
  PROVIDER_PLACEHOLDERS,
  LANGUAGE_OPTIONS,
  EFFORT_LEVELS,
  SHELL_OPTIONS,
  DESKTOP_NOTIFICATION_MODES,
  PERMISSION_MODES,
  WORKSPACE_TRUST_MODES,
  getDefaultModel,
} from './settingsConstants'
export {
  IOSToggle,
  SelectField,
  InputField,
  NumberField,
  ToggleRow,
  ChipGroup,
} from './settingsControls'
/* eslint-enable react-refresh/only-export-components */
