import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as store from './store'
import * as config from './config'
import { evaluatePreAgentSpawn } from './preAgentGate'
import type { BuiltInAgentDefinition } from '../agents/types'
import { ORCHESTRATION_STATE_VERSION } from './types'

const explore: BuiltInAgentDefinition = {
  source: 'built-in',
  agentType: 'Explore',
  whenToUse: '',
  coordinatorPhase: 'research',
  getSystemPrompt: () => '',
}

const gp: BuiltInAgentDefinition = {
  source: 'built-in',
  agentType: 'general-purpose',
  whenToUse: '',
  coordinatorPhase: 'implementation',
  getSystemPrompt: () => '',
}

const plan: BuiltInAgentDefinition = {
  source: 'built-in',
  agentType: 'Plan',
  whenToUse: '',
  coordinatorPhase: 'synthesis',
  getSystemPrompt: () => '',
}

describe('evaluatePreAgentSpawn', () => {
  beforeEach(() => {
    vi.spyOn(config, 'isOrchestrationStrictMode').mockReturnValue(true)
    vi.spyOn(store, 'loadOrchestrationState').mockReturnValue({
      conversationId: 'c1',
      version: ORCHESTRATION_STATE_VERSION,
      updatedAt: Date.now(),
      researchPhaseSatisfied: false,
      synthesisPhaseSatisfied: false,
      implementationPhaseSatisfied: false,
    })
    vi.spyOn(store, 'applyPreAgentGateAudit').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('allows any spawn when parent is not Coordinator', () => {
    const r = evaluatePreAgentSpawn({
      conversationId: 'c1',
      parentSessionAgentType: 'general-purpose',
      targetDef: gp,
    })
    expect(r.ok).toBe(true)
  })

  it('blocks implementation before research+synthesis when Coordinator + strict', () => {
    const r = evaluatePreAgentSpawn({
      conversationId: 'c1',
      parentSessionAgentType: 'Coordinator',
      targetDef: gp,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/research \(Explore\) and synthesis \(Plan\)/)
  })

  it('blocks implementation when only research satisfied', () => {
    vi.mocked(store.loadOrchestrationState).mockReturnValue({
      conversationId: 'c1',
      version: ORCHESTRATION_STATE_VERSION,
      updatedAt: Date.now(),
      researchPhaseSatisfied: true,
      synthesisPhaseSatisfied: false,
      implementationPhaseSatisfied: false,
    })
    const r = evaluatePreAgentSpawn({
      conversationId: 'c1',
      parentSessionAgentType: 'Coordinator',
      targetDef: gp,
    })
    expect(r.ok).toBe(false)
  })

  it('allows implementation after research and synthesis satisfied', () => {
    vi.mocked(store.loadOrchestrationState).mockReturnValue({
      conversationId: 'c1',
      version: ORCHESTRATION_STATE_VERSION,
      updatedAt: Date.now(),
      researchPhaseSatisfied: true,
      synthesisPhaseSatisfied: true,
      implementationPhaseSatisfied: false,
    })
    const r = evaluatePreAgentSpawn({
      conversationId: 'c1',
      parentSessionAgentType: 'Coordinator',
      targetDef: gp,
    })
    expect(r.ok).toBe(true)
  })

  it('blocks Plan (synthesis) before research when Coordinator + strict', () => {
    const r = evaluatePreAgentSpawn({
      conversationId: 'c1',
      parentSessionAgentType: 'Coordinator',
      targetDef: plan,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/Explore \(research/)
  })

  it('allows Plan after research satisfied', () => {
    vi.mocked(store.loadOrchestrationState).mockReturnValue({
      conversationId: 'c1',
      version: ORCHESTRATION_STATE_VERSION,
      updatedAt: Date.now(),
      researchPhaseSatisfied: true,
      synthesisPhaseSatisfied: false,
      implementationPhaseSatisfied: false,
    })
    const r = evaluatePreAgentSpawn({
      conversationId: 'c1',
      parentSessionAgentType: 'Coordinator',
      targetDef: plan,
    })
    expect(r.ok).toBe(true)
  })

  it('allows Explore under Coordinator + strict', () => {
    const r = evaluatePreAgentSpawn({
      conversationId: 'c1',
      parentSessionAgentType: 'Coordinator',
      targetDef: explore,
    })
    expect(r.ok).toBe(true)
  })
})
