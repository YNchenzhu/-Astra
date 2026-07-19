import React, { useState, useEffect, useCallback } from 'react'
import { Plus, Trash2, Edit3, X, RefreshCw, FolderOpen, Users, ToggleLeft, ToggleRight, Sparkles, FolderSymlink, Sliders, RotateCcw } from 'lucide-react'
import { useMemoryStore } from '../../stores/useMemoryStore'
import { useWorkspaceStore } from '../../stores/useWorkspaceStore'
import { useSettingsStore } from '../../stores/useSettingsStore'
import { useT } from '../../i18n'
import type { MemoryType } from '../../types'
import { getLastRecalledMemories, type MemoryEntryWithSource, type RecalledMemory } from '../../services/memoryAPI'
import { reportUserActionError } from '../../utils/reportUserActionError'
import './MemoryPanel.css'

type MemoryScope = 'session' | 'project' | 'user'
type GroupMode = 'type' | 'scope'

const TYPE_COLORS: Record<MemoryType, string> = {
  user: '#89b4fa',
  feedback: '#f9e2af',
  project: '#a6e3a1',
  reference: '#cba6f7',
}

const SCOPE_COLORS: Record<MemoryScope, string> = {
  session: '#f9e2af',
  project: '#89b4fa',
  user: '#a6e3a1',
}

// ── Recall tuning section ────────────────────────────────────────────────────
//
// Surfaces the 12 recall knobs that live in `electron/memory/recallTuning.ts`
// (plus the two pre-existing hybrid/freshness flags). Every change goes
// through the store's `setRecallTuning` setter, which already clamps to the
// same ranges the main process enforces.
//
// Defaults below are duplicated from `recallTuning.ts` / `memorySlice.ts`
// only so the "恢复默认" button works without an extra IPC round-trip.
// If those defaults change, update both spots.
const RECALL_TUNING_DEFAULTS = {
  memoryHybridRecallEnabled: true,
  memoryFreshnessWeight: 0.5,
  memoryRecallMinScore: 0.30,
  memoryRecallSkipShortQueryChars: 8,
  memoryRecallTopK: 5,
  memoryRecallMaxBytes: 24_000,
  memoryRecallSessionBudgetBytes: 32_000,
  workspaceContextEnabled: true,
  workspaceContextTopK: 6,
  workspaceContextMinScore: 0.30,
  attachmentContextTopK: 6,
  attachmentContextMinScore: 0.30,
} as const

type RecallTuningPatch = Partial<{
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
}>

interface RecallTuningSectionProps {
  memoryHybridRecallEnabled: boolean
  memoryFreshnessWeight: number
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
  setMemoryHybridRecallEnabled: (v: boolean) => void
  setMemoryFreshnessWeight: (v: number) => void
  setRecallTuning: (patch: RecallTuningPatch) => void
}

interface KnobRowProps {
  label: string
  hint?: string
  value: number
  min: number
  max: number
  step: number
  suffix?: string
  // Lets callers convert between display units (KB) and stored units (bytes).
  display?: (v: number) => number
  parse?: (v: number) => number
  disabled?: boolean
  onChange: (v: number) => void
}

const KnobRow: React.FC<KnobRowProps> = ({
  label, hint, value, min, max, step, suffix,
  display, parse, disabled, onChange,
}) => {
  const shown = display ? display(value) : value
  const handle = (raw: number) => {
    if (!Number.isFinite(raw)) return
    onChange(parse ? parse(raw) : raw)
  }
  return (
    <div className={`memory-tuning-row${disabled ? ' disabled' : ''}`}>
      <label className="memory-tuning-label">
        <span>{label}</span>
        {hint && <span className="memory-tuning-sublabel">{hint}</span>}
      </label>
      <div className="memory-tuning-control">
        <input
          type="range"
          min={min} max={max} step={step}
          value={shown}
          disabled={disabled}
          onChange={(e) => handle(Number(e.target.value))}
        />
        <input
          type="number"
          className="memory-tuning-number"
          min={min} max={max} step={step}
          value={shown}
          disabled={disabled}
          onChange={(e) => handle(Number(e.target.value))}
        />
        {suffix && <span className="memory-tuning-suffix">{suffix}</span>}
      </div>
    </div>
  )
}

const RecallTuningSection: React.FC<RecallTuningSectionProps> = (p) => {
  const t = useT().settings.memory
  const handleReset = () => {
    p.setMemoryHybridRecallEnabled(RECALL_TUNING_DEFAULTS.memoryHybridRecallEnabled)
    p.setMemoryFreshnessWeight(RECALL_TUNING_DEFAULTS.memoryFreshnessWeight)
    p.setRecallTuning({
      memoryRecallMinScore: RECALL_TUNING_DEFAULTS.memoryRecallMinScore,
      memoryRecallSkipShortQueryChars: RECALL_TUNING_DEFAULTS.memoryRecallSkipShortQueryChars,
      memoryRecallTopK: RECALL_TUNING_DEFAULTS.memoryRecallTopK,
      memoryRecallMaxBytes: RECALL_TUNING_DEFAULTS.memoryRecallMaxBytes,
      memoryRecallSessionBudgetBytes: RECALL_TUNING_DEFAULTS.memoryRecallSessionBudgetBytes,
      workspaceContextEnabled: RECALL_TUNING_DEFAULTS.workspaceContextEnabled,
      workspaceContextTopK: RECALL_TUNING_DEFAULTS.workspaceContextTopK,
      workspaceContextMinScore: RECALL_TUNING_DEFAULTS.workspaceContextMinScore,
      attachmentContextTopK: RECALL_TUNING_DEFAULTS.attachmentContextTopK,
      attachmentContextMinScore: RECALL_TUNING_DEFAULTS.attachmentContextMinScore,
    })
  }

  // Bytes ↔ KB helpers (UI shows KB, store keeps bytes).
  const toKB = (b: number) => Math.round(b / 1000)
  const fromKB = (kb: number) => Math.max(0, Math.round(kb)) * 1000

  return (
    <div className="memory-settings-section">
      <div className="memory-settings-title memory-tuning-title">
        <span className="memory-tuning-title-text">
          <Sliders size={14} />
          {t.tuningTitle}
        </span>
        <button
          type="button"
          className="memory-tuning-reset-btn"
          onClick={handleReset}
          title={t.tuningResetTitle}
        >
          <RotateCcw size={12} /> {t.tuningReset}
        </button>
      </div>
      <p className="memory-settings-hint">
        {t.tuningHint}
      </p>

      <div className="memory-tuning-subhead">{t.subheadTrigger}</div>
      <label className="memory-tuning-toggle-row">
        <input
          type="checkbox"
          checked={p.memoryHybridRecallEnabled}
          onChange={(e) => p.setMemoryHybridRecallEnabled(e.target.checked)}
        />
        <span>
          {t.hybridEnable}
          <span className="memory-tuning-sublabel" style={{ marginLeft: 6 }}>
            {t.hybridEnableHint}
          </span>
        </span>
      </label>
      <div className="memory-tuning-grid">
        <KnobRow
          label={t.knobSkipShort}
          hint={t.knobSkipShortHint}
          value={p.memoryRecallSkipShortQueryChars}
          min={0} max={50} step={1} suffix={t.unitChars}
          onChange={(v) => p.setRecallTuning({ memoryRecallSkipShortQueryChars: v })}
        />
        <KnobRow
          label={t.knobFreshness}
          hint={t.knobFreshnessHint}
          value={p.memoryFreshnessWeight}
          min={0} max={1} step={0.05}
          onChange={(v) => p.setMemoryFreshnessWeight(v)}
          disabled={!p.memoryHybridRecallEnabled}
        />
      </div>

      <div className="memory-tuning-subhead">{t.subheadMemoryRecall}</div>
      <div className="memory-tuning-grid">
        <KnobRow
          label={t.knobMinScore}
          hint={t.knobMinScoreHintMem}
          value={p.memoryRecallMinScore}
          min={0} max={1} step={0.01}
          onChange={(v) => p.setRecallTuning({ memoryRecallMinScore: v })}
        />
        <KnobRow
          label={t.knobTopK}
          hint={t.knobTopKHintMem}
          value={p.memoryRecallTopK}
          min={1} max={20} step={1} suffix={t.unitItems}
          onChange={(v) => p.setRecallTuning({ memoryRecallTopK: v })}
        />
        <KnobRow
          label={t.knobMaxBytes}
          hint={t.knobMaxBytesHint}
          value={p.memoryRecallMaxBytes}
          min={1} max={200} step={1} suffix="KB"
          display={toKB} parse={fromKB}
          onChange={(v) => p.setRecallTuning({ memoryRecallMaxBytes: v })}
        />
        <KnobRow
          label={t.knobSessionBudget}
          hint={t.knobSessionBudgetHint}
          value={p.memoryRecallSessionBudgetBytes}
          min={1} max={1000} step={1} suffix="KB"
          display={toKB} parse={fromKB}
          onChange={(v) => p.setRecallTuning({ memoryRecallSessionBudgetBytes: v })}
        />
      </div>

      <div className="memory-tuning-subhead">{t.subheadWorkspace}</div>
      <label className="memory-tuning-toggle-row">
        <input
          type="checkbox"
          checked={p.workspaceContextEnabled}
          onChange={(e) => p.setRecallTuning({ workspaceContextEnabled: e.target.checked })}
        />
        <span>{t.workspaceEnable}</span>
      </label>
      <div className="memory-tuning-grid">
        <KnobRow
          label={t.knobTopK}
          hint={t.knobTopKHintWs}
          value={p.workspaceContextTopK}
          min={1} max={20} step={1} suffix={t.unitItems}
          disabled={!p.workspaceContextEnabled}
          onChange={(v) => p.setRecallTuning({ workspaceContextTopK: v })}
        />
        <KnobRow
          label={t.knobMinScore}
          hint={t.knobMinScoreHintWs}
          value={p.workspaceContextMinScore}
          min={0} max={1} step={0.01}
          disabled={!p.workspaceContextEnabled}
          onChange={(v) => p.setRecallTuning({ workspaceContextMinScore: v })}
        />
      </div>

      <div className="memory-tuning-subhead">{t.subheadAttachment}</div>
      <div className="memory-tuning-grid">
        <KnobRow
          label={t.knobTopK}
          hint={t.knobTopKHintAtt}
          value={p.attachmentContextTopK}
          min={1} max={20} step={1} suffix={t.unitItems}
          onChange={(v) => p.setRecallTuning({ attachmentContextTopK: v })}
        />
        <KnobRow
          label={t.knobMinScore}
          hint={t.knobMinScoreHintAtt}
          value={p.attachmentContextMinScore}
          min={0} max={1} step={0.01}
          onChange={(v) => p.setRecallTuning({ attachmentContextMinScore: v })}
        />
      </div>
    </div>
  )
}

export const MemoryPanel: React.FC = () => {
  const t = useT().settings.memory
  const TYPE_LABELS: Record<MemoryType, string> = {
    user: t.typeUser,
    feedback: t.typeFeedback,
    project: t.typeProject,
    reference: t.typeReference,
  }
  const SCOPE_LABELS: Record<MemoryScope, string> = {
    session: t.scopeSession,
    project: t.scopeProject,
    user: t.scopeUser,
  }
  const {
    memories,
    isLoading,
    lastSyncResult,
    loadMemories,
    createMemory,
    updateMemory,
    toggleEnabled,
    deleteMemory,
    deleteMemories,
    setWorkspace,
    teamSync,
  } = useMemoryStore()
  const { rootPath } = useWorkspaceStore()
  const autoMemoryEnabled = useSettingsStore((s) => s.autoMemoryEnabled)
  const autoMemoryDirectory = useSettingsStore((s) => s.autoMemoryDirectory)
  const memoryAiRecallEnabled = useSettingsStore((s) => s.memoryAiRecallEnabled)
  const agentExperienceMemoryEnabled = useSettingsStore(
    (s) => s.agentExperienceMemoryEnabled,
  )
  const setAutoMemoryEnabled = useSettingsStore((s) => s.setAutoMemoryEnabled)
  const setAutoMemoryDirectory = useSettingsStore((s) => s.setAutoMemoryDirectory)
  const setMemoryAiRecallEnabled = useSettingsStore((s) => s.setMemoryAiRecallEnabled)
  const setAgentExperienceMemoryEnabled = useSettingsStore(
    (s) => s.setAgentExperienceMemoryEnabled,
  )
  // ── Recall tuning (mirrors electron/memory/recallTuning.ts) ──
  // Each selector pulls a single scalar so the panel only re-renders when
  // its specific knob actually changes (Zustand's default shallow check).
  const memoryHybridRecallEnabled = useSettingsStore((s) => s.memoryHybridRecallEnabled)
  const memoryFreshnessWeight = useSettingsStore((s) => s.memoryFreshnessWeight)
  const memoryRecallMinScore = useSettingsStore((s) => s.memoryRecallMinScore)
  const memoryRecallSkipShortQueryChars = useSettingsStore(
    (s) => s.memoryRecallSkipShortQueryChars,
  )
  const memoryRecallTopK = useSettingsStore((s) => s.memoryRecallTopK)
  const memoryRecallMaxBytes = useSettingsStore((s) => s.memoryRecallMaxBytes)
  const memoryRecallSessionBudgetBytes = useSettingsStore(
    (s) => s.memoryRecallSessionBudgetBytes,
  )
  const workspaceContextEnabled = useSettingsStore((s) => s.workspaceContextEnabled)
  const workspaceContextTopK = useSettingsStore((s) => s.workspaceContextTopK)
  const workspaceContextMinScore = useSettingsStore((s) => s.workspaceContextMinScore)
  const attachmentContextTopK = useSettingsStore((s) => s.attachmentContextTopK)
  const attachmentContextMinScore = useSettingsStore((s) => s.attachmentContextMinScore)
  const setMemoryHybridRecallEnabled = useSettingsStore(
    (s) => s.setMemoryHybridRecallEnabled,
  )
  const setMemoryFreshnessWeight = useSettingsStore((s) => s.setMemoryFreshnessWeight)
  const setRecallTuning = useSettingsStore((s) => s.setRecallTuning)
  const [recallSnapshot, setRecallSnapshot] = useState<RecalledMemory[]>([])
  const [recallLoading, setRecallLoading] = useState(false)
  const [showForm, setShowForm] = useState(false)
  const [editingFilename, setEditingFilename] = useState<string | null>(null)
  const [isSyncing, setIsSyncing] = useState(false)
  const [syncMessage, setSyncMessage] = useState<string>('')
  const [groupMode, setGroupMode] = useState<GroupMode>('type')
  const [formData, setFormData] = useState({
    name: '',
    description: '',
    type: 'user' as MemoryType,
    scope: 'project' as MemoryScope,
    content: '',
  })
  const [expandedMem, setExpandedMem] = useState<string | null>(null)
  const [selectedMemories, setSelectedMemories] = useState<Set<string>>(new Set())

  useEffect(() => {
    loadMemories()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (rootPath) {
      setWorkspace(rootPath)
    }
  }, [rootPath]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!lastSyncResult || !lastSyncResult.teamDir) return
    setSyncMessage(t.teamSyncDone(lastSyncResult.exported, lastSyncResult.imported))
  }, [lastSyncResult, t])

  const handleAdd = () => {
    setEditingFilename(null)
    setFormData({ name: '', description: '', type: 'user', scope: 'project', content: '' })
    setShowForm(true)
  }

  const handleEdit = (mem: MemoryEntryWithSource) => {
    if (mem.sourcePath) return

    setEditingFilename(mem.filename)
    setFormData({
      name: mem.name,
      description: mem.description,
      type: mem.type,
      scope: mem.scope || 'project',
      content: mem.content,
    })
    setShowForm(true)
  }

  const handleSave = async () => {
    if (!formData.name.trim() || !formData.content.trim()) return

    // The service layer THROWS on lock contention (audit M8) and on
    // name-collision (createMemory). Without a catch here the rejection
    // surfaced as an unhandled promise + a silently stuck form. Report it and
    // keep the form open so the user can adjust and retry rather than losing
    // their input.
    try {
      if (editingFilename) {
        await updateMemory(editingFilename, {
          name: formData.name,
          description: formData.description,
          type: formData.type,
          content: formData.content,
          scope: formData.scope,
        })
      } else {
        await createMemory(formData.name, formData.description, formData.type, formData.content, formData.scope)
      }
    } catch (error) {
      reportUserActionError(editingFilename ? t.updateAction : t.createAction, error)
      return
    }
    setShowForm(false)
    setEditingFilename(null)
    setFormData({ name: '', description: '', type: 'user', scope: 'project', content: '' })
  }

  const handleDelete = useCallback(async (mem: MemoryEntryWithSource) => {
    if (mem.sourcePath) return

    if (confirm(t.confirmDelete)) {
      await deleteMemory(mem.filename)
      if (expandedMem === mem.filename) {
        setExpandedMem(null)
      }
    }
  }, [deleteMemory, expandedMem, t])

  const handleToggle = useCallback(async (mem: MemoryEntryWithSource) => {
    if (mem.sourcePath) return
    await toggleEnabled(mem.filename, !mem.enabled)
  }, [toggleEnabled])

  const handleSelectMemory = (filename: string) => {
    const newSelected = new Set(selectedMemories)
    if (newSelected.has(filename)) {
      newSelected.delete(filename)
    } else {
      newSelected.add(filename)
    }
    setSelectedMemories(newSelected)
  }

  const handleSelectAll = () => {
    if (selectedMemories.size === memories.filter(m => !m.sourcePath).length) {
      setSelectedMemories(new Set())
    } else {
      const allDeletable = memories.filter(m => !m.sourcePath).map(m => m.filename)
      setSelectedMemories(new Set(allDeletable))
    }
  }

  const handleBatchDelete = async () => {
    if (selectedMemories.size === 0) return
    if (!confirm(t.confirmBatchDelete(selectedMemories.size))) return

    await deleteMemories(Array.from(selectedMemories))
    setSelectedMemories(new Set())
    setExpandedMem(null)
  }

  const handleRefresh = async () => {
    await loadMemories()
  }

  const pickAutoMemoryDir = useCallback(async () => {
    const api = window.electronAPI?.fs?.openDialog
    if (!api) return
    const res = await api({
      title: t.pickMirrorDialog,
      properties: ['openDirectory'],
    })
    if (res.success && !res.canceled && res.paths[0]) {
      setAutoMemoryDirectory(res.paths[0])
    }
  }, [setAutoMemoryDirectory, t])

  const refreshRecallSnapshot = useCallback(async () => {
    setRecallLoading(true)
    try {
      const rows = await getLastRecalledMemories()
      setRecallSnapshot(rows)
    } finally {
      setRecallLoading(false)
    }
  }, [])

  const handleTeamSync = async () => {
    if (!rootPath || isSyncing) return
    setIsSyncing(true)
    setSyncMessage('')
    try {
      const result = await teamSync()
      if (!result.teamDir) {
        setSyncMessage(t.noActiveWorkspace)
      } else if (result.blockedSecrets && result.blockedSecrets.length > 0) {
        // Secret guard intercepted one or more files — surface so the user
        // can fix the source memory before retrying. We list filenames
        // (not the actual matched values) to avoid leaking the secret into
        // the UI / logs.
        const names = result.blockedSecrets.map((b) => b.filename).join('、')
        setSyncMessage(
          t.blockedSecrets(result.blockedSecrets.length, names),
        )
      }
    } catch {
      setSyncMessage(t.teamSyncFailed)
    } finally {
      setIsSyncing(false)
    }
  }

  const getScope = (mem: MemoryEntryWithSource): MemoryScope => {
    return mem.scope || 'project'
  }

  const groupedByType = memories.reduce<Record<string, MemoryEntryWithSource[]>>((acc, m) => {
    if (!acc[m.type]) acc[m.type] = []
    acc[m.type].push(m)
    return acc
  }, {})

  const groupedByScope = memories.reduce<Record<string, MemoryEntryWithSource[]>>((acc, m) => {
    const scope = getScope(m)
    if (!acc[scope]) acc[scope] = []
    acc[scope].push(m)
    return acc
  }, {})

  const renderMemoryItem = (mem: MemoryEntryWithSource) => {
    const scope = getScope(mem)
    const isSelected = selectedMemories.has(mem.filename)
    const isDeletable = !mem.sourcePath

    return (
      <div
        key={`${mem.filename}:${mem.sourcePath || 'local'}`}
        className={`memory-item ${mem.isStale ? 'stale' : ''} ${!mem.enabled ? 'disabled' : ''} ${expandedMem === mem.filename ? 'expanded' : ''} ${isSelected ? 'selected' : ''}`}
      >
        <div className="memory-item-wrapper">
          <div className="memory-item-checkbox">
            <input
              type="checkbox"
              checked={isSelected}
              disabled={!isDeletable}
              onChange={() => handleSelectMemory(mem.filename)}
              title={isDeletable ? t.selectThis : t.externalNoDelete}
            />
          </div>
          <div
            className="memory-item-main"
            onClick={() => setExpandedMem(expandedMem === mem.filename ? null : mem.filename)}
          >
            <div className="memory-item-info">
              <div className="memory-item-name">{mem.name}</div>
              {mem.description && (
                <div className="memory-item-desc">{mem.description}</div>
              )}
            </div>
            <div className="memory-item-meta">
              <span
                className="memory-scope-tag"
                style={{ background: `${SCOPE_COLORS[scope]}18`, color: SCOPE_COLORS[scope] }}
              >
                {SCOPE_LABELS[scope]}
              </span>
              {mem.sourcePath && <span className="memory-source-badge">{t.badgeExternal}</span>}
              {mem.isStale && <span className="memory-stale-badge">{t.badgeStale}</span>}
              {!mem.enabled && <span className="memory-disabled-badge">{t.badgeDisabled}</span>}
              <span className="memory-item-age">{t.ageDays(mem.ageDays)}</span>
            </div>
          </div>
        </div>
        <div className="memory-item-actions">
          <button
            className="memory-btn memory-toggle-btn"
            onClick={(e) => { e.stopPropagation(); void handleToggle(mem) }}
            title={mem.enabled ? t.disableThis : t.enableThis}
            disabled={Boolean(mem.sourcePath)}
          >
            {mem.enabled ? <ToggleRight size={16} className="toggle-on" /> : <ToggleLeft size={16} className="toggle-off" />}
          </button>
          <button className="memory-btn" onClick={(e) => { e.stopPropagation(); handleEdit(mem) }} title={mem.sourcePath ? t.externalReadonly : t.edit} disabled={Boolean(mem.sourcePath)}>
            <Edit3 size={13} />
          </button>
          <button className="memory-btn memory-delete" onClick={(e) => { e.stopPropagation(); void handleDelete(mem) }} title={mem.sourcePath ? t.externalReadonly : t.delete} disabled={Boolean(mem.sourcePath)}>
            <Trash2 size={13} />
          </button>
        </div>
        {expandedMem === mem.filename && (
          <div className="memory-item-content">
            {mem.sourcePath && <div className="memory-source-path">{t.sourceLabel(mem.sourcePath)}</div>}
            <pre>{mem.content}</pre>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="memory-panel">
      <div className="memory-settings-section">
        <div className="memory-settings-title">
          <Sparkles size={14} />
          {t.autoTitle}
        </div>
        <p className="memory-settings-hint">
          {t.autoHint}
        </p>
        <label className="memory-settings-row">
          <input
            type="checkbox"
            checked={autoMemoryEnabled}
            onChange={(e) => setAutoMemoryEnabled(e.target.checked)}
          />
          <span>{t.autoEnable}</span>
        </label>
        <label className="memory-settings-row">
          <input
            type="checkbox"
            checked={memoryAiRecallEnabled}
            disabled={!autoMemoryEnabled}
            onChange={(e) => setMemoryAiRecallEnabled(e.target.checked)}
          />
          <span>{t.aiRecall}</span>
        </label>
        <label className="memory-settings-row">
          <input
            type="checkbox"
            checked={agentExperienceMemoryEnabled}
            onChange={(e) => setAgentExperienceMemoryEnabled(e.target.checked)}
          />
          <span>
            {t.agentExperience}
            <span
              style={{
                fontSize: 10.5,
                color: 'var(--text-muted)',
                marginLeft: 8,
                fontStyle: 'italic',
              }}
            >
              {t.agentExperienceHint}
            </span>
          </span>
        </label>
        <div className="memory-settings-row memory-settings-dir-row">
          <label className="memory-settings-dir-label" htmlFor="auto-memory-dir">
            {t.mirrorDir}
          </label>
          <div className="memory-settings-dir-inputs">
            <input
              id="auto-memory-dir"
              type="text"
              className="memory-settings-input"
              value={autoMemoryDirectory}
              onChange={(e) => setAutoMemoryDirectory(e.target.value)}
              placeholder={t.mirrorPlaceholder}
            />
            <button
              type="button"
              className="memory-action-btn"
              onClick={() => void pickAutoMemoryDir()}
              title={t.pickFolder}
            >
              <FolderSymlink size={14} />
            </button>
          </div>
        </div>
      </div>

      <RecallTuningSection
        memoryHybridRecallEnabled={memoryHybridRecallEnabled}
        memoryFreshnessWeight={memoryFreshnessWeight}
        memoryRecallMinScore={memoryRecallMinScore}
        memoryRecallSkipShortQueryChars={memoryRecallSkipShortQueryChars}
        memoryRecallTopK={memoryRecallTopK}
        memoryRecallMaxBytes={memoryRecallMaxBytes}
        memoryRecallSessionBudgetBytes={memoryRecallSessionBudgetBytes}
        workspaceContextEnabled={workspaceContextEnabled}
        workspaceContextTopK={workspaceContextTopK}
        workspaceContextMinScore={workspaceContextMinScore}
        attachmentContextTopK={attachmentContextTopK}
        attachmentContextMinScore={attachmentContextMinScore}
        setMemoryHybridRecallEnabled={setMemoryHybridRecallEnabled}
        setMemoryFreshnessWeight={setMemoryFreshnessWeight}
        setRecallTuning={setRecallTuning}
      />

      <div className="memory-settings-section memory-recall-snapshot">
        <div className="memory-settings-title">
          {t.snapshotTitle}
        </div>
        <p className="memory-settings-hint">
          {t.snapshotHint}
        </p>
        <div className="memory-recall-toolbar">
          <button
            type="button"
            className="memory-action-btn"
            onClick={() => void refreshRecallSnapshot()}
            disabled={recallLoading}
          >
            <RefreshCw size={14} className={recallLoading ? 'memory-spin' : ''} />
            {recallLoading ? t.snapshotReading : t.snapshotRefresh}
          </button>
        </div>
        {recallSnapshot.length === 0 ? (
          <p className="memory-settings-hint memory-recall-empty">{t.snapshotEmpty}</p>
        ) : (
          <ul className="memory-recall-list">
            {recallSnapshot.map((r) => (
              <li key={r.filename} className="memory-recall-item">
                <span className="memory-recall-name">{r.name}</span>
                <span className="memory-recall-type">{r.type}</span>
                <span className="memory-recall-snippet">{r.matchSnippet}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="memory-panel-header">
        <div className="memory-panel-actions">
          {selectedMemories.size > 0 && (
            <div className="memory-batch-actions">
              <span className="memory-selected-count">{t.selectedCount(selectedMemories.size)}</span>
              <button
                className="memory-action-btn memory-batch-delete-btn"
                onClick={handleBatchDelete}
                title={t.batchDeleteTitle}
              >
                <Trash2 size={14} /> {t.batchDelete}
              </button>
            </div>
          )}
          <div className="memory-group-toggle">
            <button
              className={`memory-group-btn ${groupMode === 'type' ? 'active' : ''}`}
              onClick={() => setGroupMode('type')}
            >
              {t.groupByType}
            </button>
            <button
              className={`memory-group-btn ${groupMode === 'scope' ? 'active' : ''}`}
              onClick={() => setGroupMode('scope')}
            >
              {t.groupByScope}
            </button>
          </div>
          {memories.length > 0 && (
            <button
              type="button"
              className="memory-action-btn memory-action-btn-selectall"
              onClick={handleSelectAll}
              title={selectedMemories.size === memories.filter(m => !m.sourcePath).length ? t.deselectAll : t.selectAll}
            >
              {selectedMemories.size === memories.filter(m => !m.sourcePath).length ? t.deselectAll : t.selectAll}
            </button>
          )}
          <button type="button" className="memory-action-btn memory-action-btn-icon" onClick={handleRefresh} title={t.refresh}>
            <RefreshCw size={14} />
          </button>
          <button
            type="button"
            className="memory-action-btn memory-action-btn-team-sync"
            onClick={handleTeamSync}
            disabled={!rootPath || isSyncing}
          >
            <Users size={14} /> {isSyncing ? t.teamSyncing : t.teamSync}
          </button>
          <button className="memory-action-btn" onClick={handleAdd} disabled={!rootPath}>
            <Plus size={14} /> {t.addMemory}
          </button>
        </div>
      </div>

      {syncMessage && (
        <div className="memory-sync-status">{syncMessage}</div>
      )}

      {!rootPath && (
        <div className="memory-no-workspace">
          <FolderOpen size={16} />
          <span>{t.noWorkspace}</span>
        </div>
      )}

      {showForm && (
        <div className="memory-form-overlay">
          <div className="memory-form">
            <div className="memory-form-header">
              <h4>{editingFilename ? t.editTitle : t.createTitle}</h4>
              <button className="memory-form-close" onClick={() => setShowForm(false)}>
                <X size={16} />
              </button>
            </div>

            <div className="memory-form-group">
              <label>{t.fieldName}</label>
              <input
                type="text"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder={t.namePlaceholder}
              />
            </div>

            <div className="memory-form-group">
              <label>{t.fieldDesc}</label>
              <input
                type="text"
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                placeholder={t.descPlaceholder}
              />
            </div>

            <div className="memory-form-row-inline">
              <div className="memory-form-group memory-form-half">
                <label>{t.fieldType}</label>
                <select
                  value={formData.type}
                  onChange={(e) => setFormData({ ...formData, type: e.target.value as MemoryType })}
                >
                  {(Object.keys(TYPE_LABELS) as MemoryType[]).map((t) => (
                    <option key={t} value={t}>{TYPE_LABELS[t]}</option>
                  ))}
                </select>
              </div>

              <div className="memory-form-group memory-form-half">
                <label>{t.fieldScope}</label>
                <select
                  value={formData.scope}
                  onChange={(e) => setFormData({ ...formData, scope: e.target.value as MemoryScope })}
                >
                  {(Object.keys(SCOPE_LABELS) as MemoryScope[]).map((s) => (
                    <option key={s} value={s}>{SCOPE_LABELS[s]}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="memory-form-group">
              <label>{t.fieldContent}</label>
              <textarea
                value={formData.content}
                onChange={(e) => setFormData({ ...formData, content: e.target.value })}
                placeholder={t.contentPlaceholder}
                rows={6}
              />
            </div>

            <div className="memory-form-actions">
              <button className="memory-form-cancel" onClick={() => setShowForm(false)}>{t.cancel}</button>
              <button className="memory-form-save" onClick={handleSave} disabled={!formData.name.trim() || !formData.content.trim()}>
                {editingFilename ? t.update : t.create}
              </button>
            </div>
          </div>
        </div>
      )}

      {isLoading && memories.length === 0 ? (
        <div className="memory-loading">{t.loading}</div>
      ) : memories.length === 0 ? (
        rootPath ? (
          <div className="memory-empty">
            <p>{t.emptyTitle}</p>
            <p className="memory-empty-hint">{t.emptyHint}</p>
          </div>
        ) : null
      ) : groupMode === 'type' ? (
        <div className="memory-list">
          {(Object.keys(groupedByType) as MemoryType[]).map((type) => (
            <div key={type} className="memory-type-section">
              <div className="memory-type-header">
                <span
                  className="memory-type-badge"
                  style={{ background: `${TYPE_COLORS[type]}22`, color: TYPE_COLORS[type] }}
                >
                  {TYPE_LABELS[type]} ({groupedByType[type].length})
                </span>
              </div>
              <div className="memory-type-items">
                {groupedByType[type].map(renderMemoryItem)}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="memory-list">
          {(Object.keys(groupedByScope) as MemoryScope[]).map((scope) => (
            <div key={scope} className="memory-type-section">
              <div className="memory-type-header">
                <span
                  className="memory-type-badge"
                  style={{ background: `${SCOPE_COLORS[scope]}22`, color: SCOPE_COLORS[scope] }}
                >
                  {SCOPE_LABELS[scope]} ({groupedByScope[scope].length})
                </span>
              </div>
              <div className="memory-type-items">
                {groupedByScope[scope].map(renderMemoryItem)}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
