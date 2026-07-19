/**
 * TaskStopTool — stop a running background task.
 *
 * Uses the new task dispatcher for structured error codes and
 * unified kill routing across all task types.
 */

import { taskManager } from './TaskManager'
import { taskRuntimeStore } from './TaskRuntimeStore'
import { stopTask, StopTaskError } from './tasks/taskDispatcher'
import { buildTool } from './buildTool'
import { taskStopInputZod } from './toolInputZod'

export const taskStopTool = buildTool({
  name: 'TaskStop',
  zInputSchema: taskStopInputZod,
  description:
    'Stop or cancel a task. For V2 tasks (TaskList/TaskUpdate): cancels pending or in_progress tasks (status becomes cancelled). ' +
    'For dispatcher-backed runs (bash/agent in the task state manager), performs a hard stop. ' +
    'Use when the user aborts work or a background run must end.',
  inputSchema: [
    { name: 'taskId', type: 'string', description: 'ID of the task to stop' },
    { name: 'task_id', type: 'string', description: 'Snake_case alias for taskId' },
  ],
  isReadOnly: false,
  isConcurrencySafe: false,
  async call({ taskId }) {
    if (!taskId) {
      return { success: false, error: 'taskId is required' }
    }

    // Try the new dispatcher first (structured error codes, notifications)
    try {
      const result = await stopTask(taskId)
      // P1-18: dispatcher.stopTask only kills the runtime process; it does
      // NOT update the V2 TaskManager row. Without this sync, the same
      // taskId would simultaneously read as "killed" via dispatcher and
      // "in_progress" via TaskList — a permanent inconsistency that
      // confused both users and downstream consumers (planRuntime, hooks).
      // Calling `taskManager.stop` here is idempotent: it no-ops when the
      // row is already terminal or absent.
      try {
        await taskManager.stop(taskId)
      } catch {
        /* non-fatal: V2 sync is best-effort */
      }
      const task = taskManager.getTask(taskId)
      return {
        success: true,
        output: `Stopped task ${result.taskId} (${result.taskType}): ${task?.subject ?? taskId} (status: ${task?.status ?? 'killed'})`,
      }
    } catch (err) {
      if (err instanceof StopTaskError) {
        // Fall through to legacy runtime store for shell/agent tasks not in state manager
        if (err.code === 'not_found') {
          // Try the legacy runtime store
          const stopped = await taskRuntimeStore.stop(taskId)
          const stopResult = await taskManager.stop(taskId)
          if (!stopped && !stopResult) {
            const tm = taskManager.getTask(taskId)
            if (tm) {
              return {
                success: false,
                error: `Task ${taskId} is not stoppable (status: ${tm.status}). TaskStop only cancels pending or in_progress V2 tasks, or stops registered runtime/bash/agent runs.`,
              }
            }
            return { success: false, error: `Task not found: ${taskId}` }
          }
          if (stopResult) {
            const task = taskManager.getTask(taskId)
            return {
              success: true,
              output: `Stopped task ${taskId}: ${task?.subject ?? taskId} (status: ${task?.status ?? 'cancelled'})`,
            }
          }
          return { success: true, output: `Stopped runtime task ${taskId}` }
        }
        return { success: false, error: err.message }
      }
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  },
})
