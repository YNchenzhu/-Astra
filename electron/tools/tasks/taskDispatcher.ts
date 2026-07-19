/**
 * Task dispatcher — routes kill operations to the correct task implementation.
 *
 * Mirrors upstream's stopTask.ts: finds a task by ID, validates it's running,
 * then dispatches to the correct Task implementation's kill() method.
 */

import type { TaskType } from './taskInterface'
import { getTaskByType } from './taskInterface'
import { getTaskState, updateTaskState, getAllTaskStates } from './taskStateManager'
import type { AgentId } from '../ids'
import { taskKilledNotification } from './notificationSystem'
import { taskRuntimeStore } from '../TaskRuntimeStore'
import { unregisterCleanup, cleanupAll } from './cleanupRegistry'
import { isLocalShellTask } from './guards'
import type { LocalShellTaskState, LocalAgentTaskState } from './guards'
import { markShellTaskNotified } from './ShellTaskManager'

export type StopTaskErrorCode = 'not_found' | 'not_running' | 'unsupported_type'

export class StopTaskError extends Error {
  code: StopTaskErrorCode
  taskId: string
  taskType?: string
  command?: string

  constructor(code: StopTaskErrorCode, taskId: string, message: string) {
    super(message)
    this.name = 'StopTaskError'
    this.code = code
    this.taskId = taskId
  }
}

/** Stop a task by ID. Dispatches to the correct task implementation's kill(). */
export async function stopTask(taskId: string): Promise<{
  taskId: string
  taskType?: TaskType
  command?: string
}> {
  // 1. Find task
  const task = getTaskState(taskId)
  if (!task) {
    throw new StopTaskError('not_found', taskId, `Task not found: ${taskId}`)
  }

  // 2. Validate running
  if (task.status !== 'running' && task.status !== 'pending') {
    throw new StopTaskError('not_running', taskId, `Task ${taskId} is not running (status: ${task.status})`)
  }

  // 3. Get task implementation by type
  const taskImpl = getTaskByType(task.type)
  if (!taskImpl) {
    throw new StopTaskError('unsupported_type', taskId, `Unsupported task type: ${task.type}`)
  }

  // 4. Call kill implementation. We deliberately update task state AFTER
  // `kill()` returns so a `kill()` rejection (process gone, permission
  // error, killer impl bug, etc.) can be reflected accurately as `failed`
  // instead of being permanently mismarked as `killed`. The previous
  // "mark-then-kill" ordering claimed to "prevent races" but actually
  // created an unrecoverable lie: kill rejected → state stuck on `killed`
  // → `cleanupAll()` couldn't tell "kill went through" apart from "kill
  // never ran" and downstream UI showed a phantom-dead task that was
  // still alive in the OS.
  try {
    await taskImpl.kill(taskId)
  } catch (err) {
    updateTaskState(taskId, (state) => ({
      ...state,
      status: 'failed' as const,
      endTime: Date.now(),
    }))
    // Surface the failure to the runtime store so transcripts/observers
    // see a coherent terminal state instead of an open record.
    taskRuntimeStore.markFailed(
      taskId,
      err instanceof Error ? err.message : String(err),
    )
    // Best-effort resource cleanup even on kill failure — don't leak the
    // cleanup callback just because the kill rejected.
    await unregisterCleanup(taskId).catch(() => {})
    throw err
  }

  // 5. Mark killed only after kill() resolved successfully.
  updateTaskState(taskId, (state) => ({
    ...state,
    status: 'killed' as const,
    endTime: Date.now(),
  }))

  // 6. Clean up runtime store
  taskRuntimeStore.markStopped(taskId)

  // 7. Clean up resources
  await unregisterCleanup(taskId)

  // 8. Send notification.
  //
  // Bash: suppress the killed XML — it's almost always "exit code 137" noise
  // from a user-initiated Ctrl+C and adds nothing the model can act on.
  // We still flip `notified=true` so downstream eviction guards see a
  // coherent terminal state. Mirrors upstream stopTask.ts behaviour.
  //
  // Agent tasks: keep the killed notification — the agent's AbortError catch
  // path historically carries partial-result payload here, not noise.
  if (isLocalShellTask(task)) {
    markShellTaskNotified(taskId)
  } else {
    const agentId =
      'agentId' in task
        ? (task as LocalShellTaskState | LocalAgentTaskState).agentId
        : undefined
    taskKilledNotification(taskId, task.type, agentId)
  }

  return {
    taskId,
    taskType: task.type,
    command:
      'command' in task && typeof (task as { command?: unknown }).command === 'string'
        ? (task as { command: string }).command
        : undefined,
  }
}

/** Kill all running tasks of any type. */
export async function killAllTasks(): Promise<string[]> {
  const allTasks = getAllTaskStates().filter(
    (t) => t.status === 'running' || t.status === 'pending',
  )

  const killed: string[] = []
  for (const task of allTasks) {
    try {
      await stopTask(task.id)
      killed.push(task.id)
    } catch (err) {
      console.warn('[TaskDispatcher] failed to kill', task.id, err)
    }
  }

  // Final cleanup of all remaining resources
  await cleanupAll()

  return killed
}

/** Kill all running tasks for a specific agent ID. */
export async function killTasksByAgent(agentId: AgentId): Promise<string[]> {
  const agentTasks = getAllTaskStates().filter(
    (t) =>
      (t.status === 'running' || t.status === 'pending') &&
      'agentId' in t &&
      (t as { agentId?: AgentId }).agentId === agentId,
  )

  const killed: string[] = []
  for (const task of agentTasks) {
    try {
      await stopTask(task.id)
      killed.push(task.id)
    } catch (err) {
      console.warn('[TaskDispatcher] failed to kill agent task', task.id, err)
    }
  }

  return killed
}
