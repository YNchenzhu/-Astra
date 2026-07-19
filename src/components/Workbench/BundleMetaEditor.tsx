/**
 * BundleMetaEditor —— 工作包 meta 字段编辑器。
 *
 * 可编辑字段:名称 / 描述 / 领域 / 作者 / 图标 / 版本
 * 只读字段:ID / 来源 / 创建时间 / 统计(agents/teams 数量)
 *
 * 使用 `workbenchDraftStore` 管理 dirty 状态,保存走
 * `bundleStore.saveBundleMeta`。preset 源的工作包首次保存会自动
 * fork 到 user 目录(与 saveAgent/saveTeam 策略一致)。
 *
 * "主界面布局"字段已移除 —— 主界面永远是 code IDE,Bundle 只决定
 * 团队 + 项目路径,不再影响布局形态。
 */

import React, { useCallback, useMemo, useState } from 'react'
import {
  Save,
  RotateCcw,
  Loader2,
  AlertTriangle,
  CheckCircle2,
} from 'lucide-react'
import type { Bundle } from '../../../electron/agents/bundles/types'
import {
  useWorkbenchDraftStore,
  bundleMetaDraftKey,
  type EditableBundleMetaField,
  type EditableBundleMetaPatch,
} from '../../stores/workbenchDraftStore'
import { useBundleStore } from '../../stores/bundleStore'
import { useT } from '../../i18n'
import './AgentEditor.css'

export interface BundleMetaEditorProps {
  bundle: Bundle
}

/** baseline + draft 合并成预览态。undefined 键不覆盖,null 视为清除。 */
function apply(
  baseline: Bundle['meta'],
  draft: EditableBundleMetaPatch | undefined,
): Bundle['meta'] {
  if (!draft) return baseline
  const merged: Bundle['meta'] = { ...baseline }
  for (const [key, value] of Object.entries(draft)) {
    if (value === undefined) continue
    ;(merged as unknown as Record<string, unknown>)[key] = value as unknown
  }
  return merged
}

function hasAnyDraft(draft: EditableBundleMetaPatch | undefined): boolean {
  if (!draft) return false
  for (const value of Object.values(draft)) {
    if (value !== undefined) return true
  }
  return false
}

export const BundleMetaEditor: React.FC<BundleMetaEditorProps> = ({ bundle }) => {
  const t = useT()
  const bm = t.workbench.bundleMeta
  const draftKey = bundleMetaDraftKey(bundle.meta.id)
  const draft = useWorkbenchDraftStore((s) => s.metaDrafts[draftKey])
  const saving = useWorkbenchDraftStore((s) => s.saving[draftKey] === true)
  const errorMsg = useWorkbenchDraftStore((s) => s.errors[draftKey] ?? null)

  const setMetaField = useWorkbenchDraftStore((s) => s.setMetaField)
  const clearMeta = useWorkbenchDraftStore((s) => s.clearMeta)
  const setSaving = useWorkbenchDraftStore((s) => s.setSaving)
  const setError = useWorkbenchDraftStore((s) => s.setError)

  const saveBundleMeta = useBundleStore((s) => s.saveBundleMeta)

  const effectiveMeta = useMemo(() => apply(bundle.meta, draft), [bundle.meta, draft])
  const dirty = hasAnyDraft(draft)

  const [savedToast, setSavedToast] = useState(false)

  const handleField = useCallback(
    (field: EditableBundleMetaField, raw: string) => {
      const value = raw.trim()
      const baselineVal =
        (bundle.meta as unknown as Record<string, unknown>)[field] ?? ''
      if (value === '' && baselineVal) {
        // 清空 → null 显式删除(可选字段)
        setMetaField(bundle.meta.id, field, null as unknown as string)
      } else if (value === String(baselineVal)) {
        // 和 baseline 相同 → 清 draft
        setMetaField(bundle.meta.id, field, undefined)
      } else {
        setMetaField(bundle.meta.id, field, value)
      }
    },
    [bundle.meta, setMetaField],
  )

  const handleReset = useCallback(() => {
    clearMeta(bundle.meta.id)
    setError(draftKey, null)
  }, [bundle.meta.id, clearMeta, setError, draftKey])

  const handleSave = useCallback(async () => {
    if (!dirty) return
    setSaving(draftKey, true)
    setError(draftKey, null)
    try {
      await saveBundleMeta(bundle.meta.id, { meta: draft ?? {} })
      clearMeta(bundle.meta.id)
      setSavedToast(true)
      window.setTimeout(() => setSavedToast(false), 1800)
    } catch (err) {
      setError(draftKey, err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(draftKey, false)
    }
  }, [
    dirty,
    draft,
    bundle.meta.id,
    saveBundleMeta,
    clearMeta,
    setSaving,
    setError,
    draftKey,
  ])

  const createdAtLabel = useMemo(() => {
    const n = bundle.meta.createdAt
    if (!n) return '—'
    try {
      return new Date(n).toLocaleString()
    } catch {
      return String(n)
    }
  }, [bundle.meta.createdAt])

  return (
    <div className="agent-editor">
      <div className="agent-editor-header">
        <div className="agent-editor-header-main">
          <div className="agent-editor-header-title">
            <span className="agent-editor-header-name">{effectiveMeta.name}</span>
            {dirty ? <span className="agent-editor-dirty-dot" /> : null}
          </div>
          <div className="agent-editor-header-sub">
            {bm.headerSub(bundle.meta.source, bundle.meta.id)}
          </div>
        </div>
        <div className="agent-editor-header-actions">
          <button
            type="button"
            className="agent-editor-action"
            onClick={handleReset}
            disabled={!dirty || saving}
            title={bm.undoTitle}
          >
            <RotateCcw size={12} />
            {bm.undo}
          </button>
          <button
            type="button"
            className="agent-editor-action agent-editor-action-primary"
            onClick={handleSave}
            disabled={!dirty || saving}
            title={
              bundle.meta.source === 'preset'
                ? bm.savePresetTitle
                : bm.saveTitle
            }
          >
            {saving ? (
              <Loader2 size={12} className="is-spinning" />
            ) : (
              <Save size={12} />
            )}
            {bm.save}
          </button>
        </div>
      </div>

      {savedToast ? (
        <div className="agent-editor-toast">
          <CheckCircle2 size={12} /> {bm.saved}
        </div>
      ) : null}
      {errorMsg ? (
        <div className="agent-editor-error-banner">
          <AlertTriangle size={12} /> {errorMsg}
        </div>
      ) : null}

      <div className="agent-editor-body">
        <div className="agent-editor-section">
          <div className="agent-editor-section-title">{bm.sectionBasic}</div>
          <div className="agent-editor-section-body">
            <div className="agent-editor-field">
              <span className="agent-editor-field-label">{bm.displayName}</span>
              <div className="agent-editor-field-value">
                <input
                  className="agent-editor-input"
                  type="text"
                  value={effectiveMeta.name ?? ''}
                  onChange={(e) => handleField('name', e.currentTarget.value)}
                  disabled={saving}
                  placeholder={bm.displayNamePlaceholder}
                />
                <div className="agent-editor-field-hint">
                  {bm.displayNameHint}
                </div>
              </div>
            </div>

            <div className="agent-editor-field">
              <span className="agent-editor-field-label">{bm.internalId}</span>
              <div className="agent-editor-field-value">
                <input
                  className="agent-editor-input agent-editor-input-readonly"
                  type="text"
                  value={bundle.meta.id}
                  readOnly
                  disabled
                />
                <div className="agent-editor-field-hint">
                  {bm.internalIdHint}
                </div>
              </div>
            </div>

            <div className="agent-editor-field">
              <span className="agent-editor-field-label">{bm.description}</span>
              <div className="agent-editor-field-value">
                <textarea
                  className="agent-editor-input agent-editor-textarea"
                  rows={3}
                  value={effectiveMeta.description ?? ''}
                  onChange={(e) => handleField('description', e.currentTarget.value)}
                  disabled={saving}
                  placeholder={bm.descriptionPlaceholder}
                />
              </div>
            </div>

            <div className="agent-editor-field">
              <span className="agent-editor-field-label">{bm.domain}</span>
              <div className="agent-editor-field-value">
                <input
                  className="agent-editor-input"
                  type="text"
                  value={effectiveMeta.domain ?? ''}
                  onChange={(e) => handleField('domain', e.currentTarget.value)}
                  disabled={saving}
                  placeholder={bm.domainPlaceholder}
                />
                <div className="agent-editor-field-hint">
                  {bm.domainHint}
                </div>
              </div>
            </div>

            <div className="agent-editor-field">
              <span className="agent-editor-field-label">{bm.author}</span>
              <div className="agent-editor-field-value">
                <input
                  className="agent-editor-input"
                  type="text"
                  value={effectiveMeta.author ?? ''}
                  onChange={(e) => handleField('author', e.currentTarget.value)}
                  disabled={saving}
                  placeholder={bm.authorPlaceholder}
                />
              </div>
            </div>

            <div className="agent-editor-field">
              <span className="agent-editor-field-label">{bm.icon}</span>
              <div className="agent-editor-field-value">
                <input
                  className="agent-editor-input"
                  type="text"
                  value={effectiveMeta.icon ?? ''}
                  onChange={(e) => handleField('icon', e.currentTarget.value)}
                  disabled={saving}
                  placeholder={bm.iconPlaceholder}
                />
                <div className="agent-editor-field-hint">
                  {bm.iconHint}
                </div>
              </div>
            </div>

            <div className="agent-editor-field">
              <span className="agent-editor-field-label">{bm.version}</span>
              <div className="agent-editor-field-value">
                <input
                  className="agent-editor-input"
                  type="text"
                  value={effectiveMeta.version ?? ''}
                  onChange={(e) => handleField('version', e.currentTarget.value)}
                  disabled={saving}
                  placeholder={bm.versionPlaceholder}
                />
                <div className="agent-editor-field-hint">
                  {bm.versionHint}
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="agent-editor-section">
          <div className="agent-editor-section-title">{bm.sectionStats}</div>
          <div className="agent-editor-section-body">
            <div className="agent-editor-field">
              <span className="agent-editor-field-label">{bm.source}</span>
              <div className="agent-editor-field-value">
                <span className="agent-editor-static-value">
                  {bundle.meta.source}
                </span>
              </div>
            </div>
            <div className="agent-editor-field">
              <span className="agent-editor-field-label">{bm.createdAt}</span>
              <div className="agent-editor-field-value">
                <span className="agent-editor-static-value">{createdAtLabel}</span>
              </div>
            </div>
            <div className="agent-editor-field">
              <span className="agent-editor-field-label">{bm.agentCount}</span>
              <div className="agent-editor-field-value">
                <span className="agent-editor-static-value">
                  {bundle.agents.length}
                </span>
              </div>
            </div>
            <div className="agent-editor-field">
              <span className="agent-editor-field-label">{bm.teamCount}</span>
              <div className="agent-editor-field-value">
                <span className="agent-editor-static-value">
                  {bundle.teams.length}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
