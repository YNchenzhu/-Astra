import React, { useState, useEffect, useMemo } from 'react'
import { Plus, Trash2, Edit3, X, Sparkles } from 'lucide-react'
import { queueMirrorRendererPrefsToDisk } from '../../services/rendererPrefsSync'
import { ENABLED_PRESETS_KEY, RULE_PRESETS } from '../../utils/rulePresets'
import { useT } from '../../i18n'
import './RulesPanel.css'

interface Rule {
  id: string
  name: string
  description: string
  type: 'user' | 'project'
  content: string
}

export const RulesPanel: React.FC = () => {
  const t = useT().settings.rules
  const [rules, setRules] = useState<Rule[]>([])
  const [editingId, setEditingId] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [formData, setFormData] = useState<Omit<Rule, 'id'>>({
    name: '',
    description: '',
    type: 'user',
    content: '',
  })
  const [enabledPresets, setEnabledPresets] = useState<Set<string>>(new Set())
  const [presetTab, setPresetTab] = useState<'user' | 'project'>('user')

  useEffect(() => {
    const saved = localStorage.getItem('claude-rules')
    if (saved) {
      try {
        // Mount-time rehydrate from localStorage. The rule is meant to
        // discourage using an effect as a derivation engine; this is a
        // true side-effect (disk → state), which is exactly what
        // useEffect exists for.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setRules(JSON.parse(saved))
      } catch (e) {
        console.error('Failed to load rules:', e)
      }
    }
    const enabled = localStorage.getItem(ENABLED_PRESETS_KEY)
    if (enabled) {
      try {
        setEnabledPresets(new Set(JSON.parse(enabled)))
      } catch (e) {
        console.error('Failed to load enabled presets:', e)
      }
    }
  }, [])

  const saveRules = (newRules: Rule[]) => {
    setRules(newRules)
    localStorage.setItem('claude-rules', JSON.stringify(newRules))
    queueMirrorRendererPrefsToDisk()
  }

  const togglePreset = (presetId: string) => {
    setEnabledPresets((prev) => {
      const next = new Set(prev)
      if (next.has(presetId)) {
        next.delete(presetId)
      } else {
        next.add(presetId)
      }
      localStorage.setItem(ENABLED_PRESETS_KEY, JSON.stringify(Array.from(next)))
      queueMirrorRendererPrefsToDisk()
      return next
    })
  }

  const handleAdd = () => {
    setEditingId(null)
    setFormData({ name: '', description: '', type: 'user', content: '' })
    setShowForm(true)
  }

  const handleEdit = (rule: Rule) => {
    setEditingId(rule.id)
    setFormData({
      name: rule.name,
      description: rule.description,
      type: rule.type,
      content: rule.content,
    })
    setShowForm(true)
  }

  const handleSave = () => {
    if (!formData.name.trim() || !formData.content.trim()) {
      alert(t.nameContentRequired)
      return
    }

    let newRules: Rule[]
    if (editingId) {
      newRules = rules.map((r) =>
        r.id === editingId
          ? { ...r, ...formData }
          : r
      )
    } else {
      newRules = [
        ...rules,
        {
          id: `rule-${Date.now()}`,
          ...formData,
        },
      ]
    }

    saveRules(newRules)
    setShowForm(false)
    setFormData({ name: '', description: '', type: 'user', content: '' })
  }

  const handleDelete = (id: string) => {
    if (confirm(t.confirmDelete)) {
      saveRules(rules.filter((r) => r.id !== id))
    }
  }

  const userRules = rules.filter((r) => r.type === 'user')
  const projectRules = rules.filter((r) => r.type === 'project')

  const visiblePresets = useMemo(
    () => RULE_PRESETS.filter((p) => p.type === presetTab),
    [presetTab]
  )
  const enabledCount = useMemo(
    () => RULE_PRESETS.filter((p) => enabledPresets.has(p.id)).length,
    [enabledPresets]
  )

  return (
    <div className="rules-panel">
      <div className="rules-header">
        <h3>{t.title}</h3>
        <button className="rules-add-btn" onClick={handleAdd}>
          <Plus size={16} /> {t.newRule}
        </button>
      </div>

      {/* 预设面板，使用横向 Tab 切换 */}
      <div className="rules-presets">
        <div className="rules-presets-head">
          <div className="rules-presets-title">
            <Sparkles size={14} />
            <span>{t.presets}</span>
            {enabledCount > 0 && (
              <span className="rules-presets-count">{t.enabledCount(enabledCount)}</span>
            )}
          </div>
          <div className="rules-presets-tabs" role="tablist">
            <button
              role="tab"
              aria-selected={presetTab === 'user'}
              className={`rules-presets-tab${presetTab === 'user' ? ' is-active' : ''}`}
              onClick={() => setPresetTab('user')}
            >
              {t.tabUser}
            </button>
            <button
              role="tab"
              aria-selected={presetTab === 'project'}
              className={`rules-presets-tab${presetTab === 'project' ? ' is-active' : ''}`}
              onClick={() => setPresetTab('project')}
            >
              {t.tabProject}
            </button>
          </div>
        </div>

        <div className="rules-presets-list">
          {visiblePresets.map((preset) => {
            const enabled = enabledPresets.has(preset.id)
            return (
              <div
                key={preset.id}
                className={`preset-item${enabled ? ' is-enabled' : ''}`}
              >
                <div className="preset-info">
                  <div className="preset-name">{preset.name}</div>
                  <div className="preset-description">{preset.description}</div>
                </div>
                <button
                  role="switch"
                  aria-checked={enabled}
                  aria-label={t.toggleAria(enabled ? t.disable : t.enable, preset.name)}
                  className={`preset-toggle${enabled ? ' is-on' : ''}`}
                  onClick={() => togglePreset(preset.id)}
                >
                  <span className="preset-toggle-thumb" />
                </button>
              </div>
            )
          })}
        </div>
      </div>

      {showForm && (
        <div className="rules-form">
          <div className="rules-form-header">
            <h4>{editingId ? t.editTitle : t.createTitle}</h4>
            <button className="rules-form-close" onClick={() => setShowForm(false)}>
              <X size={16} />
            </button>
          </div>

          <div className="rules-form-group">
            <label>{t.fieldName}</label>
            <input
              type="text"
              value={formData.name}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              placeholder={t.namePlaceholder}
            />
          </div>

          <div className="rules-form-group">
            <label>{t.fieldDesc}</label>
            <input
              type="text"
              value={formData.description}
              onChange={(e) => setFormData({ ...formData, description: e.target.value })}
              placeholder={t.descPlaceholder}
            />
          </div>

          <div className="rules-form-group">
            <label>{t.fieldType}</label>
            <select
              value={formData.type}
              onChange={(e) => setFormData({ ...formData, type: e.target.value as 'user' | 'project' })}
            >
              <option value="user">{t.typeUser}</option>
              <option value="project">{t.typeProject}</option>
            </select>
          </div>

          <div className="rules-form-group">
            <label>{t.fieldContent}</label>
            <textarea
              value={formData.content}
              onChange={(e) => setFormData({ ...formData, content: e.target.value })}
              placeholder={t.contentPlaceholder}
              rows={6}
            />
          </div>

          <div className="rules-form-actions">
            <button className="rules-form-save" onClick={handleSave}>
              {t.save}
            </button>
            <button className="rules-form-cancel" onClick={() => setShowForm(false)}>
              {t.cancel}
            </button>
          </div>
        </div>
      )}

      <div className="rules-sections">
        {userRules.length > 0 && (
          <div className="rules-section">
            <h4>{t.userRules(userRules.length)}</h4>
            <div className="rules-list">
              {userRules.map((rule) => (
                <div key={rule.id} className="rule-item">
                  <div className="rule-info">
                    <div className="rule-name">{rule.name}</div>
                    {rule.description && <div className="rule-description">{rule.description}</div>}
                  </div>
                  <div className="rule-actions">
                    <button className="rule-btn" onClick={() => handleEdit(rule)} title={t.edit}>
                      <Edit3 size={14} />
                    </button>
                    <button className="rule-btn rule-delete" onClick={() => handleDelete(rule.id)} title={t.delete}>
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {projectRules.length > 0 && (
          <div className="rules-section">
            <h4>{t.projectRules(projectRules.length)}</h4>
            <div className="rules-list">
              {projectRules.map((rule) => (
                <div key={rule.id} className="rule-item">
                  <div className="rule-info">
                    <div className="rule-name">{rule.name}</div>
                    {rule.description && <div className="rule-description">{rule.description}</div>}
                  </div>
                  <div className="rule-actions">
                    <button className="rule-btn" onClick={() => handleEdit(rule)} title={t.edit}>
                      <Edit3 size={14} />
                    </button>
                    <button className="rule-btn rule-delete" onClick={() => handleDelete(rule.id)} title={t.delete}>
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {rules.length === 0 && !showForm && (
          <div className="rules-empty">
            <p>{t.empty}</p>
          </div>
        )}
      </div>
    </div>
  )
}
