/**
 * AgentEditor — Workbench middle column. Phase 2 Sprint 2a.
 *
 * Sprint 2a unlocks scalar-field editing:
 *   ✓ Tab 1 基本     — all fields editable
 *   ∘ Tab 2 提示词   — still read-only (Sprint 2b: promptSections editor)
 *   ∘ Tab 3 能力     — still read-only (Sprint 2b: arrays editor)
 *   ✓ Tab 4 模型     — all fields editable
 *   ✓ Tab 5 权限     — all fields editable
 *   ∘ Tab 6 钩子     — still read-only (Sprint 2b: hook list editor)
 *   ✓ Tab 7 协调     — coordinatorPhase / subagentToolProfile editable
 *
 * State flow:
 *   baseline (bundleStore) + draft (workbenchDraftStore)
 *     ─► applyDraft() ─► `effectiveAgent` shown in inputs
 *   edits ─► draftStore.setField
 *   Save  ─► computePatchToSend() ─► bundleStore.saveAgent() ─► IPC
 *             on success: clearAgent(draft) + freshBundle reflected
 *   Reset ─► clearAgent(draft) ─► inputs revert to baseline
 *
 * The list of accepted editable fields MUST stay aligned with both:
 *   - `EditableAgentPatch` in `workbenchDraftStore.ts`
 *   - `agentPatchSchema` in `electron/ipc/bundleHandlers.ts`
 * Otherwise edits silently drop at the Zod boundary.
 */
import React, { useCallback, useMemo, useState } from 'react'
import {
  Save,
  RotateCcw,
  Loader2,
  AlertTriangle,
  CheckCircle2,
  PlayCircle,
} from 'lucide-react'
import type {
  Bundle,
  AgentBundleEntry,
  TeamTemplate,
} from '../../../electron/agents/bundles/types'
import type { WorkbenchSelection } from './AgentWorkbench'
import {
  useWorkbenchDraftStore,
  applyDraft,
  isAgentDirty,
  computePatchToSend,
  draftKey,
} from '../../stores/workbenchDraftStore'
import { useBundleStore } from '../../stores/bundleStore'
import { useLayoutStore } from '../../stores/useLayoutStore'
import { TeamEditor } from './TeamEditor'
import { BundleMetaEditor } from './BundleMetaEditor'
import { TABS, type TabId, type OnFieldChange } from './agentEditor/constants'
import { TabBasic } from './agentEditor/TabBasic'
import { TabModel } from './agentEditor/TabModel'
import { TabPermission } from './agentEditor/TabPermission'
import { TabCoordination } from './agentEditor/TabCoordination'
import { TabPrompt } from './agentEditor/TabPrompt'
import { TabCapability } from './agentEditor/TabCapability'
import { TabHooks } from './agentEditor/TabHooks'
import { useT } from '../../i18n'
import './AgentEditor.css'

export interface AgentEditorProps {
  bundles: Bundle[]
  selection: WorkbenchSelection
}

export const AgentEditor: React.FC<AgentEditorProps> = ({ bundles, selection }) => {
  const t = useT()
  const [activeTab, setActiveTab] = useState<TabId>('basic')
  const [toastMsg, setToastMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  const resolved = useMemo(() => {
    if (selection.kind === 'none') return null
    const bundle = bundles.find((b) => b.meta.id === selection.bundleId) ?? null
    if (!bundle) return null
    if (selection.kind === 'agent') {
      const agent = bundle.agents.find((a) => a.agentType === selection.agentType) ?? null
      return { bundle, agent, team: null as TeamTemplate | null }
    }
    if (selection.kind === 'team') {
      const team = bundle.teams.find((t) => t.id === selection.teamId) ?? null
      return { bundle, agent: null as AgentBundleEntry | null, team }
    }
    return { bundle, agent: null as AgentBundleEntry | null, team: null as TeamTemplate | null }
  }, [bundles, selection])

  // Always-fresh draft for the current selection (even if selection
  // has no draft yet — the hook must be called unconditionally).
  const dKey =
    selection.kind === 'agent' ? draftKey(selection.bundleId, selection.agentType) : null
  const draft = useWorkbenchDraftStore((s) => (dKey ? s.drafts[dKey] : undefined))
  const saving = useWorkbenchDraftStore((s) => (dKey ? !!s.saving[dKey] : false))
  const lastError = useWorkbenchDraftStore((s) => (dKey ? s.errors[dKey] ?? null : null))
  const setField = useWorkbenchDraftStore((s) => s.setField)
  const clearAgent = useWorkbenchDraftStore((s) => s.clearAgent)
  const setSaving = useWorkbenchDraftStore((s) => s.setSaving)
  const setError = useWorkbenchDraftStore((s) => s.setError)
  const saveAgentAction = useBundleStore((s) => s.saveAgent)
  const setTryRunDrawerTarget = useLayoutStore((s) => s.setTryRunDrawerTarget)
  const tryRunDrawerTarget = useLayoutStore((s) => s.tryRunDrawerTarget)

  const agent = resolved?.agent ?? null
  const effectiveAgent = useMemo<AgentBundleEntry | null>(
    () => (agent ? applyDraft(agent, draft) : null),
    [agent, draft],
  )
  const dirty = useMemo(
    () => (agent ? isAgentDirty(agent, draft) : false),
    [agent, draft],
  )

  const onFieldChange = useCallback<OnFieldChange>(
    (field, value) => {
      if (selection.kind !== 'agent') return
      setField(selection.bundleId, selection.agentType, field, value)
    },
    [selection, setField],
  )

  const handleSave = useCallback(async () => {
    if (selection.kind !== 'agent' || !agent || !dirty) return
    const patch = computePatchToSend(agent, draft)
    if (Object.keys(patch).length === 0) return
    const key = draftKey(selection.bundleId, selection.agentType)
    setSaving(key, true)
    setError(key, null)
    try {
      await saveAgentAction(selection.bundleId, selection.agentType, patch)
      clearAgent(selection.bundleId, selection.agentType)
      setToastMsg({ kind: 'ok', text: t.workbench.chrome.saved })
      setTimeout(() => setToastMsg((prev) => (prev?.kind === 'ok' ? null : prev)), 2200)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(key, msg)
      setToastMsg({ kind: 'err', text: t.workbench.chrome.saveFailed(msg) })
    } finally {
      setSaving(key, false)
    }
  }, [selection, agent, dirty, draft, saveAgentAction, clearAgent, setSaving, setError, t])

  const handleReset = useCallback(() => {
    if (selection.kind !== 'agent') return
    clearAgent(selection.bundleId, selection.agentType)
  }, [selection, clearAgent])

  if (!resolved) {
    return (
      <div className="workbench-empty-state">
        {t.workbench.chrome.selectToStart}
      </div>
    )
  }

  const { bundle, team } = resolved

  // ── Bundle-meta editor (Sprint 2c.2) ──
  if (selection.kind === 'bundle-meta') {
    return <BundleMetaEditor bundle={bundle} />
  }

  // ── Team 编辑(Sprint 2c.1) ──
  if (selection.kind === 'team' && team) {
    return <TeamEditor bundle={bundle} team={team} />
  }

  // ── Agent editor ──
  // 执行到这里时,上面的 bundle-meta / team 分支都已 return,所以
  // selection 必然是 'agent';TS 的分支追踪不过 return 边界,这里
  // 显式归一化一下便于向下传递 bundleId/agentType。
  if (selection.kind !== 'agent' || !agent || !effectiveAgent) {
    return (
      <div className="workbench-empty-state">
        {t.workbench.chrome.agentNotFound}
      </div>
    )
  }

  return (
    <div className="agent-editor">
      <div className="agent-editor-header">
        <div className="agent-editor-header-title">
          <span className="agent-editor-name">{effectiveAgent.displayName ?? effectiveAgent.agentType}</span>
          <span className="agent-editor-type mono">{effectiveAgent.agentType}</span>
          {effectiveAgent.isPrimary ? <span className="agent-editor-primary-badge">{t.workbench.chrome.primaryBadge}</span> : null}
          {dirty ? <span className="agent-editor-dirty-dot" aria-label={t.workbench.chrome.unsavedAria} /> : null}
        </div>
        <div className="agent-editor-header-actions">
          {/* Sprint 2d.a: 打开右侧试跑抽屉,用当前 draft 合成的 system
              prompt 直接跟 LLM 一问一答;不走工具、不写对话历史。 */}
          <button
            type="button"
            className={`agent-editor-btn agent-editor-btn-ghost ${
              tryRunDrawerTarget?.bundleId === selection.bundleId &&
              tryRunDrawerTarget?.agentType === selection.agentType
                ? 'is-active'
                : ''
            }`}
            onClick={() =>
              setTryRunDrawerTarget(
                tryRunDrawerTarget &&
                  tryRunDrawerTarget.bundleId === selection.bundleId &&
                  tryRunDrawerTarget.agentType === selection.agentType
                  ? null
                  : {
                      bundleId: selection.bundleId,
                      agentType: selection.agentType,
                    },
              )
            }
            title={t.workbench.chrome.tryRunTitle}
          >
            <PlayCircle size={12} />
            <span>{t.workbench.chrome.tryRun}</span>
          </button>
          <button
            type="button"
            className="agent-editor-btn agent-editor-btn-ghost"
            onClick={handleReset}
            disabled={!dirty || saving}
            title={t.workbench.chrome.undoTitle}
          >
            <RotateCcw size={12} />
            <span>{t.workbench.chrome.undo}</span>
          </button>
          <button
            type="button"
            className="agent-editor-btn agent-editor-btn-primary"
            onClick={handleSave}
            disabled={!dirty || saving}
            title={t.workbench.chrome.saveTitle}
          >
            {saving ? <Loader2 size={12} className="is-spinning" /> : <Save size={12} />}
            <span>{saving ? t.workbench.chrome.saving : t.workbench.chrome.save}</span>
          </button>
        </div>
      </div>

      {effectiveAgent.tagline ? (
        <div className="agent-editor-tagline">{effectiveAgent.tagline}</div>
      ) : null}

      {toastMsg ? (
        <div
          className={`agent-editor-toast ${toastMsg.kind === 'err' ? 'is-error' : 'is-ok'}`}
          role="status"
        >
          {toastMsg.kind === 'err' ? <AlertTriangle size={12} /> : <CheckCircle2 size={12} />}
          <span>{toastMsg.text}</span>
          {toastMsg.kind === 'err' ? (
            <button
              type="button"
              className="agent-editor-toast-dismiss"
              onClick={() => setToastMsg(null)}
              aria-label={t.workbench.chrome.dismiss}
            >
              ×
            </button>
          ) : null}
        </div>
      ) : null}

      {lastError && !toastMsg ? (
        <div className="agent-editor-error-banner" role="alert">
          <AlertTriangle size={12} />
          <span>{lastError}</span>
        </div>
      ) : null}

      <div className="agent-editor-tabs" role="tablist">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            className={`agent-editor-tab ${activeTab === tab.id ? 'is-active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
          >
            {t.workbench.tab[tab.id]}
          </button>
        ))}
      </div>

      <div className="agent-editor-panels">
        {activeTab === 'basic' ? (
          <TabBasic agent={effectiveAgent} onChange={onFieldChange} />
        ) : null}
        {activeTab === 'prompt' ? (
          <TabPrompt
            bundleId={selection.bundleId}
            agentType={selection.agentType}
            agent={effectiveAgent}
            onChange={onFieldChange}
          />
        ) : null}
        {activeTab === 'capability' ? (
          <TabCapability agent={effectiveAgent} onChange={onFieldChange} />
        ) : null}
        {activeTab === 'model' ? (
          <TabModel agent={effectiveAgent} onChange={onFieldChange} />
        ) : null}
        {activeTab === 'permission' ? (
          <TabPermission agent={effectiveAgent} onChange={onFieldChange} />
        ) : null}
        {activeTab === 'hooks' ? (
          <TabHooks agent={effectiveAgent} onChange={onFieldChange} />
        ) : null}
        {activeTab === 'coordination' ? (
          <TabCoordination agent={effectiveAgent} onChange={onFieldChange} />
        ) : null}
      </div>
    </div>
  )
}
