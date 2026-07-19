import React, { useState, useRef, useEffect, useCallback } from 'react'
import { X, MessageSquarePlus } from 'lucide-react'
import type { TabInfo } from '../../types'
import { useChatStore } from '../../stores/useChatStore'
import { clampFixedContextMenuPosition } from '../../utils/contextMenuClamp'
import './TabBar.css'

interface TabBarProps {
  tabs: TabInfo[]
  activeTabId: string | null
  onSelectTab: (tabId: string) => void
  onCloseTab: (tabId: string) => void
}

const langIcon = (language: string) => {
  const colors: Record<string, string> = {
    typescript: '#3178c6',
    javascript: '#f1e05a',
    json: '#cbcb41',
    markdown: '#519aba',
    css: '#663399',
    html: '#e34c26',
    python: '#3572a5',
    rust: '#dea584',
    go: '#00add8',
    java: '#b07219',
    shell: '#89e051',
    yaml: '#cb171e',
    xml: '#0060ac',
    sql: '#e38c00',
    plaintext: '#6c7086',
  }
  return colors[language] || colors.plaintext
}

const langLabel = (language: string) => {
  const labels: Record<string, string> = {
    typescript: 'TS',
    javascript: 'JS',
    json: '{ }',
    markdown: 'MD',
    css: 'CSS',
    html: '<>',
    python: 'PY',
    rust: 'RS',
    go: 'GO',
    java: 'JV',
    shell: 'SH',
    yaml: 'YML',
    xml: 'XML',
    sql: 'SQL',
    plaintext: '',
  }
  return labels[language] || ''
}

const TabBarInner: React.FC<TabBarProps> = ({ tabs, activeTabId, onSelectTab, onCloseTab }) => {
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; path: string } | null>(null)
  const ctxRef = useRef<HTMLDivElement>(null)
  const barRef = useRef<HTMLDivElement>(null)

  // The bar hides its horizontal scrollbar, so map the (vertical) wheel to
  // horizontal scrolling — otherwise overflowed tabs are unreachable by mouse.
  const handleWheel = useCallback((e: React.WheelEvent) => {
    const bar = barRef.current
    if (!bar || bar.scrollWidth <= bar.clientWidth) return
    bar.scrollLeft += e.deltaY + e.deltaX
  }, [])

  // Keep the active tab visible when activated from elsewhere (command
  // palette, search, AI diff focus, …), not just by direct clicks.
  useEffect(() => {
    if (!activeTabId) return
    barRef.current
      ?.querySelector('.tab.active')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeTabId])

  const handleCtx = useCallback((e: React.MouseEvent, path: string) => {
    e.preventDefault()
    e.stopPropagation()
    const { x, y } = clampFixedContextMenuPosition(e.clientX, e.clientY, 200, 80)
    setCtxMenu({ x, y, path })
  }, [])

  const handleRefToChat = useCallback(() => {
    if (ctxMenu) useChatStore.getState().toggleReferencedFile(ctxMenu.path)
    setCtxMenu(null)
  }, [ctxMenu])

  useEffect(() => {
    if (!ctxMenu) return
    const dismiss = (e: MouseEvent) => {
      if (ctxRef.current && !ctxRef.current.contains(e.target as Node)) setCtxMenu(null)
    }
    document.addEventListener('mousedown', dismiss)
    return () => document.removeEventListener('mousedown', dismiss)
  }, [ctxMenu])

  return (
    <div className="tab-bar" ref={barRef} onWheel={handleWheel}>
      {tabs.map((tab) => (
        <div
          key={tab.id}
          className={`tab ${tab.id === activeTabId ? 'active' : ''}`}
          title={tab.path}
          onClick={() => onSelectTab(tab.id)}
          onContextMenu={(e) => handleCtx(e, tab.path)}
        >
          <span
            className="tab-lang-icon"
            style={{ color: langIcon(tab.language) }}
          >
            {langLabel(tab.language)}
          </span>
          <span className="tab-name">{tab.name}</span>
          {tab.isModified && <span className="tab-modified-dot" />}
          <button
            className="tab-close"
            onClick={(e) => {
              e.stopPropagation()
              onCloseTab(tab.id)
            }}
          >
            <X size={14} />
          </button>
        </div>
      ))}
      {ctxMenu && (
        <div
          ref={ctxRef}
          className="tab-context-menu"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
        >
          <button className="tab-context-item" onClick={handleRefToChat}>
            <MessageSquarePlus size={13} />
            <span>引用到聊天</span>
          </button>
        </div>
      )}
    </div>
  )
}

export const TabBar = React.memo(TabBarInner)
