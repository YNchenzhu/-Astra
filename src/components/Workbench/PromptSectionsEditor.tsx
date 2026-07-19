/**
 * PromptSectionsEditor —— 结构化提示词段落编辑器（Sprint 2b.1）
 *
 * 每个段落对应运行时 prompt 里的一段 "## 标题\n\n正文"。
 * 合成顺序由 `order` 决定，编辑器提供：
 *   ✓ 添加新段落（追加到末尾）
 *   ✓ 删除段落
 *   ✓ 上/下移调整顺序（order 重编号）
 *   ✓ 编辑标题 / 正文
 *   ✗ 内联重命名 id（id 是持久化主键,提供重命名会导致历史 JSON 引用错位）
 *
 * 数据流：父组件（Tab 2）持有 `sections: PromptSection[]`，每次改动
 * 通过 `onChange` 回调返回新的整数组。父组件再写到 draftStore。
 *
 * 为什么不用 DnD：拖拽库（react-dnd / dnd-kit）会大幅拉高依赖重量，
 * 而提示词段落一般 5-10 条，上/下移按钮足以使用。真要支持 DnD，
 * 在 Sprint 2b.2 的 tools/hooks 编辑器里再统一引入。
 */
import React, { useCallback, useMemo, useRef } from 'react'
import { Plus, Trash2, ArrowUp, ArrowDown } from 'lucide-react'
import type { PromptSection } from '../../../electron/agents/bundles/types'
import { useT } from '../../i18n'
import './PromptSectionsEditor.css'

export interface PromptSectionsEditorProps {
  sections: PromptSection[]
  onChange: (next: PromptSection[]) => void
  /** 只读时仅展示，不显示操作按钮。保留给未来 "查看其它 Agent" 等场景。 */
  readOnly?: boolean
}

/** 为新段落生成一个稳定且唯一的 id。用计数器 + 时间戳，避免两次点击
 *  添加时在同一毫秒命中相同 id。 */
function makeSectionId(existing: PromptSection[]): string {
  let n = existing.length + 1
  while (existing.some((s) => s.id === `section_${n}`)) n++
  return `section_${n}`
}

export const PromptSectionsEditor: React.FC<PromptSectionsEditorProps> = ({
  sections,
  onChange,
  readOnly,
}) => {
  const t = useT()
  const ps = t.workbench.promptSections
  // 把段落按 order 排序后再渲染；内部操作按显示顺序的索引。
  const sorted = useMemo(
    () => sections.slice().sort((a, b) => a.order - b.order),
    [sections],
  )

  // 为新增段落滚动定位用：追加后把焦点/滚动移到它
  const lastAddedIdRef = useRef<string | null>(null)

  const emit = useCallback(
    (next: PromptSection[]) => {
      // 重新编号 order,让保存时数组顺序与 order 完全一致。
      const renum = next.map((s, idx) => ({ ...s, order: idx }))
      onChange(renum)
    },
    [onChange],
  )

  const handleAdd = useCallback(() => {
    const id = makeSectionId(sorted)
    lastAddedIdRef.current = id
    emit([
      ...sorted,
      {
        id,
        title: ps.newSection,
        body: '',
        order: sorted.length,
      },
    ])
  }, [sorted, emit, ps])

  const handleDelete = useCallback(
    (idx: number) => {
      if (sorted[idx].required) {
        // required 段落不应被删除（UI 已隐藏按钮,这里防御一次）
        return
      }
      const next = sorted.slice()
      next.splice(idx, 1)
      emit(next)
    },
    [sorted, emit],
  )

  const handleMove = useCallback(
    (idx: number, direction: -1 | 1) => {
      const target = idx + direction
      if (target < 0 || target >= sorted.length) return
      const next = sorted.slice()
      ;[next[idx], next[target]] = [next[target], next[idx]]
      emit(next)
    },
    [sorted, emit],
  )

  const handleFieldChange = useCallback(
    <K extends keyof PromptSection>(idx: number, field: K, value: PromptSection[K]) => {
      const next = sorted.slice()
      next[idx] = { ...next[idx], [field]: value }
      emit(next)
    },
    [sorted, emit],
  )

  if (sorted.length === 0) {
    return (
      <div className="prompt-sections-editor">
        <div className="prompt-sections-empty">
          {ps.empty}
        </div>
        {readOnly ? null : (
          <button type="button" className="prompt-sections-add" onClick={handleAdd}>
            <Plus size={13} />
            <span>{ps.addSection}</span>
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="prompt-sections-editor">
      {/* Reading `lastAddedIdRef.current` inside this map is intentional:
          the ref tracks a transient "just-added" marker used for a
          one-shot CSS animation. It doesn't need to be reactive — a
          ref change between renders shouldn't force another pass. The
          lint targets the outer callback, so the disable goes here. */}
      {/* eslint-disable-next-line react-hooks/refs */}
      {sorted.map((section, idx) => {
        const isFirst = idx === 0
        const isLast = idx === sorted.length - 1
        const canDelete = !readOnly && !section.required
        const isLastAdded = lastAddedIdRef.current === section.id

        return (
          <div
            key={section.id}
            className={`prompt-section-card ${isLastAdded ? 'is-new' : ''}`}
          >
            <div className="prompt-section-header">
              <span className="prompt-section-index">#{idx + 1}</span>
              <input
                className="prompt-section-title-input"
                type="text"
                value={section.title}
                placeholder={ps.titlePlaceholder}
                disabled={readOnly}
                onChange={(e) => handleFieldChange(idx, 'title', e.currentTarget.value)}
              />
              {section.required ? (
                <span className="prompt-section-required-badge" title={ps.requiredTitle}>
                  {ps.required}
                </span>
              ) : null}
              {readOnly ? null : (
                <div className="prompt-section-actions">
                  <button
                    type="button"
                    className="prompt-section-icon-btn"
                    title={ps.moveUp}
                    disabled={isFirst}
                    onClick={() => handleMove(idx, -1)}
                  >
                    <ArrowUp size={12} />
                  </button>
                  <button
                    type="button"
                    className="prompt-section-icon-btn"
                    title={ps.moveDown}
                    disabled={isLast}
                    onClick={() => handleMove(idx, 1)}
                  >
                    <ArrowDown size={12} />
                  </button>
                  <button
                    type="button"
                    className="prompt-section-icon-btn prompt-section-icon-btn-danger"
                    title={canDelete ? ps.deleteSection : ps.requiredCantDelete}
                    disabled={!canDelete}
                    onClick={() => handleDelete(idx)}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              )}
            </div>

            {section.hint ? (
              <div className="prompt-section-hint">{section.hint}</div>
            ) : null}

            <textarea
              className="prompt-section-body"
              value={section.body}
              placeholder={ps.bodyPlaceholder}
              rows={Math.max(3, Math.min(16, section.body.split('\n').length + 1))}
              disabled={readOnly}
              onChange={(e) => handleFieldChange(idx, 'body', e.currentTarget.value)}
            />
          </div>
        )
      })}

      {readOnly ? null : (
        <button type="button" className="prompt-sections-add" onClick={handleAdd}>
          <Plus size={13} />
          <span>{ps.addSection}</span>
        </button>
      )}
    </div>
  )
}
