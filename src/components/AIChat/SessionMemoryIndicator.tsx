/**
 * Header pill showing the current conversation's `session-memory-internal`
 * sub-agent status. Replaces the previous in-timeline `subagent-msg-*` bubble
 * — the agent is a host-internal task (writes a markdown file under the
 * user's `~/.claude/` tree) that users mostly don't need to see
 * mid-conversation, but a small status hint is useful for trust / debugging.
 *
 * State source: `ChatState.sessionMemoryStatus[currentConversationId]`,
 * populated by `subAgentStreamRouter`. The exact on-disk path is resolved
 * via the `session:get-memory-path` IPC because it depends on the open
 * workspace's slug (project-scoped layout under `~/.claude/projects/<slug>/
 * session-memory/`) and is not derivable from the renderer state alone.
 */
import React, { useEffect, useState } from 'react'
import { Brain, CheckCircle2, AlertCircle } from 'lucide-react'
import { useChatStore } from '../../stores/useChatStore'
import { useWorkspaceStore } from '../../stores/useWorkspaceStore'

function formatDuration(ms?: number): string | undefined {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return undefined
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

/**
 * Resolve the absolute path the scribe writes for the active
 * (conversationId, workspacePath) pair. Returns `null` until the IPC
 * answer comes back. Re-runs whenever either input changes.
 */
function useSessionMemoryPath(
  conversationId: string | null,
  workspacePath: string | null,
): string | null {
  const [path, setPath] = useState<string | null>(null)
  useEffect(() => {
    if (!conversationId) {
      // Reset cached path when the conversation goes away. Derived-render
      // can't help here because the resolved path comes from an async IPC
      // — we still need the state cell, just need to clear it on input
      // invalidation before the .then() of a stale call lands.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPath(null)
      return
    }
    const api = window.electronAPI?.session?.getMemoryPath
    if (typeof api !== 'function') {
      setPath(null)
      return
    }
    let cancelled = false
    api({ conversationId, workspacePath: workspacePath || null })
      .then((p) => {
        if (!cancelled) setPath(typeof p === 'string' && p.trim() ? p : null)
      })
      .catch(() => {
        if (!cancelled) setPath(null)
      })
    return () => {
      cancelled = true
    }
  }, [conversationId, workspacePath])
  return path
}

export const SessionMemoryIndicator: React.FC = () => {
  const conversationId = useChatStore((s) => s.currentConversationId)
  const status = useChatStore((s) =>
    s.currentConversationId ? s.sessionMemoryStatus[s.currentConversationId] : undefined,
  )
  const workspacePath = useWorkspaceStore((s) => s.rootPath)
  const memoryPath = useSessionMemoryPath(conversationId ?? null, workspacePath ?? null)

  if (!status) return null

  const dur = formatDuration(status.totalDurationMs)
  const tokens =
    typeof status.totalTokens === 'number' && status.totalTokens > 0
      ? `${status.totalTokens.toLocaleString()} tok`
      : undefined

  if (status.status === 'running') {
    return (
      <span
        className="chat-session-memory-indicator chat-session-memory-indicator--running"
        title={
          [
            '正在更新会话记忆',
            memoryPath ? `路径: ${memoryPath}` : null,
          ]
            .filter(Boolean)
            .join('\n') || undefined
        }
      >
        <Brain size={11} className="chat-session-memory-icon" />
        <span>记忆</span>
      </span>
    )
  }

  if (status.status === 'failed') {
    return (
      <span
        className="chat-session-memory-indicator chat-session-memory-indicator--failed"
        title={
          [
            '会话记忆更新失败',
            status.errorMessage,
            memoryPath ? `路径: ${memoryPath}` : null,
          ]
            .filter(Boolean)
            .join('\n') || undefined
        }
      >
        <AlertCircle size={11} className="chat-session-memory-icon" />
        <span>记忆</span>
      </span>
    )
  }

  return (
    <span
      className="chat-session-memory-indicator chat-session-memory-indicator--done"
      title={
        [
          '会话记忆已更新',
          dur ? `耗时 ${dur}` : null,
          tokens ? `用量 ${tokens}` : null,
          memoryPath ? `路径: ${memoryPath}` : null,
        ]
          .filter(Boolean)
          .join('\n')
      }
    >
      <CheckCircle2 size={11} className="chat-session-memory-icon" />
      <span>记忆</span>
      {dur ? <span className="chat-session-memory-meta">{dur}</span> : null}
    </span>
  )
}
