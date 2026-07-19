/**
 * Spawn In-Process Teammate
 *
 * Creates and registers a new in-process teammate task.
 */

import type { InProcessTeammateTaskState, TeammateIdentity } from '../../types/InProcessTeammateTask'
import type { AgentModel } from '../../types/Agent'
import { useExecutionStore } from '../../stores/executionStore'
import { asAgentId, asSessionId } from '../../types/ids'

export type SpawnTeammateConfig = {
  name: string
  teamName: string
  prompt: string
  model?: AgentModel
  color?: string
  planModeRequired?: boolean
  parentSessionId?: string
}

export type SpawnTeammateResult = {
  success: boolean
  taskId?: string
  agentId?: string
  error?: string
}

/**
 * Spawn a new in-process teammate.
 */
export function spawnInProcessTeammate(config: SpawnTeammateConfig): SpawnTeammateResult {
  try {
    const taskId = globalThis.crypto?.randomUUID?.() || `task_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
    const agentId = `${config.name}@${config.teamName}`

    const identity: TeammateIdentity = {
      agentId: asAgentId(agentId),
      agentName: config.name,
      teamName: config.teamName,
      color: config.color,
      planModeRequired: config.planModeRequired ?? false,
      parentSessionId: asSessionId(config.parentSessionId || 'main'),
    }

    const task: InProcessTeammateTaskState = {
      id: taskId,
      type: 'in_process_teammate',
      status: 'idle',
      identity,
      prompt: config.prompt,
      model: config.model,
      awaitingPlanApproval: false,
      messages: [],
      isIdle: true,
      shutdownRequested: false,
      lastReportedToolCount: 0,
      lastReportedTokenCount: 0,
    }

    // Register task in store
    const store = useExecutionStore.getState()
    store.createTask(task)

    return {
      success: true,
      taskId,
      agentId,
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Kill an in-process teammate.
 */
export function killInProcessTeammate(taskId: string): void {
  const store = useExecutionStore.getState()
  const task = store.getTask(taskId)

  if (!task) {
    return
  }

  store.updateTask(taskId, {
    status: 'stopped',
    shutdownRequested: true,
  })
}

/**
 * Get all running teammates.
 */
export function getRunningTeammates(): InProcessTeammateTaskState[] {
  const store = useExecutionStore.getState()
  return store.getAllTasks().filter((t) => t.status === 'running')
}
