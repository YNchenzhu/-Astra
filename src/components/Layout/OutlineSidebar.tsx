/**
 * OutlineSidebar —— 文档为主布局的大纲侧栏 (Sprint 9.2+)。
 *
 * 与现有 Sidebar (文件树)平行的替代品。从当前活跃 tab 的 markdown
 * 内容中抽取 #/##/### 标题,渲染成**扁平列表 + 缩进**(不构建 tree
 * 避免跳级问题)。点击跳转到 Editor 对应行。
 *
 * 输入变化触发重解析:
 *   - 切换 tab → activeTab.content 变
 *   - 用户编辑 → activeTab.content 变
 *   解析本身是 O(n) 线性扫描,200K 字符级文档也 < 5ms,不做防抖。
 *
 * 退化情况:
 *   - 没打开任何文件:显示空态
 *   - 打开了非文档文件(.ts/.py):显示"当前文件非 Markdown"
 *   - 文档里一个 # 都没有:显示"此文档暂无标题"
 *
 * 宽度复用 `.sidebar` 类名的默认宽度,避免 re-layout 抖动;resize
 * handle 暂不提供(下个迭代再补)。
 */

import React, { useEffect, useMemo, useRef } from 'react'
import { FileText, ListTree } from 'lucide-react'
import { useFileStore } from '../../stores/useFileStore'
import { useVisibleStartLine } from '../../stores/editorScrollSync'
import { parseOutline, isDocumentFile, type OutlineItem } from './outlineParser'
import './OutlineSidebar.css'

/**
 * 根据当前视口起始行,找到"当前可见的章节"对应 outline item 索引。
 * 策略:line ≤ visibleStartLine 的最后一个(即最近的上方标题)。
 * 若没有任何标题在 viewport 之上,返回 -1(高亮第一条做兜底)。
 */
function findActiveIndex(items: OutlineItem[], visibleLine: number): number {
  if (items.length === 0) return -1
  let candidate = -1
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    if (!it) continue
    if (it.line <= visibleLine) candidate = i
    else break
  }
  // 连第一条都在 viewport 下方,说明用户滚到了文档最顶 —— 也高亮第一条
  return candidate === -1 ? 0 : candidate
}

export const OutlineSidebar: React.FC = () => {
  const tabs = useFileStore((s) => s.tabs)
  const activeTabId = useFileStore((s) => s.activeTabId)
  const requestJump = useFileStore((s) => s.requestJump)

  const activeTab = useMemo(
    () => tabs.find((t) => t.id === activeTabId) ?? null,
    [tabs, activeTabId],
  )

  const items: OutlineItem[] = useMemo(() => {
    if (!activeTab) return []
    if (!isDocumentFile(activeTab.path) && !isDocumentFile(activeTab.name)) {
      return []
    }
    return parseOutline(activeTab.content ?? '')
  }, [activeTab])

  const isDoc =
    !!activeTab &&
    (isDocumentFile(activeTab.path) || isDocumentFile(activeTab.name))

  // Sprint 9.2+: 编辑器滚动 → 大纲高亮联动
  const visibleLine = useVisibleStartLine(activeTab?.id ?? null)
  const activeIndex = useMemo(
    () => findActiveIndex(items, visibleLine),
    [items, visibleLine],
  )

  // 高亮项若已不在 outline-list 可视区域,缓动滚过去;用户自己手动
  // 往上往下滚 list 时不想被打断,所以仅在 activeIndex *变化* 时才滚。
  const listRef = useRef<HTMLUListElement | null>(null)
  const lastActiveIndexRef = useRef<number>(-1)
  useEffect(() => {
    if (activeIndex === lastActiveIndexRef.current) return
    lastActiveIndexRef.current = activeIndex
    if (activeIndex < 0) return
    const list = listRef.current
    if (!list) return
    const el = list.children.item(activeIndex) as HTMLElement | null
    if (!el) return
    const listRect = list.getBoundingClientRect()
    const elRect = el.getBoundingClientRect()
    const outOfTop = elRect.top < listRect.top
    const outOfBottom = elRect.bottom > listRect.bottom
    if (outOfTop || outOfBottom) {
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }
  }, [activeIndex])

  return (
    <div className="sidebar outline-sidebar" role="navigation" aria-label="文档大纲">
      <div className="sidebar-header">
        <span className="sidebar-title">
          <ListTree size={11} style={{ marginRight: 5, verticalAlign: '-1px' }} />
          文档大纲
        </span>
        {activeTab ? (
          <span className="outline-sidebar-file" title={activeTab.path}>
            {activeTab.name}
          </span>
        ) : null}
      </div>
      <div className="sidebar-content outline-sidebar-content">
        {!activeTab ? (
          <EmptyState>
            <FileText size={24} strokeWidth={1.3} />
            <div>未打开任何文档</div>
            <div className="outline-empty-hint">从侧栏或文件树打开一个 .md 文件</div>
          </EmptyState>
        ) : !isDoc ? (
          <EmptyState>
            <FileText size={24} strokeWidth={1.3} />
            <div>当前文件非 Markdown</div>
            <div className="outline-empty-hint">大纲仅对 .md / .markdown / .mdx / .txt 生效</div>
          </EmptyState>
        ) : items.length === 0 ? (
          <EmptyState>
            <ListTree size={24} strokeWidth={1.3} />
            <div>此文档暂无标题</div>
            <div className="outline-empty-hint">加入 # / ## / ### 标题即可自动显示</div>
          </EmptyState>
        ) : (
          <ul className="outline-list" ref={listRef}>
            {items.map((item, idx) => (
              <li
                key={`${item.line}-${idx}`}
                className={`outline-item outline-level-${item.level}${idx === activeIndex ? ' is-active' : ''}`}
                style={{ paddingLeft: 8 + (item.level - 1) * 12 }}
                onClick={() => requestJump(item.line, 1)}
                title={`跳转到第 ${item.line} 行`}
              >
                <span className="outline-item-marker" aria-hidden>
                  {'#'.repeat(item.level)}
                </span>
                <span className="outline-item-text">{item.text}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

const EmptyState: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="outline-empty">{children}</div>
)
