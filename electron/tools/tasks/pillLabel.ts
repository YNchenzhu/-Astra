/**
 * Pill label system — compact background task labels for the status bar.
 *
 * Mirrors upstream's pillLabel.ts: generates short text labels like
 * "1 shell", "2 local agents", "1 cloud session" for the footer pill.
 */

import type { TaskStateBase } from './taskInterface'
import type { LocalShellTaskState, RemoteAgentTaskState } from './guards'

/** Result from getPillLabel */
export interface PillInfo {
  /** Short label text for the pill */
  label: string
  /** Whether to show a "down arrow to view" CTA */
  needsCta: boolean
  /** Whether any task needs user input */
  needsInput: boolean
}

/** Get pill label for a collection of background tasks. */
export function getPillLabel(tasks: TaskStateBase[]): PillInfo {
  if (tasks.length === 0) {
    return { label: '', needsCta: false, needsInput: false }
  }

  // Count by type
  const counts = new Map<string, number>()
  let hasUltraplanInput = false
  let hasUltraplanReady = false

  for (const task of tasks) {
    if (!isRunningOrPending(task)) continue
    const key = pillTypeKey(task)
    counts.set(key, (counts.get(key) || 0) + 1)

    if (task.type === 'remote_agent') {
      const r = task as RemoteAgentTaskState
      if (r.ultraplanPhase === 'needs_input') hasUltraplanInput = true
      if (r.ultraplanPhase === 'plan_ready') hasUltraplanReady = true
    }
  }

  if (counts.size === 0) {
    return { label: '', needsCta: false, needsInput: false }
  }

  // Single type: show specific label
  if (counts.size === 1) {
    const [key, count] = counts.entries().next().value as [string, number]
    return {
      label: singleTypeLabel(key, count),
      needsCta: hasUltraplanInput || hasUltraplanReady,
      needsInput: hasUltraplanInput,
    }
  }

  // Multiple types: generic label
  const total = [...counts.values()].reduce((a, b) => a + b, 0)
  return {
    label: total === 1 ? '1 task' : `${total} tasks`,
    needsCta: hasUltraplanInput || hasUltraplanReady,
    needsInput: hasUltraplanInput,
  }
}

function pillTypeKey(task: TaskStateBase): string {
  if (task.type === 'local_bash') {
    const s = task as LocalShellTaskState
    return s.kind === 'monitor' ? 'monitor' : 'shell'
  }
  return task.type
}

function singleTypeLabel(key: string, count: number): string {
  switch (key) {
    case 'shell':
      return count === 1 ? '1 shell' : `${count} shells`
    case 'monitor':
      return count === 1 ? '1 monitor' : `${count} monitors`
    case 'local_agent':
      return count === 1 ? '1 agent' : `${count} agents`
    case 'remote_agent':
      return count === 1 ? '1 cloud' : `${count} cloud`
    case 'main_session':
      return count === 1 ? '1 session' : `${count} sessions`
    default:
      return count === 1 ? '1 task' : `${count} tasks`
  }
}

function isRunningOrPending(task: TaskStateBase): boolean {
  return task.status === 'running' || task.status === 'pending'
}
