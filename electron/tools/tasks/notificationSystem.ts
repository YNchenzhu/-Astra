/**
 * Notification system — task completion/failure/stall notifications.
 *
 * Mirrors upstream's messageQueueManager + enqueuePendingNotification pattern.
 * Notifications are queued as XML and delivered at the next tool round boundary.
 */

export type NotificationStatus = 'completed' | 'failed' | 'killed' | 'stalled' | 'progress'

import type { AgentId } from '../ids'
import { fireNotificationHooks } from '../hooks/runtimeHookBridges'

export interface TaskNotification {
  taskId: string
  taskType: string
  status: NotificationStatus
  summary?: string
  outputPath?: string
  command?: string
  exitCode?: number
  error?: string
  /**
   * Agent that owns this task (set when the task was spawned by, or is itself,
   * a sub-agent). When the owning agent is killed, all of its queued
   * notifications are purged via {@link dequeueByAgent} so the next agent
   * doesn't see orphaned messages addressed to a dead one.
   */
  agentId?: AgentId
}

/** Pending notification queue. */
const pendingNotifications: TaskNotification[] = []

/** Enqueue a task notification for delivery to the LLM. */
export function enqueueTaskNotification(notification: TaskNotification): void {
  pendingNotifications.push(notification)
  fireNotificationHooks({ ...notification })
  maybeEmitBackgroundCompleted(notification)
}

/**
 * Precise auto-resume trigger source.
 *
 * The renderer's `autoResumeBackgroundTasks` controller must only wake an idle
 * conversation when BOTH conditions hold (per product intent + Cursor's
 * discrete completion-event design): the task was genuinely running in the
 * BACKGROUND and it reached `completed`. Inferring this from raw
 * `task:output-chunk` events was wrong — foreground commands (e.g. py_compile)
 * also emit a `completed` chunk, and a `kill` emits `stopped`, so the agent got
 * spurious `[自动续跑]` after finishing a normal turn.
 *
 * Here we sit at the single notification choke point and emit a dedicated
 * `background-task-completed` stream event ONLY when:
 *   - the notification status is `completed` (not failed / killed), AND
 *   - the owning task state is `isBackgrounded === true`.
 * Lazy-require keeps `taskStateManager` / electron `window` out of this pure
 * module's static graph (unit tests import it without an Electron stub).
 */
function maybeEmitBackgroundCompleted(n: TaskNotification): void {
  if (n.status !== 'completed') return
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy to avoid cycle / electron in test graph
    const { getTaskState } = require('./taskStateManager') as typeof import('./taskStateManager')
    const state = getTaskState(n.taskId)
    if (!state || state.isBackgrounded !== true) return
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy electron dependency
    const { sendToMainWindow } = require('../../window/mainWindow') as typeof import('../../window/mainWindow')
    sendToMainWindow('ai:stream-event', {
      type: 'background-task-completed',
      taskId: n.taskId,
    })
  } catch {
    /* best-effort; auto-resume is a convenience, never block the queue */
  }
}

/** Drain all pending notifications and return as formatted XML. */
export function drainNotificationsXml(): string | null {
  if (pendingNotifications.length === 0) return null

  const parts: string[] = []
  while (pendingNotifications.length > 0) {
    const n = pendingNotifications.shift()!
    const xml = formatNotificationXml(n)
    parts.push(xml)
  }

  return `<task_notifications>\n${parts.join('\n')}\n</task_notifications>`
}

function formatNotificationXml(n: TaskNotification): string {
  const lines: string[] = [
    '<task_notification>',
    `  <taskId>${escapeXml(n.taskId)}</taskId>`,
    `  <type>${escapeXml(n.taskType)}</type>`,
    `  <status>${escapeXml(n.status)}</status>`,
  ]
  if (n.summary) lines.push(`  <summary>${escapeXml(n.summary)}</summary>`)
  if (n.command) lines.push(`  <command>${escapeXml(n.command)}</command>`)
  if (typeof n.exitCode === 'number') lines.push(`  <exitCode>${n.exitCode}</exitCode>`)
  if (n.outputPath) lines.push(`  <outputPath>${escapeXml(n.outputPath)}</outputPath>`)
  if (n.error) lines.push(`  <error>${escapeXml(n.error)}</error>`)
  lines.push('</task_notification>')
  return lines.join('\n')
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

/** Check if there are pending notifications. */
export function hasPendingNotifications(): boolean {
  return pendingNotifications.length > 0
}

/** Clear all pending notifications. */
export function clearNotifications(): void {
  pendingNotifications.length = 0
}

/** Create a completion notification for a task. */
export function taskCompletedNotification(
  taskId: string,
  taskType: string,
  summary?: string,
  agentId?: AgentId,
): void {
  enqueueTaskNotification({ taskId, taskType, status: 'completed', summary, agentId })
}

/** Create a failure notification for a task. */
export function taskFailedNotification(
  taskId: string,
  taskType: string,
  error?: string,
  agentId?: AgentId,
): void {
  enqueueTaskNotification({ taskId, taskType, status: 'failed', error, agentId })
}

/** Create a killed notification for a task. */
export function taskKilledNotification(
  taskId: string,
  taskType: string,
  agentId?: AgentId,
): void {
  enqueueTaskNotification({ taskId, taskType, status: 'killed', agentId })
}

/**
 * Drop every queued notification owned by `agentId`. Called on agent kill
 * (and on `killShellTasksForAgent`) so the next agent's first
 * `drainNotificationsXml` doesn't carry messages addressed to a dead agent.
 * Returns the number of notifications removed (handy for tests + telemetry).
 */
export function dequeueByAgent(agentId: AgentId): number {
  let removed = 0
  for (let i = pendingNotifications.length - 1; i >= 0; i--) {
    if (pendingNotifications[i]!.agentId === agentId) {
      pendingNotifications.splice(i, 1)
      removed++
    }
  }
  return removed
}
