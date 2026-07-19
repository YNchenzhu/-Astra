import { useState, useEffect, useCallback, useMemo } from 'react'
import type { MCPServerConfig, MCPServerState } from '../../types'
import { useWorkspaceStore } from '../../stores/useWorkspaceStore'
import { useManageMCPConnections } from '../../context/MCPConnectionContext'
import { openPathInOS } from '../../services/electronAPI'
import { reportUserActionError } from '../../utils/reportUserActionError'
import { useT } from '../../i18n'
import {
  buildStatusConfig,
  type MCPDiagnostic,
  type MCPListedTool,
  type MCPPreset,
  type MCPResource,
  type MCPStatus,
} from './mcpPanelTypes'

/**
 * All `MCPPanel` state + IPC handlers. Extracted verbatim from the former
 * inline component body so `MCPPanel.tsx` is reduced to the JSX surface.
 * The hook runs in the same render context as the panel, so behaviour is
 * unchanged — the component just destructures what it needs.
 */
export function useMcpPanelState() {
  const t = useT().settings.mcp
  const STATUS_CONFIG = useMemo(() => buildStatusConfig(t), [t])
  const { reconnectMcpServer } = useManageMCPConnections()
  const workspaceRoot = useWorkspaceStore((s) => s.rootPath)
  const [servers, setServers] = useState<MCPServerState[]>([])
  const [expanded, setExpanded] = useState<string | null>(null)
  const [showAddForm, setShowAddForm] = useState(false)
  const [showPresets, setShowPresets] = useState(false)
  const [connectStatus, setConnectStatus] = useState<Record<string, string>>({})
  const [presets, setPresets] = useState<MCPPreset[]>([])
  const [diagnostics, setDiagnostics] = useState<Record<string, MCPDiagnostic>>({})
  const [resources, setResources] = useState<Record<string, MCPResource[]>>({})
  const [resourceContent, setResourceContent] = useState<Record<string, string>>({})
  const [activeTab, setActiveTab] = useState<Record<string, 'details' | 'tools' | 'resources'>>({})
  const [toolsByServer, setToolsByServer] = useState<Record<string, MCPListedTool[]>>({})
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [banner, setBanner] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null)
  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(null)
  const [formMode, setFormMode] = useState<'add' | 'edit'>('add')
  const [editingOriginalName, setEditingOriginalName] = useState<string | null>(null)

  const [newServer, setNewServer] = useState<MCPServerConfig>({
    name: '',
    transport: 'stdio',
    command: 'npx',
    args: [],
    env: {},
    cwd: undefined,
  })

  const [permissionRelayWebhookUrl, setPermissionRelayWebhookUrl] = useState('')
  const [pluginMarketplaceIndexUrl, setPluginMarketplaceIndexUrl] = useState('')
  const [showPluginRelayExtras, setShowPluginRelayExtras] = useState(false)
  const [unconfiguredRelayChannels, setUnconfiguredRelayChannels] = useState<
    Array<{ id: string; reason: string }>
  >([])
  const [pluginBundleCachePath, setPluginBundleCachePath] = useState('')

  const fetchServers = useCallback(async (): Promise<MCPServerState[]> => {
    const api = window.electronAPI
    const configs = await api.mcp.getConfigs()
    const connected = await api.mcp.listServers()
    const connectedMap = new Map(connected.map((s) => [s.name, s]))

    return configs.map((cfg: MCPServerConfig) => ({
      config: cfg,
      connected: connectedMap.get(cfg.name)?.connected || false,
      status: connectedMap.get(cfg.name)?.status || 'disconnected',
      toolCount: connectedMap.get(cfg.name)?.toolCount || 0,
      resourceCount: connectedMap.get(cfg.name)?.resourceCount || 0,
      lastError: connectedMap.get(cfg.name)?.lastError,
      lastConnectedAt: connectedMap.get(cfg.name)?.lastConnectedAt,
    }))
  }, [])

  const loadServers = useCallback(async () => {
    const next = await fetchServers()
    setServers(next)
  }, [fetchServers])

  const showBanner = useCallback((type: 'success' | 'error' | 'info', text: string) => {
    setBanner({ type, text })
    setTimeout(() => setBanner(null), 3500)
  }, [])

  const selectedPreset = presets.find((p) => p.id === selectedPresetId)

  const requiredEnvKeys = useCallback((preset?: MCPPreset): string[] => {
    if (!preset) return []
    const env = (preset.config as { env?: Record<string, unknown> }).env
    if (!env || typeof env !== 'object') return []
    return Object.keys(env)
  }, [])

  const maskableEnvKey = (key: string): boolean => {
    const upper = key.toUpperCase()
    return upper.includes('KEY') || upper.includes('TOKEN') || upper.includes('SECRET') || upper.includes('PASSWORD')
  }

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [nextServers, nextPresets, settings, ch, cache] = await Promise.all([
          fetchServers(),
          window.electronAPI.mcp.presets(workspaceRoot ?? null),
          window.electronAPI.settings.get(),
          window.electronAPI.mcp.unconfiguredChannels(),
          window.electronAPI.plugin.bundleCachePath(),
        ])
        if (cancelled) return
        setServers(nextServers)
        setPresets(nextPresets)
        setPermissionRelayWebhookUrl(
          typeof settings.permissionRelayWebhookUrl === 'string'
            ? settings.permissionRelayWebhookUrl
            : '',
        )
        setPluginMarketplaceIndexUrl(
          typeof settings.pluginMarketplaceIndexUrl === 'string'
            ? settings.pluginMarketplaceIndexUrl
            : '',
        )
        setUnconfiguredRelayChannels(ch.channels ?? [])
        if (cache?.path) setPluginBundleCachePath(cache.path)
      } catch {
        // ignore on first paint
      }
    })()
    return () => {
      cancelled = true
    }
  }, [fetchServers, workspaceRoot])

  const saveRelayAndMarketplaceSettings = async () => {
    const r = await window.electronAPI.settings.set({
      permissionRelayWebhookUrl: permissionRelayWebhookUrl.trim() || undefined,
      pluginMarketplaceIndexUrl: pluginMarketplaceIndexUrl.trim() || undefined,
    })
    if (r.success) {
      showBanner('success', t.saved)
      const ch = await window.electronAPI.mcp.unconfiguredChannels()
      setUnconfiguredRelayChannels(ch.channels ?? [])
    } else {
      showBanner('error', r.error || t.saveFailedShort)
    }
  }

  const pickAndInstallMcpb = async () => {
    setIsSubmitting(true)
    try {
      const dlg = await window.electronAPI.fs.openDialog({
        title: t.selectMcpbDialog,
        properties: ['openFile'],
        filters: [
          { name: 'MCPB', extensions: ['mcpb', 'zip'] },
          { name: 'All', extensions: ['*'] },
        ],
      })
      if (dlg.canceled || !dlg.paths[0]) {
        setIsSubmitting(false)
        return
      }
      const r = await window.electronAPI.plugin.installMcpbBundle(dlg.paths[0])
      if (r.success) {
        showBanner('success', t.installed(r.added.length, r.added.join(', ')))
      } else {
        showBanner('error', r.error || t.installFailed)
      }
      await loadServers()
    } catch (e) {
      showBanner('error', e instanceof Error ? e.message : String(e))
    }
    setIsSubmitting(false)
  }

  const openPluginBundleCache = async () => {
    if (!pluginBundleCachePath) {
      const r = await window.electronAPI.plugin.bundleCachePath()
      if (r.path) setPluginBundleCachePath(r.path)
      if (!r.path) return
      await openPathInOS(r.path)
      return
    }
    await openPathInOS(pluginBundleCachePath)
  }

  const probeMarketplace = async () => {
    const r = await window.electronAPI.plugin.fetchMarketplaceIndex(
      pluginMarketplaceIndexUrl.trim() || null,
    )
    if (r.success) {
      showBanner('success', t.marketOk(r.pluginIds?.length ?? 0))
    } else {
      showBanner('error', r.error || t.fetchFailed)
    }
  }

  const handleConnect = async (config: MCPServerConfig) => {
    setIsSubmitting(true)
    showBanner('info', t.connectingTo(config.name))
    setConnectStatus((prev) => ({ ...prev, [config.name]: t.connectDots }))
    try {
      const result = await window.electronAPI.mcp.connect(config, workspaceRoot)
      if (result.success) {
        setConnectStatus((prev) => ({ ...prev, [config.name]: t.connectedFound(result.toolCount || 0) }))
        showBanner('success', t.connectedBanner(config.name, result.toolCount || 0))
      } else {
        setConnectStatus((prev) => ({ ...prev, [config.name]: result.error || t.connectFailed }))
        showBanner('error', t.connectFailedMsg(result.error || t.unknownError))
      }
      await loadServers()
    } catch (error) {
      // Catches unexpected IPC rejection (preload bridge missing, etc.).
      // Normal success/failure already flows through showBanner above.
      const msg = error instanceof Error ? error.message : String(error)
      setConnectStatus((prev) => ({ ...prev, [config.name]: t.ipcError(msg) }))
      showBanner('error', t.connectFailedMsg(msg))
      reportUserActionError('MCP 连接', error, { silent: true })
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleDisconnect = async (name: string) => {
    try {
      await window.electronAPI.mcp.disconnect(name)
      await loadServers()
    } catch (error) {
      showBanner('error', t.disconnectFailed(error instanceof Error ? error.message : String(error)))
      reportUserActionError('MCP 断开', error, { silent: true })
    }
  }

  const handleReconnect = async (name: string) => {
    setIsSubmitting(true)
    showBanner('info', t.reconnectingTo(name))
    setConnectStatus((prev) => ({ ...prev, [name]: t.reconnectDots }))
    try {
      const result = await reconnectMcpServer(name)
      if (result.success) {
        setConnectStatus((prev) => ({ ...prev, [name]: t.reconnectedFound(result.toolCount || 0) }))
        showBanner('success', t.reconnectedBanner(name))
      } else {
        setConnectStatus((prev) => ({ ...prev, [name]: result.error || t.reconnectFailed }))
        showBanner('error', t.reconnectFailedMsg(result.error || t.unknownError))
      }
      await loadServers()
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      setConnectStatus((prev) => ({ ...prev, [name]: t.ipcError(msg) }))
      showBanner('error', t.reconnectFailedMsg(msg))
      reportUserActionError('MCP 重连', error, { silent: true })
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleDelete = async (config: MCPServerConfig) => {
    try {
      if (config.name) {
        await window.electronAPI.mcp.disconnect(config.name)
      }
      const updated = servers.filter((s) => s.config.name !== config.name)
      await window.electronAPI.mcp.saveConfigs(updated.map((s) => s.config))
      await loadServers()
    } catch (error) {
      showBanner('error', t.deleteFailed(error instanceof Error ? error.message : String(error)))
      reportUserActionError('MCP 删除', error, { silent: true })
    }
  }

  const resetAddForm = () => {
    setFormMode('add')
    setEditingOriginalName(null)
    setNewServer({ name: '', transport: 'stdio', command: 'npx', args: [], env: {}, cwd: undefined })
    setSelectedPresetId(null)
  }

  const openAddForm = () => {
    resetAddForm()
    setShowAddForm(true)
    setShowPresets(false)
  }

  const beginEditServer = (config: MCPServerConfig) => {
    setNewServer({
      ...config,
      args: [...(config.args || [])],
      env: config.env ? { ...config.env } : {},
    })
    setFormMode('edit')
    setEditingOriginalName(config.name)
    setShowAddForm(true)
    setShowPresets(false)
    setSelectedPresetId(null)
    setExpanded(config.name)
  }

  const handleSaveEdit = async () => {
    if (!editingOriginalName || !newServer.name.trim()) return
    if (newServer.name.trim() !== editingOriginalName) {
      showBanner('error', t.editNoRenameMsg)
      return
    }
    setIsSubmitting(true)
    showBanner('info', t.savingName(editingOriginalName))
    const prev = servers.find((s) => s.config.name === editingOriginalName)
    const wasConnected = prev?.connected
    const merged: MCPServerConfig = {
      ...newServer,
      name: editingOriginalName,
      autoConnectOnLaunch: prev?.config.autoConnectOnLaunch,
    }
    const nextConfigs = servers.map((s) =>
      s.config.name === editingOriginalName ? merged : s.config,
    )
    try {
      await window.electronAPI.mcp.saveConfigs(nextConfigs)
      if (wasConnected) {
        // 断开以便用新配置重连；保留「启动时自动连接」偏好（勿与手动「断开」混淆）
        await window.electronAPI.mcp.disconnect(editingOriginalName, true)
        const result = await window.electronAPI.mcp.connect(merged, workspaceRoot)
        if (result.success) {
          showBanner('success', t.savedReconnected(editingOriginalName))
        } else {
          showBanner('error', t.savedReconnectFailed(editingOriginalName, result.error || t.unknownError))
        }
      } else {
        showBanner('success', t.savedConfig(editingOriginalName))
      }
      setShowAddForm(false)
      resetAddForm()
      await loadServers()
    } catch {
      showBanner('error', t.saveFailedShort)
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleAdd = async () => {
    if (!newServer.name.trim()) return
    if (formMode === 'edit') {
      await handleSaveEdit()
      return
    }
    setIsSubmitting(true)
    showBanner('info', t.connectingPreset(newServer.name))
    try {
      const result = await window.electronAPI.mcp.connect(newServer, workspaceRoot)
      if (result.success) {
        // connect() 已写入 mcp-servers.json 并标记 autoConnectOnLaunch
        setConnectStatus((prev) => ({ ...prev, [newServer.name]: t.connectedFound(result.toolCount || 0) }))
        showBanner('success', t.presetConnected(newServer.name, result.toolCount || 0))
        setShowAddForm(false)
        setShowPresets(false)
        resetAddForm()
        await loadServers()
      } else {
        setConnectStatus((prev) => ({ ...prev, [newServer.name]: result.error || t.connectFailed }))
        showBanner('error', t.connectFailedMsg(result.error || t.unknownError))
      }
    } catch (error) {
      // Before: the newly-added server "vanished" silently when the connect
      // IPC rejected (preload missing / main-process crash). Surface it.
      const msg = error instanceof Error ? error.message : String(error)
      setConnectStatus((prev) => ({ ...prev, [newServer.name]: t.ipcError(msg) }))
      showBanner('error', t.addFailed(msg))
      reportUserActionError('MCP 添加服务器', error, { silent: true })
    } finally {
      setIsSubmitting(false)
    }
  }

  const handlePresetSelect = (preset: MCPPreset) => {
    const cfg = preset.config as Partial<MCPServerConfig>
    const normalizedEnv =
      cfg.env && typeof cfg.env === 'object'
        ? Object.fromEntries(
            Object.entries(cfg.env).map(([k, v]) => [k, typeof v === 'string' ? v : '']),
          )
        : {}
    setNewServer({
      name: preset.id,
      transport: cfg.transport === 'sse' ? 'sse' : 'stdio',
      command: typeof cfg.command === 'string' ? cfg.command : 'npx',
      args: Array.isArray(cfg.args) ? cfg.args : [],
      url: typeof cfg.url === 'string' ? cfg.url : undefined,
      headers: cfg.headers,
      env: normalizedEnv,
      cwd: typeof cfg.cwd === 'string' ? cfg.cwd : undefined,
    })
    setFormMode('add')
    setEditingOriginalName(null)
    setSelectedPresetId(preset.id)
    setShowAddForm(true)
    setShowPresets(false)
  }

  const handleReconnectAll = async () => {
    try {
      await window.electronAPI.mcp.reconnectAll(workspaceRoot)
      await loadServers()
    } catch (error) {
      showBanner('error', t.reconnectAllFailed(error instanceof Error ? error.message : String(error)))
      reportUserActionError('MCP 全部重连', error, { silent: true })
    }
  }

  const handleHealthCheck = async (serverName: string) => {
    try {
      const result = await window.electronAPI.mcp.healthCheck(serverName)
      setDiagnostics((prev) => ({ ...prev, [serverName]: result }))
    } catch (error) {
      showBanner('error', t.healthCheckFailed(error instanceof Error ? error.message : String(error)))
      reportUserActionError('MCP 健康检查', error, { silent: true })
    }
  }

  const handleDiagnosticsAll = async () => {
    try {
      const results = await window.electronAPI.mcp.diagnostics()
      const map: Record<string, MCPDiagnostic> = {}
      for (const d of results) {
        map[d.serverName] = d
      }
      setDiagnostics(map)
    } catch (error) {
      showBanner('error', t.diagFailed(error instanceof Error ? error.message : String(error)))
      reportUserActionError('MCP 诊断', error, { silent: true })
    }
  }

  const handleLoadResources = async (serverName: string) => {
    try {
      const result = await window.electronAPI.mcp.listResources(serverName)
      if (result.success && result.resources) {
        setResources((prev) => ({ ...prev, [serverName]: result.resources }))
      }
    } catch (error) {
      showBanner('error', t.loadResourcesFailed(error instanceof Error ? error.message : String(error)))
      reportUserActionError('MCP 加载资源', error, { silent: true })
    }
  }

  const handleLoadTools = async (serverName: string) => {
    const allTools = await window.electronAPI.mcp.listTools()
    const serverTools = allTools.filter((t) => t.serverName === serverName)
    setToolsByServer((prev) => ({ ...prev, [serverName]: serverTools }))
  }

  const handleReadResource = async (serverName: string, uri: string) => {
    const key = `${serverName}::${uri}`
    setResourceContent((prev) => ({ ...prev, [key]: t.loadingResource }))
    const result = await window.electronAPI.mcp.readResource({ serverName, uri })
    if (result.success && result.contents && result.contents.length > 0) {
      const text = result.contents.map((c) => c.text || t.binaryFile(c.blobSavedTo ?? '')).join('\n')
      setResourceContent((prev) => ({ ...prev, [key]: text }))
    } else {
      setResourceContent((prev) => ({ ...prev, [key]: result.error || t.noContent }))
    }
  }

  const getStatusConfig = (status: string) => {
    return STATUS_CONFIG[status as MCPStatus] || STATUS_CONFIG.disconnected
  }

  const presetsByCategory = presets.reduce<Record<string, MCPPreset[]>>((acc, p) => {
    if (!acc[p.category]) acc[p.category] = []
    acc[p.category].push(p)
    return acc
  }, {})

  return {
    workspaceRoot,
    servers,
    expanded,
    setExpanded,
    showAddForm,
    setShowAddForm,
    showPresets,
    setShowPresets,
    connectStatus,
    presets,
    diagnostics,
    resources,
    resourceContent,
    activeTab,
    setActiveTab,
    toolsByServer,
    isSubmitting,
    banner,
    selectedPresetId,
    formMode,
    newServer,
    setNewServer,
    permissionRelayWebhookUrl,
    setPermissionRelayWebhookUrl,
    pluginMarketplaceIndexUrl,
    setPluginMarketplaceIndexUrl,
    showPluginRelayExtras,
    setShowPluginRelayExtras,
    unconfiguredRelayChannels,
    pluginBundleCachePath,
    setSelectedPresetId,
    loadServers,
    showBanner,
    selectedPreset,
    requiredEnvKeys,
    maskableEnvKey,
    saveRelayAndMarketplaceSettings,
    pickAndInstallMcpb,
    openPluginBundleCache,
    probeMarketplace,
    handleConnect,
    handleDisconnect,
    handleReconnect,
    handleDelete,
    resetAddForm,
    openAddForm,
    beginEditServer,
    handleSaveEdit,
    handleAdd,
    handlePresetSelect,
    handleReconnectAll,
    handleHealthCheck,
    handleDiagnosticsAll,
    handleLoadResources,
    handleLoadTools,
    handleReadResource,
    getStatusConfig,
    presetsByCategory,
  }
}
