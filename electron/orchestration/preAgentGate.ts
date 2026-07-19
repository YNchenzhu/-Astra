/**
 * Pre–Agent-tool gate: optional strict ordering for Coordinator sessions.
 */

import type { AgentDefinitionUnion } from '../agents/types'
import { loadOrchestrationState, applyPreAgentGateAudit } from './store'
import { isOrchestrationStrictMode } from './config'

export type PreAgentGateResult = { ok: true } | { ok: false; error: string }

function gateError(phase: string, detail: string): { ok: false; error: string } {
  return {
    ok: false,
    error: `[Orchestration] Strict mode: cannot spawn this agent yet (${phase}). ${detail}`,
  }
}

function isCoordinatorSessionAgentType(agentType: string | undefined): boolean {
  const t = agentType?.trim().toLowerCase()
  if (!t) return false
  return t === 'coordinator' || t.endsWith('coordinator') || t.includes('coordinator-')
}

/**
 * Runs before spawning a sub-agent. Persists gate audit (allowed and blocked) per conversation.
 */
export function evaluatePreAgentSpawn(params: {
  conversationId: string | undefined
  parentSessionAgentType: string | undefined
  targetDef: AgentDefinitionUnion
}): PreAgentGateResult {
  const { conversationId, parentSessionAgentType, targetDef } = params
  const phase = targetDef.coordinatorPhase
  const conv = conversationId && String(conversationId).trim() ? String(conversationId).trim() : ''
  const agentType = targetDef.agentType

  const audit = (allowed: boolean, blockReason?: string): void => {
    if (!conv) return
    applyPreAgentGateAudit({
      conversationId: conv,
      allowed,
      agentType,
      coordinatorPhase: phase,
      ...(blockReason && { blockReason }),
    })
  }

  if (!isOrchestrationStrictMode()) {
    audit(true)
    return { ok: true }
  }

  if (!isCoordinatorSessionAgentType(parentSessionAgentType)) {
    audit(true)
    return { ok: true }
  }

  if (!conv) {
    audit(true)
    return { ok: true }
  }

  const state = loadOrchestrationState(conv)

  if (phase === 'synthesis') {
    if (!state.researchPhaseSatisfied) {
      const err = gateError(
        'synthesis',
        'Run Explore (research phase) successfully before spawning Plan or another synthesis agent.',
      )
      audit(false, err.error)
      return err
    }
  }

  if (phase === 'implementation') {
    if (!state.researchPhaseSatisfied || !state.synthesisPhaseSatisfied) {
      const err = gateError(
        'implementation',
        'Complete research (Explore) and synthesis (Plan) successfully before implementation agents.',
      )
      audit(false, err.error)
      return err
    }
  }

  if (phase === 'verification') {
    if (!state.implementationPhaseSatisfied) {
      const err = gateError(
        'verification',
        'Run an implementation agent (general-purpose or Debug) successfully first.',
      )
      audit(false, err.error)
      return err
    }
  }

  audit(true)
  return { ok: true }
}
