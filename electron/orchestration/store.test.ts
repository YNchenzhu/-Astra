/**
 * OrchestrationState `activeTaskId` + resetCoordinatorPhasesForNewTask.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  initOrchestrationStore,
  loadOrchestrationState,
  saveOrchestrationState,
  recordSubAgentOrchestrationOutcome,
  resetCoordinatorPhasesForNewTask,
} from './store'
import { ORCHESTRATION_STATE_VERSION } from './types'

let tmpDir = ''

describe('resetCoordinatorPhasesForNewTask ', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-store-'))
    initOrchestrationStore(tmpDir)
  })

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('first call binds activeTaskId and reports reset=true when prior bits existed', () => {
    // Seed prior-task bits into disk (as if v2 was sitting there after upgrade).
    saveOrchestrationState({
      conversationId: 'c1',
      version: ORCHESTRATION_STATE_VERSION,
      updatedAt: Date.now(),
      researchPhaseSatisfied: true,
      synthesisPhaseSatisfied: true,
      implementationPhaseSatisfied: false,
    })
    const r = resetCoordinatorPhasesForNewTask('c1', 'task-A')
    expect(r.reset).toBe(true)
    const loaded = loadOrchestrationState('c1')
    expect(loaded.activeTaskId).toBe('task-A')
    expect(loaded.researchPhaseSatisfied).toBe(false)
    expect(loaded.synthesisPhaseSatisfied).toBe(false)
    expect(loaded.implementationPhaseSatisfied).toBe(false)
  })

  it('same taskId is a no-op (preserves in-flight progress)', () => {
    const r1 = resetCoordinatorPhasesForNewTask('c1', 'task-A')
    expect(r1.reset).toBe(true)
    // Simulate Explore succeeding mid-task.
    recordSubAgentOrchestrationOutcome({
      conversationId: 'c1',
      success: true,
      coordinatorPhase: 'research',
    })
    const mid = loadOrchestrationState('c1')
    expect(mid.researchPhaseSatisfied).toBe(true)

    const r2 = resetCoordinatorPhasesForNewTask('c1', 'task-A')
    expect(r2.reset).toBe(false)
    const after = loadOrchestrationState('c1')
    expect(after.researchPhaseSatisfied).toBe(true)
  })

  it('different taskId resets all phase bits', () => {
    resetCoordinatorPhasesForNewTask('c1', 'task-A')
    recordSubAgentOrchestrationOutcome({
      conversationId: 'c1',
      success: true,
      coordinatorPhase: 'research',
    })
    recordSubAgentOrchestrationOutcome({
      conversationId: 'c1',
      success: true,
      coordinatorPhase: 'synthesis',
    })
    expect(loadOrchestrationState('c1').researchPhaseSatisfied).toBe(true)
    expect(loadOrchestrationState('c1').synthesisPhaseSatisfied).toBe(true)

    const r = resetCoordinatorPhasesForNewTask('c1', 'task-B')
    expect(r.reset).toBe(true)
    const after = loadOrchestrationState('c1')
    expect(after.activeTaskId).toBe('task-B')
    expect(after.researchPhaseSatisfied).toBe(false)
    expect(after.synthesisPhaseSatisfied).toBe(false)
    expect(after.implementationPhaseSatisfied).toBe(false)
  })

  it('noop when conversationId empty or taskId empty', () => {
    expect(resetCoordinatorPhasesForNewTask(undefined, 'x').reset).toBe(false)
    expect(resetCoordinatorPhasesForNewTask('', 'x').reset).toBe(false)
    expect(resetCoordinatorPhasesForNewTask('c1', '').reset).toBe(false)
    expect(resetCoordinatorPhasesForNewTask('c1', '   ').reset).toBe(false)
  })

  it('v2 on-disk state migrates to v3 and drops activeTaskId so next new-task triggers reset', () => {
    // Hand-craft a v2 state file on disk.
    const p = path.join(tmpDir, 'orchestration', 'c1.json')
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(
      p,
      JSON.stringify({
        conversationId: 'c1',
        version: 2,
        updatedAt: Date.now(),
        researchPhaseSatisfied: true,
        synthesisPhaseSatisfied: true,
        implementationPhaseSatisfied: false,
      }),
      'utf-8',
    )

    const loaded = loadOrchestrationState('c1')
    expect(loaded.version).toBe(ORCHESTRATION_STATE_VERSION)
    expect(loaded.activeTaskId).toBeUndefined()
    // Satisfied bits preserved so a mid-task conversation survives restart.
    expect(loaded.researchPhaseSatisfied).toBe(true)

    // New user turn → reset fires because activeTaskId was undefined.
    const r = resetCoordinatorPhasesForNewTask('c1', 'task-fresh')
    expect(r.reset).toBe(true)
    const after = loadOrchestrationState('c1')
    expect(after.activeTaskId).toBe('task-fresh')
    expect(after.researchPhaseSatisfied).toBe(false)
  })
})
