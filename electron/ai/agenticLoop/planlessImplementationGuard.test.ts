import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../agents/agentContext', () => ({
  getAgentContext: vi.fn(() => ({ agentId: 'main', streamConversationId: 'conv-1' })),
}))
vi.mock('../../planning/planRuntime', () => ({
  getActivePlanStepsSnapshot: vi.fn(() => null),
}))
vi.mock('../../planning/verificationGateState', () => ({
  getVerificationGateState: vi.fn(() => undefined),
}))
vi.mock('../../tools/TodoWriteTool', () => ({
  hasActiveTodos: vi.fn(() => false),
}))
vi.mock('./verificationGate', () => ({
  activeBundleUsesCodeVerification: vi.fn(() => true),
}))

import {
  buildPlanlessImplementationGuardSignal,
  PLANLESS_GUARD_MARKER,
  __resetPlanlessGuardForTests,
} from './planlessImplementationGuard'
import { getAgentContext } from '../../agents/agentContext'
import { getActivePlanStepsSnapshot } from '../../planning/planRuntime'
import { getVerificationGateState } from '../../planning/verificationGateState'
import { hasActiveTodos } from '../../tools/TodoWriteTool'
import { activeBundleUsesCodeVerification } from './verificationGate'

beforeEach(() => {
  vi.mocked(getAgentContext).mockReturnValue({
    agentId: 'main',
    streamConversationId: 'conv-1',
  } as never)
  vi.mocked(getActivePlanStepsSnapshot).mockReturnValue(null)
  vi.mocked(getVerificationGateState).mockReturnValue({ needsVerification: true, mutationCount: 8 })
  vi.mocked(hasActiveTodos).mockReturnValue(false)
  vi.mocked(activeBundleUsesCodeVerification).mockReturnValue(true)
  delete process.env.POLE_PLANLESS_GUARD
  delete process.env.POLE_PLANLESS_GUARD_MIN_MUTATIONS
  __resetPlanlessGuardForTests()
})
afterEach(() => vi.clearAllMocks())

describe('buildPlanlessImplementationGuardSignal', () => {
  it('fires once when substantial unplanned mutations exist (no plan, no todos)', () => {
    const first = buildPlanlessImplementationGuardSignal('done some edits')
    expect(first).toBeDefined()
    expect(first?.mutationCount).toBe(8)
    expect(first?.directiveBody).toContain(PLANLESS_GUARD_MARKER)
    // One-shot: a second call in the same episode is suppressed.
    expect(buildPlanlessImplementationGuardSignal('still going')).toBeUndefined()
  })

  it('does not fire below the mutation threshold', () => {
    vi.mocked(getVerificationGateState).mockReturnValue({ needsVerification: true, mutationCount: 2 })
    expect(buildPlanlessImplementationGuardSignal('x')).toBeUndefined()
  })

  it('does not fire for non-code work packages', () => {
    vi.mocked(activeBundleUsesCodeVerification).mockReturnValue(false)
    expect(buildPlanlessImplementationGuardSignal('finished the domain document')).toBeUndefined()
  })

  it('does not fire when an active plan has open steps (work is tracked)', () => {
    vi.mocked(getActivePlanStepsSnapshot).mockReturnValue({
      planFilePath: '/p',
      steps: [{ taskId: 't1', subject: 's', status: 'in_progress' }],
    })
    expect(buildPlanlessImplementationGuardSignal('x')).toBeUndefined()
  })

  it('does not fire when there are active todos (work is tracked)', () => {
    vi.mocked(hasActiveTodos).mockReturnValue(true)
    expect(buildPlanlessImplementationGuardSignal('x')).toBeUndefined()
  })

  it('is exempt when the visible reply is a question', () => {
    expect(buildPlanlessImplementationGuardSignal('Should I use Postgres or MySQL?')).toBeUndefined()
  })

  it('is disabled for sub-agents', () => {
    vi.mocked(getAgentContext).mockReturnValue({
      agentId: 'sub-1',
      streamConversationId: 'conv-1',
    } as never)
    expect(buildPlanlessImplementationGuardSignal('x')).toBeUndefined()
  })

  it('respects the POLE_PLANLESS_GUARD=0 kill switch', () => {
    process.env.POLE_PLANLESS_GUARD = '0'
    expect(buildPlanlessImplementationGuardSignal('x')).toBeUndefined()
  })

  it('re-arms the one-shot once work becomes tracked then untracked again', () => {
    expect(buildPlanlessImplementationGuardSignal('x')).toBeDefined()
    // Model created todos → tracked → guard clears its one-shot flag.
    vi.mocked(hasActiveTodos).mockReturnValue(true)
    expect(buildPlanlessImplementationGuardSignal('x')).toBeUndefined()
    // Todos all done / cleared, but new unplanned edits pile up again.
    vi.mocked(hasActiveTodos).mockReturnValue(false)
    expect(buildPlanlessImplementationGuardSignal('x')).toBeDefined()
  })
})
