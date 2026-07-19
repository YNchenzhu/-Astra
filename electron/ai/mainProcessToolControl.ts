/**
 * Main-process control plane for renderer tool_use lifecycle (stop / retry).
 * Bridges IPC to {@link taskRuntimeStore}, optional per-tool abort, and V2 {@link taskManager}.
 */

import { taskRuntimeStore } from '../tools/TaskRuntimeStore'
import { taskManager } from '../tools/TaskManager'
import { abortToolExecutionById } from './toolStopRegistry'

export type StopToolUseResult = { success: boolean; error?: string }

export type RetryToolUseResult = { success: boolean; taskId?: string; error?: string }

/**
 * Stop a running tool_use: abort in-flight work (Agent/Bash with handler), runtime store, and V2 task row if any.
 */
export async function stopToolUseById(toolUseId: string): Promise<StopToolUseResult> {
  const id = typeof toolUseId === 'string' ? toolUseId.trim() : ''
  if (!id) {
    return { success: false, error: 'taskId is required' }
  }

  const aborted = abortToolExecutionById(id)
  const runtimeStopped = await taskRuntimeStore.stop(id)
  const tm = await taskManager.stop(id)

  if (!aborted && !runtimeStopped && !tm) {
    return { success: false, error: `No active tool or task for id: ${id}` }
  }

  return { success: true }
}

/**
 * Clear runtime state for this id so a new model/tool cycle can run cleanly. Does not re-invoke the model.
 */
export function prepareToolUseRetry(toolUseId: string): RetryToolUseResult {
  const id = typeof toolUseId === 'string' ? toolUseId.trim() : ''
  if (!id) {
    return { success: false, error: 'taskId is required' }
  }

  taskRuntimeStore.removeRecord(id)
  return { success: true, taskId: id }
}
