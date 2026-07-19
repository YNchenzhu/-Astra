/**
 * InlineAddRow —— 左栏子列表内的轻量添加行（Sprint 2c.2b）
 *
 * 行为类似 VSCode 资源管理器里的「新建文件」：点 "+" 后立即在列表中
 * 弹出一个输入行,Enter 确认、Esc 取消。比独立对话框更贴合"导航栏"
 * 的使用场景。
 *
 * 使用方:BundleListPane 的 "智能体 · N" / "团队 · N" 子标题旁 "+"
 * 按钮切换到这个行;用户输入 id + 可选 display 名后回车,调用父组件
 * 的 onSubmit 走 IPC。
 *
 * id 规范化逻辑内置:
 *   - 小写化
 *   - [a-z0-9_-] 之外替换为 -
 *   - 首尾破折号剥离
 * 冲突由父组件(拿着现有列表)计算并传入 `existingIds`。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, X, Loader2 } from 'lucide-react'
import { chineseToId, isIdStillDerivedFrom } from '../../utils/chineseToId'
import { useT } from '../../i18n'
import './InlineAddRow.css'

export interface InlineAddRowProps {
  /** 已存在的 id 列表,用于冲突检查。 */
  existingIds: string[]
  /** id 的种类,决定占位符文案。 */
  kind: 'agent' | 'team'
  onSubmit: (payload: { id: string; name: string }) => Promise<void>
  onCancel: () => void
}

export const InlineAddRow: React.FC<InlineAddRowProps> = ({
  existingIds,
  kind,
  onSubmit,
  onCancel,
}) => {
  const t = useT()
  const ia = t.workbench.inlineAdd
  const [id, setId] = useState('')
  const [name, setName] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [idManuallyEdited, setIdManuallyEdited] = useState(false)
  const nameInputRef = useRef<HTMLInputElement | null>(null)

  // chineseToId 处理中文 → 拼音 + 规范化;英文输入等价于直接规范化。
  const normalizedId = useMemo(() => chineseToId(id), [id])
  const conflict = existingIds.includes(normalizedId)
  const canSubmit =
    !submitting && normalizedId.length > 0 && !conflict

  // Auto-focus name input on mount —— 新 UX:先打中文名,ID 自动从拼音联动
  useEffect(() => {
    requestAnimationFrame(() => nameInputRef.current?.focus())
  }, [])

  const handleNameChange = useCallback(
    (next: string) => {
      setName(next)
      if (!idManuallyEdited) {
        setId(chineseToId(next))
      }
    },
    [idManuallyEdited],
  )

  const handleIdChange = useCallback(
    (next: string) => {
      setId(next)
      if (next.trim().length === 0) {
        setIdManuallyEdited(false)
      } else if (!idManuallyEdited) {
        setIdManuallyEdited(!isIdStillDerivedFrom(chineseToId(next), name))
      }
    },
    [idManuallyEdited, name],
  )

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return
    setSubmitting(true)
    setError(null)
    try {
      await onSubmit({ id: normalizedId, name: name.trim() })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setSubmitting(false)
    }
    // 成功场景由父组件处理 (unmount 该行),无需手动复位
  }, [canSubmit, normalizedId, name, onSubmit])

  const handleKey = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        void handleSubmit()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        onCancel()
      }
    },
    [handleSubmit, onCancel],
  )

  const namePlaceholder =
    kind === 'agent' ? ia.agentNamePlaceholder : ia.teamNamePlaceholder
  const idPlaceholder = ia.idPlaceholder

  return (
    <div className="inline-add-row">
      <div className="inline-add-row-fields">
        <input
          ref={nameInputRef}
          type="text"
          className="inline-add-input"
          value={name}
          placeholder={namePlaceholder}
          onChange={(e) => handleNameChange(e.currentTarget.value)}
          onKeyDown={handleKey}
          disabled={submitting}
        />
        <input
          type="text"
          className="inline-add-input"
          value={id}
          placeholder={idPlaceholder}
          onChange={(e) => handleIdChange(e.currentTarget.value)}
          onKeyDown={handleKey}
          disabled={submitting}
        />
        <button
          type="button"
          className="inline-add-btn inline-add-btn-ok"
          onClick={() => void handleSubmit()}
          disabled={!canSubmit}
          title={ia.confirmTitle}
        >
          {submitting ? <Loader2 size={11} className="is-spinning" /> : <Check size={11} />}
        </button>
        <button
          type="button"
          className="inline-add-btn inline-add-btn-cancel"
          onClick={onCancel}
          disabled={submitting}
          title={ia.cancelTitle}
        >
          <X size={11} />
        </button>
      </div>
      {!idManuallyEdited && normalizedId.length > 0 ? (
        <div className="inline-add-hint inline-add-hint-auto">
          {ia.autoIdPrefix}<code>{normalizedId}</code>
        </div>
      ) : normalizedId.length > 0 && normalizedId !== id.trim().toLowerCase() ? (
        <div className="inline-add-hint">
          {ia.normalizedPrefix}<code>{normalizedId}</code>
        </div>
      ) : null}
      {conflict ? (
        <div className="inline-add-hint inline-add-hint-err">
          {ia.idExists}
        </div>
      ) : null}
      {error ? <div className="inline-add-hint inline-add-hint-err">{error}</div> : null}
    </div>
  )
}
