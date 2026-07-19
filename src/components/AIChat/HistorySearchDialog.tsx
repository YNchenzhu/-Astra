import React, { useMemo, useState } from 'react'
import { Search, X } from 'lucide-react'
import type { ChatMessage, ConversationSearchResult } from '../../types'
import { searchConversations } from '../../services/conversationAPI'
import { getActiveBundleId } from '../../stores/bundleStore'
import { useChatStore } from '../../stores/useChatStore'

interface HistorySearchDialogProps {
  open: boolean
  onClose: () => void
  onSelectMessage: (messageId: string) => void
  onLoadConversation?: (convId: string) => void
  workspacePath?: string
}

export const HistorySearchDialog: React.FC<HistorySearchDialogProps> = ({
  open,
  onClose,
  onSelectMessage,
  onLoadConversation,
  workspacePath,
}) => {
  // Subscribe directly so "current conversation" search reflects live message
  // content while streaming (ChatPanel no longer holds a `messages` subscription
  // to pass down). When closed this returns null below; the subscription cost is
  // a single no-op re-render per delta.
  const messages = useChatStore((s) => s.messages)
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<'current' | 'all'>('current')
  const [crossResults, setCrossResults] = useState<ConversationSearchResult[]>([])
  const [crossLoading, setCrossLoading] = useState(false)

  // Current conversation search
  const currentResults = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    if (!normalizedQuery) return []

    return messages
      .filter((message) => message.content.toLowerCase().includes(normalizedQuery))
      .slice(-200)
      .reverse()
  }, [messages, query])

  // Cross-conversation search
  const handleCrossSearch = async (searchQuery: string) => {
    if (!searchQuery.trim()) {
      setCrossResults([])
      return
    }
    setCrossLoading(true)
    try {
      // Narrow the cross-conversation search to the current bundle, so
      // a "notes" bundle doesn't surface results from "code-dev" when
      // the user expects them to be scoped.
      const results = await searchConversations(searchQuery, workspacePath, getActiveBundleId())
      setCrossResults(results)
    } catch {
      setCrossResults([])
    } finally {
      setCrossLoading(false)
    }
  }

  const handleQueryChange = (newQuery: string) => {
    setQuery(newQuery)
    if (scope === 'all') {
      handleCrossSearch(newQuery)
    }
  }

  const handleScopeChange = (newScope: 'current' | 'all') => {
    setScope(newScope)
    if (newScope === 'all' && query.trim()) {
      handleCrossSearch(query)
    }
  }

  const activeResults = scope === 'current' ? currentResults : crossResults

  if (!open) return null

  return (
    <div className="history-search-overlay" onClick={onClose}>
      <div className="history-search-dialog" onClick={(event) => event.stopPropagation()}>
        <div className="history-search-header">
          <div className="history-search-title">
            <Search size={14} />
            <span>历史搜索</span>
          </div>
          <div className="history-search-scope">
            <button
              className={`history-search-scope-btn ${scope === 'current' ? 'active' : ''}`}
              onClick={() => handleScopeChange('current')}
            >
              当前会话
            </button>
            <button
              className={`history-search-scope-btn ${scope === 'all' ? 'active' : ''}`}
              onClick={() => handleScopeChange('all')}
            >
              所有会话
            </button>
          </div>
          <button className="history-search-close" onClick={onClose}>
            <X size={14} />
          </button>
        </div>

        <div className="history-search-input-wrap">
          <input
            className="history-search-input"
            placeholder={scope === 'current' ? '搜索当前会话内容' : '搜索所有会话内容'}
            value={query}
            onChange={(event) => handleQueryChange(event.target.value)}
            autoFocus
          />
        </div>

        <div className="history-search-results">
          {query.trim().length === 0 ? (
            <div className="history-search-empty">
              输入关键词搜索{scope === 'current' ? '当前会话' : '所有会话'}消息
            </div>
          ) : crossLoading ? (
            <div className="history-search-empty">搜索中...</div>
          ) : activeResults.length === 0 ? (
            <div className="history-search-empty">没有匹配结果</div>
          ) : scope === 'current' ? (
            (activeResults as ChatMessage[]).map((message) => {
              const preview = message.content.trim().replace(/\s+/g, ' ').slice(0, 160)
              return (
                <button
                  key={message.id}
                  className="history-search-item"
                  onClick={() => {
                    onSelectMessage(message.id)
                    onClose()
                  }}
                >
                  <span className="history-search-item-role">
                    {message.role === 'user' ? '你' : '太初'}
                  </span>
                  <span className="history-search-item-text">{preview || '(空消息)'}</span>
                </button>
              )
            })
          ) : (
            (activeResults as ConversationSearchResult[]).map((result) => (
              <button
                key={`${result.conversationId}-${result.messageId}`}
                className="history-search-item"
                onClick={() => {
                  if (onLoadConversation) {
                    onLoadConversation(result.conversationId)
                  }
                  onClose()
                }}
              >
                <div className="history-search-item-cross">
                  <span className="history-search-item-conv-title">
                    {result.conversationTitle}
                  </span>
                  <span className="history-search-item-role">
                    {result.role === 'user' ? '你' : '太初'}
                  </span>
                </div>
                <span className="history-search-item-text">
                  {result.preview || '(空消息)'}
                </span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
