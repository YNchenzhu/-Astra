/**
 * In-Process Teammate Task Management
 *
 * Zustand-native helpers that wrap executionStore actions with
 * teammate-specific business logic (graceful shutdown, capped messages,
 * plan-approval tracking, sorted queries).
 *
 * Previously this file used a React `SetAppState` callback pattern.  It has
 * been rewritten to use `useExecutionStore` directly so the functions can be
 * called from hooks, runners, and event handlers without an extra adaptor.
 */

import { useExecutionStore } from '../stores/executionStore'
import type { InProcessTeammateTaskState } from '../types/InProcessTeammateTask'
import { appendCappedMessage, isInProcessTeammateTask } from '../types/InProcessTeammateTask'

// ---------------------------------------------------------------------------
// Graceful shutdown — marks `shutdownRequested` so the agent loop can finish
// its current turn before exiting (instead of a hard `killInProcessTeammate`).
// ---------------------------------------------------------------------------

export function requestTeammateShutdown(taskId: string): void {
  useExecutionStore.getState().updateTask(taskId, { shutdownRequested: true })
}

// ---------------------------------------------------------------------------
// Capped message append — prevents unbounded growth in the teammate's
// conversation history when the agent produces many tool-use / text turns.
// ---------------------------------------------------------------------------

export function appendTeammateMessage(
  taskId: string,
  message: InProcessTeammateTaskState['messages'][0],
): void {
  const store = useExecutionStore.getState()
  const task = store.getTask(taskId)
  if (!task || !isInProcessTeammateTask(task)) return
  store.updateTask(taskId, {
    messages: appendCappedMessage(task.messages, message),
  })
}

// ---------------------------------------------------------------------------
// Plan approval tracking — the main loop sets this before waiting for user
// approval of a plan; the UX layer reads it to show a confirmation prompt.
// ---------------------------------------------------------------------------

export function setAwaitingPlanApproval(
  taskId: string,
  awaiting: boolean,
): void {
  useExecutionStore.getState().updateTask(taskId, { awaitingPlanApproval: awaiting })
}

// ---------------------------------------------------------------------------
// Query helpers — read from the store and return filtered / sorted views.
// ---------------------------------------------------------------------------

export function findTeammateTaskByAgentId(
  agentId: string,
): InProcessTeammateTaskState | undefined {
  let fallback: InProcessTeammateTaskState | undefined
  for (const task of useExecutionStore.getState().getAllTasks()) {
    if (isInProcessTeammateTask(task) && task.identity.agentId === agentId) {
      if (task.status === 'running') return task
      if (!fallback) fallback = task
    }
  }
  return fallback
}

export function getAllInProcessTeammateTasks(): InProcessTeammateTaskState[] {
  return useExecutionStore.getState().getAllTasks().filter(isInProcessTeammateTask)
}

export function getRunningTeammatesSorted(): InProcessTeammateTaskState[] {
  return getAllInProcessTeammateTasks()
    .filter((t) => t.status === 'running')
    .sort((a, b) => a.identity.agentName.localeCompare(b.identity.agentName))
}

export function findInProcessTeammateTaskId(
  agentName: string,
): string | undefined {
  for (const task of useExecutionStore.getState().getAllTasks()) {
    if (isInProcessTeammateTask(task) && task.identity.agentName === agentName) {
      return task.id
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Status / error / idle — thin wrappers around `updateTask` that keep call
// sites self-documenting instead of repeating `{ status: 'idle' }` objects.
// ---------------------------------------------------------------------------

export function updateTaskStatus(
  taskId: string,
  status: InProcessTeammateTaskState['status'],
): void {
  useExecutionStore.getState().updateTask(taskId, { status })
}

export function setTaskError(
  taskId: string,
  error: string,
): void {
  useExecutionStore.getState().updateTask(taskId, { status: 'failed', error })
}

export function setTaskIdle(
  taskId: string,
  isIdle: boolean,
): void {
  useExecutionStore.getState().updateTask(taskId, { isIdle })
}
