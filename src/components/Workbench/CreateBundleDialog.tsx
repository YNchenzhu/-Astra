/**
 * CreateBundleDialog —— 新建工作包小模态（Sprint 2c.2a）
 *
 * 两种创建方式:
 *   - **空白** —— 新工作包自带一个占位智能体("assistant"),便于通过
 *     `validateBundleSemantics` 的"至少一个 agent"校验
 *   - **复制自 ...** —— 从目录中任一 bundle 深拷贝 agents/teams/
 *     capabilities/layout,只改 meta (id / name 等)
 *
 * UI 选型:紧凑小对话框而非大弹窗。位于 Workbench 内部,所以叠在它
 * 之上即可,不需要全屏 overlay。
 *
 * 字段校验(前端):
 *   - id 规范化:转小写,非字母数字下划线破折号替换为 `-`;空则禁用提交
 *   - id 冲突:已有同名 bundle 即提示,禁用提交
 *   - name 可选,空时后端会用 id 替代
 *
 * 提交成功后:
 *   - 关对话框
 *   - 调用 onCreated(newBundle),父组件负责选中该 bundle(workbench
 *     selection)
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X, Plus, Loader2, AlertTriangle, Copy, FilePlus2 } from 'lucide-react'
import type { Bundle } from '../../../electron/agents/bundles/types'
import { useBundleStore } from '../../stores/bundleStore'
import { chineseToId, isIdStillDerivedFrom } from '../../utils/chineseToId'
import { useT } from '../../i18n'
import './CreateBundleDialog.css'

export interface CreateBundleDialogProps {
  /** 当前可作为"复制源"的所有 bundles。 */
  bundles: Bundle[]
  /** 预填的 "复制自" bundle id。常见用例:右栏某 bundle 选中时点
   *  "+ 新建" 自动以它为种子。 */
  defaultCopyFromId?: string
  onClose: () => void
  onCreated: (newBundle: Bundle) => void
}

type Mode = 'blank' | 'copy'

export const CreateBundleDialog: React.FC<CreateBundleDialogProps> = ({
  bundles,
  defaultCopyFromId,
  onClose,
  onCreated,
}) => {
  const t = useT()
  const cb = t.workbench.createBundle
  const createBundle = useBundleStore((s) => s.createBundle)

  const [mode, setMode] = useState<Mode>(defaultCopyFromId ? 'copy' : 'blank')
  const [id, setId] = useState<string>('')
  const [name, setName] = useState<string>('')
  const [description, setDescription] = useState<string>('')
  const [domain, setDomain] = useState<string>('')
  const [copyFromId, setCopyFromId] = useState<string>(defaultCopyFromId ?? bundles[0]?.meta.id ?? '')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 当用户手动编辑 ID 框后,停止从"显示名称"联动自动生成,
  // 避免覆盖用户的自定义输入。
  const [idManuallyEdited, setIdManuallyEdited] = useState(false)
  const idInputRef = useRef<HTMLInputElement | null>(null)
  const nameInputRef = useRef<HTMLInputElement | null>(null)

  // 用 `chineseToId` 统一规范化:中文走拼音,其它原样清洗。
  // 用户直接在 ID 框打中文也能正确转换。
  const normalizedId = useMemo(() => chineseToId(id), [id])
  const idConflict = bundles.some((b) => b.meta.id === normalizedId)
  const canSubmit =
    !submitting &&
    normalizedId.length > 0 &&
    !idConflict &&
    (mode === 'blank' || !!copyFromId)

  // 打开时自动聚焦 **显示名称** 框 —— 新 UX:用户先打中文,ID 跟着自动联动,
  // 不需要先对着 ID 框发愁英文怎么写。
  useEffect(() => {
    requestAnimationFrame(() => nameInputRef.current?.focus())
  }, [])

  // "显示名称" → "ID" 自动联动。只要用户还没手动改过 ID,name 的每一次
  // 变化都会重算 ID(通过拼音转换 + 规范化)。用户开始编辑 ID 后,
  // `idManuallyEdited` 被设为 true,联动停止。
  const handleNameChange = useCallback(
    (next: string) => {
      setName(next)
      if (!idManuallyEdited) {
        const autoId = chineseToId(next)
        setId(autoId)
      }
    },
    [idManuallyEdited],
  )

  const handleIdChange = useCallback(
    (next: string) => {
      setId(next)
      // 如果用户把 ID 清空 → 允许再次联动(下次敲 name 又会自动填)
      // 否则一旦手动输入任意字符,切断联动
      if (next.trim().length === 0) {
        setIdManuallyEdited(false)
      } else if (!idManuallyEdited) {
        setIdManuallyEdited(!isIdStillDerivedFrom(chineseToId(next), name))
      }
    },
    [idManuallyEdited, name],
  )

  // Esc 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return
    setSubmitting(true)
    setError(null)
    try {
      const bundle = await createBundle({
        id: normalizedId,
        name: name.trim() || undefined,
        description: description.trim() || undefined,
        domain: domain.trim() || undefined,
        copyFromId: mode === 'copy' ? copyFromId : undefined,
      })
      onCreated(bundle)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }, [
    canSubmit,
    normalizedId,
    name,
    description,
    domain,
    mode,
    copyFromId,
    createBundle,
    onCreated,
    onClose,
  ])

  // Portal 到 document.body 是故意的:本组件有可能被挂在 TitleBar 内部
  // (BundleSwitcher 的 "+ 新建" 入口),而 TitleBar 设了
  // `-webkit-app-region: drag` 让整条标题栏可以拖动窗口。Electron 的
  // 拖动区会把子元素上的鼠标/键盘事件全部吞掉,导致对话框里的 input
  // 彻底点不动、打不了字。Portal 到 body 让 DOM 层级脱离标题栏,
  // 事件就恢复正常。与 BundleSwitcher popover 的处理方式保持一致。
  return createPortal(
    <div className="cbd-overlay" role="dialog" aria-modal="true" aria-label={cb.title}>
      <div className="cbd-backdrop" onClick={onClose} aria-hidden="true" />
      <div className="cbd-surface" onClick={(e) => e.stopPropagation()}>
        <header className="cbd-header">
          <span className="cbd-title">{cb.title}</span>
          <button
            type="button"
            className="cbd-close"
            onClick={onClose}
            title={t.workbench.closeEsc}
            aria-label={t.workbench.close}
          >
            <X size={14} />
          </button>
        </header>

        {/* 模式切换 */}
        <div className="cbd-mode-row">
          <button
            type="button"
            className={`cbd-mode-btn ${mode === 'blank' ? 'is-active' : ''}`}
            onClick={() => setMode('blank')}
          >
            <FilePlus2 size={14} />
            <div className="cbd-mode-body">
              <span className="cbd-mode-title">{cb.modeBlank}</span>
              <span className="cbd-mode-desc">{cb.modeBlankDesc}</span>
            </div>
          </button>
          <button
            type="button"
            className={`cbd-mode-btn ${mode === 'copy' ? 'is-active' : ''}`}
            onClick={() => setMode('copy')}
            disabled={bundles.length === 0}
          >
            <Copy size={14} />
            <div className="cbd-mode-body">
              <span className="cbd-mode-title">{cb.modeCopy}</span>
              <span className="cbd-mode-desc">{cb.modeCopyDesc}</span>
            </div>
          </button>
        </div>

        {/* 字段区 */}
        <div className="cbd-fields">
          <div className="cbd-field">
            <label className="cbd-field-label">{cb.displayName}</label>
            <input
              ref={nameInputRef}
              className="cbd-input"
              type="text"
              value={name}
              onChange={(e) => handleNameChange(e.currentTarget.value)}
              placeholder={cb.displayNamePlaceholder}
            />
            <div className="cbd-field-hint">
              {cb.displayNameHint}
            </div>
          </div>

          <div className="cbd-field">
            <label className="cbd-field-label">{cb.idLabel}</label>
            <input
              ref={idInputRef}
              className="cbd-input"
              type="text"
              value={id}
              onChange={(e) => handleIdChange(e.currentTarget.value)}
              placeholder={cb.idPlaceholder}
            />
            <div className="cbd-field-hint">
              {!idManuallyEdited && id.length > 0 ? (
                <span>
                  <span className="cbd-field-hint-auto">{cb.autoLinking}</span>
                  {' · '}
                  <span>{cb.switchManualHint}</span>
                </span>
              ) : normalizedId.length > 0 && normalizedId !== id.trim().toLowerCase() ? (
                <span>
                  {cb.normalizedPrefix}<code>{normalizedId}</code>
                </span>
              ) : (
                <span>{cb.idRule}</span>
              )}
              {idConflict ? (
                <span className="cbd-field-hint-err">{cb.idExists}</span>
              ) : null}
            </div>
          </div>

          {mode === 'copy' ? (
            <div className="cbd-field">
              <label className="cbd-field-label">{cb.copyFrom}</label>
              <select
                className="cbd-input cbd-select"
                value={copyFromId}
                onChange={(e) => setCopyFromId(e.currentTarget.value)}
              >
                {bundles.map((b) => (
                  <option key={b.meta.id} value={b.meta.id}>
                    {b.meta.name} · {b.meta.id}
                  </option>
                ))}
              </select>
              <div className="cbd-field-hint">
                {cb.copyFromHint}
              </div>
            </div>
          ) : null}

          <div className="cbd-field">
            <label className="cbd-field-label">{cb.description}</label>
            <textarea
              className="cbd-input cbd-textarea"
              value={description}
              onChange={(e) => setDescription(e.currentTarget.value)}
              rows={2}
              placeholder={cb.descriptionPlaceholder}
            />
          </div>

          <div className="cbd-field">
            <label className="cbd-field-label">{cb.domain}</label>
            <input
              className="cbd-input"
              type="text"
              value={domain}
              onChange={(e) => setDomain(e.currentTarget.value)}
              placeholder={cb.domainPlaceholder}
            />
          </div>
        </div>

        {error ? (
          <div className="cbd-error">
            <AlertTriangle size={12} />
            <span>{error}</span>
          </div>
        ) : null}

        <footer className="cbd-footer">
          <button type="button" className="cbd-btn cbd-btn-ghost" onClick={onClose}>
            {cb.cancel}
          </button>
          <button
            type="button"
            className="cbd-btn cbd-btn-primary"
            onClick={handleSubmit}
            disabled={!canSubmit}
          >
            {submitting ? <Loader2 size={12} className="is-spinning" /> : <Plus size={12} />}
            <span>{submitting ? cb.creating : cb.create}</span>
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  )
}
