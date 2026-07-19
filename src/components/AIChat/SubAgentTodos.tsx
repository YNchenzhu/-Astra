/**
 * SubAgentTodos — a compact task panel for a single sub-agent run.
 *
 * Mirrors the visual vocabulary of the main {@link TodoPanel} (pending / in
 * progress / completed status dots, line-through on completed) but kept
 * deliberately smaller so it can live *inside* the sub-agent block without
 * taking over the thread.
 *
 * Data source: `SubAgentDisplay.todos`, which {@link storeCompose} populates
 * whenever a `subagent_tool_result` event carries a successful `TodoWrite`
 * call. The main conversation's top-level task panel is **not** updated from
 * that event — per-sub-agent scoping keeps parallel workers from trampling
 * one another and the user's own task list.
 */
import React from 'react'
import type { TodoItem } from '../../types'
import './SubAgentTodos.css'

interface SubAgentTodosProps {
  todos: TodoItem[]
}

const PendingIcon: React.FC = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
    <circle cx="8" cy="8" r="5.2" />
  </svg>
)

const InProgressIcon: React.FC = () => (
  <svg
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    className="sub-agent-todo-spinner"
  >
    <path d="M8 2.5a5.5 5.5 0 0 1 0 11" strokeLinecap="round" />
  </svg>
)

const CompletedIcon: React.FC = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
    <path d="M4 8.2l2.8 2.8L12.2 5.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

const StatusIcon: React.FC<{ status: TodoItem['status'] }> = ({ status }) => {
  switch (status) {
    case 'in_progress':
      return <InProgressIcon />
    case 'completed':
      return <CompletedIcon />
    default:
      return <PendingIcon />
  }
}

export const SubAgentTodos: React.FC<SubAgentTodosProps> = ({ todos }) => {
  if (!todos || todos.length === 0) return null

  const completed = todos.filter((t) => t.status === 'completed').length
  const inProgress = todos.filter((t) => t.status === 'in_progress').length

  return (
    <div className="sub-agent-todos" role="list" aria-label="子智能体任务清单">
      <div className="sub-agent-todos-header">
        <span className="sub-agent-todos-title">子任务清单</span>
        <span className="sub-agent-todos-count">
          {completed}/{todos.length}
        </span>
        {inProgress > 0 ? (
          <span className="sub-agent-todos-active">{inProgress} 进行中</span>
        ) : null}
      </div>
      <ul className="sub-agent-todos-list">
        {todos.map((todo, idx) => (
          <li
            key={idx}
            role="listitem"
            className={`sub-agent-todo-item status-${todo.status}`}
          >
            <span className="sub-agent-todo-status" aria-hidden="true">
              <StatusIcon status={todo.status} />
            </span>
            <span className="sub-agent-todo-text">
              {todo.status === 'in_progress' ? todo.activeForm : todo.content}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
