import React from 'react'
import type { ContextState } from '../../../services/electronAPI'
import { RecentPromptDiagnosticsList } from '../RecentPromptDiagnosticsList'
import { formatContextTokens } from './format'

interface ContextMeterProps {
  contextState: ContextState
  showContextBreakdown: boolean
  setShowContextBreakdown: React.Dispatch<React.SetStateAction<boolean>>
  currentConversationId: string | null
}

export const ContextMeter: React.FC<ContextMeterProps> = ({
  contextState,
  showContextBreakdown,
  setShowContextBreakdown,
  currentConversationId,
}) => {
  return (
            <div className="chat-context-meter">
              <button
                type="button"
                className={`chat-context-indicator chat-context-${contextState.level}`}
                title="打开上下文用量明细"
                aria-expanded={showContextBreakdown}
                onClick={() => setShowContextBreakdown((v) => !v)}
              >
                {formatContextTokens(contextState.estimatedTokens)}
                {contextState.usagePercentOfWindow != null &&
                  ` · ${contextState.usagePercentOfWindow.toFixed(0)}%`}
                {contextState.compactCount > 0 && ` · ${contextState.compactCount}c`}
              </button>
              {showContextBreakdown && (
                <div className="chat-context-popover" role="dialog" aria-label="上下文用量明细">
                  <div className="chat-context-popover-header">
                    <div>
                      <div className="chat-context-popover-title">上下文用量</div>
                      <div className="chat-context-popover-subtitle">
                        {contextState.breakdown?.accuracy === 'anchored' ? '服务端/锚点校准' : '启发式估算'}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="chat-context-popover-close"
                      onClick={() => setShowContextBreakdown(false)}
                      aria-label="关闭上下文明细"
                    >
                      ×
                    </button>
                  </div>
                  <div className="chat-context-popover-total">
                    <span>{contextState.estimatedTokens.toLocaleString()} tokens</span>
                    {contextState.usagePercentOfWindow != null && (
                      <span>{contextState.usagePercentOfWindow.toFixed(1)}% window</span>
                    )}
                  </div>
                  {contextState.breakdown?.cache && (
                    <div className="chat-context-cache-panel">
                      <div className="chat-context-cache-title">Prompt cache</div>
                      <div className="chat-context-cache-grid">
                        <div>
                          <span>Read</span>
                          <strong>{formatContextTokens(contextState.breakdown.cache.cacheReadInputTokens)}</strong>
                        </div>
                        <div>
                          <span>Write</span>
                          <strong>{formatContextTokens(contextState.breakdown.cache.cacheCreationInputTokens)}</strong>
                        </div>
                        <div>
                          <span>Hit rate</span>
                          <strong>{contextState.breakdown.cache.cacheHitRate.toFixed(0)}%</strong>
                        </div>
                        <div>
                          <span>Output</span>
                          <strong>{formatContextTokens(contextState.breakdown.cache.outputTokens)}</strong>
                        </div>
                      </div>
                    </div>
                  )}
                  <div className="chat-context-breakdown-list">
                    {(contextState.breakdown?.categories ?? []).slice(0, 10).map((cat) => (
                      <div className="chat-context-breakdown-row" key={cat.id}>
                        <div className="chat-context-breakdown-row-top">
                          <span>{cat.label}</span>
                          <span>{formatContextTokens(cat.tokens)}</span>
                        </div>
                        <div className="chat-context-breakdown-bar">
                          <div
                            className="chat-context-breakdown-bar-fill"
                            style={{ width: `${Math.max(1, Math.min(100, cat.percentOfTotal))}%` }}
                          />
                        </div>
                      </div>
                    ))}
                    {!contextState.breakdown?.categories?.length && (
                      <div className="chat-context-breakdown-empty">
                        明细会在下一次模型请求后生成。
                      </div>
                    )}
                  </div>
                  <div className="chat-context-popover-footer">
                    状态: {contextState.level}
                    {contextState.compactCount > 0 && ` · 已压缩 ${contextState.compactCount} 次`}
                  </div>
                  <RecentPromptDiagnosticsList
                    active={showContextBreakdown}
                    conversationId={currentConversationId?.trim() || undefined}
                    refreshNonce={contextState?.estimatedTokens ?? 0}
                  />
                </div>
              )}
            </div>

  )
}
