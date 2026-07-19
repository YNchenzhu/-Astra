import { useState, useMemo, useEffect, useCallback } from 'react'
import { queueMirrorRendererPrefsToDisk } from '../../../services/rendererPrefsSync'
import { useSettingsStore, type CustomAgentScopeSetting } from '../../../stores/useSettingsStore'
import { buildBuiltinAgentMeta } from './agentConstants'
import { useT } from '../../../i18n'
import type { CustomAgentInfo, DiskAgentInfo, ScopeDirs } from './agentTypes'

function syncToBackend(agents: CustomAgentInfo[]): void {
  window.electronAPI?.agents?.syncCustom?.(agents).catch(() => {})
}

/**
 * All `AgentsPanel` state + handlers. Extracted verbatim from the former
 * inline component body so `AgentsPanel.tsx` is reduced to its render surface.
 */
export function useAgentsPanelState() {
  const t = useT().settings.agents
  const BUILTIN_AGENT_META = useMemo(() => buildBuiltinAgentMeta(t), [t])
  const [tab, setTab] = useState<'builtin' | 'custom'>('builtin')
  const [search, setSearch] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [customAgents, setCustomAgents] = useState<CustomAgentInfo[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('custom-agents') || '[]')
      if (saved.length > 0) syncToBackend(saved)
      return saved
    } catch {
      return []
    }
  })
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  /**
   * When editing a disk-backed agent, remember its original `sourcePath` and
   * `agentType` so we can (1) keep the save destination locked to the same
   * scope (users don't accidentally duplicate a `.md` into another layer)
   * and (2) delete the old file if the user renamed the agent in the form.
   */
  const [editingDisk, setEditingDisk] = useState<
    | null
    | {
        sourcePath: string
        originalAgentType: string
        scope: CustomAgentScopeSetting
        extraDirIndex?: number
      }
  >(null)
  const extraDirs = useSettingsStore((s) => s.customAgentsExtraDirs)
  const defaultNewAgentScope = useSettingsStore((s) => s.defaultNewAgentScope)
  const setCustomAgentsExtraDirs = useSettingsStore((s) => s.setCustomAgentsExtraDirs)
  const setDefaultNewAgentScope = useSettingsStore((s) => s.setDefaultNewAgentScope)
  const [formData, setFormData] = useState({
    name: '',
    /** "功能是..." — required (form validation). */
    capability: '',
    /** "当...的时候调用" — required (form validation). */
    description: '',
    tools: '',
    disallowedTools: '',
    model: 'inherit',
    prompt: '',
    maxTurns: '',
    timeout: '',
    thinkingBudgetTokens: '',
    /** Save destination. 'localStorage' = legacy behavior; others = disk. */
    saveTo: 'localStorage' as 'localStorage' | CustomAgentScopeSetting,
    saveToExtraIndex: 0,
  })
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [showPrompt, setShowPrompt] = useState<string | null>(null)
  const [diskAgents, setDiskAgents] = useState<DiskAgentInfo[]>([])
  const [scopeDirs, setScopeDirs] = useState<ScopeDirs>({
    userGlobal: '',
    userApp: null,
    project: null,
    extra: [],
  })
  /**
   * Set of custom agent types (`agentType` for disk, `name` for localStorage)
   * the user has hidden from the main AI. Mirrors the main-process
   * `settings.disabledCustomAgents` and is refreshed on every `listAll`.
   */
  const [disabledCustomAgents, setDisabledCustomAgents] = useState<Set<string>>(new Set())

  /**
   * Batch-selection mode. When `true`, each custom-agent card renders a
   * checkbox and the toolbar swaps in a batch-action bar (delete / hide /
   * show / cancel). Selection keys are `disk:{sourcePath}` or
   * `local:{id}` so we never confuse the two stores even if they share
   * an agentType. The set is cleared when the user exits batch mode.
   */
  const [batchMode, setBatchMode] = useState(false)
  const [batchSelected, setBatchSelected] = useState<Set<string>>(new Set())

  const refreshDiskAgents = useCallback(async () => {
    try {
      const api = window.electronAPI?.agents
      if (!api?.listAll) return
      const res = await api.listAll()
      if (res?.success) {
        setDiskAgents(res.agents as DiskAgentInfo[])
        setScopeDirs(res.scopeDirs)
        setDisabledCustomAgents(
          new Set(Array.isArray(res.disabledCustomAgents) ? res.disabledCustomAgents : []),
        )
      }
    } catch {
      /* ignore — panel still works with localStorage-only custom agents */
    }
  }, [])

  useEffect(() => {
    // `refreshDiskAgents` is async; state writes happen from the IPC
    // response callback, not synchronously in the effect body — the
    // `set-state-in-effect` rule can't see through the async boundary
    // and would otherwise false-positive on this standard
    // "fetch on mount + subscribe" pattern.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshDiskAgents()
    const unsubscribe = window.electronAPI?.agents?.onChanged?.(() => {
      void refreshDiskAgents()
    })
    return () => {
      try { unsubscribe?.() } catch { /* ignore */ }
    }
  }, [refreshDiskAgents])

  // Push any persisted extra dirs to main on first mount so cold-start
  // chokidar + layered merge include them without waiting for the user to
  // re-open Settings.
  useEffect(() => {
    if (extraDirs.length > 0) {
      window.electronAPI?.agents?.setExtraDirs?.(extraDirs).catch(() => {})
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const filteredBuiltin = useMemo(() => {
    if (!search.trim()) return BUILTIN_AGENT_META
    const q = search.toLowerCase()
    return BUILTIN_AGENT_META.filter(
      (a) =>
        a.agentType.toLowerCase().includes(q) ||
        a.name.includes(q) ||
        a.whenToUse.toLowerCase().includes(q),
    )
  }, [search, BUILTIN_AGENT_META])

  const filteredCustom = useMemo(() => {
    if (!search.trim()) return customAgents
    const q = search.toLowerCase()
    return customAgents.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        a.description.toLowerCase().includes(q),
    )
  }, [search, customAgents])

  const resetForm = () => {
    setShowForm(false)
    setEditingId(null)
    setEditingDisk(null)
    // Default the "save to" dropdown to the user's configured preference
    // rather than always falling back to localStorage — makes first-time
    // disk saves a one-click action for users who set a default scope.
    const defaultSaveTo: 'localStorage' | CustomAgentScopeSetting =
      defaultNewAgentScope || 'localStorage'
    setFormData({
      name: '',
      capability: '',
      description: '',
      tools: '',
      disallowedTools: '',
      model: 'inherit',
      prompt: '',
      maxTurns: '',
      timeout: '',
      thinkingBudgetTokens: '',
      saveTo: defaultSaveTo,
      saveToExtraIndex: 0,
    })
  }

  const handleEditCustom = (agent: CustomAgentInfo) => {
    setEditingId(agent.id)
    setFormData({
      name: agent.name,
      capability: agent.capability || '',
      description: agent.description,
      tools: (agent.tools || []).join(', '),
      disallowedTools: (agent.disallowedTools || []).join(', '),
      model: agent.model,
      prompt: agent.prompt,
      maxTurns: agent.maxTurns != null ? String(agent.maxTurns) : '',
      timeout: agent.timeout != null ? String(agent.timeout) : '',
      thinkingBudgetTokens:
        agent.thinkingBudgetTokens != null ? String(agent.thinkingBudgetTokens) : '',
      // Editing an existing localStorage agent updates in place; scope swap
      // lives behind a separate "转存为..." button (not part of this pass).
      saveTo: 'localStorage',
      saveToExtraIndex: 0,
    })
    setShowForm(true)
  }

  /**
   * Open the create/edit form pre-populated from a disk-backed agent. The
   * save destination is locked to the agent's original scope — editing a
   * project-level `.md` writes back to `{workspace}/.claude/agents/`, never
   * surprise-promotes it to user-global. See {@link handleSaveCustom} for
   * the rename-detection that cleans up the pre-rename file.
   */
  const handleEditDiskAgent = (agent: DiskAgentInfo) => {
    if (!agent.sourcePath || !agent.sourceScope) return
    const scope = agent.sourceScope as CustomAgentScopeSetting
    setEditingId(null)
    setEditingDisk({
      sourcePath: agent.sourcePath,
      originalAgentType: agent.agentType,
      scope,
      extraDirIndex: agent.extraDirIndex,
    })
    setFormData({
      name: agent.agentType,
      capability: agent.capability || '',
      description: agent.whenToUse || '',
      tools: (agent.tools || []).join(', '),
      disallowedTools: (agent.disallowedTools || []).join(', '),
      model: agent.model || 'inherit',
      prompt: agent.prompt || '',
      maxTurns: agent.maxTurns != null ? String(agent.maxTurns) : '',
      timeout: agent.timeout != null ? String(agent.timeout) : '',
      thinkingBudgetTokens:
        agent.thinkingBudgetTokens != null ? String(agent.thinkingBudgetTokens) : '',
      saveTo: scope,
      saveToExtraIndex: agent.extraDirIndex ?? 0,
    })
    setShowForm(true)
  }

  /**
   * Flip the "hidden from main AI" state for a custom agent (disk or
   * localStorage). Optimistically updates the UI set then round-trips to
   * main; on IPC failure we refresh from the server so the UI converges on
   * truth rather than drifting.
   */
  const handleToggleDisabled = async (agentName: string) => {
    const api = window.electronAPI?.agents
    if (!api?.setDisabled) return
    const next = new Set(disabledCustomAgents)
    if (next.has(agentName)) next.delete(agentName)
    else next.add(agentName)
    setDisabledCustomAgents(next)
    try {
      const res = await api.setDisabled([...next])
      if (!res?.success) {
        await refreshDiskAgents()
      }
    } catch {
      await refreshDiskAgents()
    }
  }

  const parseOptInt = (s: string): number | undefined => {
    const t = s.trim()
    if (!t) return undefined
    const n = Number(t)
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined
  }

  const handleSaveCustom = async () => {
    // The three "必填" slots that feed the main-AI prompt template
    // "你有自定义智能体 X，功能是 Y，当 Z 的时候调用". We also require
    // `prompt` since it's what the sub-agent actually executes.
    if (
      !formData.name.trim() ||
      !formData.capability.trim() ||
      !formData.description.trim() ||
      !formData.prompt.trim()
    ) {
      return
    }
    const maxTurns = parseOptInt(formData.maxTurns)
    const timeout = parseOptInt(formData.timeout)
    const thinkingBudgetTokens = parseOptInt(formData.thinkingBudgetTokens)

    if (formData.saveTo === 'localStorage') {
      // Legacy path: renderer-local agent, synced to main via
      // `agents:sync-custom`. Unchanged from pre-scope code.
      const agent: CustomAgentInfo = {
        id: editingId || `custom-${Date.now()}`,
        name: formData.name.trim(),
        capability: formData.capability.trim(),
        description: formData.description.trim(),
        tools: formData.tools ? formData.tools.split(',').map((t) => t.trim()).filter(Boolean) : undefined,
        disallowedTools: formData.disallowedTools ? formData.disallowedTools.split(',').map((t) => t.trim()).filter(Boolean) : undefined,
        model: formData.model,
        prompt: formData.prompt.trim(),
        ...(maxTurns !== undefined ? { maxTurns } : {}),
        ...(timeout !== undefined ? { timeout } : {}),
        ...(thinkingBudgetTokens !== undefined ? { thinkingBudgetTokens } : {}),
      }
      const saved: CustomAgentInfo[] = editingId
        ? customAgents.map((a) => (a.id === editingId ? agent : a))
        : [...customAgents, agent]
      setCustomAgents(saved)
      localStorage.setItem('custom-agents', JSON.stringify(saved))
      queueMirrorRendererPrefsToDisk()
      syncToBackend(saved)
      resetForm()
      return
    }

    // Disk path: write a markdown file into the chosen scope. Main process
    // will re-scan and fire `agents:changed` → refreshDiskAgents picks it up.
    const api = window.electronAPI?.agents
    if (!api?.saveToDisk) {
      // Fallback: if the preload bridge is too old, just store in localStorage
      // so the user doesn't lose the entered data.
      console.warn('[AgentsPanel] saveToDisk IPC unavailable — falling back to localStorage')
      setFormData((prev) => ({ ...prev, saveTo: 'localStorage' }))
      return
    }
    const scope = formData.saveTo
    if (scope === 'project' && !scopeDirs.project) {
      alert(t.noProjectWs)
      return
    }
    if (scope === 'extra' && scopeDirs.extra.length === 0) {
      alert(t.noExtraDir)
      return
    }
    try {
      const res = await api.saveToDisk({
        scope,
        extraDirIndex: scope === 'extra' ? formData.saveToExtraIndex : undefined,
        agent: {
          agentType: formData.name.trim(),
          description: formData.description.trim(),
          capability: formData.capability.trim(),
          prompt: formData.prompt.trim(),
          tools: formData.tools ? formData.tools.split(',').map((t) => t.trim()).filter(Boolean) : undefined,
          disallowedTools: formData.disallowedTools ? formData.disallowedTools.split(',').map((t) => t.trim()).filter(Boolean) : undefined,
          model: formData.model,
          ...(maxTurns !== undefined ? { maxTurns } : {}),
          ...(timeout !== undefined ? { timeout } : {}),
          ...(thinkingBudgetTokens !== undefined ? { thinkingBudgetTokens } : {}),
        },
      })
      if (!res?.success) {
        alert(t.saveFailed(res?.error || t.unknownError))
        return
      }
      // Edit path: the filename is derived from `agentType`, so when the
      // user renames the agent the write above creates a second file
      // instead of replacing the old one. Delete the stale original here
      // (best effort; failure is non-fatal — user can clean up manually).
      if (
        editingDisk &&
        editingDisk.sourcePath &&
        editingDisk.originalAgentType !== formData.name.trim() &&
        res.filePath &&
        res.filePath !== editingDisk.sourcePath &&
        api.deleteFromDisk
      ) {
        try {
          await api.deleteFromDisk(editingDisk.sourcePath)
        } catch (err) {
          console.warn('[AgentsPanel] failed to delete renamed-from file:', err)
        }
      }
      await refreshDiskAgents()
      resetForm()
    } catch (e) {
      alert(t.saveFailed(e instanceof Error ? e.message : String(e)))
    }
  }

  const handleDeleteCustom = (id: string) => {
    // BUG-U4 fix: require confirmation before destroying the localStorage
    // entry. The disk-backed sibling (`handleDeleteDiskAgent`) already
    // confirms; the localStorage path was the only deletion surface
    // without a guard. A misclicked Trash2 icon previously erased the
    // agent's tool whitelist, system prompt, and provider routing
    // permanently with no undo.
    const target = customAgents.find((a) => a.id === id)
    const label = target?.name?.trim() || target?.id || t.defaultAgentLabel
    const confirmed = window.confirm(
      t.confirmDeleteLocal(label),
    )
    if (!confirmed) return
    const saved = customAgents.filter((a) => a.id !== id)
    setCustomAgents(saved)
    localStorage.setItem('custom-agents', JSON.stringify(saved))
    queueMirrorRendererPrefsToDisk()
    syncToBackend(saved)
  }

  const handleDeleteDiskAgent = async (agent: DiskAgentInfo) => {
    if (!agent.sourcePath) return
    const confirmed = window.confirm(t.confirmDeleteDisk(agent.agentType, agent.sourcePath))
    if (!confirmed) return
    const api = window.electronAPI?.agents
    if (!api?.deleteFromDisk) return
    const res = await api.deleteFromDisk(agent.sourcePath)
    if (!res?.success) {
      alert(t.deleteFailed(res?.error || t.unknownError))
      return
    }
    await refreshDiskAgents()
  }

  // ===== Batch operations =====
  //
  // Selection keys are namespaced so disk-backed and localStorage agents
  // with the same agentType never collide:
  //   `disk:{sourcePath}`   for .md files
  //   `local:{id}`          for renderer localStorage rows
  // The batch bar derives its enabled/disabled buttons from the current
  // selection so we don't offer "Hide" when every selected agent is
  // already hidden.

  const localSelectionKey = (id: string) => `local:${id}`
  const diskSelectionKey = (sourcePath: string) => `disk:${sourcePath}`

  /** All agent types in the current batch selection (for hide/show IPC). */
  const selectedAgentTypes = (): string[] => {
    const names: string[] = []
    for (const key of batchSelected) {
      if (key.startsWith('disk:')) {
        const sp = key.slice('disk:'.length)
        const a = diskAgents.find((d) => d.sourcePath === sp)
        if (a) names.push(a.agentType)
      } else if (key.startsWith('local:')) {
        const id = key.slice('local:'.length)
        const a = customAgents.find((c) => c.id === id)
        if (a) names.push(a.name)
      }
    }
    return names
  }

  const toggleBatchSelection = (key: string) => {
    const next = new Set(batchSelected)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    setBatchSelected(next)
  }

  const selectAllVisible = () => {
    const next = new Set<string>()
    const q = search.trim().toLowerCase()
    for (const a of diskAgents) {
      if (a.source !== 'custom' || !a.sourcePath) continue
      if (q && !a.agentType.toLowerCase().includes(q) && !(a.whenToUse || '').toLowerCase().includes(q)) {
        continue
      }
      next.add(diskSelectionKey(a.sourcePath))
    }
    for (const a of customAgents) {
      if (q && !a.name.toLowerCase().includes(q) && !a.description.toLowerCase().includes(q)) continue
      next.add(localSelectionKey(a.id))
    }
    setBatchSelected(next)
  }

  const enterBatchMode = () => {
    setBatchMode(true)
    setBatchSelected(new Set())
  }

  const exitBatchMode = () => {
    setBatchMode(false)
    setBatchSelected(new Set())
  }

  const handleBatchHide = async () => {
    const names = selectedAgentTypes()
    if (names.length === 0) return
    const next = new Set(disabledCustomAgents)
    for (const n of names) next.add(n)
    setDisabledCustomAgents(next)
    const api = window.electronAPI?.agents
    if (api?.setDisabled) {
      const res = await api.setDisabled([...next])
      if (!res?.success) await refreshDiskAgents()
    }
  }

  const handleBatchShow = async () => {
    const names = new Set(selectedAgentTypes())
    if (names.size === 0) return
    const next = new Set([...disabledCustomAgents].filter((n) => !names.has(n)))
    setDisabledCustomAgents(next)
    const api = window.electronAPI?.agents
    if (api?.setDisabled) {
      const res = await api.setDisabled([...next])
      if (!res?.success) await refreshDiskAgents()
    }
  }

  const handleBatchDelete = async () => {
    if (batchSelected.size === 0) return
    const keys = [...batchSelected]
    const confirmed = window.confirm(
      t.confirmBatchDelete(keys.length),
    )
    if (!confirmed) return

    const api = window.electronAPI?.agents
    const diskPaths: string[] = []
    const localIds: string[] = []
    for (const key of keys) {
      if (key.startsWith('disk:')) diskPaths.push(key.slice('disk:'.length))
      else if (key.startsWith('local:')) localIds.push(key.slice('local:'.length))
    }

    // localStorage: single synchronous mutation, then one backend sync.
    if (localIds.length > 0) {
      const keepSet = new Set(localIds)
      const saved = customAgents.filter((a) => !keepSet.has(a.id))
      setCustomAgents(saved)
      localStorage.setItem('custom-agents', JSON.stringify(saved))
      queueMirrorRendererPrefsToDisk()
      syncToBackend(saved)
    }

    // Disk: sequential deletes so the watcher + rebuild sees each file
    // gone. `agents:changed` broadcasts at the end refresh the UI.
    if (api?.deleteFromDisk) {
      for (const sp of diskPaths) {
        try {
          const res = await api.deleteFromDisk(sp)
          if (!res?.success) {
            console.warn('[AgentsPanel] batch delete item failed:', sp, res?.error)
          }
        } catch (err) {
          console.warn('[AgentsPanel] batch delete threw:', sp, err)
        }
      }
    }

    exitBatchMode()
    await refreshDiskAgents()
  }

  // ===== Extra-dirs management =====

  const handleAddExtraDir = async () => {
    const api = window.electronAPI?.agents
    if (!api?.pickDirectory) return
    const res = await api.pickDirectory(t.pickExtraDirTitle)
    if (!res?.path) return
    if (extraDirs.includes(res.path)) return
    setCustomAgentsExtraDirs([...extraDirs, res.path])
    // setCustomAgentsExtraDirs already pushes to main via IPC; watcher rewires
    // and agents list refreshes on the broadcast.
  }

  const handleRemoveExtraDir = (dir: string) => {
    setCustomAgentsExtraDirs(extraDirs.filter((d) => d !== dir))
  }

  const handleCopyPrompt = (text: string, id: string) => {
    navigator.clipboard.writeText(text).catch(() => {})
    setCopiedId(id)
    setTimeout(() => setCopiedId(null), 2000)
  }

  return {
    tab, setTab,
    search, setSearch,
    expanded, setExpanded,
    customAgents,
    showForm, setShowForm,
    editingId,
    editingDisk,
    extraDirs,
    defaultNewAgentScope,
    setDefaultNewAgentScope,
    formData, setFormData,
    copiedId,
    showPrompt, setShowPrompt,
    diskAgents,
    scopeDirs,
    disabledCustomAgents,
    batchMode,
    batchSelected, setBatchSelected,
    refreshDiskAgents,
    filteredBuiltin,
    filteredCustom,
    resetForm,
    handleEditCustom,
    handleEditDiskAgent,
    handleToggleDisabled,
    handleSaveCustom,
    handleDeleteCustom,
    handleDeleteDiskAgent,
    localSelectionKey,
    diskSelectionKey,
    toggleBatchSelection,
    selectAllVisible,
    enterBatchMode,
    exitBatchMode,
    handleBatchHide,
    handleBatchShow,
    handleBatchDelete,
    handleAddExtraDir,
    handleRemoveExtraDir,
    handleCopyPrompt,
  }
}
