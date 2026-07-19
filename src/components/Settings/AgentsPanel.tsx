import React from 'react'
import { Bot, Plus, Trash2, Edit3, X, Search, Copy, Eye, Folder, HardDrive, Globe, FolderPlus, RefreshCw, EyeOff, CheckSquare, Square, ListChecks } from 'lucide-react'
import './AgentsPanel.css'
import type { CustomAgentScopeSetting } from '../../stores/useSettingsStore'
import { ALL_TOOLS, buildBuiltinAgentMeta, buildScopeMeta, buildModelOptions } from './agents/agentConstants'
import { resolveAgentTools } from './agents/agentTools'
import { ChevronDown, ChevronRight } from './agents/icons'
import { useAgentsPanelState } from './agents/useAgentsPanelState'
import { AgentForm } from './agents/AgentForm'
import { PromptViewerModal } from './agents/PromptViewerModal'
import { useT } from '../../i18n'

export const AgentsPanel: React.FC = () => {
  const t = useT().settings.agents
  const BUILTIN_AGENT_META = React.useMemo(() => buildBuiltinAgentMeta(t), [t])
  const SCOPE_META = React.useMemo(() => buildScopeMeta(t), [t])
  const MODEL_OPTIONS = React.useMemo(() => buildModelOptions(t), [t])
  const {
    tab, setTab, search, setSearch, expanded, setExpanded, customAgents, showForm,
    setShowForm, editingId, editingDisk, extraDirs, defaultNewAgentScope,
    setDefaultNewAgentScope, formData, setFormData, copiedId, showPrompt, setShowPrompt,
    diskAgents, scopeDirs, disabledCustomAgents, batchMode, batchSelected, setBatchSelected,
    refreshDiskAgents, filteredBuiltin, filteredCustom, resetForm, handleEditCustom,
    handleEditDiskAgent, handleToggleDisabled, handleSaveCustom, handleDeleteCustom,
    handleDeleteDiskAgent, localSelectionKey, diskSelectionKey, toggleBatchSelection,
    selectAllVisible, enterBatchMode, exitBatchMode, handleBatchHide, handleBatchShow,
    handleBatchDelete, handleAddExtraDir, handleRemoveExtraDir, handleCopyPrompt,
  } = useAgentsPanelState()

  return (
    <div className="agents-panel">
      {/* Tab Bar */}
      <div className="agents-tabs">
        <button
          className={`agents-tab${tab === 'builtin' ? ' active' : ''}`}
          onClick={() => { setTab('builtin'); setSearch('') }}
        >
          <Bot size={14} />
          {t.tabBuiltin}
          <span className="agents-tab-count">{BUILTIN_AGENT_META.length}</span>
        </button>
        <button
          className={`agents-tab${tab === 'custom' ? ' active' : ''}`}
          onClick={() => { setTab('custom'); setSearch('') }}
        >
          <Plus size={14} />
          {t.tabCustom}
          <span className="agents-tab-count">{customAgents.length}</span>
        </button>
      </div>

      {/* Toolbar */}
      <div className="agents-toolbar">
        <div className="agents-search">
          <Search size={14} className="agents-search-icon" />
          <input
            type="text"
            placeholder={tab === 'builtin' ? t.searchBuiltin : t.searchCustom}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {search && (
            <button className="agents-search-clear" onClick={() => setSearch('')}>
              <X size={12} />
            </button>
          )}
        </div>
        {tab === 'custom' && (
          <>
            <button
              className={`agents-toolbar-btn${batchMode ? ' active' : ''}`}
              onClick={() => (batchMode ? exitBatchMode() : enterBatchMode())}
              title={batchMode ? t.exitBatchTitle : t.enterBatchTitle}
            >
              <ListChecks size={14} />
              {batchMode ? t.exitBatch : t.batch}
            </button>
            <button
              className="agents-toolbar-btn"
              onClick={() => { resetForm(); setShowForm(!showForm) }}
              title={t.newAgentTitle}
            >
              <Plus size={14} />
              {t.new}
            </button>
          </>
        )}
      </div>

      {/* Builtin Agents */}
      {tab === 'builtin' && (
        <div className="agents-list">
          {filteredBuiltin.length === 0 ? (
            <div className="agents-empty">
              <Bot size={32} />
              <p>{t.noMatch}</p>
              <p className="agents-empty-hint">{t.tryOtherKeywords}</p>
            </div>
          ) : (
            filteredBuiltin.map((agent) => {
              const Icon = agent.icon
              const isExpanded = expanded === agent.agentType
              const { allowed, disallowed } = resolveAgentTools(agent)

              return (
                <div
                  key={agent.agentType}
                  className={`agent-card${isExpanded ? ' expanded' : ''}`}
                >
                  <div
                    className="agent-card-header"
                    onClick={() => setExpanded(isExpanded ? null : agent.agentType)}
                  >
                    <div className="agent-card-left">
                      <div className="agent-card-icon" style={{ background: `${agent.color}18`, color: agent.color }}>
                        <Icon size={18} />
                      </div>
                      <div className="agent-card-info">
                        <div className="agent-card-name-row">
                          <span className="agent-card-name">{agent.name}</span>
                          <code className="agent-card-type">{agent.agentType}</code>
                          {agent.isReadOnly && (
                            <span className="agent-badge readonly">{t.badgeReadonly}</span>
                          )}
                          {disallowed.length === 0 && (
                            <span className="agent-badge full">{t.badgeAllTools}</span>
                          )}
                        </div>
                        <p className="agent-card-brief">{agent.whenToUse.slice(0, 60)}…</p>
                      </div>
                    </div>
                    <div className="agent-card-chevron">
                      {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    </div>
                  </div>

                  {isExpanded && (
                    <div className="agent-card-body">
                      <p className="agent-card-desc">{agent.whenToUse}</p>

                      <div className="agent-card-tools">
                        <span className="agent-card-tools-label">
                          {t.availableTools(allowed.length, ALL_TOOLS.length)}
                        </span>
                        <div className="agent-tool-tags">
                          {allowed.map((tool) => (
                            <span key={tool} className="agent-tool-tag">{tool}</span>
                          ))}
                        </div>
                      </div>

                      <div className="agent-card-tools">
                        <span className="agent-card-tools-label">
                          {t.disabledToolsCount(disallowed.length, ALL_TOOLS.length)}
                        </span>
                        <div className="agent-tool-tags">
                          {disallowed.map((tool) => (
                            <span key={tool} className="agent-tool-tag disallowed">{tool}</span>
                          ))}
                        </div>
                      </div>

                      <div className="agent-card-footer">
                        <button
                          className="agent-card-footer-btn"
                          onClick={(e) => {
                            e.stopPropagation()
                            setShowPrompt(showPrompt === agent.agentType ? null : agent.agentType)
                          }}
                        >
                          <Eye size={12} />
                          {showPrompt === agent.agentType ? t.hideSystemPrompt : t.viewSystemPrompt}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )
            })
          )}
        </div>
      )}

      {/* Batch action bar — shown above the list when any item is selected.
          Kept visually distinct (sticky top, accent background) so users
          immediately see what action keys are available. */}
      {tab === 'custom' && !showForm && batchMode && (
        <div className="agents-batch-bar">
          <div className="agents-batch-bar-left">
            <span className="agents-batch-bar-count">{t.batchSelected(batchSelected.size)}</span>
            <button className="agents-batch-bar-btn" onClick={selectAllVisible} title={t.selectAllVisibleTitle}>
              {t.selectAll}
            </button>
            <button
              className="agents-batch-bar-btn"
              onClick={() => setBatchSelected(new Set())}
              disabled={batchSelected.size === 0}
            >
              {t.clearSelection}
            </button>
          </div>
          <div className="agents-batch-bar-right">
            <button
              className="agents-batch-bar-btn"
              onClick={() => void handleBatchHide()}
              disabled={batchSelected.size === 0}
              title={t.batchHideTitle}
            >
              <EyeOff size={13} /> {t.hide}
            </button>
            <button
              className="agents-batch-bar-btn"
              onClick={() => void handleBatchShow()}
              disabled={batchSelected.size === 0}
              title={t.batchShowTitle}
            >
              <Eye size={13} /> {t.show}
            </button>
            <button
              className="agents-batch-bar-btn danger"
              onClick={() => void handleBatchDelete()}
              disabled={batchSelected.size === 0}
              title={t.batchDeleteTitle}
            >
              <Trash2 size={13} /> {t.delete}
            </button>
            <button className="agents-batch-bar-btn" onClick={exitBatchMode} title={t.exitBatchTitle}>
              <X size={13} />
            </button>
          </div>
        </div>
      )}

      {/* Custom Agents */}
      {tab === 'custom' && !showForm && (
        <div className="agents-list">
          {/* Disk-backed agents (user-global + user-app + project + extra) */}
          {diskAgents.filter((a) => a.source === 'custom').length > 0 && (
            <div className="agents-scope-section">
              <div className="agents-scope-section-header">
                <span>{t.diskFiles}<code>.md</code></span>
                <button
                  className="agents-scope-refresh"
                  onClick={() => void refreshDiskAgents()}
                  title={t.rescan}
                >
                  <RefreshCw size={12} />
                </button>
              </div>
              {diskAgents
                .filter((a) => {
                  if (a.source !== 'custom') return false
                  if (!search.trim()) return true
                  const q = search.toLowerCase()
                  return (
                    a.agentType.toLowerCase().includes(q) ||
                    (a.whenToUse || '').toLowerCase().includes(q)
                  )
                })
                .map((a) => {
                  const scopeKey = a.sourceScope || 'renderer'
                  const meta = SCOPE_META[scopeKey] || SCOPE_META.renderer
                  const Icon = meta.Icon
                  const isExpanded = expanded === `disk:${a.agentType}:${a.sourcePath || ''}`
                  const isHidden = disabledCustomAgents.has(a.agentType)
                  const selKey = a.sourcePath ? diskSelectionKey(a.sourcePath) : null
                  const isSelected = !!selKey && batchSelected.has(selKey)
                  return (
                    <div
                      key={`disk:${a.agentType}:${a.sourcePath || ''}`}
                      className={`agent-card custom${isExpanded ? ' expanded' : ''}${isHidden ? ' agent-card--hidden' : ''}${isSelected ? ' agent-card--selected' : ''}`}
                    >
                      <div
                        className="agent-card-header"
                        onClick={() => {
                          if (batchMode && selKey) {
                            toggleBatchSelection(selKey)
                            return
                          }
                          setExpanded(isExpanded ? null : `disk:${a.agentType}:${a.sourcePath || ''}`)
                        }}
                      >
                        <div className="agent-card-left">
                          {batchMode && selKey && (
                            <span
                              className="agent-card-check"
                              onClick={(e) => { e.stopPropagation(); toggleBatchSelection(selKey) }}
                              title={isSelected ? t.deselect : t.select}
                            >
                              {isSelected ? <CheckSquare size={16} /> : <Square size={16} />}
                            </span>
                          )}
                          <div className="agent-card-icon" style={{ background: `${meta.color}18`, color: meta.color }}>
                            <Icon size={18} />
                          </div>
                          <div className="agent-card-info">
                            <div className="agent-card-name-row">
                              <span className="agent-card-name">{a.agentType}</span>
                              <span
                                className="agent-badge"
                                style={{
                                  background: `${meta.color}22`,
                                  color: meta.color,
                                  borderColor: `${meta.color}55`,
                                }}
                                title={meta.hint}
                              >
                                {meta.label}
                              </span>
                              {a.model && <code className="agent-card-model">{a.model}</code>}
                              {a.isReadOnly && <span className="agent-badge readonly">{t.badgeReadonly}</span>}
                              {isHidden && (
                                <span
                                  className="agent-badge"
                                  style={{ background: '#ef444422', color: '#ef4444', borderColor: '#ef444455' }}
                                  title={t.hiddenBadgeTitle}
                                >
                                  {t.hiddenFromMain}
                                </span>
                              )}
                            </div>
                            <p className="agent-card-brief">
                              {a.capability ? t.briefCapability(a.capability) : ''}
                              {a.capability && (a.whenToUse || a.sourcePath) ? ' · ' : ''}
                              {a.whenToUse ? t.briefWhenToUse(a.whenToUse) : a.sourcePath || t.noDesc}
                            </p>
                          </div>
                        </div>
                        <div className="agent-card-actions" onClick={(e) => e.stopPropagation()}>
                          <button
                            className={`agent-card-action-btn${isHidden ? ' danger' : ''}`}
                            onClick={() => void handleToggleDisabled(a.agentType)}
                            title={
                              isHidden
                                ? t.toggleHiddenOnTitle
                                : t.toggleHiddenOffTitle
                            }
                          >
                            {isHidden ? <EyeOff size={13} /> : <Eye size={13} />}
                          </button>
                          <button
                            className="agent-card-action-btn"
                            onClick={() => handleEditDiskAgent(a)}
                            title={t.editDiskTitle}
                          >
                            <Edit3 size={13} />
                          </button>
                          {a.sourcePath && (
                            <button
                              className="agent-card-action-btn danger"
                              onClick={() => void handleDeleteDiskAgent(a)}
                              title={t.deleteDiskTitle(a.sourcePath)}
                            >
                              <Trash2 size={13} />
                            </button>
                          )}
                        </div>
                      </div>
                      {isExpanded && (
                        <div className="agent-card-body">
                          <p className="agent-card-desc">{a.whenToUse}</p>
                          {a.sourcePath && (
                            <p className="agent-card-desc" style={{ fontSize: 11, opacity: 0.7 }}>
                              {t.fileLabel}<code>{a.sourcePath}</code>
                            </p>
                          )}
                          {a.tools && a.tools.length > 0 && (
                            <div className="agent-card-tools">
                              <span className="agent-card-tools-label">{t.availableToolsLabel}</span>
                              <div className="agent-tool-tags">
                                {a.tools.map((tool) => (
                                  <span key={tool} className="agent-tool-tag">{tool}</span>
                                ))}
                              </div>
                            </div>
                          )}
                          {a.disallowedTools && a.disallowedTools.length > 0 && (
                            <div className="agent-card-tools">
                              <span className="agent-card-tools-label">{t.disabledToolsLabel}</span>
                              <div className="agent-tool-tags">
                                {a.disallowedTools.map((tool) => (
                                  <span key={tool} className="agent-tool-tag disallowed">{tool}</span>
                                ))}
                              </div>
                            </div>
                          )}
                          <div className="agent-card-footer">
                            <button
                              className="agent-card-footer-btn"
                              onClick={() =>
                                setShowPrompt(
                                  showPrompt === `disk:${a.agentType}` ? null : `disk:${a.agentType}`,
                                )
                              }
                            >
                              <Eye size={12} />
                              {showPrompt === `disk:${a.agentType}` ? t.hidePrompt : t.viewPrompt}
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })}
            </div>
          )}

          {filteredCustom.length === 0 && diskAgents.filter((a) => a.source === 'custom').length === 0 ? (
            <div className="agents-empty">
              <Bot size={32} />
              <p>{t.emptyCustom}</p>
              <p className="agents-empty-hint">
                {t.emptyCustomHint}
              </p>
              <ul className="agents-empty-paths">
                <li><code>~/.claude/agents/</code>{t.emptyPathGlobal}</li>
                <li><code>{'{workspace}/.claude/agents/'}</code>{t.emptyPathProject}</li>
              </ul>
            </div>
          ) : null}

          {filteredCustom.length > 0 && (
            <div className="agents-scope-section">
              <div className="agents-scope-section-header">
                <span>
                  {t.uiCreated}
                </span>
              </div>
              {filteredCustom.map((agent) => {
              const isExpanded = expanded === agent.id
              const isHidden = disabledCustomAgents.has(agent.name)
              const selKey = localSelectionKey(agent.id)
              const isSelected = batchSelected.has(selKey)
              return (
                <div
                  key={agent.id}
                  className={`agent-card custom${isExpanded ? ' expanded' : ''}${isHidden ? ' agent-card--hidden' : ''}${isSelected ? ' agent-card--selected' : ''}`}
                >
                  <div
                    className="agent-card-header"
                    onClick={() => {
                      if (batchMode) {
                        toggleBatchSelection(selKey)
                        return
                      }
                      setExpanded(isExpanded ? null : agent.id)
                    }}
                  >
                    <div className="agent-card-left">
                      {batchMode && (
                        <span
                          className="agent-card-check"
                          onClick={(e) => { e.stopPropagation(); toggleBatchSelection(selKey) }}
                          title={isSelected ? t.deselect : t.select}
                        >
                          {isSelected ? <CheckSquare size={16} /> : <Square size={16} />}
                        </span>
                      )}
                      <div className="agent-card-icon" style={{ background: '#8b5cf618', color: '#8b5cf6' }}>
                        <Bot size={18} />
                      </div>
                      <div className="agent-card-info">
                        <div className="agent-card-name-row">
                          <span className="agent-card-name">{agent.name}</span>
                          <span className="agent-badge custom-badge">{t.badgeCustom}</span>
                          <code className="agent-card-model">
                            {MODEL_OPTIONS.find((m) => m.value === agent.model)?.label || agent.model}
                          </code>
                          {isHidden && (
                            <span
                              className="agent-badge"
                              style={{ background: '#ef444422', color: '#ef4444', borderColor: '#ef444455' }}
                              title={t.hiddenBadgeTitle}
                            >
                              {t.hiddenFromMain}
                            </span>
                          )}
                        </div>
                        <p className="agent-card-brief">
                          {agent.capability ? t.briefCapability(agent.capability) : ''}
                          {agent.capability && agent.description ? ' · ' : ''}
                          {agent.description ? t.briefWhenToUse(agent.description) : ''}
                        </p>
                      </div>
                    </div>
                    <div className="agent-card-actions" onClick={(e) => e.stopPropagation()}>
                      <button
                        className={`agent-card-action-btn${isHidden ? ' danger' : ''}`}
                        onClick={() => void handleToggleDisabled(agent.name)}
                        title={
                          isHidden
                            ? t.toggleHiddenOnTitle
                            : t.toggleHiddenOffTitle
                        }
                      >
                        {isHidden ? <EyeOff size={13} /> : <Eye size={13} />}
                      </button>
                      <button
                        className="agent-card-action-btn"
                        onClick={() => handleCopyPrompt(agent.prompt, agent.id)}
                        title={t.copyPrompt}
                      >
                        {copiedId === agent.id ? t.copied : <Copy size={13} />}
                      </button>
                      <button
                        className="agent-card-action-btn"
                        onClick={() => handleEditCustom(agent)}
                        title={t.edit}
                      >
                        <Edit3 size={13} />
                      </button>
                      <button
                        className="agent-card-action-btn danger"
                        onClick={() => handleDeleteCustom(agent.id)}
                        title={t.delete}
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>

                  {isExpanded && (
                    <div className="agent-card-body">
                      <p className="agent-card-desc">{agent.description}</p>
                      {agent.tools && agent.tools.length > 0 && (
                        <div className="agent-card-tools">
                          <span className="agent-card-tools-label">{t.availableToolsLabel}</span>
                          <div className="agent-tool-tags">
                            {agent.tools.map((tool) => (
                              <span key={tool} className="agent-tool-tag">{tool}</span>
                            ))}
                          </div>
                        </div>
                      )}
                      {agent.disallowedTools && agent.disallowedTools.length > 0 && (
                        <div className="agent-card-tools">
                          <span className="agent-card-tools-label">{t.disabledToolsLabel}</span>
                          <div className="agent-tool-tags">
                            {agent.disallowedTools.map((tool) => (
                              <span key={tool} className="agent-tool-tag disallowed">{tool}</span>
                            ))}
                          </div>
                        </div>
                      )}
                      {(agent.maxTurns != null || agent.timeout != null || agent.thinkingBudgetTokens != null) && (
                        <p className="agent-card-desc" style={{ fontSize: 12, opacity: 0.85 }}>
                          {agent.maxTurns != null && <span>maxTurns={agent.maxTurns} </span>}
                          {agent.timeout != null && <span>timeout={agent.timeout}ms </span>}
                          {agent.thinkingBudgetTokens != null && (
                            <span>thinking={agent.thinkingBudgetTokens} </span>
                          )}
                        </p>
                      )}
                      <div className="agent-card-footer">
                        <button
                          className="agent-card-footer-btn"
                          onClick={() => setShowPrompt(showPrompt === agent.id ? null : agent.id)}
                        >
                          <Eye size={12} />
                          {showPrompt === agent.id ? t.hidePrompt : t.viewPrompt}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )
              })}
            </div>
          )}

          {/* Extra dirs management — visible on the custom tab even when empty,
              so users discover the "add another location" affordance. */}
          <div className="agents-scope-section">
            <div className="agents-scope-section-header">
              <span>{t.extraDirsTitle}</span>
              <button
                className="agents-toolbar-btn"
                onClick={() => void handleAddExtraDir()}
                title={t.addDirTitle}
              >
                <FolderPlus size={13} />
                {t.addDir}
              </button>
            </div>
            <div className="agents-extra-dirs-list">
              <div className="agents-extra-dir agents-extra-dir--builtin">
                <Globe size={14} style={{ color: SCOPE_META['user-global'].color }} />
                <div className="agents-extra-dir-info">
                  <span className="agents-extra-dir-label">{t.scopeGlobalShort}</span>
                  <code className="agents-extra-dir-path">{scopeDirs.userGlobal}</code>
                </div>
              </div>
              {scopeDirs.userApp && (
                <div className="agents-extra-dir agents-extra-dir--builtin">
                  <HardDrive size={14} style={{ color: SCOPE_META['user-app'].color }} />
                  <div className="agents-extra-dir-info">
                    <span className="agents-extra-dir-label">{t.scopeAppShort}</span>
                    <code className="agents-extra-dir-path">{scopeDirs.userApp}</code>
                  </div>
                </div>
              )}
              {scopeDirs.project && (
                <div className="agents-extra-dir agents-extra-dir--builtin">
                  <Folder size={14} style={{ color: SCOPE_META.project.color }} />
                  <div className="agents-extra-dir-info">
                    <span className="agents-extra-dir-label">{t.scopeProjectShort}</span>
                    <code className="agents-extra-dir-path">{scopeDirs.project}</code>
                  </div>
                </div>
              )}
              {extraDirs.map((dir) => (
                <div key={dir} className="agents-extra-dir">
                  <FolderPlus size={14} style={{ color: SCOPE_META.extra.color }} />
                  <div className="agents-extra-dir-info">
                    <span className="agents-extra-dir-label">{t.scopeExtraShort}</span>
                    <code className="agents-extra-dir-path">{dir}</code>
                  </div>
                  <button
                    className="agents-extra-dir-remove"
                    onClick={() => handleRemoveExtraDir(dir)}
                    title={t.removeDirTitle}
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}
            </div>
            <div className="agents-scope-default">
              <label>{t.defaultSaveTo}</label>
              <select
                value={defaultNewAgentScope}
                onChange={(e) => setDefaultNewAgentScope(e.target.value as CustomAgentScopeSetting)}
              >
                <option value="user-global">{t.optGlobal}</option>
                {scopeDirs.userApp && <option value="user-app">{t.optApp}</option>}
                {scopeDirs.project && <option value="project">{t.optProject}</option>}
                {extraDirs.length > 0 && <option value="extra">{t.optExtra}</option>}
              </select>
            </div>
          </div>
        </div>
      )}

      {/* Create / Edit Form */}
      {tab === 'custom' && showForm && (
        <AgentForm
          formData={formData}
          setFormData={setFormData}
          editingId={editingId}
          editingDisk={editingDisk}
          scopeDirs={scopeDirs}
          extraDirs={extraDirs}
          resetForm={resetForm}
          handleSaveCustom={handleSaveCustom}
        />
      )}

      {/* Prompt Viewer Modal */}
      {showPrompt && (
        <PromptViewerModal
          showPrompt={showPrompt}
          setShowPrompt={setShowPrompt}
          tab={tab}
          customAgents={customAgents}
          copiedId={copiedId}
          handleCopyPrompt={handleCopyPrompt}
        />
      )}
    </div>
  )
}
