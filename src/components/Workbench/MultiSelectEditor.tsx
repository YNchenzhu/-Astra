/**
 * MultiSelectEditor —— 字符串数组多选编辑（Sprint 2b.2）
 *
 * 用于工具 / 技能 / MCP 三个名称数组的编辑。UX：
 *
 *   ┌─────────────────────────────────────────────────────┐
 *   │ [标签A ×] [标签B ×] [标签C ×]                       │
 *   │ ┌─────────────────────────┐ [+ 全部]                │
 *   │ │ 下拉(含搜索)          ▼ │                        │
 *   │ └─────────────────────────┘                        │
 *   └─────────────────────────────────────────────────────┘
 *
 * 核心交互：
 *   - 已选项以标签形式展示,`×` 按钮删除单项
 *   - 下拉列表展示"目录中尚未被选中"的选项,带搜索框过滤
 *   - 点击下拉项直接加入,下拉自动收起
 *   - `allowCustom` 时,搜索框内容在下拉无匹配时可作为"自由输入项"添加
 *   - `wildcardValue`（默认 "*"）作为单选特殊项:一旦勾选自动清空其它所有项
 *
 * 目录加载状态:
 *   - loading 时展示 placeholder,禁止下拉
 *   - 目录为空且 allowCustom 时,仍可手动输入添加
 *
 * 不做拖拽排序:名称数组的顺序不影响语义,保留插入顺序即可。
 */

import React, { useCallback, useMemo, useRef, useState } from 'react'
import { Plus, X, ChevronDown, Loader2, RefreshCw, Zap } from 'lucide-react'
import { useT } from '../../i18n'
import './MultiSelectEditor.css'

export interface MultiSelectEditorProps {
  /** 当前已选条目。 */
  value: string[] | undefined
  /** 写回回调。空数组表示"清空",父组件需在 Save 时转为 null（由 draftStore 处理）。 */
  onChange: (next: string[] | undefined) => void

  /** 可选项目录。空数组 + loading=false + allowCustom=false → 显示"无可选项"。 */
  catalog: string[]
  loading?: boolean
  /** 触发"重新加载目录"的按钮（可选）。 */
  onRefreshCatalog?: () => void

  /** 允许手动输入未出现在目录中的条目（适合 tools 白名单类场景）。 */
  allowCustom?: boolean
  /**
   * 通配值。设为非空时,一旦该值出现在 value 中,UI 视为"全选",
   * 并隐藏其它项；清除通配值会恢复常规多选。默认 `*`。
   * 设为 `null` 禁用通配能力（如 skills / mcpServers 没有通配概念）。
   */
  wildcardValue?: string | null
  /** 通配项在 UI 中的显示文本,默认 "全部(*)"。 */
  wildcardLabel?: string

  /** 空状态提示（value 为空数组时的 UI 文案）。 */
  emptyText?: string

  /** 占位符文本（下拉框按钮上的提示）。 */
  placeholder?: string

  /**
   * "运行时自动注入"项的名字集合（如 `TodoWrite`）。
   *
   * 这些条目由运行时无条件挂到子智能体工具面，无需出现在白名单里；
   * 这里只负责 **标注**：
   *   - 下拉列表里每项后面加一个 ⚡ 徽章 + "自动注入" 小字。
   *   - 如果用户仍选了它，已选标签上也显示徽章与 tooltip。
   *
   * 如果想真正禁用，用 `禁用的工具` 列表把它列进 `disallowedTools`。
   */
  autoInjectedItems?: ReadonlySet<string> | string[]
  /** 当某项属于自动注入集合时，显示的 tooltip 文案。默认简体中文。 */
  autoInjectedHint?: string
}

export const MultiSelectEditor: React.FC<MultiSelectEditorProps> = ({
  value,
  onChange,
  catalog,
  loading,
  onRefreshCatalog,
  allowCustom = false,
  wildcardValue = '*',
  wildcardLabel,
  emptyText,
  placeholder,
  autoInjectedItems,
  autoInjectedHint,
}) => {
  const t = useT()
  const ms = t.workbench.multiSelect
  const wildcardLabelR = wildcardLabel ?? ms.defaultWildcardLabel
  const emptyTextR = emptyText ?? ms.defaultEmpty
  const placeholderR = placeholder ?? ms.defaultPlaceholder
  const autoInjectedHintR = autoInjectedHint ?? ms.defaultAutoHint
  const selected: string[] = useMemo(() => value ?? [], [value])
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [query, setQuery] = useState('')
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const autoInjectedSet = useMemo<ReadonlySet<string>>(
    () =>
      autoInjectedItems instanceof Set
        ? autoInjectedItems
        : new Set(Array.isArray(autoInjectedItems) ? autoInjectedItems : []),
    [autoInjectedItems],
  )
  const isAutoInjected = useCallback(
    (name: string) => autoInjectedSet.has(name),
    [autoInjectedSet],
  )

  const hasWildcard =
    wildcardValue !== null && selected.length === 1 && selected[0] === wildcardValue

  const availableOptions = useMemo(() => {
    // 已选的不再出现在下拉中。通配值作为"特殊首项"单独列出。
    const selectedSet = new Set(selected)
    const out = catalog.filter((name) => !selectedSet.has(name))
    return out
  }, [catalog, selected])

  const filteredOptions = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return availableOptions
    return availableOptions.filter((name) => name.toLowerCase().includes(q))
  }, [availableOptions, query])

  const openDropdown = useCallback(() => {
    setDropdownOpen(true)
    setQuery('')
    // 让搜索框在下一次渲染后拿到焦点
    requestAnimationFrame(() => searchInputRef.current?.focus())
  }, [])

  const closeDropdown = useCallback(() => {
    setDropdownOpen(false)
    setQuery('')
  }, [])

  const commitNext = useCallback(
    (next: string[]) => {
      // 空数组通过 onChange(undefined) 往上传,由 draftStore 的 null-哨兵
      // 机制翻译为"清空此字段";非空则原样传。
      if (next.length === 0) {
        onChange(undefined)
      } else {
        // 去重（保持插入顺序）
        const seen = new Set<string>()
        const dedup: string[] = []
        for (const n of next) {
          if (!seen.has(n)) {
            seen.add(n)
            dedup.push(n)
          }
        }
        onChange(dedup)
      }
    },
    [onChange],
  )

  const addItem = useCallback(
    (name: string) => {
      const trimmed = name.trim()
      if (!trimmed) return
      // 勾选通配 → 清空其它项,仅保留通配
      if (wildcardValue !== null && trimmed === wildcardValue) {
        commitNext([wildcardValue])
        closeDropdown()
        return
      }
      // 已有通配 → 先清除通配
      const base = hasWildcard ? [] : selected
      commitNext([...base, trimmed])
      closeDropdown()
    },
    [commitNext, selected, hasWildcard, wildcardValue, closeDropdown],
  )

  const removeItem = useCallback(
    (name: string) => {
      commitNext(selected.filter((n) => n !== name))
    },
    [commitNext, selected],
  )

  const handleSearchEnter = useCallback(() => {
    const q = query.trim()
    if (!q) return
    // 回车:若与目录某项完全匹配则加它;若无匹配且允许自定义则加自定义项
    const exact = availableOptions.find((n) => n.toLowerCase() === q.toLowerCase())
    if (exact) {
      addItem(exact)
      return
    }
    if (allowCustom) {
      addItem(q)
    }
  }, [query, availableOptions, allowCustom, addItem])

  const canAddWildcard =
    wildcardValue !== null && !hasWildcard && !selected.includes(wildcardValue)

  return (
    <div className="multi-select-editor" onBlur={(e) => {
      // 点击下拉外部时收起;currentTarget 是整个组件容器
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
        closeDropdown()
      }
    }}>
      {/* 已选标签列表 */}
      {selected.length === 0 ? (
        <div className="multi-select-empty">{emptyTextR}</div>
      ) : hasWildcard ? (
        <div className="multi-select-wildcard-notice">
          <span className="multi-select-tag is-wildcard">
            <span>{wildcardLabelR}</span>
            <button
              type="button"
              className="multi-select-tag-remove"
              onClick={() => removeItem(wildcardValue!)}
              aria-label={ms.removeWildcard}
            >
              <X size={10} />
            </button>
          </span>
          <span className="multi-select-wildcard-hint">
            {ms.wildcardNotice}
          </span>
        </div>
      ) : (
        <div className="multi-select-tags">
          {selected.map((name) => {
            const auto = isAutoInjected(name)
            return (
              <span
                key={name}
                className={`multi-select-tag${auto ? ' is-auto-injected' : ''}`}
                title={auto ? autoInjectedHintR : undefined}
              >
                <span className="multi-select-tag-name">{name}</span>
                {auto ? (
                  <Zap
                    size={10}
                    className="multi-select-tag-auto-icon"
                    aria-label={ms.autoInjectedAria}
                  />
                ) : null}
                <button
                  type="button"
                  className="multi-select-tag-remove"
                  onClick={() => removeItem(name)}
                  aria-label={ms.removePrefix(name)}
                >
                  <X size={10} />
                </button>
              </span>
            )
          })}
        </div>
      )}

      {/* 下拉 + 快捷按钮 */}
      <div className="multi-select-controls">
        {dropdownOpen ? (
          <div className="multi-select-dropdown">
            <input
              ref={searchInputRef}
              type="text"
              className="multi-select-search"
              placeholder={
                loading
                  ? ms.catalogLoading
                  : allowCustom
                    ? ms.searchOrType
                    : ms.search
              }
              value={query}
              onChange={(e) => setQuery(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  handleSearchEnter()
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  closeDropdown()
                }
              }}
            />
            <div className="multi-select-dropdown-list">
              {loading ? (
                <div className="multi-select-dropdown-loading">
                  <Loader2 size={12} className="is-spinning" />
                  <span>{ms.loadingCatalog}</span>
                </div>
              ) : filteredOptions.length === 0 ? (
                <div className="multi-select-dropdown-empty">
                  {allowCustom && query.trim().length > 0 ? (
                    <>
                      {ms.enterAddPrefix}<kbd>Enter</kbd>{ms.enterAddSuffix}
                      <span className="multi-select-dropdown-custom">
                        「{query.trim()}」
                      </span>
                    </>
                  ) : catalog.length === 0 ? (
                    <>{ms.catalogEmpty}{onRefreshCatalog ? ms.tryRefresh : null}</>
                  ) : (
                    ms.noMatch
                  )}
                </div>
              ) : (
                filteredOptions.map((name) => {
                  const auto = isAutoInjected(name)
                  return (
                    <button
                      key={name}
                      type="button"
                      className={`multi-select-dropdown-item${auto ? ' is-auto-injected' : ''}`}
                      onClick={() => addItem(name)}
                      title={auto ? autoInjectedHintR : undefined}
                    >
                      <span className="multi-select-dropdown-item-name">{name}</span>
                      {auto ? (
                        <span className="multi-select-dropdown-item-auto">
                          <Zap size={10} />
                          <span>{ms.autoInjected}</span>
                        </span>
                      ) : null}
                      <Plus size={11} className="multi-select-dropdown-item-plus" />
                    </button>
                  )
                })
              )}
            </div>
            {onRefreshCatalog ? (
              <button
                type="button"
                className="multi-select-dropdown-refresh"
                onClick={() => onRefreshCatalog()}
                title={ms.refreshTitle}
              >
                <RefreshCw size={11} />
                <span>{ms.refresh}</span>
              </button>
            ) : null}
          </div>
        ) : (
          <button
            type="button"
            className="multi-select-trigger"
            onClick={openDropdown}
            disabled={hasWildcard}
            title={hasWildcard ? ms.wildcardDisabledTitle : undefined}
          >
            <Plus size={11} />
            <span>{placeholderR}</span>
            <ChevronDown size={11} className="multi-select-trigger-chevron" />
          </button>
        )}

        {canAddWildcard ? (
          <button
            type="button"
            className="multi-select-wildcard-btn"
            onClick={() => addItem(wildcardValue!)}
            title={ms.selectAllTitle}
          >
            {wildcardLabelR}
          </button>
        ) : null}
      </div>
    </div>
  )
}
