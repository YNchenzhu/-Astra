/**
 * TeamEditor —— 工作台中栏的团队编辑器（Sprint 2c.1）
 *
 * 替代 Sprint 1 的 team-summary 只读视图。布局和 AgentEditor 保持
 * 一致（header + 字段区），复用 .agent-editor-* 样式类。
 *
 * 编辑范围：
 *   ✓ name / description      —— 文本
 *   ✓ coordination            —— 下拉(solo/parallel/sequential/swarm/coordinator)
 *   ✓ members[]               —— 独立的 TeamMemberList 子组件
 *   ✗ id                      —— 锁定不可改(引用完整性)
 *
 * 保存走 `bundle.saveTeam` IPC，会自动:
 *   - 若当前 bundle 源自 preset，复制到 user 目录再改
 *   - 若 member 引用了不存在的 agentType，服务端 Zod + validateBundle
 *     的 `referenced agent "X" unknown` 会拒绝保存（错误以 toast 呈现）
 */

import React, { useCallback, useMemo, useState } from 'react'
import { Save, RotateCcw, Loader2, AlertTriangle, CheckCircle2 } from 'lucide-react'
import type { Bundle, TeamTemplate } from '../../../electron/agents/bundles/types'
import {
  useWorkbenchDraftStore,
  teamDraftKey,
  type EditableTeamPatch,
  type EditableTeamField,
} from '../../stores/workbenchDraftStore'
import { useBundleStore } from '../../stores/bundleStore'
import { TeamMemberList } from './TeamMemberList'
import { MermaidBlock } from '../AIChat/MermaidBlock'
import { teamFlowToMermaid } from './teamFlowMermaid'
import { useT, type Messages } from '../../i18n'
import './AgentEditor.css'
import './TeamEditor.css'

export interface TeamEditorProps {
  bundle: Bundle
  team: TeamTemplate
}

/** 把 baseline + draft 合成为展示用的"有效 team"。字段层面的深比较
 *  通过 workbenchDraftStore 的 shallowEqual 统一处理；这里只做简单
 *  覆盖,undefined 跳过。 */
function applyTeamDraft(
  baseline: TeamTemplate,
  draft: EditableTeamPatch | undefined,
): TeamTemplate {
  if (!draft) return baseline
  const merged: TeamTemplate = { ...baseline }
  for (const [key, value] of Object.entries(draft)) {
    if (value !== undefined) {
      ;(merged as unknown as Record<string, unknown>)[key] = value
    }
  }
  return merged
}

/** 判断 draft 是否"脏"：任何一个字段与 baseline 不等就算。 */
function isTeamDirty(
  baseline: TeamTemplate,
  draft: EditableTeamPatch | undefined,
): boolean {
  if (!draft) return false
  const base = baseline as unknown as Record<string, unknown>
  for (const [key, value] of Object.entries(draft)) {
    if (value === undefined) continue
    if (!deepEqual(base[key], value)) return true
  }
  return false
}

/** 生成发送给主进程的最小 patch：undefined 转 null 哨兵,其余照旧。 */
function computeTeamPatch(
  baseline: TeamTemplate,
  draft: EditableTeamPatch | undefined,
): Record<string, unknown> {
  if (!draft) return {}
  const base = baseline as unknown as Record<string, unknown>
  const patch: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(draft)) {
    const bv = base[key]
    if (value === undefined) {
      if (bv !== undefined) patch[key] = null
      continue
    }
    if (!deepEqual(bv, value)) patch[key] = value
  }
  return patch
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null) return false
  if (typeof a !== typeof b) return false
  if (typeof a !== 'object') return false
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false
    return true
  }
  if (Array.isArray(b)) return false
  const ao = a as Record<string, unknown>
  const bo = b as Record<string, unknown>
  const ak = Object.keys(ao)
  if (ak.length !== Object.keys(bo).length) return false
  for (const k of ak) {
    if (!Object.prototype.hasOwnProperty.call(bo, k)) return false
    if (!deepEqual(ao[k], bo[k])) return false
  }
  return true
}

function coordOptions(te: Messages['workbench']['teamEditor']): Array<{
  value: TeamTemplate['coordination']
  label: string
  hint: string
}> {
  return [
    { value: 'solo', label: te.coordSoloLabel, hint: te.coordSoloHint },
    { value: 'parallel', label: te.coordParallelLabel, hint: te.coordParallelHint },
    { value: 'sequential', label: te.coordSequentialLabel, hint: te.coordSequentialHint },
    { value: 'swarm', label: te.coordSwarmLabel, hint: te.coordSwarmHint },
    { value: 'coordinator', label: te.coordCoordinatorLabel, hint: te.coordCoordinatorHint },
  ]
}

export const TeamEditor: React.FC<TeamEditorProps> = ({ bundle, team }) => {
  const t = useT()
  const te = t.workbench.teamEditor
  const COORD_OPTIONS = useMemo(() => coordOptions(te), [te])
  const [toastMsg, setToastMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(
    null,
  )

  const key = teamDraftKey(bundle.meta.id, team.id)
  const draft = useWorkbenchDraftStore((s) => s.teamDrafts[key])
  const saving = useWorkbenchDraftStore((s) => !!s.saving[key])
  const lastError = useWorkbenchDraftStore((s) => s.errors[key] ?? null)
  const setField = useWorkbenchDraftStore((s) => s.setTeamField)
  const clearTeam = useWorkbenchDraftStore((s) => s.clearTeam)
  const setSaving = useWorkbenchDraftStore((s) => s.setSaving)
  const setError = useWorkbenchDraftStore((s) => s.setError)
  const saveTeamAction = useBundleStore((s) => s.saveTeam)

  const effective = useMemo(() => applyTeamDraft(team, draft), [team, draft])
  const dirty = useMemo(() => isTeamDirty(team, draft), [team, draft])

  const handleField = useCallback(
    <K extends EditableTeamField>(field: K, value: EditableTeamPatch[K]) => {
      setField(bundle.meta.id, team.id, field, value)
    },
    [setField, bundle.meta.id, team.id],
  )

  const handleSave = useCallback(async () => {
    if (!dirty) return
    const patch = computeTeamPatch(team, draft)
    if (Object.keys(patch).length === 0) return
    setSaving(key, true)
    setError(key, null)
    try {
      await saveTeamAction(bundle.meta.id, team.id, patch)
      clearTeam(bundle.meta.id, team.id)
      setToastMsg({ kind: 'ok', text: te.saved })
      setTimeout(() => setToastMsg((prev) => (prev?.kind === 'ok' ? null : prev)), 2200)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(key, msg)
      setToastMsg({ kind: 'err', text: te.saveFailed(msg) })
    } finally {
      setSaving(key, false)
    }
  }, [
    dirty,
    draft,
    team,
    key,
    bundle.meta.id,
    saveTeamAction,
    clearTeam,
    setSaving,
    setError,
    te,
  ])

  const handleReset = useCallback(() => {
    clearTeam(bundle.meta.id, team.id)
  }, [clearTeam, bundle.meta.id, team.id])

  // 当前 bundle 中可选的 agentType 列表,传给成员编辑器。
  const availableAgentTypes = useMemo(
    () =>
      bundle.agents
        .map((a) => ({
          agentType: a.agentType,
          displayName: a.displayName,
        }))
        .sort((a, b) =>
          (a.displayName ?? a.agentType).localeCompare(b.displayName ?? b.agentType),
        ),
    [bundle.agents],
  )

  return (
    <div className="agent-editor">
      <div className="agent-editor-header">
        <div className="agent-editor-header-title">
          <span className="agent-editor-name">{effective.name || effective.id}</span>
          <span className="agent-editor-type mono">{effective.id}</span>
          {dirty ? <span className="agent-editor-dirty-dot" aria-label={te.unsavedAria} /> : null}
        </div>
        <div className="agent-editor-header-actions">
          <button
            type="button"
            className="agent-editor-btn agent-editor-btn-ghost"
            onClick={handleReset}
            disabled={!dirty || saving}
            title={te.undoTitle}
          >
            <RotateCcw size={12} />
            <span>{te.undo}</span>
          </button>
          <button
            type="button"
            className="agent-editor-btn agent-editor-btn-primary"
            onClick={handleSave}
            disabled={!dirty || saving}
            title={te.saveTitle}
          >
            {saving ? <Loader2 size={12} className="is-spinning" /> : <Save size={12} />}
            <span>{saving ? te.saving : te.save}</span>
          </button>
        </div>
      </div>

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
              aria-label={te.dismiss}
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

      <div className="agent-editor-panels">
        <div className="agent-editor-panel">
          <div className="agent-editor-field">
            <span className="agent-editor-field-label">{te.internalId}</span>
            <div className="agent-editor-field-value">
              <span className="agent-editor-field-locked mono">{team.id}</span>
              <div className="agent-editor-field-hint">
                {te.internalIdHint}
              </div>
            </div>
          </div>

          <div className="agent-editor-field">
            <span className="agent-editor-field-label">{te.displayName}</span>
            <div className="agent-editor-field-value">
              <input
                className="agent-editor-input"
                type="text"
                value={effective.name ?? ''}
                placeholder={te.displayNamePlaceholder}
                onChange={(e) => handleField('name', e.currentTarget.value)}
              />
            </div>
          </div>

          <div className="agent-editor-field">
            <span className="agent-editor-field-label">{te.description}</span>
            <div className="agent-editor-field-value">
              <textarea
                className="agent-editor-input agent-editor-textarea"
                value={effective.description ?? ''}
                rows={3}
                placeholder={te.descriptionPlaceholder}
                onChange={(e) => handleField('description', e.currentTarget.value)}
              />
            </div>
          </div>

          <div className="agent-editor-field">
            <span className="agent-editor-field-label">{te.coordination}</span>
            <div className="agent-editor-field-value">
              <select
                className="agent-editor-input agent-editor-select"
                value={effective.coordination}
                onChange={(e) =>
                  handleField('coordination', e.currentTarget.value as TeamTemplate['coordination'])
                }
              >
                {COORD_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
              <div className="agent-editor-field-hint">
                {COORD_OPTIONS.find((o) => o.value === effective.coordination)?.hint ?? ''}
              </div>
            </div>
          </div>

          <div className="agent-editor-field agent-editor-field-members">
            <span className="agent-editor-field-label">{te.members}</span>
            <div className="agent-editor-field-value">
              <TeamMemberList
                members={effective.members}
                availableAgents={availableAgentTypes}
                coordination={effective.coordination}
                onChange={(next) => handleField('members', next)}
              />
            </div>
          </div>

          <TeamFlowSection bundle={bundle} team={effective} />
        </div>
      </div>
    </div>
  )
}

/**
 * Real React error boundary that catches MermaidBlock render-time crashes
 * (e.g. `flowDb.clear()` on undefined webpack modules when bundled by
 * rolldown) and falls back to a friendly placeholder.
 *
 * Why a class component: React render errors propagate through reconciler
 * lifecycles, not the synchronous call stack — `try { return <Mermaid/> }
 * catch { … }` would only catch errors thrown by `React.createElement`
 * itself (which never throws on valid props), not errors thrown inside
 * MermaidBlock's render. The previous implementation also did
 * `useEffect(() => setFailed(false), [code])` which is the canonical
 * "setState synchronously in effect" anti-pattern; using
 * `getDerivedStateFromProps` resets the boundary on prop change without
 * an effect at all.
 */
interface MermaidErrorGuardProps { code: string; fallback: string }
interface MermaidErrorGuardState { failed: boolean; lastCode: string }
class MermaidErrorGuard extends React.Component<
  MermaidErrorGuardProps,
  MermaidErrorGuardState
> {
  state: MermaidErrorGuardState = { failed: false, lastCode: this.props.code }

  static getDerivedStateFromProps(
    props: MermaidErrorGuardProps,
    state: MermaidErrorGuardState,
  ): Partial<MermaidErrorGuardState> | null {
    if (props.code !== state.lastCode) {
      return { failed: false, lastCode: props.code }
    }
    return null
  }

  static getDerivedStateFromError(): Partial<MermaidErrorGuardState> {
    return { failed: true }
  }

  componentDidCatch(error: unknown): void {
    console.warn('[TeamEditor] Mermaid render failed:', error)
  }

  render(): React.ReactNode {
    if (this.state.failed) {
      return <div className="team-flow-empty">{this.props.fallback}</div>
    }
    return <MermaidBlock code={this.props.code} />
  }
}

/**
 * 协调流程预览 —— TeamEditor 底部的只读可视化区。
 *
 * 编辑成员 / 切协调方式时,会实时重新生成 mermaid 源码并喂给
 * MermaidBlock。MermaidBlock 自带 250ms 防抖,所以快速点选也不会
 * 出现闪烁。
 */
const TeamFlowSection: React.FC<{
  bundle: Bundle
  team: import('../../../electron/agents/bundles/types').TeamTemplate
}> = ({ bundle, team }) => {
  const t = useT()
  const te = t.workbench.teamEditor
  const tf = t.workbench.teamFlow
  const { code, emptyReason } = useMemo(
    () => teamFlowToMermaid(team, bundle, tf),
    [team, bundle, tf],
  )

  return (
    <div className="team-flow-section">
      <div className="team-flow-header">
        <span className="team-flow-title">{te.flowPreview}</span>
        <span className="team-flow-hint">
          {te.flowPreviewHint}
        </span>
      </div>
      {code ? (
        <MermaidErrorGuard code={code} fallback={te.flowRenderFailed} />
      ) : (
        <div className="team-flow-empty">{emptyReason}</div>
      )}
    </div>
  )
}
