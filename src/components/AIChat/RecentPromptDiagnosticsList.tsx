import React, { useEffect, useState } from 'react'
import { getPromptDiagnostics } from '../../services/electronAPI'
import type { PromptDiagnosticsRecordCompact } from '../../types/workspaceModels'

function formatContextTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return '0'
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(tokens >= 10_000 ? 0 : 1)}k`
  return String(Math.round(tokens))
}

function formatDurationMs(ms: number | undefined): string {
  if (!Number.isFinite(ms) || !ms || ms <= 0) return '—'
  if (ms >= 1000) return `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)}s`
  return `${Math.round(ms)}ms`
}

interface Props {
  /**
   * Trigger to (re-)load diagnostics. The parent sets this to `true` only
   * when the surrounding context panel is open, so the IPC fetch stays
   * dormant the rest of the time.
   */
  active: boolean
  /** When set, the list shows only this conversation's bucket. */
  conversationId?: string
  /**
   * Bumped by the parent whenever it wants a refresh (e.g. after a context
   * display update). Only consulted while `active` is true.
   */
  refreshNonce: number
  /** Per-call limit, defaults to 5. */
  limit?: number
}

export const RecentPromptDiagnosticsList: React.FC<Props> = ({
  active,
  conversationId,
  refreshNonce,
  limit = 5,
}) => {
  const [records, setRecords] = useState<PromptDiagnosticsRecordCompact[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!active) return
    let cancelled = false
    void getPromptDiagnostics({ limit, conversationId })
      .then((rows) => {
        if (cancelled) return
        setRecords(rows)
        setError(null)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [active, conversationId, refreshNonce, limit])

  return (
    <div className="chat-context-diagnostics">
      <div className="chat-context-diagnostics-header">
        <span>最近请求诊断</span>
        <span>{records.length > 0 ? `${records.length} runs` : ''}</span>
      </div>
      {error && (
        <div className="chat-context-diagnostics-empty">
          诊断读取失败: {error}
        </div>
      )}
      {!error && records.length === 0 && (
        <div className="chat-context-diagnostics-empty">
          暂无请求诊断。发送一次消息后这里会显示 TTFB、cache 与慢因。
        </div>
      )}
      {!error &&
        records.map((run) => (
          <div className="chat-context-diagnostic-run" key={run.requestId}>
            <div className="chat-context-diagnostic-top">
              <span
                className={`chat-context-diagnostic-status chat-context-diagnostic-status--${run.status}`}
              >
                {run.status}
              </span>
              <span>{run.model}</span>
              <span>iter {run.iteration}</span>
            </div>
            <div className="chat-context-diagnostic-metrics">
              <span>TTFB {formatDurationMs(run.timing.ttfbMs)}</span>
              <span>Total {formatDurationMs(run.timing.totalMs)}</span>
              <span>
                In {formatContextTokens(run.usage?.totalInputWithCache ?? run.payload.messageTokens)}
              </span>
              {run.usage && (
                <span>
                  Cache {formatContextTokens(run.usage.cacheReadInputTokens)}/
                  {formatContextTokens(run.usage.cacheCreationInputTokens)}
                </span>
              )}
            </div>
            <div className="chat-context-diagnostic-payload">
              <span>sys {formatContextTokens(run.payload.systemPromptTokens)}</span>
              <span>meta {formatContextTokens(run.payload.userMetaTokens)}</span>
              <span>tools {formatContextTokens(run.payload.toolSchemaTokens)}</span>
              <span>msgs {run.payload.messageCount}</span>
            </div>
            <div className="chat-context-diagnostic-diagnosis">
              {run.diagnosis.slice(0, 2).join(' · ')}
            </div>
          </div>
        ))}
    </div>
  )
}
