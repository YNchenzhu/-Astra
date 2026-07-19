/**
 * MCP Monitor Task Manager — long-lived MCP server liveness probes.
 *
 * Each connected MCP server gets one monitor task that pings periodically
 * and flips to `failed` when the connection drops. The renderer surfaces
 * this through the standard task notification XML so the model also sees
 * "MCP server `foo` lost connection — reconnect required" without us
 * having to thread MCP into every prompt.
 *
 * Differs from {@link AgentTaskManager} in two ways:
 *   - There's no AbortController to cancel a "monitor" — kill just stops
 *     the heartbeat interval.
 *   - `failed` is the natural terminal state on disconnect; `completed`
 *     fires only when the user explicitly closes the server.
 */

import { registerTaskState, updateTaskState, getTaskStatesByType } from './taskStateManager'
import { registerTaskImpl, type Task } from './taskInterface'
import type { MonitorMcpTaskState } from './guards'
import { taskCompletedNotification, taskFailedNotification, taskKilledNotification } from './notificationSystem'
import { registerCleanup, unregisterCleanup } from './cleanupRegistry'

/** Heartbeat handles keyed by taskId so we can cancel them on kill. */
const heartbeatHandles = new Map<string, ReturnType<typeof setInterval>>()
const notifiedTasks = new Set<string>()

export type McpMonitorRegistration = {
  taskId: string
  serverName: string
  description: string
  /**
   * Optional heartbeat function. When set, runs every `heartbeatIntervalMs`
   * (default 30s); a thrown error or rejected promise flips the task to
   * `failed` and emits the notification.
   */
  heartbeat?: () => Promise<void> | void
  heartbeatIntervalMs?: number
  connectionLabel?: string
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000

export function registerMcpMonitor(params: McpMonitorRegistration): MonitorMcpTaskState {
  const state: MonitorMcpTaskState = {
    id: params.taskId,
    type: 'monitor_mcp',
    status: 'running',
    description: params.description,
    startTime: Date.now(),
    notified: false,
    isBackgrounded: true, // monitors are always background by nature
    serverName: params.serverName,
    connectionLabel: params.connectionLabel,
    lastHeartbeatMs: Date.now(),
  }
  registerTaskState(state)

  if (params.heartbeat) {
    const interval = params.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS
    const handle = setInterval(async () => {
      try {
        await params.heartbeat!()
        updateTaskState(params.taskId, (s) => ({
          ...(s as MonitorMcpTaskState),
          lastHeartbeatMs: Date.now(),
        }))
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        failMcpMonitor(params.taskId, msg)
      }
    }, interval)
    heartbeatHandles.set(params.taskId, handle)
  }

  registerCleanup(params.taskId, async () => {
    const h = heartbeatHandles.get(params.taskId)
    if (h) clearInterval(h)
    heartbeatHandles.delete(params.taskId)
    notifiedTasks.delete(params.taskId)
  })

  return state
}

/** Manually flip a monitor to `completed` (user-initiated server shutdown). */
export function completeMcpMonitor(taskId: string, summary?: string): void {
  const h = heartbeatHandles.get(taskId)
  if (h) clearInterval(h)
  heartbeatHandles.delete(taskId)
  updateTaskState(taskId, (s) => ({
    ...s,
    status: 'completed' as const,
    endTime: Date.now(),
  }))
  if (!notifiedTasks.has(taskId)) {
    notifiedTasks.add(taskId)
    taskCompletedNotification(taskId, 'mcp', summary)
  }
  unregisterCleanup(taskId).catch(() => {})
}

/** Connection lost — flip to failed and emit one notification (idempotent). */
export function failMcpMonitor(taskId: string, error: string): void {
  const h = heartbeatHandles.get(taskId)
  if (h) clearInterval(h)
  heartbeatHandles.delete(taskId)
  updateTaskState(taskId, (s) => ({
    ...(s as MonitorMcpTaskState),
    status: 'failed' as const,
    endTime: Date.now(),
    lastError: error,
  }))
  if (!notifiedTasks.has(taskId)) {
    notifiedTasks.add(taskId)
    taskFailedNotification(taskId, 'mcp', error)
  }
  unregisterCleanup(taskId).catch(() => {})
}

export async function killMcpMonitor(taskId: string): Promise<void> {
  const h = heartbeatHandles.get(taskId)
  if (h) clearInterval(h)
  heartbeatHandles.delete(taskId)
  updateTaskState(taskId, (s) => ({
    ...s,
    status: 'killed' as const,
    endTime: Date.now(),
  }))
  if (!notifiedTasks.has(taskId)) {
    notifiedTasks.add(taskId)
    taskKilledNotification(taskId, 'mcp')
  }
  unregisterCleanup(taskId).catch(() => {})
}

export async function killAllMcpMonitors(): Promise<string[]> {
  const tasks = getTaskStatesByType('monitor_mcp').filter(
    (t) => t.status === 'running' || t.status === 'pending',
  )
  const killed: string[] = []
  for (const t of tasks) {
    try {
      await killMcpMonitor(t.id)
      killed.push(t.id)
    } catch (err) {
      console.warn('[McpMonitorTaskManager] failed to kill', t.id, err)
    }
  }
  return killed
}

const MonitorMcpTask: Task = {
  name: 'MonitorMcpTask',
  type: 'monitor_mcp',
  async kill(taskId: string): Promise<void> {
    await killMcpMonitor(taskId)
  },
}

registerTaskImpl(MonitorMcpTask)
