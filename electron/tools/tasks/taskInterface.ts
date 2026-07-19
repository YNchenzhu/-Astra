/**
 * Task interface — strategy pattern for all task types.
 *
 * Mirrors upstream's Task interface: each task type implements
 * a `kill()` method, and a dispatcher routes by type string.
 */

export type TaskType =
  | 'local_bash'
  | 'local_agent'
  | 'main_session'
  | 'remote_agent'
  | 'local_workflow'
  | 'monitor_mcp'
  | 'dream'

export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'killed'

/** Base fields shared by all task states. */
export interface TaskStateBase {
  id: string
  type: TaskType
  status: TaskStatus
  description: string
  startTime: number
  endTime?: number
  notified: boolean
  isBackgrounded: boolean
  toolUseId?: string
}

/** Unified Task interface (Strategy Pattern). */
export interface Task {
  /** Human-readable name, e.g. "LocalShellTask" */
  name: string
  /** Machine type discriminator */
  type: TaskType
  /** Kill a running task by id and update app state */
  kill(taskId: string): Promise<void>
}

/** Registry of task implementations, keyed by TaskType. */
const taskImpls = new Map<TaskType, Task>()

export function registerTaskImpl(task: Task): void {
  taskImpls.set(task.type, task)
}

export function getTaskByType(type: TaskType): Task | undefined {
  return taskImpls.get(type)
}

export function getAllTaskImpls(): Task[] {
  return [...taskImpls.values()]
}
