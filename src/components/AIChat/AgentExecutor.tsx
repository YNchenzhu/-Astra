import React, { useEffect, useRef, useState } from 'react'
import { useAgentExecution } from '../../hooks/useAgentExecution'
import type { InProcessTeammateTaskState } from '../../types/InProcessTeammateTask'
import { extractTextContent } from '../../utils/messages'
import './AgentExecutor.css'

interface AgentExecutorProps {
  taskId: string | null
  onTaskComplete?: (task: InProcessTeammateTaskState) => void
}

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'stopped'])

export const AgentExecutor: React.FC<AgentExecutorProps> = ({ taskId, onTaskComplete }) => {
  const { task, isRunning, error, startExecution, stopExecution } = useAgentExecution(taskId)
  const [autoStart, setAutoStart] = useState(false)

  // P1-37: parent components frequently pass `onTaskComplete` as an inline
  // closure, so its identity changes on every render. The previous
  // `useEffect(..., [task, onTaskComplete])` therefore re-fired on EVERY
  // parent rerender once the task reached a terminal state — invoking
  // the callback dozens of times for one logical completion. Pin the
  // callback into a ref and gate dispatch on a per-task fired flag so
  // each terminal transition fires exactly once.
  const onTaskCompleteRef = useRef(onTaskComplete)
  useEffect(() => {
    onTaskCompleteRef.current = onTaskComplete
  }, [onTaskComplete])
  const completedTaskRef = useRef<{ taskId: string | null; status: string } | null>(null)

  useEffect(() => {
    if (autoStart && task && !isRunning && task.status === 'idle') {
      startExecution()
    }
  }, [autoStart, task, isRunning, startExecution])

  useEffect(() => {
    if (!task) return
    if (!TERMINAL_STATUSES.has(task.status)) return
    const last = completedTaskRef.current
    if (last && last.taskId === taskId && last.status === task.status) return
    completedTaskRef.current = { taskId, status: task.status }
    onTaskCompleteRef.current?.(task)
  }, [task, taskId])

  if (!task) {
    return <div className="agent-executor-empty">未选择任务</div>
  }

  return (
    <div className="agent-executor">
      <div className="agent-executor-header">
        <div>
          <h3 className="agent-executor-title">{task.identity.agentName}</h3>
          <p className="agent-executor-id">{task.identity.agentId}</p>
        </div>
        <div className="agent-executor-actions">
          {!isRunning && task.status === 'idle' && (
            <button
              onClick={() => startExecution()}
              className="agent-executor-btn primary"
            >
              开始
            </button>
          )}
          {isRunning && (
            <button
              onClick={() => stopExecution()}
              className="agent-executor-btn danger"
            >
              停止
            </button>
          )}
        </div>
      </div>

      <div className="agent-executor-status-row">
        <div
          className={`agent-executor-status-dot ${
            isRunning
              ? 'running'
              : task.status === 'completed'
                ? 'completed'
                : task.status === 'failed'
                  ? 'failed'
                  : 'idle'
          }`}
        />
        <span className="agent-executor-status-label">{task.status}</span>
      </div>

      <div className="agent-executor-card">
        <p className="agent-executor-card-title">提示词</p>
        <p className="agent-executor-card-body">{task.prompt}</p>
      </div>

      {(error || task.error) && (
        <div className="agent-executor-error">
          {error || task.error}
        </div>
      )}

      {task.messages && task.messages.length > 0 && (
        <div className="agent-executor-card agent-executor-messages">
          <p className="agent-executor-card-title">消息 ({task.messages.length})</p>
          <div className="agent-executor-message-list">
            {task.messages.map((msg, i) => (
              <div key={i} className="agent-executor-message-item">
                <p className="agent-executor-message-role">{msg.role}</p>
                <p className="agent-executor-message-content">{extractTextContent(msg)}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="agent-executor-metrics">
        <div className="agent-executor-metric">
          <p className="agent-executor-metric-label">工具调用</p>
          <p className="agent-executor-metric-value">{task.lastReportedToolCount}</p>
        </div>
        <div className="agent-executor-metric">
          <p className="agent-executor-metric-label">令牌</p>
          <p className="agent-executor-metric-value">{task.lastReportedTokenCount}</p>
        </div>
        <div className="agent-executor-metric">
          <p className="agent-executor-metric-label">消息</p>
          <p className="agent-executor-metric-value">{task.messages?.length || 0}</p>
        </div>
      </div>

      <label className="agent-executor-toggle-row">
        <input
          type="checkbox"
          checked={autoStart}
          onChange={(e) => setAutoStart(e.target.checked)}
        />
        自动开始执行
      </label>
    </div>
  )
}
