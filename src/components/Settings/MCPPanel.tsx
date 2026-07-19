import React from 'react'
import {
  Plus, Trash2, Plug, Unplug, RefreshCw, ChevronDown, ChevronRight,
  Activity, AlertTriangle, FileText, Zap, Heart, Pencil,
  FolderOpen, Wrench,
} from 'lucide-react'
import { McpProjectDiscoverySection } from './McpProjectDiscovery'
import {
  CATEGORY_ICONS,
  buildCategoryLabels,
  formatMcpSpawnLine,
  isFilesystemMcpConfig,
  splitMcpArgsLine,
} from './mcpPanelTypes'
import { useMcpPanelState } from './mcpPanelState'
import { useT } from '../../i18n'
import './MCPPanel.css'

export const MCPPanel: React.FC = () => {
  const t = useT().settings.mcp
  const CATEGORY_LABELS = React.useMemo(() => buildCategoryLabels(t), [t])
  const {
    handleDiagnosticsAll, handleReconnectAll, showPresets, setShowPresets, setShowAddForm,
    setSelectedPresetId, showAddForm, formMode, resetAddForm, openAddForm, workspaceRoot,
    loadServers, setShowPluginRelayExtras, showPluginRelayExtras, isSubmitting,
    pickAndInstallMcpb, openPluginBundleCache, pluginBundleCachePath,
    unconfiguredRelayChannels, permissionRelayWebhookUrl, setPermissionRelayWebhookUrl,
    pluginMarketplaceIndexUrl, setPluginMarketplaceIndexUrl, saveRelayAndMarketplaceSettings,
    probeMarketplace, banner, presets, presetsByCategory, servers, handlePresetSelect,
    requiredEnvKeys, newServer, setNewServer, selectedPreset, maskableEnvKey, connectStatus,
    handleAdd, getStatusConfig, diagnostics, resources, toolsByServer, activeTab, expanded,
    setExpanded, beginEditServer, handleDisconnect, handleConnect, handleReconnect,
    handleDelete, setActiveTab, handleLoadTools, handleLoadResources, handleHealthCheck,
    resourceContent, handleReadResource,
  } = useMcpPanelState()

  return (
    <div className="mcp-panel">
      <div className="mcp-panel-header">
        <h3>{t.title}</h3>
        <div className="mcp-panel-actions">
          <button className="mcp-btn mcp-btn-ghost" onClick={handleDiagnosticsAll} title={t.diagnoseAll}>
            <Activity size={14} />
          </button>
          <button className="mcp-btn mcp-btn-ghost" onClick={handleReconnectAll} title={t.reconnectAll}>
            <RefreshCw size={14} />
          </button>
          <button
            className="mcp-btn mcp-btn-ghost"
            onClick={() => { setShowPresets(!showPresets); setShowAddForm(false); setSelectedPresetId(null) }}
            title={t.addFromPreset}
          >
            <Zap size={14} />
          </button>
          <button
            className="mcp-btn mcp-btn-primary"
            onClick={() => {
              if (showAddForm && formMode === 'add') {
                setShowAddForm(false)
                resetAddForm()
              } else {
                openAddForm()
              }
            }}
          >
            <Plus size={14} />
            {t.addServer}
          </button>
        </div>
      </div>

      <McpProjectDiscoverySection workspaceRoot={workspaceRoot ?? undefined} onCatalogChanged={loadServers} />

      <button
        type="button"
        className="mcp-btn mcp-btn-secondary mcp-extras-toggle"
        onClick={() => setShowPluginRelayExtras((v) => !v)}
      >
        <ChevronRight size={14} className={`mcp-extras-chevron${showPluginRelayExtras ? ' mcp-extras-chevron-open' : ''}`} />
        {t.pluginRelaySettings}
      </button>

      {showPluginRelayExtras && (
        <div className="mcp-extras-panel">
          <div className="mcp-extras-section-title">{t.pluginBundle}</div>
          <div className="mcp-form-row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="mcp-btn mcp-btn-secondary"
              disabled={isSubmitting}
              onClick={() => void pickAndInstallMcpb()}
            >
              <FileText size={14} />
              {t.selectMcpb}
            </button>
            <button type="button" className="mcp-btn mcp-btn-ghost" onClick={() => void openPluginBundleCache()}>
              <FolderOpen size={14} />
              {t.openCacheDir}
            </button>
          </div>
          {pluginBundleCachePath ? (
            <div className="mcp-form-hint" style={{ marginTop: 6 }}>
              <code style={{ wordBreak: 'break-all' }}>{pluginBundleCachePath}</code>
            </div>
          ) : null}

          <div className="mcp-extras-section-title">{t.relayAndMarket}</div>
          {unconfiguredRelayChannels.length > 0 && (
            <div className="mcp-banner mcp-banner-error mcp-relay-channels">
              <AlertTriangle size={14} />
              <div>
                <div className="mcp-project-issues-title">{t.channelsNeedWebhook}</div>
                <ul>
                  {unconfiguredRelayChannels.map((c) => (
                    <li key={c.id}>
                      <code>{c.id}</code> {c.reason}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
          <div className="mcp-form-row mcp-form-row-stack">
            <label>{t.relayWebhookUrl}</label>
            <input
              type="url"
              placeholder="https://example.com/permission-hook"
              value={permissionRelayWebhookUrl}
              onChange={(e) => setPermissionRelayWebhookUrl(e.target.value)}
            />
          </div>
          <div className="mcp-form-row mcp-form-row-stack">
            <label>{t.marketIndexUrl}</label>
            <input
              type="url"
              placeholder="https://example.com/plugin-marketplace.json"
              value={pluginMarketplaceIndexUrl}
              onChange={(e) => setPluginMarketplaceIndexUrl(e.target.value)}
            />
          </div>
          <div className="mcp-form-actions mcp-extras-actions">
            <button type="button" className="mcp-btn mcp-btn-primary" onClick={() => void saveRelayAndMarketplaceSettings()}>
              {t.save}
            </button>
            <button type="button" className="mcp-btn mcp-btn-ghost" onClick={() => void probeMarketplace()}>
              {t.testMarket}
            </button>
          </div>
        </div>
      )}

      {banner && (
        <div className={`mcp-banner mcp-banner-${banner.type}`}>
          {banner.text}
        </div>
      )}

      {/* Preset Templates */}
      {showPresets && presets.length > 0 && (
        <div className="mcp-presets">
          <div className="mcp-presets-title">{t.presetsTitle}</div>
          {Object.entries(presetsByCategory).map(([category, items]) => (
            <div key={category} className="mcp-preset-category">
              <div className="mcp-preset-category-label">
                {CATEGORY_ICONS[category] || <Zap size={14} />}
                <span>{CATEGORY_LABELS[category] || category}</span>
              </div>
              <div className="mcp-preset-grid">
                {items.map((preset) => {
                  const alreadyAdded = servers.some((s) => s.config.name === preset.id)
                  return (
                    <button
                      key={preset.id}
                      className={`mcp-preset-card ${alreadyAdded ? 'mcp-preset-disabled' : ''}`}
                      onClick={() => !alreadyAdded && handlePresetSelect(preset)}
                      disabled={alreadyAdded}
                    >
                      <div className="mcp-preset-name">{preset.name}</div>
                      <div className="mcp-preset-desc">{preset.description}</div>
                      {requiredEnvKeys(preset).length > 0 && (
                        <div className="mcp-preset-env-hint">
                          {t.envNeeded(requiredEnvKeys(preset).join(', '))}
                        </div>
                      )}
                      {alreadyAdded && <span className="mcp-preset-added">{t.added}</span>}
                    </button>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add Form */}
      {showAddForm && (
        <div className="mcp-add-form">
          <div className="mcp-add-form-title">{formMode === 'edit' ? t.formEditTitle : t.formAddTitle}</div>
          {newServer.transport === 'stdio' && (
            <div className="mcp-form-hint mcp-workspace-hint">
              {workspaceRoot
                ? t.stdioHintWs(workspaceRoot)
                : t.stdioHintNoWs}
            </div>
          )}
          <div className="mcp-form-row">
            <label>{t.fieldName}</label>
            <input
              type="text"
              placeholder="my-server"
              value={newServer.name}
              readOnly={formMode === 'edit'}
              title={formMode === 'edit' ? t.editNoRename : undefined}
              onChange={(e) => setNewServer({ ...newServer, name: e.target.value })}
            />
          </div>
          <div className="mcp-form-row">
            <label>{t.transport}</label>
            <select
              value={newServer.transport}
              onChange={(e) => setNewServer({ ...newServer, transport: e.target.value as 'stdio' | 'sse' })}
            >
              <option value="stdio">stdio</option>
              <option value="sse">SSE (HTTP)</option>
            </select>
          </div>
          {newServer.transport === 'stdio' ? (
            <>
              <div className="mcp-form-row">
                <label>{t.command}</label>
                <input
                  type="text"
                  placeholder="npx"
                  value={newServer.command}
                  onChange={(e) => setNewServer({ ...newServer, command: e.target.value })}
                />
              </div>
              <div className="mcp-form-row">
                <label>{t.args}</label>
                <input
                  type="text"
                  placeholder="-y @modelcontextprotocol/server-filesystem ."
                  value={newServer.args?.join(' ') || ''}
                  onChange={(e) =>
                    setNewServer({ ...newServer, args: splitMcpArgsLine(e.target.value) })
                  }
                />
              </div>
              <div className="mcp-form-row">
                <label>{t.cwd}</label>
                <input
                  type="text"
                  placeholder={t.cwdPlaceholder}
                  value={newServer.cwd || ''}
                  onChange={(e) =>
                    setNewServer({
                      ...newServer,
                      cwd: e.target.value.trim() ? e.target.value : undefined,
                    })
                  }
                />
              </div>
            </>
          ) : (
            <div className="mcp-form-row">
              <label>{t.url}</label>
              <input
                type="text"
                placeholder="http://localhost:3001/mcp"
                value={newServer.url || ''}
                onChange={(e) => setNewServer({ ...newServer, url: e.target.value })}
              />
            </div>
          )}
          {Object.keys(newServer.env || {}).length > 0 && (
            <div className="mcp-env-section">
              <div className="mcp-env-title">
                {t.envVars}
                {selectedPreset && requiredEnvKeys(selectedPreset).length > 0 && (
                  <span className="mcp-env-required-note">{t.presetRequired}</span>
                )}
              </div>
              {Object.entries(newServer.env || {}).map(([key, val]) => (
                <div key={key} className="mcp-form-row">
                  <label>{key}</label>
                  <input
                    type={maskableEnvKey(key) ? 'password' : 'text'}
                    placeholder={t.envPlaceholder(key)}
                    value={val}
                    onChange={(e) =>
                      setNewServer((prev) => ({
                        ...prev,
                        env: { ...(prev.env || {}), [key]: e.target.value },
                      }))
                    }
                  />
                </div>
              ))}
            </div>
          )}
          {connectStatus[newServer.name] && (
            <div className="mcp-status-message">{connectStatus[newServer.name]}</div>
          )}
          <div className="mcp-form-actions">
            <button
              className="mcp-btn mcp-btn-ghost"
              onClick={() => {
                setShowAddForm(false)
                resetAddForm()
              }}
              disabled={isSubmitting}
            >
              {t.cancel}
            </button>
            <button className="mcp-btn mcp-btn-primary" onClick={() => void handleAdd()} disabled={isSubmitting}>
              {isSubmitting
                ? formMode === 'edit'
                  ? t.saving
                  : t.connecting
                : formMode === 'edit'
                  ? t.saveConfig
                  : t.connect}
            </button>
          </div>
        </div>
      )}

      {/* Server List */}
      <div className="mcp-server-list">
        {servers.length === 0 && !showAddForm && !showPresets && (
          <div className="mcp-empty">
            <Plug size={24} />
            <p>{t.emptyTitle}</p>
            <p className="mcp-empty-hint">{t.emptyHint}</p>
          </div>
        )}

        {servers.map((server) => {
          const sc = getStatusConfig(server.status)
          const diag = diagnostics[server.config.name]
          const serverResources = resources[server.config.name] || []
          const serverTools = toolsByServer[server.config.name] || []
          const tab = activeTab[server.config.name] || 'details'

          return (
            <div key={server.config.name} className="mcp-server-item">
              <div className="mcp-server-header" onClick={() => setExpanded(expanded === server.config.name ? null : server.config.name)}>
                <div className="mcp-server-info">
                  {expanded === server.config.name ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  <span
                    className={`mcp-status-dot ${sc.pulse ? 'pulse' : ''}`}
                    style={{ background: sc.color, boxShadow: server.connected ? `0 0 6px ${sc.color}40` : 'none' }}
                  />
                  <span className="mcp-server-name">{server.config.name}</span>
                  <span className="mcp-server-meta">
                    {sc.label} · {server.config.transport}
                    {server.connected && t.toolCountSuffix(server.toolCount)}
                    {server.resourceCount > 0 && t.resourceCountSuffix(server.resourceCount)}
                  </span>
                </div>
                <div className="mcp-server-actions" onClick={(e) => e.stopPropagation()}>
                  <button
                    className="mcp-btn mcp-btn-ghost"
                    onClick={() => beginEditServer(server.config)}
                    title={t.editConfig}
                  >
                    <Pencil size={14} />
                  </button>
                  {server.connected ? (
                    <button className="mcp-btn mcp-btn-ghost" onClick={() => handleDisconnect(server.config.name)} title={t.disconnect}>
                      <Unplug size={14} />
                    </button>
                  ) : (
                    <button className="mcp-btn mcp-btn-ghost" onClick={() => handleConnect(server.config)} title={t.connect}>
                      <Plug size={14} />
                    </button>
                  )}
                  <button
                    className="mcp-btn mcp-btn-ghost"
                    onClick={() => handleReconnect(server.config.name)}
                    title={t.reconnect}
                  >
                    <RefreshCw size={14} />
                  </button>
                  <button className="mcp-btn mcp-btn-ghost mcp-btn-danger" onClick={() => handleDelete(server.config)}>
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>

              {connectStatus[server.config.name] && (
                <div className="mcp-status-message">{connectStatus[server.config.name]}</div>
              )}

              {expanded === server.config.name && (
                <div className="mcp-server-expanded">
                  {/* Tab Switcher */}
                  <div className="mcp-tab-bar">
                    <button
                      className={`mcp-tab ${tab === 'details' ? 'active' : ''}`}
                      onClick={() => setActiveTab((prev) => ({ ...prev, [server.config.name]: 'details' }))}
                    >
                      {t.tabDetails}
                    </button>
                    {server.connected && (
                      <button
                        className={`mcp-tab ${tab === 'tools' ? 'active' : ''}`}
                        onClick={() => {
                          setActiveTab((prev) => ({ ...prev, [server.config.name]: 'tools' }))
                          if (!toolsByServer[server.config.name]) {
                            handleLoadTools(server.config.name)
                          }
                        }}
                      >
                        {t.tabTools}
                      </button>
                    )}
                    {server.connected && (
                      <button
                        className={`mcp-tab ${tab === 'resources' ? 'active' : ''}`}
                        onClick={() => {
                          setActiveTab((prev) => ({ ...prev, [server.config.name]: 'resources' }))
                          if (!resources[server.config.name]) {
                            handleLoadResources(server.config.name)
                          }
                        }}
                      >
                        {t.tabResources}
                      </button>
                    )}
                  </div>

                  {tab === 'details' && (
                    <div className="mcp-server-details">
                      <div className="mcp-detail-row">
                        <span>{t.detailCommand}</span>
                        <div className="mcp-spawn-display">
                          <code>{formatMcpSpawnLine(server.config)}</code>
                          {isFilesystemMcpConfig(server.config) && (
                            <p className="mcp-form-hint mcp-spawn-hint">
                              {t.fsHintPre}<strong>{t.fsHintConnect}</strong>{t.fsHintMid}
                              <code className="mcp-servers-json">mcp-servers.json</code>
                              {workspaceRoot ? (
                                <>
                                  {t.fsHintWsPre}<code>{workspaceRoot}</code>
                                </>
                              ) : null}
                              {t.fsHintSuf1}<code>npx</code>{t.fsHintSuf2}
                              <code>{t.fsHintArgsExample}</code>{t.fsHintEnd}
                            </p>
                          )}
                        </div>
                      </div>
                      {server.config.url && (
                        <div className="mcp-detail-row">
                          <span>{t.detailUrl}</span>
                          <code>{server.config.url}</code>
                        </div>
                      )}
                      {server.lastConnectedAt && (
                        <div className="mcp-detail-row">
                          <span>{t.detailLastConnected}</span>
                          <code>{new Date(server.lastConnectedAt).toLocaleString()}</code>
                        </div>
                      )}
                      {server.config.env && Object.keys(server.config.env).length > 0 && (
                        <div className="mcp-detail-row">
                          <span>{t.detailEnv}</span>
                          <code>{Object.keys(server.config.env).join(', ')}</code>
                        </div>
                      )}
                      <div className="mcp-detail-row">
                        <span>{t.detailCwd}</span>
                        <code>
                          {server.config.cwd?.trim()
                            ? server.config.cwd
                            : workspaceRoot
                              ? t.cwdDefault(workspaceRoot)
                              : t.cwdUnset}
                        </code>
                      </div>

                      {/* Diagnostics Section */}
                      <div className="mcp-diagnostics">
                        <button
                          className="mcp-btn mcp-btn-ghost mcp-diag-btn"
                          onClick={() => handleHealthCheck(server.config.name)}
                        >
                          <Heart size={12} />
                          {t.healthCheck}
                        </button>

                        {diag && (
                          <div className={`mcp-diag-result ${diag.error ? 'has-error' : ''}`}>
                            <div className="mcp-diag-status">
                              {t.statusLabel}<span style={{ color: getStatusConfig(diag.status).color }}>
                                {getStatusConfig(diag.status).label}
                              </span>
                              {diag.toolCount > 0 && t.diagToolCount(diag.toolCount)}
                            </div>
                            {diag.error && (
                              <div className="mcp-diag-error">
                                <AlertTriangle size={12} />
                                <span>{diag.error}</span>
                              </div>
                            )}
                            {diag.suggestion && (
                              <div className="mcp-diag-suggestion">{diag.suggestion}</div>
                            )}
                          </div>
                        )}

                        {server.lastError && !diag && (
                          <div className="mcp-diag-result has-error">
                            <div className="mcp-diag-error">
                              <AlertTriangle size={12} />
                              <span>{server.lastError}</span>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {tab === 'tools' && (
                    <div className="mcp-tools">
                      {serverTools.length === 0 ? (
                        <div className="mcp-tools-empty">
                          <Wrench size={16} />
                          <span>{t.toolsEmpty}</span>
                        </div>
                      ) : (
                        <div className="mcp-tool-list">
                          {serverTools.map((tool) => (
                            <div key={tool.name} className="mcp-tool-item">
                              <div className="mcp-tool-name">{tool.originalName}</div>
                              <div className="mcp-tool-fullname">{tool.name}</div>
                              {tool.description && (
                                <div className="mcp-tool-desc">{tool.description}</div>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {tab === 'resources' && (
                    <div className="mcp-resources">
                      {serverResources.length === 0 ? (
                        <div className="mcp-resources-empty">
                          <FileText size={16} />
                          <span>{t.resourcesEmpty}</span>
                        </div>
                      ) : (
                        <div className="mcp-resource-list">
                          {serverResources.map((res) => {
                            const contentKey = `${server.config.name}::${res.uri}`
                            const content = resourceContent[contentKey]
                            return (
                              <div key={res.uri} className="mcp-resource-item">
                                <div
                                  className="mcp-resource-header"
                                  onClick={() => handleReadResource(server.config.name, res.uri)}
                                >
                                  <FileText size={12} />
                                  <span className="mcp-resource-name">{res.name}</span>
                                  {res.mimeType && <span className="mcp-resource-mime">{res.mimeType}</span>}
                                </div>
                                {res.description && (
                                  <div className="mcp-resource-desc">{res.description}</div>
                                )}
                                {content && (
                                  <pre className="mcp-resource-content">
                                    {content.length > 2000 ? content.slice(0, 2000) + t.truncatedSuffix : content}
                                  </pre>
                                )}
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

export type {
  MCPStatus,
  MCPPreset,
  MCPDiagnostic,
  MCPResource,
  MCPListedTool,
} from './mcpPanelTypes'
// Back-compat re-exports: the constants/utilities already live in
// `./mcpPanelTypes`; consumers historically imported them from this module.
// Fast-refresh-affecting non-component exports are intentional here.
/* eslint-disable react-refresh/only-export-components */
export {
  buildStatusConfig,
  CATEGORY_ICONS,
  buildCategoryLabels,
  splitMcpArgsLine,
  formatMcpSpawnLine,
  isFilesystemMcpConfig,
} from './mcpPanelTypes'
/* eslint-enable react-refresh/only-export-components */
