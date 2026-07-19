/**
 * RetrievalCitation — P1-6 citation UI for auto-recalled context.
 *
 * Surfaces the workspace-index code snippets (`workspace_recall`) and
 * attachment snippets (`attachment_recall`) that the main process injected
 * into the current turn's context via semantic retrieval. Previously these
 * `workspace_recall` / `attachment_recall` stream events were emitted by
 * `electron/ai/streamHandler.ts` but had no renderer consumer, so the user
 * never saw which files fed the assistant's answer.
 *
 * Reads the store directly (like `PreflightDenialToast` / `OrchestrationTimeline`)
 * so it doesn't need prop-threading through `ChatMessageList` → `ChatMessage`.
 * The store fields are cleared on every turn boundary (see
 * `lifecycleStreamEvents` + `mainStreamRouter` `task_terminated`) and re-set by
 * the post-`message_stop` recall events, so the strip reflects the latest turn.
 */
import React, { useState } from 'react'
import { FileSearch, Paperclip, ChevronDown, ChevronRight } from 'lucide-react'
import { useChatStore } from '../../stores/useChatStore'

function basename(p: string): string {
  const parts = p.split(/[\\/]/)
  return parts[parts.length - 1] || p
}

export const RetrievalCitation: React.FC = () => {
  const workspaceHits = useChatStore((s) => s.recalledWorkspaceHits)
  const attachmentHits = useChatStore((s) => s.recalledAttachmentHits)
  const [expanded, setExpanded] = useState(false)

  const wsCount = workspaceHits?.length ?? 0
  const atCount = attachmentHits?.length ?? 0
  if (wsCount === 0 && atCount === 0) return null

  const total = wsCount + atCount

  return (
    <div className="memory-citation retrieval-citation" style={{ margin: '4px 12px' }}>
      <button className="memory-citation-toggle" onClick={() => setExpanded(!expanded)}>
        <FileSearch size={12} />
        <span>
          本轮检索注入了 {total} 段上下文
          {wsCount > 0 ? `（工作区 ${wsCount}` : '（'}
          {atCount > 0 ? `${wsCount > 0 ? '、' : ''}附件 ${atCount}` : ''}
          ）
        </span>
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
      </button>
      {expanded && (
        <div className="memory-citation-list">
          {(workspaceHits ?? []).map((h, i) => (
            <div key={`ws-${h.filePath}-${h.startLine}-${i}`} className="memory-citation-item">
              <span className="memory-citation-name">
                <FileSearch size={10} style={{ marginRight: 4, verticalAlign: 'middle' }} />
                {basename(h.filePath)}:{h.startLine}-{h.endLine}
              </span>
              {typeof h.score === 'number' && (
                <span className="memory-citation-type">score {h.score.toFixed(3)}</span>
              )}
              <span className="memory-citation-snippet" title={h.filePath}>
                {h.text.slice(0, 200)}
              </span>
            </div>
          ))}
          {(attachmentHits ?? []).map((h, i) => (
            <div key={`at-${h.namespace ?? 'attachment'}-${i}`} className="memory-citation-item">
              <span className="memory-citation-name">
                <Paperclip size={10} style={{ marginRight: 4, verticalAlign: 'middle' }} />
                {h.namespace ?? '附件'}
              </span>
              {typeof h.score === 'number' && (
                <span className="memory-citation-type">score {h.score.toFixed(3)}</span>
              )}
              <span className="memory-citation-snippet">{h.text.slice(0, 200)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
