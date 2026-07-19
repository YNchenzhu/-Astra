import React, { useCallback, useState } from 'react'
import { Brain, ChevronDown, ChevronRight, Paperclip, FileText, Copy, Check } from 'lucide-react'
import type { ChatMessage as ChatMessageType } from '../../../types'
import { useFileStore, findTabForWorkspacePath } from '../../../stores/useFileStore'
import { useWorkspaceStore } from '../../../stores/useWorkspaceStore'
import { readTabContent } from '../../../services/openBehavior'
import { isAbsolutePath, joinWorkspaceRelative, toRelativePath } from '../../../services/pathUtils'
import type { ChatMessageStoreSliceProps } from './types'
import {
  REF_OPEN_LANG_MAP,
  refPathBasename,
  formatMessageTimestamp,
  COMPACT_TOKEN_DIGITS,
} from './helpers'
import { useT } from '../../../i18n'

/** Read-only collapsible card for paths the user attached when sending (mirrors ChatInput styling). */
export const UserMessageReferencedFiles: React.FC<{ paths: string[] }> = ({ paths }) => {
  const t = useT()
  const [expanded, setExpanded] = useState(true)

  const openInEditor = (filePath: string) => {
    const fileState = useFileStore.getState()
    const root = useWorkspaceStore.getState().rootPath
    const existing = findTabForWorkspacePath(fileState.tabs, filePath, root)
    if (existing) {
      fileState.setActiveTab(existing.id)
      return
    }
    const absolute = isAbsolutePath(filePath) ? filePath : joinWorkspaceRelative(root, filePath)
    void (async () => {
      try {
        const rel = toRelativePath(absolute, root)
        const name = rel.split('/').pop() || rel
        const ext = name.split('.').pop() || ''
        // 统一打开行为表:图片/文档预览类不做 UTF-8 全文读取。
        const content = await readTabContent(absolute, name)
        fileState.openFile({
          id: `msg-ref-${Date.now()}-${name}`,
          name,
          path: rel,
          language: REF_OPEN_LANG_MAP[ext] || 'plaintext',
          content,
          isModified: false,
        })
      } catch {
        /* file missing or not in workspace */
      }
    })()
  }

  if (paths.length === 0) return null

  return (
    <div className="chat-ref-card chat-ref-card--in-message">
      <button
        type="button"
        className="chat-ref-card-header"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="chat-ref-card-header-left">
          <Paperclip size={12} />
          <span>{t.message.referencedFiles}</span>
          <span className="chat-ref-card-count">{paths.length}</span>
        </div>
        <ChevronDown
          size={12}
          className={`chat-ref-card-chevron ${expanded ? 'expanded' : ''}`}
        />
      </button>
      {expanded && (
        <div className="chat-ref-card-body">
          {paths.map((file) => (
            <span
              key={file}
              className="chat-ref-tag chat-ref-tag--message"
              role="button"
              tabIndex={0}
              title={file}
              onClick={(e) => { e.stopPropagation(); openInEditor(file) }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  openInEditor(file)
                }
              }}
            >
              <FileText size={11} className="chat-ref-tag-icon" />
              <span className="chat-ref-tag-name" title={file}>{refPathBasename(file)}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

export const MemoryCitation: React.FC<{
  isLast: boolean
  recalledMemories: ChatMessageStoreSliceProps['recalledMemories']
}> = ({ isLast, recalledMemories }) => {
  const t = useT()
  const [expanded, setExpanded] = useState(false)

  if (!isLast || recalledMemories.length === 0) return null

  return (
    <div className="memory-citation">
      <button className="memory-citation-toggle" onClick={() => setExpanded(!expanded)}>
        <Brain size={12} />
        <span>{t.message.memoryCitation(recalledMemories.length)}</span>
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
      </button>
      {expanded && (
        <div className="memory-citation-list">
          {recalledMemories.map((mem) => (
            <div key={mem.filename} className="memory-citation-item">
              <span className="memory-citation-name">{mem.name}</span>
              <span className="memory-citation-type">
                {(mem.type && (t.message.memoryType as Record<string, string>)[mem.type]) || mem.type || ''}
              </span>
              {mem.matchSnippet && (
                <span className="memory-citation-snippet">{mem.matchSnippet}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export const MessageTimestamp: React.FC<{ ts: number }> = ({ ts }) => {
  if (!ts) return null
  const label = formatMessageTimestamp(ts)
  if (!label) return null
  return (
    <time
      className="chat-message-time"
      dateTime={new Date(ts).toISOString()}
      title={new Date(ts).toLocaleString()}
    >
      {label}
    </time>
  )
}

export const MessageCopyButton: React.FC<{ getText: () => string }> = ({ getText }) => {
  const t = useT()
  const [copied, setCopied] = useState(false)
  const handleCopy = useCallback(async () => {
    const text = getText().trim()
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      // Best-effort. Some sandboxed contexts deny clipboard writes; nothing
      // useful we can do here without a confirmation dialog that would
      // distract from the (rare) failure.
    }
  }, [getText])
  return (
    <button
      type="button"
      className={`chat-message-copy chat-message-icon-btn${copied ? ' chat-message-copy--copied' : ''}`}
      onClick={handleCopy}
      title={copied ? t.message.copyDone : t.message.copyMessageTitle}
      aria-label={copied ? 'Message copied' : 'Copy message'}
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
    </button>
  )
}

export const CompactBoundaryRow: React.FC<{
  boundary: NonNullable<ChatMessageType['compactBoundary']> | undefined
}> = ({ boundary }) => {
  const t = useT()
  const level = boundary?.level ?? 'unknown'
  const reclaimed =
    typeof boundary?.reclaimedTokens === 'number' && boundary.reclaimedTokens > 0
      ? boundary.reclaimedTokens
      : undefined
  const levelLabel = (t.message.compactLevel as Record<string, string>)[level] ?? level
  const parts: string[] = [t.message.compactCompressed, levelLabel]
  if (reclaimed !== undefined) {
    parts.push(t.message.compactReleased(COMPACT_TOKEN_DIGITS.format(reclaimed)))
  }
  return (
    <div className="chat-compact-boundary" role="separator" aria-label="Conversation compacted">
      <span className="chat-compact-boundary-text">{parts.join(' · ')}</span>
    </div>
  )
}
