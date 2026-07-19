import React from 'react'
import { Bot, X, Edit3, Globe, Folder, HardDrive, FolderPlus } from 'lucide-react'
import { buildModelOptions, buildScopeMeta } from './agentConstants'
import { useT } from '../../../i18n'
import type { useAgentsPanelState } from './useAgentsPanelState'

type PanelState = ReturnType<typeof useAgentsPanelState>

interface AgentFormProps {
  formData: PanelState['formData']
  setFormData: PanelState['setFormData']
  editingId: PanelState['editingId']
  editingDisk: PanelState['editingDisk']
  scopeDirs: PanelState['scopeDirs']
  extraDirs: PanelState['extraDirs']
  resetForm: PanelState['resetForm']
  handleSaveCustom: PanelState['handleSaveCustom']
}

export const AgentForm: React.FC<AgentFormProps> = ({
  formData,
  setFormData,
  editingId,
  editingDisk,
  scopeDirs,
  extraDirs,
  resetForm,
  handleSaveCustom,
}) => {
  const t = useT().settings.agents
  const MODEL_OPTIONS = React.useMemo(() => buildModelOptions(t), [t])
  const SCOPE_META = React.useMemo(() => buildScopeMeta(t), [t])
  return (
    <div className="agent-form-overlay" onClick={resetForm}>
      <div className="agent-form" onClick={(e) => e.stopPropagation()}>
        <div className="agent-form-header">
          <h4>
            <Bot size={16} />
            {editingId || editingDisk ? t.formEditTitle : t.formCreateTitle}
          </h4>
          <button className="agent-form-close" onClick={resetForm}>
            <X size={18} />
          </button>
        </div>

        <div className="agent-form-scroll">
          <div className="agent-form-group">
            <label>{t.fieldTypeName} <span className="agent-form-required">*</span></label>
            <input
              type="text"
              value={formData.name}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              placeholder={t.typeNamePlaceholder}
            />
            <span className="agent-form-hint">{t.typeNameHint}</span>
          </div>

          <div className="agent-form-group">
            <label>{t.fieldCapability} <span className="agent-form-required">*</span></label>
            <textarea
              value={formData.capability}
              onChange={(e) => setFormData({ ...formData, capability: e.target.value })}
              placeholder={t.capabilityPlaceholder}
              rows={2}
            />
            <span className="agent-form-hint">
              {t.capabilityHintPre}
              <code>{t.capabilityHintTemplate}</code>
            </span>
          </div>

          <div className="agent-form-group">
            <label>{t.fieldWhenToUse} <span className="agent-form-required">*</span></label>
            <textarea
              value={formData.description}
              onChange={(e) => setFormData({ ...formData, description: e.target.value })}
              placeholder={t.whenToUsePlaceholder}
              rows={2}
            />
            <span className="agent-form-hint">{t.whenToUseHint}</span>
          </div>

          <div className="agent-form-row">
            <div className="agent-form-group">
              <label>{t.fieldTools}</label>
              <input
                type="text"
                value={formData.tools}
                onChange={(e) => setFormData({ ...formData, tools: e.target.value })}
                placeholder="read_file, grep, glob, bash"
              />
            </div>
            <div className="agent-form-group">
              <label>{t.fieldDisallowed}</label>
              <input
                type="text"
                value={formData.disallowedTools}
                onChange={(e) => setFormData({ ...formData, disallowedTools: e.target.value })}
                placeholder="write_file, edit_file"
              />
            </div>
          </div>

          <div className="agent-form-group">
            <label>{t.fieldModel}</label>
            <select
              value={formData.model}
              onChange={(e) => setFormData({ ...formData, model: e.target.value })}
            >
              {MODEL_OPTIONS.map((m) => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
            <span className="agent-form-hint">{t.modelHint}</span>
          </div>

          <div className="agent-form-row">
            <div className="agent-form-group">
              <label>{t.fieldMaxTurns}</label>
              <input
                type="text"
                inputMode="numeric"
                value={formData.maxTurns}
                onChange={(e) => setFormData({ ...formData, maxTurns: e.target.value })}
                placeholder={t.emptyDefault}
              />
              <span className="agent-form-hint">{t.maxTurnsHint}</span>
            </div>
            <div className="agent-form-group">
              <label>{t.fieldTimeout}</label>
              <input
                type="text"
                inputMode="numeric"
                value={formData.timeout}
                onChange={(e) => setFormData({ ...formData, timeout: e.target.value })}
                placeholder={t.emptyDefault}
              />
              <span className="agent-form-hint">{t.timeoutHint}</span>
            </div>
            <div className="agent-form-group">
              <label>{t.fieldThinking}</label>
              <input
                type="text"
                inputMode="numeric"
                value={formData.thinkingBudgetTokens}
                onChange={(e) => setFormData({ ...formData, thinkingBudgetTokens: e.target.value })}
                placeholder={t.emptyInherit}
              />
              <span className="agent-form-hint">{t.thinkingHint}</span>
            </div>
          </div>

          <div className="agent-form-group">
            <label>{t.fieldPrompt} <span className="agent-form-required">*</span></label>
            <textarea
              value={formData.prompt}
              onChange={(e) => setFormData({ ...formData, prompt: e.target.value })}
              placeholder={t.promptPlaceholder}
              rows={8}
              className="agent-form-prompt"
            />
            <span className="agent-form-hint">{t.promptHint}</span>
          </div>

          {editingDisk && (
            <div className="agent-form-group">
              <div className="agent-form-edit-target">
                <Edit3 size={12} />
                <span>{t.editingFilePre}<code>{editingDisk.sourcePath}</code></span>
              </div>
              <span className="agent-form-hint">
                {t.editingFileHint}
              </span>
            </div>
          )}

          {!editingId && !editingDisk && (
            <div className="agent-form-group">
              <label>{t.saveTo}</label>
              <div className="agent-form-scope-options">
                <label className="agent-form-scope-option">
                  <input
                    type="radio"
                    name="saveTo"
                    checked={formData.saveTo === 'localStorage'}
                    onChange={() => setFormData({ ...formData, saveTo: 'localStorage' })}
                  />
                  <div>
                    <div className="agent-form-scope-title">
                      <Edit3 size={12} /> UI / localStorage
                    </div>
                    <div className="agent-form-scope-hint">{t.saveToLocalHint}</div>
                  </div>
                </label>
                <label className="agent-form-scope-option">
                  <input
                    type="radio"
                    name="saveTo"
                    checked={formData.saveTo === 'user-global'}
                    onChange={() => setFormData({ ...formData, saveTo: 'user-global' })}
                  />
                  <div>
                    <div className="agent-form-scope-title" style={{ color: SCOPE_META['user-global'].color }}>
                      <Globe size={12} /> {t.saveToGlobal}
                    </div>
                    <div className="agent-form-scope-hint">
                      <code>{scopeDirs.userGlobal}</code>
                    </div>
                  </div>
                </label>
                <label className={`agent-form-scope-option${!scopeDirs.project ? ' disabled' : ''}`}>
                  <input
                    type="radio"
                    name="saveTo"
                    checked={formData.saveTo === 'project'}
                    disabled={!scopeDirs.project}
                    onChange={() => setFormData({ ...formData, saveTo: 'project' })}
                  />
                  <div>
                    <div className="agent-form-scope-title" style={{ color: SCOPE_META.project.color }}>
                      <Folder size={12} /> {t.saveToProject}
                    </div>
                    <div className="agent-form-scope-hint">
                      {scopeDirs.project ? (
                        <code>{scopeDirs.project}</code>
                      ) : (
                        <span>{t.saveToProjectNoWs}</span>
                      )}
                    </div>
                  </div>
                </label>
                {scopeDirs.userApp && (
                  <label className="agent-form-scope-option">
                    <input
                      type="radio"
                      name="saveTo"
                      checked={formData.saveTo === 'user-app'}
                      onChange={() => setFormData({ ...formData, saveTo: 'user-app' })}
                    />
                    <div>
                      <div className="agent-form-scope-title" style={{ color: SCOPE_META['user-app'].color }}>
                        <HardDrive size={12} /> {t.saveToApp}
                      </div>
                      <div className="agent-form-scope-hint">
                        <code>{scopeDirs.userApp}</code>
                      </div>
                    </div>
                  </label>
                )}
                {extraDirs.length > 0 && (
                  <label className="agent-form-scope-option">
                    <input
                      type="radio"
                      name="saveTo"
                      checked={formData.saveTo === 'extra'}
                      onChange={() => setFormData({ ...formData, saveTo: 'extra' })}
                    />
                    <div style={{ flex: 1 }}>
                      <div className="agent-form-scope-title" style={{ color: SCOPE_META.extra.color }}>
                        <FolderPlus size={12} /> {t.saveToExtra}
                      </div>
                      <select
                        value={formData.saveToExtraIndex}
                        onChange={(e) =>
                          setFormData({
                            ...formData,
                            saveTo: 'extra',
                            saveToExtraIndex: Number(e.target.value),
                          })
                        }
                        disabled={formData.saveTo !== 'extra'}
                        style={{ width: '100%', marginTop: 4 }}
                      >
                        {extraDirs.map((dir, idx) => (
                          <option key={dir} value={idx}>
                            {dir}
                          </option>
                        ))}
                      </select>
                    </div>
                  </label>
                )}
              </div>
              <span className="agent-form-hint">
                {t.saveToHintPre}<code>.md</code>{t.saveToHintSuf}
              </span>
            </div>
          )}
        </div>

        <div className="agent-form-actions">
          <button className="agent-form-btn agent-form-btn-cancel" onClick={resetForm}>{t.cancel}</button>
          <button
            className="agent-form-btn agent-form-btn-primary"
            onClick={() => { void handleSaveCustom() }}
            disabled={
              !formData.name.trim() ||
              !formData.capability.trim() ||
              !formData.description.trim() ||
              !formData.prompt.trim()
            }
          >
            {editingId || editingDisk ? t.update : t.create}
          </button>
        </div>
      </div>
    </div>
  )
}
