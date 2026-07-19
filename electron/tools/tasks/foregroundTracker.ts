/**
 * Foreground task tracker — tracks foreground vs background tasks.
 *
 * Mirrors upstream's foreground/background dual mode.
 * Tasks registered here are "visible" in the main view; unregistered
 * tasks run in the background with separate output panels.
 */

import type { TaskStateBase } from './taskInterface'
import { updateTaskState } from './taskStateManager'

type ForegroundEntry = {
  taskId: string
  task: TaskStateBase
  unregisterCleanup?: () => void
}

const foregroundTasks = new Map<string, ForegroundEntry>()

/** Register a task as foreground (visible in main view). */
export function registerForegroundTask(
  taskId: string,
  task: TaskStateBase,
  unregisterCleanup?: () => void,
): void {
  foregroundTasks.set(taskId, { taskId, task, unregisterCleanup })
}

/**
 * Unregister a foreground task.
 *
 * `opts.runCleanup: false` removes the entry WITHOUT invoking the
 * registered cleanup callback. Backgrounding paths must use this: the
 * cleanup callbacks drop the manager's kill handle (`shellProcesses` /
 * `abortControllers` / `handles`), which is only correct when the task
 * reached a terminal state. Running them on background used to make
 * every backgrounded task unkillable (audit A-P0-1/A-P0-2).
 */
export function unregisterForegroundTask(
  taskId: string,
  opts?: { runCleanup?: boolean },
): void {
  const entry = foregroundTasks.get(taskId)
  foregroundTasks.delete(taskId)
  if (opts?.runCleanup === false) return
  if (entry?.unregisterCleanup) {
    try {
      entry.unregisterCleanup()
    } catch (err) {
      console.warn('[ForegroundTracker] cleanup error for', taskId, err)
    }
  }
}

/** Check if a task is foreground. */
export function isForegroundTask(taskId: string): boolean {
  return foregroundTasks.has(taskId)
}

/** Get all foreground tasks. */
export function getAllForegroundTasks(): ForegroundEntry[] {
  return [...foregroundTasks.values()]
}

/** Check if there are any foreground tasks that can be backgrounded. */
export function hasForegroundTasks(): boolean {
  return foregroundTasks.size > 0
}

/**
 * Background all foreground tasks (Ctrl+B equivalent). Returns list of task IDs.
 *
 * Mutates BOTH stores: writes `isBackgrounded=true` into `taskStateManager`
 * (the source-of-truth queried by `getBackgroundTasks()` /
 * `getForegroundTasks()`) and removes the entry from this tracker's local
 * map. The local `entry.task` ref is also flipped so any stray reader
 * holding the snapshot still sees a consistent value, but the authoritative
 * write goes through `updateTaskState` which produces a new object the
 * central store actually publishes.
 *
 * Without this dual-write the per-manager `backgroundXxxTask(id)` helpers
 * (Shell/Agent/Workflow/RemoteAgent) and the bulk path here would publish
 * inconsistent state — the bulk path would silently leave background tasks
 * still classified as foreground in the central manager.
 */
export function backgroundAllForegroundTasks(): string[] {
  const ids: string[] = []
  for (const [, entry] of foregroundTasks) {
    updateTaskState(entry.taskId, (state) => ({
      ...state,
      isBackgrounded: true,
    }))
    entry.task.isBackgrounded = true
    ids.push(entry.taskId)
    // Deliberately do NOT invoke `entry.unregisterCleanup` — the task keeps
    // running in the background, and the cleanup callbacks drop the kill
    // handles the manager needs to stop it later. The manager's own
    // terminal paths (complete/fail/kill) release those handles.
  }
  foregroundTasks.clear()
  return ids
}

/** Background a single foreground task. */
export function backgroundForegroundTask(taskId: string): boolean {
  const entry = foregroundTasks.get(taskId)
  if (!entry) return false
  updateTaskState(taskId, (state) => ({
    ...state,
    isBackgrounded: true,
  }))
  entry.task.isBackgrounded = true
  // Same as backgroundAllForegroundTasks: keep the kill handle alive.
  foregroundTasks.delete(taskId)
  return true
}
