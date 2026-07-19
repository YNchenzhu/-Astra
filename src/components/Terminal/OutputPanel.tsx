import React, { useRef, useEffect, useState, useCallback } from 'react'
import { X, Trash2, Search, ArrowDown } from 'lucide-react'
import { useOutputStore } from '../../stores/useOutputStore'
import { useT } from '../../i18n'
import './OutputPanel.css'

function formatTime(date: Date) {
  const h = date.getHours().toString().padStart(2, '0')
  const m = date.getMinutes().toString().padStart(2, '0')
  const s = date.getSeconds().toString().padStart(2, '0')
  return `${h}:${m}:${s}`
}

export const OutputPanel: React.FC = () => {
  const t = useT()
  const channelLabel = (id: string, fallback: string) =>
    id === 'tasks' ? t.output.channelTasks
      : id === 'lsp' ? t.output.channelLsp
      : id === 'app' ? t.output.channelApp
      : fallback
  const channels = useOutputStore((s) => s.channels)
  const activeChannelId = useOutputStore((s) => s.activeChannelId)
  const setActiveChannel = useOutputStore((s) => s.setActiveChannel)
  const clearChannel = useOutputStore((s) => s.clearChannel)
  const clearAll = useOutputStore((s) => s.clearAll)
  const listRef = useRef<HTMLDivElement>(null)
  const [filterText, setFilterText] = useState('')
  const [showFilter, setShowFilter] = useState(false)
  const [autoScroll, setAutoScroll] = useState(true)

  const activeChannel = channels.find((c) => c.id === activeChannelId)
  const entries = activeChannel?.entries || []

  const filteredEntries = filterText
    ? entries.filter((e) => e.message.toLowerCase().includes(filterText.toLowerCase()))
    : entries

  // Auto-scroll to bottom on new entries (when autoScroll is enabled)
  useEffect(() => {
    if (autoScroll && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight
    }
  }, [filteredEntries.length, autoScroll])

  const handleScroll = useCallback(() => {
    if (!listRef.current) return
    const { scrollTop, scrollHeight, clientHeight } = listRef.current
    const isAtBottom = scrollHeight - scrollTop - clientHeight < 30
    setAutoScroll(isAtBottom)
  }, [])

  const scrollToBottom = useCallback(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight
      setAutoScroll(true)
    }
  }, [])

  return (
    <div className="output-panel">
      <div className="output-toolbar">
        <div className="output-toolbar-left">
          <select
            className="output-channel-select"
            value={activeChannelId}
            onChange={(e) => setActiveChannel(e.target.value)}
          >
            {channels.map((ch) => (
              <option key={ch.id} value={ch.id}>{channelLabel(ch.id, ch.label)}</option>
            ))}
          </select>
          <span className="output-entry-count">{t.output.entryCount(filteredEntries.length)}</span>
        </div>
        <div className="output-toolbar-right">
          <button
            className={`output-action-btn ${showFilter ? 'active' : ''}`}
            onClick={() => setShowFilter(!showFilter)}
            title={t.output.searchFilter}
          >
            <Search size={13} />
          </button>
          {!autoScroll && (
            <button
              className="output-action-btn output-scroll-btn"
              onClick={scrollToBottom}
              title={t.output.scrollToBottom}
            >
              <ArrowDown size={13} />
            </button>
          )}
          <button
            className="output-action-btn"
            onClick={() => clearChannel(activeChannelId)}
            title={t.output.clearCurrent}
          >
            <Trash2 size={13} />
          </button>
          <button
            className="output-action-btn"
            onClick={clearAll}
            title={t.output.clearAll}
          >
            <X size={13} />
          </button>
        </div>
      </div>

      {showFilter && (
        <div className="output-filter-row">
          <Search size={12} className="output-filter-icon" />
          <input
            className="output-filter-input"
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
            placeholder={t.output.filterPlaceholder}
            autoFocus
          />
          {filterText && (
            <button className="output-filter-clear" onClick={() => setFilterText('')}>×</button>
          )}
        </div>
      )}

      <div className="output-content" ref={listRef} onScroll={handleScroll}>
        {filteredEntries.length === 0 ? (
          <div className="output-empty">
            <span>{filterText ? t.output.noMatch : t.output.noOutput}</span>
          </div>
        ) : (
          filteredEntries.map((entry, i) => (
            <div key={i} className={`output-line output-${entry.type || 'info'}`}>
              <span className="output-line-time">[{formatTime(entry.timestamp)}]</span>
              <span className="output-line-message">{entry.message}</span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
