/**
 * Workflow Task Manager — declarative multi-step pipelines.
 *
 * A "workflow" is any task that runs a fixed (or model-driven) sequence of
 * steps and reports progress per step. Examples: the `WorkflowTool` runner,
 * the `ralphinho-rfc-pipeline` skill, the new "research → implement →
 * verify" auto-run path. We give them their own task type so the renderer
 * can show a step-progress bar and the kill button cancels the entire
 * pipeline (vs. just the current sub-step).
 *
 * Lifecycle parity with {@link AgentTaskManager}:
 *   - registerForeground / registerBackground
 *   - update / progress (step counter)
 *   - complete / fail / kill
 *   - implements `Task` interface so `taskDispatcher.stopTask` works.
 */

import type { AgentId } from '../ids'
import { registerTaskState, updateTaskState, getTaskStatesByType } from './taskStateManager'
import {
  registerForegroundTask,
  unregisterForegroundTask,
  isForegroundTask,
} from './foregroundTracker'
import { registerTaskImpl, type Task } from './taskInterface'
import type { LocalWorkflowTaskState } from './guards'
import { taskCompletedNotification, taskFailedNotification } from './notificationSystem'
import { registerCleanup, unregisterCleanup } from './cleanupRegistry'
import { taskRuntimeStore } from '../TaskRuntimeStore'

const abortControllers = new Map<string, AbortController>()
const notifiedTasks = new Set<string>()

export type WorkflowRegistration = {
  taskId: string
  workflowName: string
  description: string
  abortController: AbortController
  agentId?: AgentId
  totalSteps?: number
  toolUseId?: string
}

function buildState(
  params: WorkflowRegistration,
  isBackgrounded: boolean,
): LocalWorkflowTaskState {
  return {
    id: params.taskId,
    type: 'local_workflow',
    status: 'running',
    description:
      params.description.length > 100
        ? `${params.description.slice(0, 100)}...`
        : params.description,
    startTime: Date.now(),
    notified: false,
    isBackgrounded,
    workflowName: params.workflowName,
    agentId: params.agentId,
    stepIndex: 0,
    totalSteps: params.totalSteps,
    toolUseId: params.toolUseId,
  }
}

export function registerForegroundWorkflow(
  params: WorkflowRegistration,
): LocalWorkflowTaskState {
  const state = buildState(params, false)
  registerTaskState(state)
  abortControllers.set(params.taskId, params.abortController)
  registerForegroundTask(params.taskId, state, () => {
    abortControllers.delete(params.taskId)
  })
  registerCleanup(params.taskId, async () => {
    abortControllers.get(params.taskId)?.abort()
    abortControllers.delete(params.taskId)
    notifiedTasks.delete(params.taskId)
  })
  return state
}

export function registerBackgroundWorkflow(
  params: WorkflowRegistration,
): LocalWorkflowTaskState {
  const state = buildState(params, true)
  registerTaskState(state)
  abortControllers.set(params.taskId, params.abortController)
  registerCleanup(params.taskId, async () => {
    abortControllers.get(params.taskId)?.abort()
    abortControllers.delete(params.taskId)
    notifiedTasks.delete(params.taskId)
  })
  return state
}

/** Update the current step counter / label. */
export function updateWorkflowStep(
  taskId: string,
  stepIndex: number,
  currentStep?: string,
): void {
  updateTaskState(taskId, (state) => ({
    ...(state as LocalWorkflowTaskState),
    stepIndex,
    currentStep,
  }))
}

export function completeWorkflowTask(taskId: string, summary?: string): void {
  updateTaskState(taskId, (state) => ({
    ...state,
    status: 'completed' as const,
    endTime: Date.now(),
  }))
  if (!notifiedTasks.has(taskId)) {
    notifiedTasks.add(taskId)
    taskCompletedNotification(taskId, 'workflow', summary)
  }
  unregisterForegroundTask(taskId)
  unregisterCleanup(taskId).catch(() => {})
  abortControllers.delete(taskId)
}

export function failWorkflowTask(taskId: string, error: string): void {
  updateTaskState(taskId, (state) => ({
    ...state,
    status: 'failed' as const,
    endTime: Date.now(),
  }))
  if (!notifiedTasks.has(taskId)) {
    notifiedTasks.add(taskId)
    taskFailedNotification(taskId, 'workflow', error)
  }
  unregisterForegroundTask(taskId)
  unregisterCleanup(taskId).catch(() => {})
  abortControllers.delete(taskId)
}

export async function killWorkflowTask(taskId: string): Promise<void> {
  const controller = abortControllers.get(taskId)
  if (controller) {
    controller.abort()
    abortControllers.delete(taskId)
  }
  updateTaskState(taskId, (state) => ({
    ...state,
    status: 'killed' as const,
    endTime: Date.now(),
  }))
  taskRuntimeStore.markStopped(taskId)
  notifiedTasks.delete(taskId)
  // Symmetric with completeWorkflowTask / failWorkflowTask — drops the
  // cleanup registration so the registry doesn't leak entries on kill.
  unregisterCleanup(taskId).catch(() => {})
}

export function backgroundWorkflowTask(taskId: string): boolean {
  if (!isForegroundTask(taskId)) return false
  // Keep the `abortControllers` kill handle for the still-running workflow.
  unregisterForegroundTask(taskId, { runCleanup: false })
  updateTaskState(taskId, (state) => ({ ...state, isBackgrounded: true }))
  return true
}

export async function killAllWorkflowTasks(): Promise<string[]> {
  const tasks = getTaskStatesByType('local_workflow').filter(
    (t) => t.status === 'running' || t.status === 'pending',
  )
  const killed: string[] = []
  for (const t of tasks) {
    try {
      await killWorkflowTask(t.id)
      killed.push(t.id)
    } catch (err) {
      console.warn('[WorkflowTaskManager] failed to kill', t.id, err)
    }
  }
  return killed
}

const LocalWorkflowTask: Task = {
  name: 'LocalWorkflowTask',
  type: 'local_workflow',
  async kill(taskId: string): Promise<void> {
    await killWorkflowTask(taskId)
  },
}

registerTaskImpl(LocalWorkflowTask)
