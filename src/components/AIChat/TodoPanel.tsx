import React, { useMemo, useState } from 'react'
import { useChatStore } from '../../stores/useChatStore'
import type { TodoItem } from '../../types'
import {
  useTaskListV2Snapshot,
  useTaskListV2Sync,
  type TaskV2,
} from '../../stores/useTaskListV2'
import { useActivePlanStore } from '../../stores/useActivePlan'
import { openActivePlanTab } from '../../services/planTab'
import './TodoPanel.css'

const PendingIcon: React.FC = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
    <circle cx="8" cy="8" r="6" />
  </svg>
)

const InProgressIcon: React.FC = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="todo-spinner">
    <path d="M8 2a6 6 0 0 1 0 12" strokeLinecap="round" />
  </svg>
)

const CompletedIcon: React.FC = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
    <path d="M4 8l3 3 5-6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

const FailedIcon: React.FC = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
    <circle cx="8" cy="8" r="6" />
    <path d="M5 5l6 6M11 5l-6 6" strokeLinecap="round" />
  </svg>
)

const CancelledIcon: React.FC = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
    <circle cx="8" cy="8" r="6" />
    <path d="M5 8h6" strokeLinecap="round" />
  </svg>
)

const StatusIcon: React.FC<{ status: TodoItem['status'] }> = ({ status }) => {
  switch (status) {
    case 'in_progress':
      return <InProgressIcon />
    case 'completed':
      return <CompletedIcon />
    case 'failed':
      return <FailedIcon />
    case 'cancelled':
      return <CancelledIcon />
    default:
      return <PendingIcon />
  }
}

const SOURCE_LABELS: Record<string, string> = {
  agent: '智能体',
  user: '用户',
  system: '系统',
  todo_sync: '',
  plan: '计划',
  coordinator: '协调',
}

/**
 * Project a V2 TaskManager task onto the unified `TodoItem` shape so
 * one panel can render V1 (TodoWrite), V2 (TaskCreate / TaskUpdate),
 * or BOTH simultaneously without dual code paths.
 *
 * 星构Astra coexist extension (2026-05): the two surfaces are NO
 * LONGER mutually exclusive at runtime. The default `'coexist'`
 * mode (see `electron/tools/todoMode.ts`) keeps both V1 and V2
 * tools enabled — the model picks ephemeral (V1, in-conversation
 * checklist) vs durable (V2, cross-conversation managed task) per
 * task. This panel renders the merged set so the user sees a single
 * source of truth for "AI is planning / working on these things".
 * The two surfaces' data shapes are projected onto `TodoItem` here
 * (V2 first so plan-seeded tasks anchor the top).
 *
 * Audit T-2 (2026-05): `TodoItem.status` was widened to include
 * `failed` / `cancelled` so V2 termination states render as their
 * own visual category (red X icon for failed, gray minus for
 * cancelled) instead of being collapsed into `completed`. The
 * underlying error string is folded into `summary` for the meta
 * line.
 */
function taskV2ToTodoItem(task: TaskV2): TodoItem {
  const summary = task.error ?? task.summary
  return {
    content: task.subject,
    status: task.status,
    activeForm: task.activeForm ?? task.subject,
    source: (task.source === 'user' || task.source === 'system'
      ? task.source
      : (task.source as TodoItem['source']) ?? undefined),
    owner: task.owner,
    summary,
  }
}

export const TodoPanel: React.FC = () => {
  // V1 source — TodoWrite tool_result stream
  const v1Todos = useChatStore((s) => s.todos)
  const conversationId = useChatStore((s) => s.currentConversationId)
  // V2 source — TaskManager lifecycle stream
  useTaskListV2Sync(conversationId ?? undefined)
  const v2Tasks = useTaskListV2Snapshot()

  const todos = useMemo<TodoItem[]>(() => {
    // 星构Astra coexist mode: V1 + V2 are simultaneously active by
    // default. V2 first so plan-seeded durable tasks anchor the top,
    // V1 ephemeral checklist follows below.
    return [...v2Tasks.map(taskV2ToTodoItem), ...v1Todos]
  }, [v1Todos, v2Tasks])

  const [collapsed, setCollapsed] = useState(false)
  const [filter, setFilter] = useState<'all' | TodoItem['status']>('all')
  // Persistent "查看计划" re-entry: available once a plan has been approved
  // (the slim approval bar that first offered it is gone by implementation time).
  const activePlanPath = useActivePlanStore((s) => s.planFilePath)

  if (todos.length === 0) return null
  // 全部任务已 closed(completed / failed / cancelled)时,sticky 面板
  // 不再代表"AI 进行中",收起以免历史已消费的清单一直占据输入框上方。
  // 完整明细仍可通过消息流里的 TodoWrite tool 卡片回看。
  const hasOpenTodo = todos.some(
    (t) => t.status === 'pending' || t.status === 'in_progress',
  )
  if (!hasOpenTodo) return null

  const completedCount = todos.filter((t) => t.status === 'completed').length
  const inProgressCount = todos.filter((t) => t.status === 'in_progress').length
  const pendingCount = todos.filter((t) => t.status === 'pending').length
  const failedCount = todos.filter((t) => t.status === 'failed').length
  const cancelledCount = todos.filter((t) => t.status === 'cancelled').length
  // Show closed-status count separately so failed/cancelled don't
  // hide inside the "completed" denominator.
  const closedCount = completedCount + failedCount + cancelledCount
  const visibleTodos = filter === 'all' ? todos : todos.filter((t) => t.status === filter)

  return (
    <div className={`todo-panel${collapsed ? ' collapsed' : ''}`}>
      <div
        className="todo-panel-header"
        onClick={() => setCollapsed(!collapsed)}
      >
        <span className="todo-panel-title">
          任务面板
          <span className="todo-panel-badge">
            {closedCount}/{todos.length}
          </span>
          {inProgressCount > 0 && (
            <span style={{ color: 'var(--accent-yellow, #f9e2af)', fontSize: '10px' }}>
              {inProgressCount} 进行中
            </span>
          )}
          {failedCount > 0 && (
            <span style={{ color: 'var(--accent-red, #f38ba8)', fontSize: '10px' }}>
              {failedCount} 失败
            </span>
          )}
          {cancelledCount > 0 && (
            <span style={{ color: 'var(--text-secondary, #888)', fontSize: '10px' }}>
              {cancelledCount} 取消
            </span>
          )}
        </span>
        {activePlanPath && (
          <button
            type="button"
            className="todo-panel-view-plan"
            onClick={(e) => {
              e.stopPropagation()
              void openActivePlanTab()
            }}
            title="在标签页查看完整计划（实时进度）"
          >
            查看计划
          </button>
        )}
        <span className="todo-panel-collapse-icon">
          ▾
        </span>
      </div>
      <div className="todo-panel-filters">
        <button className={`todo-filter-btn ${filter === 'all' ? 'active' : ''}`} onClick={() => setFilter('all')}>
          全部 {todos.length}
        </button>
        <button className={`todo-filter-btn ${filter === 'in_progress' ? 'active' : ''}`} onClick={() => setFilter('in_progress')}>
          运行中 {inProgressCount}
        </button>
        <button className={`todo-filter-btn ${filter === 'pending' ? 'active' : ''}`} onClick={() => setFilter('pending')}>
          待处理 {pendingCount}
        </button>
        <button className={`todo-filter-btn ${filter === 'completed' ? 'active' : ''}`} onClick={() => setFilter('completed')}>
          完成 {completedCount}
        </button>
      </div>
      <div className="todo-panel-list">
        {visibleTodos.map((todo, index) => {
          const sourceLabel = todo.source ? SOURCE_LABELS[todo.source] : ''
          return (
            <div
              key={index}
              className={`todo-item status-${todo.status}`}
            >
              <span className="todo-item-status">
                <StatusIcon status={todo.status} />
              </span>
              <span className="todo-item-content">
                <span className="todo-item-text">
                  {todo.status === 'in_progress' ? todo.activeForm : todo.content}
                </span>
                {(sourceLabel || todo.owner) && (
                  <span className="todo-item-meta">
                    {sourceLabel && <span className="todo-item-source">{sourceLabel}</span>}
                    {todo.owner && <span className="todo-item-owner">{todo.owner}</span>}
                  </span>
                )}
                {todo.summary &&
                  (todo.status === 'in_progress' || todo.status === 'failed' || todo.status === 'cancelled') &&
                  todo.summary !== todo.activeForm && (
                    <span className="todo-item-summary">{todo.summary}</span>
                )}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
