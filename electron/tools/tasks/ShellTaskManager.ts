/**
 * Shell Task Manager — manages local shell/bash command lifecycle.
 *
 * Mirrors upstream's LocalShellTask: spawn, foreground/background mode,
 * stall watchdog, notification on completion, and the Task interface.
 */

import type { ChildProcess } from 'node:child_process'
import { asAgentId, type AgentId } from '../ids'
import { registerTaskState, updateTaskState, getTaskState, getTaskStatesByType, getAllTaskStates } from './taskStateManager'
import { registerForegroundTask, unregisterForegroundTask, isForegroundTask } from './foregroundTracker'
import { registerTaskImpl } from './taskInterface'
import type { Task } from './taskInterface'
import type { LocalShellTaskState } from './guards'
import {
  taskCompletedNotification,
  taskFailedNotification,
  dequeueByAgent,
} from './notificationSystem'
import { registerCleanup, unregisterCleanup } from './cleanupRegistry'
import { startStallWatchdog, STALL_TAIL_BYTES, type StallWatchdogHandle } from './stallWatchdog'
import { forceKillProcessTree, killProcessTree } from './killProcessTree'
import { taskRuntimeStore } from '../TaskRuntimeStore'

/** Active shell processes keyed by task ID, for kill support. */
const shellProcesses = new Map<string, ChildProcess>()

/** Active stall watchdogs keyed by task ID. */
const stallWatchdogs = new Map<string, StallWatchdogHandle>()

/** Whether notification was already sent for this task (prevent dupes). */
const notifiedTasks = new Set<string>()

/**
 * Create and register a shell task state.
 */
export function createShellTaskState(
  taskId: string,
  command: string,
  agentId?: string,
  kind: 'bash' | 'monitor' = 'bash',
  opts?: { isBackgrounded?: boolean },
): LocalShellTaskState {
  const state: LocalShellTaskState = {
    id: taskId,
    type: 'local_bash',
    status: 'running',
    description: command.length > 100 ? command.slice(0, 100) + '...' : command,
    startTime: Date.now(),
    notified: false,
    isBackgrounded: opts?.isBackgrounded ?? false,
    command,
    agentId: agentId ? asAgentId(agentId) : undefined,
    kind,
    lastReportedTotalLines: 0,
  }
  registerTaskState(state)
  return state
}

/**
 * Background bash/PowerShell — task state + cleanup so {@link killShellTasksForAgent} can reap children.
 */
export function registerBackgroundShellTask(
  taskId: string,
  command: string,
  agentId?: string,
): void {
  createShellTaskState(taskId, command, agentId, 'bash', { isBackgrounded: true })
  registerCleanup(taskId, async () => {
    const child = shellProcesses.get(taskId)
    if (child && !child.killed) {
      killProcessTree(child)
    }
    shellProcesses.delete(taskId)
  })
}

export function completeBackgroundShellTask(taskId: string, exitCode: number): void {
  updateTaskState(taskId, (state) => ({
    ...state,
    status: exitCode === 0 ? ('completed' as const) : ('failed' as const),
    endTime: Date.now(),
    result: { code: exitCode, interrupted: false },
  }))
  shellProcesses.delete(taskId)
  notifiedTasks.delete(taskId)
  unregisterCleanup(taskId).catch(() => {})
}

export function failBackgroundShellTask(taskId: string, _error: string): void {
  updateTaskState(taskId, (state) => ({
    ...state,
    status: 'failed' as const,
    endTime: Date.now(),
    result: { code: 1, interrupted: true },
  }))
  shellProcesses.delete(taskId)
  notifiedTasks.delete(taskId)
  unregisterCleanup(taskId).catch(() => {})
}

/**
 * Register a shell task as foreground.
 */
export function registerForegroundShell(
  taskId: string,
  command: string,
  agentId?: string,
  kind: 'bash' | 'monitor' = 'bash',
): LocalShellTaskState {
  const state = createShellTaskState(taskId, command, agentId, kind)

  registerForegroundTask(taskId, state, () => {
    shellProcesses.delete(taskId)
  })

  registerCleanup(taskId, async () => {
    const child = shellProcesses.get(taskId)
    if (child && !child.killed) {
      // Process-tree kill so a spawned bash/pwsh that launched grandchildren
      // (e.g. `node foo.js`) doesn't leak them — bare `child.kill()` leaves
      // the tree alive on Windows.
      killProcessTree(child)
    }
    stallWatchdogs.get(taskId)?.stop()
    stallWatchdogs.delete(taskId)
    shellProcesses.delete(taskId)
    notifiedTasks.delete(taskId)
  })

  return state
}

/**
 * Start stall watchdog for a foreground shell task.
 */
export function startShellStallWatchdog(taskId: string, command: string): void {
  const agentId = (getTaskState(taskId) as LocalShellTaskState | undefined)?.agentId
  const handle = startStallWatchdog(
    taskId,
    command,
    () => {
      // Estimate output size from taskRuntimeStore
      const record = taskRuntimeStore.get(taskId)
      return record ? record.chunks.reduce((sum, c) => sum + c.text.length, 0) : 0
    },
    () => {
      const record = taskRuntimeStore.get(taskId)
      if (!record) return ''
      const allText = record.chunks.map((c) => c.text).join('')
      return allText.slice(-STALL_TAIL_BYTES)
    },
    agentId,
  )
  stallWatchdogs.set(taskId, handle)
}

/**
 * Track a shell process for kill support.
 */
export function trackShellProcess(taskId: string, child: ChildProcess): void {
  shellProcesses.set(taskId, child)
}

/**
 * Mark a shell task as completed and send notification.
 */
export function completeShellTask(taskId: string, exitCode: number): void {
  const agentId = (getTaskState(taskId) as LocalShellTaskState | undefined)?.agentId

  updateTaskState(taskId, (state) => ({
    ...state,
    status: 'completed' as const,
    endTime: Date.now(),
    result: { code: exitCode, interrupted: false },
  }))

  // Clean up stall watchdog
  const handle = stallWatchdogs.get(taskId)
  if (handle) {
    handle.stop()
    stallWatchdogs.delete(taskId)
  }

  // Send notification if not already sent
  if (!notifiedTasks.has(taskId)) {
    notifiedTasks.add(taskId)
    taskCompletedNotification(
      taskId,
      'shell',
      exitCode === 0
        ? `Command completed successfully`
        : `Command failed with exit code ${exitCode}`,
      agentId,
    )
  }

  unregisterForegroundTask(taskId)
  unregisterCleanup(taskId).catch(() => {})
}

/**
 * Mark a shell task as failed and send notification.
 */
export function failShellTask(taskId: string, error: string): void {
  const agentId = (getTaskState(taskId) as LocalShellTaskState | undefined)?.agentId

  updateTaskState(taskId, (state) => ({
    ...state,
    status: 'failed' as const,
    endTime: Date.now(),
    result: { code: 1, interrupted: true },
  }))

  const handle = stallWatchdogs.get(taskId)
  if (handle) {
    handle.stop()
    stallWatchdogs.delete(taskId)
  }

  if (!notifiedTasks.has(taskId)) {
    notifiedTasks.add(taskId)
    taskFailedNotification(taskId, 'shell', error, agentId)
  }

  unregisterForegroundTask(taskId)
  unregisterCleanup(taskId).catch(() => {})
}

/**
 * Kill a shell task by ID. Implements the Task interface.
 */
export async function killShellTask(taskId: string): Promise<void> {
  const child = shellProcesses.get(taskId)
  if (child && !child.killed) {
    // Process-tree kill (Windows taskkill /T, POSIX SIGTERM→SIGKILL) so
    // TaskStop / bulk kill don't leak grandchildren — matches shellRunner's
    // own timeout/abort kill paths.
    killProcessTree(child)
  }

  const handle = stallWatchdogs.get(taskId)
  if (handle) {
    handle.stop()
    stallWatchdogs.delete(taskId)
  }

  try {
    taskRuntimeStore.markStopped(taskId)
  } catch {
    /* ignore */
  }

  updateTaskState(taskId, (state) => ({
    ...state,
    status: 'killed' as const,
    endTime: Date.now(),
    result: { code: 137, interrupted: true },
  }))

  shellProcesses.delete(taskId)
  notifiedTasks.delete(taskId)
  // Audit A-P1-3: kill is a terminal state — drop the foreground-tracker
  // entry too, otherwise `hasForegroundTasks()` kept reporting a corpse.
  unregisterForegroundTask(taskId)
  unregisterCleanup(taskId).catch(() => {})
}

/**
 * Background a foreground shell task.
 */
export function backgroundShellTask(taskId: string): boolean {
  if (!isForegroundTask(taskId)) return false
  // Keep the `shellProcesses` kill handle — the command keeps running in
  // the background and must remain killable via killShellTask/TaskStop.
  unregisterForegroundTask(taskId, { runCleanup: false })

  updateTaskState(taskId, (state) => ({
    ...state,
    isBackgrounded: true,
  }))

  return true
}

/**
 * Mark a shell task as notified (suppress duplicate notifications).
 */
export function markShellTaskNotified(taskId: string): void {
  notifiedTasks.add(taskId)
  updateTaskState(taskId, (state) => ({ ...state, notified: true }))
}

/**
 * Audit fix R6 (2026-05) — bulk-mark every active shell task as notified.
 *
 * Mirrors {@link markAgentTasksNotified}. `KillAllTasksTool` calls this before
 * the bulk kill so that a shell which naturally completes in the race window
 * between "we decided to kill everything" and "the kill actually reached the
 * child process" does NOT enqueue a `<status>completed</status>` notification
 * the user has no use for (they just asked for everything to stop).
 *
 * Without this, the agent-side suppression
 * ({@link markAgentTasksNotified}) was asymmetric: agents stayed quiet on
 * bulk kill but shells could still spam completion XML.
 */
export function markAllShellTasksNotified(): void {
  for (const task of getAllTaskStates()) {
    if (task.type !== 'local_bash') continue
    if (task.status !== 'running' && task.status !== 'pending') continue
    notifiedTasks.add(task.id)
    updateTaskState(task.id, (state) => ({ ...state, notified: true }))
  }
}

// ============================================================
// Task interface implementation
// ============================================================

const LocalShellTask: Task = {
  name: 'LocalShellTask',
  type: 'local_bash',
  async kill(taskId: string): Promise<void> {
    await killShellTask(taskId)
  },
}

registerTaskImpl(LocalShellTask)

/**
 * Kill all running shell tasks (called on app shutdown).
 */
export function killAllShellTasks(): void {
  for (const [taskId, child] of shellProcesses) {
    if (!child.killed && child.exitCode === null) {
      forceKillProcessTree(child)
    }
    const handle = stallWatchdogs.get(taskId)
    if (handle) {
      handle.stop()
      stallWatchdogs.delete(taskId)
    }
  }
  shellProcesses.clear()
  stallWatchdogs.clear()
}

/**
 * Kill all running shell tasks for a specific agent.
 *
 * Also purges any queued notifications addressed to this agent — without
 * this, a shell whose `completeShellTask` already enqueued a "command
 * completed" XML right before the kill ran would deliver that XML to the
 * next agent that drains notifications. See upstream killShellTasks.ts
 * `dequeueAllMatching(cmd => cmd.agentId === agentId)` for the same fix.
 */
export async function killShellTasksForAgent(agentId: AgentId): Promise<string[]> {
  const shellTasks = getTaskStatesByType('local_bash').filter(
    (t) =>
      (t.status === 'running' || t.status === 'pending') &&
      (t as LocalShellTaskState).agentId === agentId,
  )

  const killed: string[] = []
  for (const task of shellTasks) {
    try {
      await killShellTask(task.id)
      killed.push(task.id)
    } catch (err) {
      console.warn('[ShellTaskManager] failed to kill shell task for agent', task.id, err)
    }
  }

  dequeueByAgent(agentId)

  return killed
}
