/**
 * Plan-step budget collector (#8, 2026-07 deep-loop uplift) tests.
 *
 * Contract under test:
 *   - no active plan / no in_progress step → no-op + counter reset
 *   - soft budget → ONE nudge per step (not repeated)
 *   - hard budget → TaskManager.update(status: 'failed') + hard directive
 *   - counter resets when the current step changes (progress)
 *   - main-chat-only + env kill-switch + hard=0 (nudge-only mode)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockGetAgentContext = vi.fn<() => { agentId?: string; streamConversationId?: string } | undefined>(
  () => ({ agentId: 'main', streamConversationId: 'conv-1' }),
)
vi.mock('../../../agents/agentContext', () => ({
  getAgentContext: () => mockGetAgentContext(),
}))

type Step = { taskId: string; subject: string; status: string }
let mockSteps: Step[] | null = null
vi.mock('../../../planning/planRuntime', () => ({
  getActivePlanStepsSnapshot: () =>
    mockSteps ? { planFilePath: '/ws/.cursor/plans/p.md', steps: mockSteps } : null,
}))

const mockTaskUpdate = vi.fn()
vi.mock('../../../tools/TaskManager', () => ({
  taskManager: { update: (...args: unknown[]) => mockTaskUpdate(...args) },
}))

import {
  DEFAULT_HARD_BUDGET_ITERATIONS,
  DEFAULT_SOFT_BUDGET_ITERATIONS,
  PLAN_STEP_BUDGET_MARKER,
  planStepBudgetCollector,
  __resetPlanStepBudgetTrackingForTests,
} from './planStepBudget'
import type { AttachmentContext } from '../hostAttachments'
import type { LoopState } from '../loopShared'

const ctx = (): AttachmentContext => ({
  state: { apiMessages: [], appendixReport: () => {} } as unknown as LoopState,
  systemPrompt: 'sys',
  callSite: 'post_tool',
})

/** Run the collector `n` times; returns every non-null action body. */
async function tick(n: number): Promise<string[]> {
  const bodies: string[] = []
  for (let i = 0; i < n; i++) {
    const raw = await planStepBudgetCollector.run(ctx())
    if (raw && !Array.isArray(raw)) {
      bodies.push(String((raw.message as { content?: unknown }).content))
    }
  }
  return bodies
}

beforeEach(() => {
  __resetPlanStepBudgetTrackingForTests()
  mockSteps = null
  mockTaskUpdate.mockReset()
  mockGetAgentContext.mockReturnValue({ agentId: 'main', streamConversationId: 'conv-1' })
})

afterEach(() => {
  delete process.env.POLE_PLAN_STEP_BUDGET
  delete process.env.POLE_PLAN_STEP_BUDGET_SOFT
  delete process.env.POLE_PLAN_STEP_BUDGET_HARD
})

describe('planStepBudgetCollector', () => {
  it('no-ops when there is no active plan', async () => {
    expect(await planStepBudgetCollector.run(ctx())).toBeNull()
  })

  it('no-ops when no step is in_progress', async () => {
    mockSteps = [{ taskId: 't1', subject: 'step 1', status: 'pending' }]
    expect(await planStepBudgetCollector.run(ctx())).toBeNull()
  })

  it('fires ONE soft nudge at the soft budget and stays silent after', async () => {
    process.env.POLE_PLAN_STEP_BUDGET_SOFT = '3'
    process.env.POLE_PLAN_STEP_BUDGET_HARD = '10'
    mockSteps = [{ taskId: 't1', subject: '实现解析器', status: 'in_progress' }]
    const bodies = await tick(6)
    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toContain(PLAN_STEP_BUDGET_MARKER)
    expect(bodies[0]).toContain('实现解析器')
    expect(bodies[0]).toContain('3 tool-batch iterations')
    expect(mockTaskUpdate).not.toHaveBeenCalled()
  })

  it('marks the step failed at the hard budget and emits the hard directive', async () => {
    process.env.POLE_PLAN_STEP_BUDGET_SOFT = '2'
    process.env.POLE_PLAN_STEP_BUDGET_HARD = '4'
    mockSteps = [{ taskId: 't1', subject: 'stuck step', status: 'in_progress' }]
    const bodies = await tick(4)
    // Soft nudge at tick 2, hard at tick 4.
    expect(bodies).toHaveLength(2)
    expect(bodies[1]).toContain('marked it FAILED')
    expect(mockTaskUpdate).toHaveBeenCalledWith('t1', { status: 'failed' })
  })

  it('resets the counter when the current step changes', async () => {
    process.env.POLE_PLAN_STEP_BUDGET_SOFT = '3'
    mockSteps = [{ taskId: 't1', subject: 'step 1', status: 'in_progress' }]
    await tick(2) // 2 ticks on t1, below soft
    mockSteps = [{ taskId: 't2', subject: 'step 2', status: 'in_progress' }]
    const bodies = await tick(2) // 2 ticks on t2 — fresh counter, below soft
    expect(bodies).toHaveLength(0)
  })

  it('hard=0 disables the fail action (nudge-only mode)', async () => {
    process.env.POLE_PLAN_STEP_BUDGET_SOFT = '2'
    process.env.POLE_PLAN_STEP_BUDGET_HARD = '0'
    mockSteps = [{ taskId: 't1', subject: 'slow step', status: 'in_progress' }]
    const bodies = await tick(30)
    expect(bodies).toHaveLength(1) // soft nudge only
    expect(bodies[0]).not.toContain('the host will mark it failed')
    expect(mockTaskUpdate).not.toHaveBeenCalled()
  })

  it('clamps hard budget to soft+1 when misconfigured below soft', async () => {
    process.env.POLE_PLAN_STEP_BUDGET_SOFT = '5'
    process.env.POLE_PLAN_STEP_BUDGET_HARD = '2'
    mockSteps = [{ taskId: 't1', subject: 's', status: 'in_progress' }]
    await tick(5)
    expect(mockTaskUpdate).not.toHaveBeenCalled() // hard clamped to 6, not 2
    await tick(1)
    expect(mockTaskUpdate).toHaveBeenCalledWith('t1', { status: 'failed' })
  })

  it('is main-chat only', async () => {
    mockGetAgentContext.mockReturnValue({ agentId: 'explore-1', streamConversationId: 'conv-1' })
    mockSteps = [{ taskId: 't1', subject: 's', status: 'in_progress' }]
    expect(await planStepBudgetCollector.run(ctx())).toBeNull()
  })

  it('honours the POLE_PLAN_STEP_BUDGET=0 kill-switch', async () => {
    process.env.POLE_PLAN_STEP_BUDGET = '0'
    mockSteps = [{ taskId: 't1', subject: 's', status: 'in_progress' }]
    const bodies = await tick(DEFAULT_HARD_BUDGET_ITERATIONS + DEFAULT_SOFT_BUDGET_ITERATIONS)
    expect(bodies).toHaveLength(0)
    expect(mockTaskUpdate).not.toHaveBeenCalled()
  })
})
