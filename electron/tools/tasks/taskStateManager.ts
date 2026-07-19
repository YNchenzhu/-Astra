/**
 * Task state manager — central store for task states.
 *
 * Mirrors upstream's AppState.tasks dictionary pattern.
 * All task states are stored here with immutable update semantics.
 */

import type { TaskStateBase, TaskType, TaskStatus } from './taskInterface'

type TaskStateMap = Map<string, TaskStateBase>
type StateUpdater = (state: TaskStateBase) => TaskStateBase

/**
 * How long a terminal-state task lingers in the store before being swept.
 * Mirrors {@link TaskRuntimeStore}'s `TERMINAL_RECORD_TTL_MS` so the two
 * stores age out at the same cadence — readers querying both never see
 * one tombstoned and the other still alive.
 */
const TERMINAL_TASK_TTL_MS = 10 * 60 * 1000

/** Central task state store. */
const taskStates: TaskStateMap = new Map()

/**
 * Drop terminal-state task records older than {@link TERMINAL_TASK_TTL_MS}.
 *
 * Runs synchronously on every `registerTaskState` / `updateTaskState`
 * call. Unlike `TaskRuntimeStore.maybeSweepTerminalRecords`, this store
 * is NOT on a high-frequency hot path — `register` is invoked once per
 * task, `update` a handful of times per lifecycle — so the linear scan
 * over `taskStates` is cheap (active tasks usually number in the dozens
 * at most). Skipping the throttle means tests, short sessions, and
 * batch operations always see the freshest TTL semantics, and we don't
 * carry a "stale throttle timestamp" across `clearAllTaskStates()`
 * resets.
 *
 * Without this sweep the central task map grew monotonically — every
 * shell command, sub-agent run, workflow run left a permanent state
 * object until the renderer process exited. Long sessions accumulated
 * thousands of completed records and the per-task spread copies in
 * `updateTaskState` started dominating the agentic loop's CPU budget.
 */
function sweepTerminalTasks(): void {
  const cutoff = Date.now() - TERMINAL_TASK_TTL_MS
  for (const [id, state] of taskStates) {
    if (state.status === 'running' || state.status === 'pending') continue
    const finished = state.endTime ?? state.startTime
    if (finished < cutoff) {
      taskStates.delete(id)
    }
  }
}

/** Register a new task state. */
export function registerTaskState(taskState: TaskStateBase): void {
  taskStates.set(taskState.id, { ...taskState })
  sweepTerminalTasks()
}

/** Update a task state with an updater function (immutable). */
export function updateTaskState(
  taskId: string,
  updater: StateUpdater,
): TaskStateBase | undefined {
  const existing = taskStates.get(taskId)
  if (!existing) return undefined
  const updated = updater({ ...existing })
  taskStates.set(taskId, updated)
  // Sweep AFTER the write so the just-finalised task still gets one
  // grace cycle in the map — readers running a tick later still see it.
  sweepTerminalTasks()
  return updated
}

/** Get a task state by ID. */
export function getTaskState(taskId: string): TaskStateBase | undefined {
  return taskStates.get(taskId)
}

/** Get all task states. */
export function getAllTaskStates(): TaskStateBase[] {
  return [...taskStates.values()]
}

/** Get task states by status. */
export function getTaskStatesByStatus(status: TaskStatus): TaskStateBase[] {
  return [...taskStates.values()].filter((t) => t.status === status)
}

/** Get task states by type. */
export function getTaskStatesByType(type: TaskType): TaskStateBase[] {
  return [...taskStates.values()].filter((t) => t.type === type)
}

/** Get background tasks (running/pending and isBackgrounded = true). */
export function getBackgroundTasks(): TaskStateBase[] {
  return [...taskStates.values()].filter(
    (t) =>
      (t.status === 'running' || t.status === 'pending') && t.isBackgrounded === true,
  )
}

/** Get foreground tasks (running/pending and isBackgrounded = false or undefined). */
export function getForegroundTasks(): TaskStateBase[] {
  return [...taskStates.values()].filter(
    (t) =>
      (t.status === 'running' || t.status === 'pending') && t.isBackgrounded !== true,
  )
}

/** Remove a task state. */
export function removeTaskState(taskId: string): void {
  taskStates.delete(taskId)
}

/** Clear all task states. */
export function clearAllTaskStates(): void {
  taskStates.clear()
}

/** Create a task state base object with defaults. */
export function createTaskStateBase(params: {
  id: string
  type: TaskType
  description: string
  toolUseId?: string
}): TaskStateBase {
  return {
    id: params.id,
    type: params.type,
    status: 'running',
    description: params.description,
    startTime: Date.now(),
    notified: false,
    isBackgrounded: false,
    toolUseId: params.toolUseId,
  }
}
