/**
 * MarkdownPreview —— Markdown 实时预览面板 (Sprint 9.2+)。
 *
 * 纯渲染组件:接收 content 字符串,走 react-markdown + remark-gfm
 * 输出 HTML。支持:
 *   - GFM 表格 / 任务列表 / 删除线 / 自动链接
 *   - 代码块语法高亮(monaco 风格的字体,不带 highlight.js;保持轻量)
 *   - 外部链接 `target="_blank" rel="noreferrer"` 安全打开
 *
 * 不实现(trade-off):
 *   - 行级滚动同步(编辑器滚到第 N 行时预览滚到对应处) —— 这需要
 *     建立 markdown AST 到 DOM 节点的行号映射,复杂度高,放 Sprint 9.3。
 *     当前实现是"静态两个滚动容器独立滚",对大多数文档已足够可用。
 *
 * 性能:react-markdown 内部用了 unified/remark 管线,对中等文档
 * (< 50K 字符) 解析 < 20ms;依赖用户 debounce 输入(Monaco 默认
 * 300ms 聚合),不做额外防抖。
 */

import React, { useEffect, useMemo, useRef } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useFileStore } from '../../stores/useFileStore'
import { useVisibleStartLine } from '../../stores/editorScrollSync'
import { parseOutline } from './outlineParser'
import './MarkdownPreview.css'

export interface MarkdownPreviewProps {
  content: string
  /** 可选:额外 className,用于让上层调整宽度/边框 */
  className?: string
  /**
   * Sprint 9.2+: 开启与 Monaco 视口的滚动同步。
   * 仅在 split 模式下推荐开启(preview 模式下没有同时可见的编辑器,
   * 同步只会在"切回编辑时残留位置"起作用)。
   * 默认 false —— 独立的 preview 容器不被动滚动,用户体验更稳定。
   */
  syncWithEditor?: boolean
}

export const MarkdownPreview: React.FC<MarkdownPreviewProps> = ({
  content,
  className,
  syncWithEditor = false,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const activeTabId = useFileStore((s) => s.activeTabId)
  const visibleLine = useVisibleStartLine(syncWithEditor ? activeTabId : null)

  // 与 OutlineSidebar 同源解析:两者对标题的识别必须一致,preview
  // 里第 i 个 heading element 才能对应 outline items[i]。
  const items = useMemo(() => (syncWithEditor ? parseOutline(content) : []), [
    syncWithEditor,
    content,
  ])

  // 找当前 viewport 起始行对应的 heading 索引
  const activeIndex = useMemo(() => {
    if (!syncWithEditor || items.length === 0) return -1
    let candidate = -1
    for (let i = 0; i < items.length; i++) {
      const it = items[i]
      if (!it) continue
      if (it.line <= visibleLine) candidate = i
      else break
    }
    return candidate === -1 ? 0 : candidate
  }, [syncWithEditor, items, visibleLine])

  const lastScrolledIndexRef = useRef<number>(-1)
  useEffect(() => {
    if (!syncWithEditor) return
    if (activeIndex < 0) return
    if (activeIndex === lastScrolledIndexRef.current) return
    lastScrolledIndexRef.current = activeIndex

    const container = containerRef.current
    if (!container) return
    // react-markdown 渲染后,heading 元素按原顺序出现
    const headings = container.querySelectorAll<HTMLElement>(
      'h1, h2, h3, h4, h5, h6',
    )
    const target = headings.item(activeIndex)
    if (!target) return

    // 使用 container 相对滚动,不用 scrollIntoView(避免整页跳动)
    const scrollParent = container
    const parentRect = scrollParent.getBoundingClientRect()
    const targetRect = target.getBoundingClientRect()
    const delta = targetRect.top - parentRect.top - 12 // 留 12px 顶边距
    scrollParent.scrollTop += delta
  }, [syncWithEditor, activeIndex])

  return (
    <div
      className={`markdown-preview${className ? ' ' + className : ''}`}
      ref={containerRef}
    >
      <div className="markdown-preview-inner">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            // 外链默认新窗口 + rel,避免 opener 泄露
            a: ({ href, children, ...props }) => (
              <a
                href={href}
                target={href && /^https?:/i.test(href) ? '_blank' : undefined}
                rel={href && /^https?:/i.test(href) ? 'noreferrer noopener' : undefined}
                {...props}
              >
                {children}
              </a>
            ),
          }}
        >
          {content || ''}
        </ReactMarkdown>
      </div>
    </div>
  )
}
