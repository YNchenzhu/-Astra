/**
 * In-Process Teammate Task Types
 *
 * Defines the state and identity for in-process teammate execution.
 * Teammates run in the same process using AsyncLocalStorage for isolation.
 */

import type { AgentId, SessionId } from './ids'

export type TeammateIdentity = {
  agentId: AgentId // e.g., "researcher@my-team"
  agentName: string // e.g., "researcher"
  teamName: string
  color?: string
  planModeRequired: boolean
  parentSessionId: SessionId
}

export type InProcessTeammateTaskState = {
  id: string
  type: 'in_process_teammate'
  status: 'running' | 'idle' | 'completed' | 'failed' | 'stopped'

  // Identity
  identity: TeammateIdentity

  // Execution
  prompt: string
  model?: string

  // Plan mode
  awaitingPlanApproval: boolean

  // State
  error?: string
  messages: import('../utils/messages').Message[]

  // Lifecycle
  isIdle: boolean
  shutdownRequested: boolean

  // Progress tracking
  lastReportedToolCount: number
  lastReportedTokenCount: number

  // Runtime only
  abortController?: AbortController
  onIdleCallbacks?: Array<() => void>
}

export function isInProcessTeammateTask(
  task: unknown,
): task is InProcessTeammateTaskState {
  return (
    typeof task === 'object' &&
    task !== null &&
    'type' in task &&
    task.type === 'in_process_teammate'
  )
}

export const TEAMMATE_MESSAGES_UI_CAP = 50

export function appendCappedMessage<T>(
  prev: readonly T[] | undefined,
  item: T,
): T[] {
  if (prev === undefined || prev.length === 0) {
    return [item]
  }
  if (prev.length >= TEAMMATE_MESSAGES_UI_CAP) {
    const next = prev.slice(-(TEAMMATE_MESSAGES_UI_CAP - 1))
    next.push(item)
    return next
  }
  return [...prev, item]
}
