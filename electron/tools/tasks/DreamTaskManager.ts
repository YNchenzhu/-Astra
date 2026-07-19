/**
 * Dream Task Manager — proactive idle-time agents.
 *
 * "Dream" tasks fire when the user is idle for more than a configured
 * window. They run a sub-agent (e.g. memory consolidation, todo cleanup,
 * documentation polish) in the background and **must auto-yield** the
 * moment the user returns. This is the third type from upstream §6.1 we hadn't
 * implemented; landing it gives the proactive agent module a first-class
 * lifecycle handle so it stops piggybacking on `local_agent`.
 *
 * Lifecycle differs from a plain agent:
 *   - `kill()` is the user's "interrupt — I'm back" signal; not an error.
 *   - The auto-yield notification is a `completed` (with the dream's
 *     summary if any), NOT a `killed`.
 */

import type { AgentId } from '../ids'
import { registerTaskState, updateTaskState, getTaskStatesByType } from './taskStateManager'
import { registerTaskImpl, type Task } from './taskInterface'
import type { DreamTaskState } from './guards'
import { taskCompletedNotification, taskFailedNotification } from './notificationSystem'
import { registerCleanup, unregisterCleanup } from './cleanupRegistry'

const abortControllers = new Map<string, AbortController>()
const notifiedTasks = new Set<string>()

export type DreamRegistration = {
  taskId: string
  trigger: string
  description: string
  agentId?: AgentId
  abortController: AbortController
}

export function registerDream(params: DreamRegistration): DreamTaskState {
  const state: DreamTaskState = {
    id: params.taskId,
    type: 'dream',
    status: 'running',
    description:
      params.description.length > 100
        ? `${params.description.slice(0, 100)}...`
        : params.description,
    startTime: Date.now(),
    notified: false,
    isBackgrounded: true,
    trigger: params.trigger,
    agentId: params.agentId,
  }
  registerTaskState(state)
  abortControllers.set(params.taskId, params.abortController)
  registerCleanup(params.taskId, async () => {
    abortControllers.get(params.taskId)?.abort()
    abortControllers.delete(params.taskId)
    notifiedTasks.delete(params.taskId)
  })
  return state
}

export function updateDreamSummary(taskId: string, summary: string): void {
  updateTaskState(taskId, (state) => ({
    ...(state as DreamTaskState),
    summary,
  }))
}

export function completeDream(taskId: string, summary?: string): void {
  if (summary) updateDreamSummary(taskId, summary)
  updateTaskState(taskId, (state) => ({
    ...state,
    status: 'completed' as const,
    endTime: Date.now(),
  }))
  if (!notifiedTasks.has(taskId)) {
    notifiedTasks.add(taskId)
    taskCompletedNotification(taskId, 'dream', summary)
  }
  unregisterCleanup(taskId).catch(() => {})
  abortControllers.delete(taskId)
}

export function failDream(taskId: string, error: string): void {
  updateTaskState(taskId, (state) => ({
    ...state,
    status: 'failed' as const,
    endTime: Date.now(),
  }))
  if (!notifiedTasks.has(taskId)) {
    notifiedTasks.add(taskId)
    taskFailedNotification(taskId, 'dream', error)
  }
  unregisterCleanup(taskId).catch(() => {})
  abortControllers.delete(taskId)
}

/**
 * "Wake up" the dream — abort sub-agent and roll the task to `completed`
 * with whatever partial summary it managed to capture. This is the path
 * the renderer should call when the user returns; it does NOT raise a
 * "task killed" notification (those are noisy for proactive flows).
 */
export async function wakeDream(taskId: string, partialSummary?: string): Promise<void> {
  const controller = abortControllers.get(taskId)
  if (controller) {
    controller.abort()
    abortControllers.delete(taskId)
  }
  if (partialSummary) updateDreamSummary(taskId, partialSummary)
  updateTaskState(taskId, (state) => ({
    ...state,
    status: 'completed' as const,
    endTime: Date.now(),
  }))
  if (!notifiedTasks.has(taskId)) {
    notifiedTasks.add(taskId)
    taskCompletedNotification(taskId, 'dream', partialSummary)
  }
  unregisterCleanup(taskId).catch(() => {})
}

/** Standard kill (used by `taskDispatcher.stopTask`) — same effect as wake. */
export async function killDream(taskId: string): Promise<void> {
  await wakeDream(taskId)
}

export async function killAllDreams(): Promise<string[]> {
  const dreams = getTaskStatesByType('dream').filter(
    (t) => t.status === 'running' || t.status === 'pending',
  )
  const killed: string[] = []
  for (const d of dreams) {
    try {
      await killDream(d.id)
      killed.push(d.id)
    } catch (err) {
      console.warn('[DreamTaskManager] failed to kill', d.id, err)
    }
  }
  return killed
}

const DreamTask: Task = {
  name: 'DreamTask',
  type: 'dream',
  async kill(taskId: string): Promise<void> {
    await killDream(taskId)
  },
}

registerTaskImpl(DreamTask)
