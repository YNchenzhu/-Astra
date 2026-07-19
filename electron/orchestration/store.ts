/**
 * JSON persistence for {@link OrchestrationState} under userData/orchestration.
 */

import fs from 'node:fs'
import path from 'node:path'
import type { CoordinatorPhase } from '../agents/types'
import {
  type OrchestrationState,
  ORCHESTRATION_STATE_VERSION,
  defaultOrchestrationState,
} from './types'

let storeDir: string | null = null

export function initOrchestrationStore(userDataPath: string): void {
  storeDir = path.join(userDataPath, 'orchestration')
  try {
    fs.mkdirSync(storeDir, { recursive: true })
  } catch {
    /* ignore */
  }
}

function safeConversationFileId(conversationId: string): string {
  return conversationId.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 200) || 'default'
}

function statePath(conversationId: string): string | null {
  if (!storeDir) return null
  return path.join(storeDir, `${safeConversationFileId(conversationId)}.json`)
}

export function loadOrchestrationState(conversationId: string): OrchestrationState {
  const p = statePath(conversationId)
  if (!p || !fs.existsSync(p)) {
    return defaultOrchestrationState(conversationId)
  }
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8')) as Partial<OrchestrationState> & {
      version?: number
      activeTaskId?: string
    }
    if (raw.conversationId !== conversationId) {
      return defaultOrchestrationState(conversationId)
    }
    const v = raw.version as number | undefined
    const research = raw.researchPhaseSatisfied === true
    const implementation = raw.implementationPhaseSatisfied === true
    /** v1 lumped research+synthesis into `researchPhaseSatisfied`; preserve unlock behavior. */
    let synthesis = raw.synthesisPhaseSatisfied === true
    let activeTaskId: string | undefined = undefined
    if (v === 1) {
      synthesis = research
    } else if (v === 2) {
      // v2 had no activeTaskId. Treat on-disk bits as "completed prior task": keep the
      // satisfied flags for backwards compat (so reopening a conversation right after upgrade does
      // not lose progress mid-task), but leave activeTaskId undefined so the next new user turn
      // mints a fresh id and resets gates.
      activeTaskId = undefined
    } else if (v !== ORCHESTRATION_STATE_VERSION) {
      return defaultOrchestrationState(conversationId)
    } else {
      activeTaskId =
        typeof raw.activeTaskId === 'string' && raw.activeTaskId.trim()
          ? raw.activeTaskId.trim()
          : undefined
    }
    return {
      conversationId,
      version: ORCHESTRATION_STATE_VERSION,
      updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : Date.now(),
      ...(activeTaskId ? { activeTaskId } : {}),
      researchPhaseSatisfied: research,
      synthesisPhaseSatisfied: synthesis,
      implementationPhaseSatisfied: implementation,
      lastSpawn: raw.lastSpawn,
      lastGateEvent: raw.lastGateEvent,
      lastSubAgentOutcome: raw.lastSubAgentOutcome,
    }
  } catch {
    return defaultOrchestrationState(conversationId)
  }
}

export function saveOrchestrationState(state: OrchestrationState): void {
  const p = statePath(state.conversationId)
  if (!p) return
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, JSON.stringify(state, null, 0), 'utf-8')
  } catch (e) {
    console.warn('[OrchestrationStore] save failed:', e)
  }
}

/**
 * Persist pre–Agent gate result and, when allowed, lastSpawn audit.
 * Replaces ad-hoc {@link recordAgentSpawn} for Coordinator strict flows.
 */
export function applyPreAgentGateAudit(params: {
  conversationId: string
  allowed: boolean
  agentType: string
  coordinatorPhase?: CoordinatorPhase
  blockReason?: string
}): void {
  const conv = params.conversationId.trim()
  if (!conv) return
  const cur = loadOrchestrationState(conv)
  const at = Date.now()
  cur.updatedAt = at
  cur.lastGateEvent = {
    allowed: params.allowed,
    agentType: params.agentType,
    coordinatorPhase: params.coordinatorPhase,
    at,
    ...(params.blockReason && { blockReason: params.blockReason }),
  }
  if (params.allowed) {
    cur.lastSpawn = {
      agentType: params.agentType,
      coordinatorPhase: params.coordinatorPhase,
      at,
    }
  }
  saveOrchestrationState(cur)
}

/** @deprecated Prefer {@link applyPreAgentGateAudit} — kept for external callers/tests. */
export function recordAgentSpawn(
  conversationId: string,
  agentType: string,
  coordinatorPhase?: CoordinatorPhase,
): void {
  applyPreAgentGateAudit({
    conversationId,
    allowed: true,
    agentType,
    coordinatorPhase,
  })
}

/**
 * Update phase satisfaction after a sub-agent terminal result.
 */
export function recordSubAgentOrchestrationOutcome(params: {
  conversationId: string | undefined
  success: boolean
  coordinatorPhase?: CoordinatorPhase
}): void {
  const { conversationId, success, coordinatorPhase } = params
  if (!conversationId || !String(conversationId).trim()) return

  const id = String(conversationId).trim()
  const cur = loadOrchestrationState(id)
  cur.updatedAt = Date.now()
  cur.lastSubAgentOutcome = {
    success,
    coordinatorPhase,
    at: Date.now(),
  }

  if (success && coordinatorPhase) {
    if (coordinatorPhase === 'research') {
      cur.researchPhaseSatisfied = true
    }
    if (coordinatorPhase === 'synthesis') {
      cur.synthesisPhaseSatisfied = true
    }
    if (coordinatorPhase === 'implementation') {
      cur.implementationPhaseSatisfied = true
    }
  }
  // 'verification' completes the loop but does not unlock earlier gates

  saveOrchestrationState(cur)
}

/**
 * Coordinator phase bits are per-task, not per-conversation. When the main thread starts
 * a new user turn (or otherwise detects a new task scope), it should call this to reset the
 * research / synthesis / implementation gate bits and bind subsequent `applyPreAgentGateAudit`
 * calls to the fresh `taskId`.
 *
 * If `taskId` matches the currently-stored `activeTaskId`, this is a no-op (same task continues).
 * If it differs (or no active task was recorded), all three phase-satisfied bits are reset to
 * false so the next Coordinator spawn must go through research → synthesis → implementation again.
 *
 * @returns `{ reset: boolean }` — whether phase bits were actually cleared (useful for telemetry).
 */
export function resetCoordinatorPhasesForNewTask(
  conversationId: string | undefined,
  taskId: string,
): { reset: boolean } {
  if (!conversationId || !String(conversationId).trim()) return { reset: false }
  const t = String(taskId).trim()
  if (!t) return { reset: false }
  const conv = String(conversationId).trim()
  const cur = loadOrchestrationState(conv)
  if (cur.activeTaskId === t) {
    return { reset: false }
  }
  const next: OrchestrationState = {
    ...cur,
    activeTaskId: t,
    researchPhaseSatisfied: false,
    synthesisPhaseSatisfied: false,
    implementationPhaseSatisfied: false,
    updatedAt: Date.now(),
  }
  saveOrchestrationState(next)
  return { reset: true }
}
