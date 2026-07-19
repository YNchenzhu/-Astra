import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../agents/agentContext', () => ({
  getAgentContext: vi.fn(() => ({ agentId: 'main' })),
}))
vi.mock('../../agents/bundles/bundleRegistryQueries', () => ({
  getActiveBundle: vi.fn(() => undefined),
}))
vi.mock('../../planning/planRuntime', () => ({
  getActivePlanStepsSnapshot: vi.fn(() => null),
}))
vi.mock('./hostAttachments/messageHistoryQueries', () => ({
  hasGenuineHumanTurnSinceLastToolUse: vi.fn(() => false),
}))

import {
  buildPlanStepGuardSignal,
  PLAN_STEP_GUARD_MARKER,
  __resetPlanStepGuardEpisodesForTests,
} from './planStepGuard'
import { getAgentContext } from '../../agents/agentContext'
import { getActiveBundle } from '../../agents/bundles/bundleRegistryQueries'
import { getActivePlanStepsSnapshot } from '../../planning/planRuntime'
import { hasGenuineHumanTurnSinceLastToolUse } from './hostAttachments/messageHistoryQueries'

const snap = (steps: Array<{ status: string; subject: string }>) => ({
  planFilePath: '/ws/.cursor/plans/p.plan.md',
  steps: steps.map((s, i) => ({ taskId: `task-${i}`, subject: s.subject, status: s.status })),
})

beforeEach(() => {
  vi.mocked(getAgentContext).mockReturnValue({ agentId: 'main' } as never)
  vi.mocked(getActiveBundle).mockReturnValue(undefined)
  vi.mocked(hasGenuineHumanTurnSinceLastToolUse).mockReturnValue(false)
  delete process.env.POLE_PLAN_STEP_GUARD
  delete process.env.POLE_PLAN_STEP_GUARD_MAX_NUDGES
  __resetPlanStepGuardEpisodesForTests()
})
afterEach(() => {
  vi.clearAllMocks()
})

describe('buildPlanStepGuardSignal', () => {
  it('fires with a hard directive when an active plan has open steps', () => {
    vi.mocked(getActivePlanStepsSnapshot).mockReturnValue(
      snap([
        { status: 'completed', subject: 'outline' },
        { status: 'in_progress', subject: 'write draft' },
        { status: 'pending', subject: 'tone pass' },
      ]),
    )
    const sig = buildPlanStepGuardSignal([], 'working on it')
    expect(sig).toBeDefined()
    expect(sig?.openCount).toBe(2)
    expect(sig?.directiveBody).toContain(PLAN_STEP_GUARD_MARKER)
    expect(sig?.directiveBody).toContain('write draft') // current step surfaced
    expect(sig?.directiveBody).toContain('turn cannot end yet')
  })

  it('uses the softer reconcile directive when a human turn intervened', () => {
    vi.mocked(getActivePlanStepsSnapshot).mockReturnValue(
      snap([{ status: 'in_progress', subject: 'step A' }]),
    )
    vi.mocked(hasGenuineHumanTurnSinceLastToolUse).mockReturnValue(true)
    const sig = buildPlanStepGuardSignal([], 'ok')
    expect(sig?.directiveBody).toContain('reconcile before ending')
  })

  it('does not fire when there is no active plan', () => {
    vi.mocked(getActivePlanStepsSnapshot).mockReturnValue(null)
    expect(buildPlanStepGuardSignal([], 'x')).toBeUndefined()
  })

  it('does not fire when all steps are done', () => {
    vi.mocked(getActivePlanStepsSnapshot).mockReturnValue(
      snap([{ status: 'completed', subject: 'a' }, { status: 'completed', subject: 'b' }]),
    )
    expect(buildPlanStepGuardSignal([], 'x')).toBeUndefined()
  })

  it('is exempt when the visible reply is a question to the user', () => {
    vi.mocked(getActivePlanStepsSnapshot).mockReturnValue(
      snap([{ status: 'in_progress', subject: 'a' }]),
    )
    expect(buildPlanStepGuardSignal([], 'Which database should I use?')).toBeUndefined()
  })

  it('is disabled for sub-agents (agentId !== main)', () => {
    vi.mocked(getAgentContext).mockReturnValue({ agentId: 'sub-1' } as never)
    vi.mocked(getActivePlanStepsSnapshot).mockReturnValue(
      snap([{ status: 'in_progress', subject: 'a' }]),
    )
    expect(buildPlanStepGuardSignal([], 'x')).toBeUndefined()
  })

  it('is disabled when the work package requests coarse step granularity', () => {
    vi.mocked(getActiveBundle).mockReturnValue({
      meta: { id: 'batchy' },
      executionPolicy: { stepGranularity: 'coarse' },
    } as never)
    vi.mocked(getActivePlanStepsSnapshot).mockReturnValue(
      snap([{ status: 'in_progress', subject: 'a' }]),
    )
    expect(buildPlanStepGuardSignal([], 'x')).toBeUndefined()
  })

  it('stays on for fine / unset granularity', () => {
    vi.mocked(getActiveBundle).mockReturnValue({
      meta: { id: 'fine-bundle' },
      executionPolicy: { stepGranularity: 'fine' },
    } as never)
    vi.mocked(getActivePlanStepsSnapshot).mockReturnValue(
      snap([{ status: 'in_progress', subject: 'a' }]),
    )
    expect(buildPlanStepGuardSignal([], 'x')).toBeDefined()
  })

  it('respects the POLE_PLAN_STEP_GUARD=0 kill switch', () => {
    process.env.POLE_PLAN_STEP_GUARD = '0'
    vi.mocked(getActivePlanStepsSnapshot).mockReturnValue(
      snap([{ status: 'in_progress', subject: 'a' }]),
    )
    expect(buildPlanStepGuardSignal([], 'x')).toBeUndefined()
  })

  describe('audit R1 — anti-spiral per-episode cap', () => {
    beforeEach(() => {
      vi.mocked(getAgentContext).mockReturnValue({
        agentId: 'main',
        streamConversationId: 'conv-spiral',
      } as never)
      process.env.POLE_PLAN_STEP_GUARD_MAX_NUDGES = '3'
    })

    it('stops firing after N consecutive nudges with no step progress', () => {
      vi.mocked(getActivePlanStepsSnapshot).mockReturnValue(
        snap([{ status: 'in_progress', subject: 'stuck step' }]),
      )
      // 3 fires allowed, the 4th is suppressed (cap reached, no progress).
      expect(buildPlanStepGuardSignal([], 'x')).toBeDefined()
      expect(buildPlanStepGuardSignal([], 'x')).toBeDefined()
      expect(buildPlanStepGuardSignal([], 'x')).toBeDefined()
      expect(buildPlanStepGuardSignal([], 'x')).toBeUndefined()
    })

    it('resets the cap when a step closes (open count drops)', () => {
      vi.mocked(getActivePlanStepsSnapshot).mockReturnValue(
        snap([
          { status: 'in_progress', subject: 's1' },
          { status: 'pending', subject: 's2' },
        ]),
      )
      buildPlanStepGuardSignal([], 'x')
      buildPlanStepGuardSignal([], 'x')
      buildPlanStepGuardSignal([], 'x')
      // Progress: one step closed → open count drops 2 → 1, cap resets.
      vi.mocked(getActivePlanStepsSnapshot).mockReturnValue(
        snap([{ status: 'in_progress', subject: 's2' }]),
      )
      expect(buildPlanStepGuardSignal([], 'x')).toBeDefined()
    })
  })
})
