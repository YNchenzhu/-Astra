/**
 * Remote Agent Task Manager — adapts {@link SessionHandle} to the unified
 * Task framework so a remote (worker-isolated) sub-agent shows up in the
 * same UI / kill / notification surface as local shells and agents.
 *
 * Lifecycle:
 *   - {@link registerRemoteAgent} stores a {@link RemoteAgentTaskState}
 *     and binds the SessionHandle's `done` promise so completion /
 *     failure flips the task state automatically and emits the right
 *     notification XML to the model on the next tool round.
 *   - {@link killRemoteAgentTask} routes the dispatcher's `stopTask` call
 *     to {@link SessionHandle.kill}; the spawner's grace window
 *     (postMessage abort → 2s wait → forceKill) handles signal escalation.
 *   - The `Task` interface impl is auto-registered on module load (same
 *     pattern as {@link AgentTaskManager}).
 */

import type { AgentId } from '../ids'
import { registerTaskState, updateTaskState, getTaskState, getTaskStatesByType } from './taskStateManager'
import { registerForegroundTask, unregisterForegroundTask, isForegroundTask } from './foregroundTracker'
import { registerTaskImpl, type Task } from './taskInterface'
import type { RemoteAgentTaskState } from './guards'
import { taskCompletedNotification, taskFailedNotification } from './notificationSystem'
import { registerCleanup, unregisterCleanup } from './cleanupRegistry'
import { taskRuntimeStore } from '../TaskRuntimeStore'
import type { SessionHandle } from '../../bridge/sessionSpawner'

/** Live SessionHandles keyed by taskId — looked up by `kill()` and tests. */
const handles = new Map<string, SessionHandle>()
const notifiedTasks = new Set<string>()

export type RemoteAgentRegistration = {
  taskId: string
  remoteId: string
  description: string
  session: SessionHandle
  isBackgrounded?: boolean
  toolUseId?: string
  agentId?: AgentId
  ultraplanPhase?: string
}

function buildState(
  params: RemoteAgentRegistration,
  isBackgrounded: boolean,
): RemoteAgentTaskState {
  const desc = params.description.length > 100
    ? `${params.description.slice(0, 100)}...`
    : params.description
  return {
    id: params.taskId,
    type: 'remote_agent',
    status: 'running',
    description: desc,
    startTime: Date.now(),
    notified: false,
    isBackgrounded,
    remoteId: params.remoteId,
    ultraplanPhase: params.ultraplanPhase,
    toolUseId: params.toolUseId,
  }
}

function bindLifecycle(taskId: string, session: SessionHandle): void {
  // Wire the SessionHandle's `done` promise to task-state transitions.
  // Failure modes:
  //   - `result` populated → completed
  //   - `error` populated → failed
  //   - exception during await (shouldn't happen — done never rejects) →
  //     route through fail path with the message.
  session.done
    .then((status) => {
      // Read-only existence check — `updateTaskState(_, s => s)` was an
      // identity update that still went through a spread + Map.set just
      // to detect "did the task get killed externally?". `getTaskState`
      // does the same observation without the wasted allocation/write.
      const taskState = getTaskState(taskId)
      if (!taskState || taskState.status !== 'running') {
        // Already killed externally; nothing more to do.
        return
      }
      if (status.error) {
        failRemoteAgentTask(taskId, status.error)
      } else {
        // `terminationResult` is typed optional on `AgenticLoopResult` —
        // guard with optional chaining so an early `done` resolution
        // (e.g. spawn-failure path) does not crash the lifecycle binder
        // with a TypeError. Falls back to the bare 'Remote agent done'
        // summary the caller already understands.
        const term = status.result?.terminationResult
        const summary = term
          ? `Remote agent done (${term.reason}, ${term.turnCount} turn(s))`
          : 'Remote agent done'
        completeRemoteAgentTask(taskId, summary)
      }
    })
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err)
      failRemoteAgentTask(taskId, message)
    })
}

export function registerForegroundRemoteAgent(
  params: RemoteAgentRegistration,
): RemoteAgentTaskState {
  const state = buildState(params, false)
  registerTaskState(state)
  handles.set(params.taskId, params.session)
  registerForegroundTask(params.taskId, state, () => {
    handles.delete(params.taskId)
  })
  registerCleanup(params.taskId, async () => {
    handles.delete(params.taskId)
    notifiedTasks.delete(params.taskId)
  })
  bindLifecycle(params.taskId, params.session)
  return state
}

export function registerBackgroundRemoteAgent(
  params: RemoteAgentRegistration,
): RemoteAgentTaskState {
  const state = buildState(params, true)
  registerTaskState(state)
  handles.set(params.taskId, params.session)
  registerCleanup(params.taskId, async () => {
    handles.delete(params.taskId)
    notifiedTasks.delete(params.taskId)
  })
  bindLifecycle(params.taskId, params.session)
  return state
}

export function completeRemoteAgentTask(taskId: string, summary?: string): void {
  updateTaskState(taskId, (state) => ({
    ...state,
    status: 'completed' as const,
    endTime: Date.now(),
  }))
  if (!notifiedTasks.has(taskId)) {
    notifiedTasks.add(taskId)
    taskCompletedNotification(taskId, 'remote_agent', summary)
  }
  unregisterForegroundTask(taskId)
  unregisterCleanup(taskId).catch(() => {})
  handles.delete(taskId)
}

export function failRemoteAgentTask(taskId: string, error: string): void {
  updateTaskState(taskId, (state) => ({
    ...state,
    status: 'failed' as const,
    endTime: Date.now(),
  }))
  if (!notifiedTasks.has(taskId)) {
    notifiedTasks.add(taskId)
    taskFailedNotification(taskId, 'remote_agent', error)
  }
  unregisterForegroundTask(taskId)
  unregisterCleanup(taskId).catch(() => {})
  handles.delete(taskId)
}

export async function killRemoteAgentTask(taskId: string): Promise<void> {
  const session = handles.get(taskId)
  if (session) {
    // Soft-kill via spawner; spawner escalates to forceKill after 2s.
    await session.kill('user-requested stop').catch(() => undefined)
    handles.delete(taskId)
  }
  updateTaskState(taskId, (state) => ({
    ...state,
    status: 'killed' as const,
    endTime: Date.now(),
  }))
  taskRuntimeStore.markStopped(taskId)
  notifiedTasks.delete(taskId)
  // Symmetric with completeRemoteAgentTask / failRemoteAgentTask — drops
  // the cleanup registration so the registry doesn't leak entries on kill.
  unregisterCleanup(taskId).catch(() => {})
}

export function backgroundRemoteAgentTask(taskId: string): boolean {
  if (!isForegroundTask(taskId)) return false
  // Keep the session handle for the still-running remote agent.
  unregisterForegroundTask(taskId, { runCleanup: false })
  updateTaskState(taskId, (state) => ({ ...state, isBackgrounded: true }))
  return true
}

export async function killAllRemoteAgentTasks(): Promise<string[]> {
  const tasks = getTaskStatesByType('remote_agent').filter(
    (t) => t.status === 'running' || t.status === 'pending',
  )
  const killed: string[] = []
  for (const t of tasks) {
    try {
      await killRemoteAgentTask(t.id)
      killed.push(t.id)
    } catch (err) {
      console.warn('[RemoteAgentTaskManager] failed to kill', t.id, err)
    }
  }
  return killed
}

/**
 * Test-only: peek at the live SessionHandle for a given task. Production
 * code goes through {@link killRemoteAgentTask} / state transitions.
 */
export function getRemoteAgentSessionForTest(taskId: string): SessionHandle | undefined {
  return handles.get(taskId)
}

const RemoteAgentTask: Task = {
  name: 'RemoteAgentTask',
  type: 'remote_agent',
  async kill(taskId: string): Promise<void> {
    await killRemoteAgentTask(taskId)
  },
}

registerTaskImpl(RemoteAgentTask)
