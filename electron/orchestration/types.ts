/**
 * Persisted coordinator / pre-agent gate state (disk JSON under userData/orchestration).
 * @see store.ts — distinct from {@link KernelLoopState} in `kernelTypes.ts`.
 */

import type { CoordinatorPhase } from '../agents/types'

/**
 * v3 — `activeTaskId` anchors the research/synthesis/implementation bits to a single
 * user task so a completed task does not leave sticky gates open for the next one (CC Coordinator
 * invariant: each user turn spans one full research → synthesis → implementation chain).
 */
export const ORCHESTRATION_STATE_VERSION = 3 as const

export type OrchestrationState = {
  conversationId: string
  version: typeof ORCHESTRATION_STATE_VERSION
  updatedAt: number
  /**
   * identifier of the user task these phase bits belong to (main thread mints one on
   * every new user turn when parent agent is Coordinator). When a new task id arrives, phase bits
   * are reset before gate evaluation.
   */
  activeTaskId?: string
  researchPhaseSatisfied: boolean
  synthesisPhaseSatisfied: boolean
  implementationPhaseSatisfied: boolean
  lastSpawn?: {
    agentType: string
    coordinatorPhase?: CoordinatorPhase
    at: number
  }
  lastGateEvent?: {
    allowed: boolean
    agentType: string
    coordinatorPhase?: CoordinatorPhase
    at: number
    blockReason?: string
  }
  lastSubAgentOutcome?: {
    success: boolean
    coordinatorPhase?: CoordinatorPhase
    at: number
  }
}

export function defaultOrchestrationState(conversationId: string): OrchestrationState {
  return {
    conversationId,
    version: ORCHESTRATION_STATE_VERSION,
    updatedAt: Date.now(),
    researchPhaseSatisfied: false,
    synthesisPhaseSatisfied: false,
    implementationPhaseSatisfied: false,
  }
}
