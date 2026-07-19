/**
 * Agent Task Manager — manages local agent sub-process lifecycle.
 *
 * Mirrors upstream's LocalAgentTask: register foreground/background agents,
 * track progress (tool count, token count, recent activities), send completion
 * notifications, and support the Task interface kill().
 */

import type { AgentId } from '../ids'
import { registerTaskState, updateTaskState, getTaskStatesByType, getTaskState } from './taskStateManager'
import { registerForegroundTask, unregisterForegroundTask, isForegroundTask } from './foregroundTracker'
import { registerTaskImpl } from './taskInterface'
import type { Task } from './taskInterface'
import type { LocalAgentTaskState } from './guards'
import {
  enqueueTaskNotification,
  taskCompletedNotification,
  taskFailedNotification,
  dequeueByAgent,
} from './notificationSystem'
import { registerCleanup, unregisterCleanup } from './cleanupRegistry'
import { taskRuntimeStore } from '../TaskRuntimeStore'

/** Abort controllers keyed by task ID for kill support. */
const abortControllers = new Map<string, AbortController>()

/** Whether notification was already sent for this task. */
const notifiedTasks = new Set<string>()

/**
 * Auto-background timers keyed by task ID. upstream §10.6 parity
 * (`tengu_auto_background_agents`): a foreground agent that runs longer than
 * the threshold below is flipped to background so the chat UI can return to
 * the user instead of pinning a long-running task in the focused slot.
 *
 * Stored separately from {@link abortControllers} so we can clear the timer
 * independently when the agent terminates / is killed / is manually
 * backgrounded.
 */
const autoBackgroundTimers = new Map<string, ReturnType<typeof setTimeout>>()

/**
 * Default 120s threshold (upstream `tengu_auto_background_agents` baseline).
 * Override via `POLE_AUTO_BACKGROUND_AGENTS_MS`; set to `0` (or any non-
 * positive number) to disable the auto-background behaviour entirely.
 */
const AUTO_BACKGROUND_AFTER_MS_DEFAULT = 120_000

function readAutoBackgroundThresholdMs(): number {
  const raw = process.env.POLE_AUTO_BACKGROUND_AGENTS_MS?.trim()
  if (raw === undefined || raw === '') return AUTO_BACKGROUND_AFTER_MS_DEFAULT
  const n = Number(raw)
  if (!Number.isFinite(n)) return AUTO_BACKGROUND_AFTER_MS_DEFAULT
  // Caller can disable explicitly with 0 / negative.
  return Math.max(0, Math.floor(n))
}

function clearAutoBackgroundTimer(taskId: string): void {
  const handle = autoBackgroundTimers.get(taskId)
  if (handle !== undefined) {
    clearTimeout(handle)
    autoBackgroundTimers.delete(taskId)
  }
}

function scheduleAutoBackground(taskId: string): void {
  const thresholdMs = readAutoBackgroundThresholdMs()
  if (thresholdMs <= 0) return // disabled via env

  clearAutoBackgroundTimer(taskId)
  // `unref()` so a pending auto-background timer never blocks Electron's main
  // process from quitting cleanly when the user closes the window.
  const handle = setTimeout(() => {
    autoBackgroundTimers.delete(taskId)

    // Guard 1: task may have already completed / failed / been killed.
    // Guard 2: task may have been manually backgrounded already
    //          (in which case `isForegroundTask` is false).
    const state = getTaskState(taskId)
    if (!state || state.status !== 'running') return
    if (!isForegroundTask(taskId)) return

    const flipped = backgroundAgentTask(taskId)
    if (flipped) {
      // Notify the model so it knows the previously-foreground task is now
      // running in the background. Distinct from completion: status remains
      // 'running'. Use the existing 'progress' notification channel rather
      // than inventing a new status.
      enqueueTaskNotification({
        taskId,
        taskType: 'local_agent',
        status: 'progress',
        summary: `Agent auto-backgrounded after ${Math.round(thresholdMs / 1000)}s — still running; results will arrive when ready.`,
        agentId: (state as LocalAgentTaskState).agentId,
      })
    }
  }, thresholdMs)
  if (typeof (handle as { unref?: () => void }).unref === 'function') {
    ;(handle as { unref?: () => void }).unref!()
  }
  autoBackgroundTimers.set(taskId, handle)
}

/**
 * Register a background (hidden) agent task.
 */
export function registerBackgroundAgent(params: {
  taskId: string
  agentId: AgentId
  prompt: string
  agentType: string
  model?: string
  selectedAgent?: string
  abortController: AbortController
}): LocalAgentTaskState {
  const state: LocalAgentTaskState = {
    id: params.taskId,
    type: 'local_agent',
    status: 'running',
    description: params.prompt.length > 100 ? params.prompt.slice(0, 100) + '...' : params.prompt,
    startTime: Date.now(),
    notified: false,
    isBackgrounded: true,
    agentId: params.agentId,
    prompt: params.prompt,
    agentType: params.agentType,
    model: params.model,
    selectedAgent: params.selectedAgent,
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

/**
 * Register a foreground (visible) agent task.
 */
export function registerForegroundAgent(params: {
  taskId: string
  agentId: AgentId
  prompt: string
  agentType: string
  model?: string
  selectedAgent?: string
  abortController: AbortController
}): LocalAgentTaskState {
  const state: LocalAgentTaskState = {
    id: params.taskId,
    type: 'local_agent',
    status: 'running',
    description: params.prompt.length > 100 ? params.prompt.slice(0, 100) + '...' : params.prompt,
    startTime: Date.now(),
    notified: false,
    isBackgrounded: false,
    agentId: params.agentId,
    prompt: params.prompt,
    agentType: params.agentType,
    model: params.model,
    selectedAgent: params.selectedAgent,
    retain: false,
  }

  registerTaskState(state)
  abortControllers.set(params.taskId, params.abortController)

  registerForegroundTask(params.taskId, state, () => {
    abortControllers.delete(params.taskId)
  })

  registerCleanup(params.taskId, async () => {
    clearAutoBackgroundTimer(params.taskId)
    abortControllers.get(params.taskId)?.abort()
    abortControllers.delete(params.taskId)
    notifiedTasks.delete(params.taskId)
  })

  // upstream §10.6 — flip to background after N seconds so a long-running
  // foreground agent doesn't pin the chat UI. Disabled by setting
  // `POLE_AUTO_BACKGROUND_AGENTS_MS=0`.
  scheduleAutoBackground(params.taskId)

  return state
}

/**
 * Update agent progress info.
 */
export function updateAgentProgress(
  taskId: string,
  progress: { toolUseCount: number; tokenCount: number; summary?: string },
): void {
  updateTaskState(taskId, (state) => {
    const agent = state as LocalAgentTaskState
    return {
      ...agent,
      progress: {
        ...(agent.progress || { toolUseCount: 0, tokenCount: 0 }),
        ...progress,
      },
    }
  })
}

/**
 * Update agent summary.
 */
export function updateAgentSummary(taskId: string, summary: string): void {
  updateTaskState(taskId, (state) => {
    const agent = state as LocalAgentTaskState
    return {
      ...agent,
      progress: {
        ...(agent.progress || { toolUseCount: 0, tokenCount: 0 }),
        summary,
      },
    }
  })
}

/**
 * Mark an agent task as completed and send notification.
 */
export function completeAgentTask(taskId: string, summary?: string): void {
  const agentId = (getTaskState(taskId) as LocalAgentTaskState | undefined)?.agentId

  updateTaskState(taskId, (state) => ({
    ...state,
    status: 'completed' as const,
    endTime: Date.now(),
  }))

  if (summary) {
    updateAgentSummary(taskId, summary)
  }

  if (!notifiedTasks.has(taskId)) {
    notifiedTasks.add(taskId)
    taskCompletedNotification(taskId, 'agent', summary, agentId)
  }

  clearAutoBackgroundTimer(taskId)
  unregisterForegroundTask(taskId)
  unregisterCleanup(taskId).catch(() => {})
  abortControllers.delete(taskId)
}

/**
 * Mark an agent task as failed and send notification.
 */
export function failAgentTask(taskId: string, error: string): void {
  const agentId = (getTaskState(taskId) as LocalAgentTaskState | undefined)?.agentId

  updateTaskState(taskId, (state) => ({
    ...state,
    status: 'failed' as const,
    endTime: Date.now(),
    error,
  }))

  if (!notifiedTasks.has(taskId)) {
    notifiedTasks.add(taskId)
    taskFailedNotification(taskId, 'agent', error, agentId)
  }

  clearAutoBackgroundTimer(taskId)
  unregisterForegroundTask(taskId)
  unregisterCleanup(taskId).catch(() => {})
  abortControllers.delete(taskId)
}

/**
 * Kill an agent task by ID. Implements the Task interface.
 *
 * After the state flip, also purges any pending notifications addressed to
 * this agent so the next agent doesn't read messages addressed to a corpse
 * (the same agentId is shared by the agent's own task and any shell tasks
 * it spawned, so this single dequeue covers both).
 */
export async function killAgentTask(taskId: string): Promise<void> {
  const agentId = (getTaskState(taskId) as LocalAgentTaskState | undefined)?.agentId

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

  clearAutoBackgroundTimer(taskId)
  taskRuntimeStore.markStopped(taskId)
  notifiedTasks.delete(taskId)

  // Drop the cleanup registration. Without this, every kill leaks one
  // entry in `cleanupCallbacks` until process exit, and re-using a task
  // id (tests, restart flows) trips the "duplicate cleanup registration"
  // warn. The callback itself is a safe no-op at this point — the
  // controller already aborted above and notifiedTasks was already
  // cleared — so invoking it again costs nothing.
  unregisterCleanup(taskId).catch(() => {})

  if (agentId) {
    dequeueByAgent(agentId)
  }
}

/**
 * Background a foreground agent task.
 */
export function backgroundAgentTask(taskId: string): boolean {
  if (!isForegroundTask(taskId)) return false
  // Keep the `abortControllers` kill handle — the agent keeps running in
  // the background and must remain killable via killAgentTask.
  unregisterForegroundTask(taskId, { runCleanup: false })
  // Either explicit user action or the auto-background timer fired — in
  // both cases the timer is no longer needed.
  clearAutoBackgroundTimer(taskId)

  updateTaskState(taskId, (state) => ({
    ...state,
    isBackgrounded: true,
  }))

  return true
}

// ============================================================
// Test-only hooks for the auto-background timer
// ============================================================

/** @internal Used by AgentTaskManager.test.ts to assert timer scheduling. */
export function __hasAutoBackgroundTimerForTests(taskId: string): boolean {
  return autoBackgroundTimers.has(taskId)
}

/** @internal Reset timers between tests to avoid cross-test leaks. */
export function __clearAllAutoBackgroundTimersForTests(): void {
  for (const handle of autoBackgroundTimers.values()) {
    clearTimeout(handle)
  }
  autoBackgroundTimers.clear()
}

/**
 * Kill all running agent tasks.
 */
export async function killAllAgentTasks(): Promise<string[]> {
  const agentTasks = getTaskStatesByType('local_agent').filter(
    (t) => t.status === 'running' || t.status === 'pending',
  )

  const killed: string[] = []
  for (const task of agentTasks) {
    try {
      await killAgentTask(task.id)
      killed.push(task.id)
    } catch (err) {
      console.warn('[AgentTaskManager] failed to kill agent task', task.id, err)
    }
  }

  return killed
}

/**
 * Mark agent tasks as notified without sending notifications.
 * Used before bulk-kill to prevent spam.
 */
export function markAgentTasksNotified(): void {
  for (const task of getTaskStatesByType('local_agent')) {
    notifiedTasks.add(task.id)
    updateTaskState(task.id, (state) => ({ ...state, notified: true }))
  }
}

// ============================================================
// Task interface implementation
// ============================================================

const LocalAgentTask: Task = {
  name: 'LocalAgentTask',
  type: 'local_agent',
  async kill(taskId: string): Promise<void> {
    await killAgentTask(taskId)
  },
}

registerTaskImpl(LocalAgentTask)
