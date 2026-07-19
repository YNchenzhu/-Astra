/**
 * Unit tests for VerifyPlanExecution v2 — deterministic cross-checks
 * (2026-06 verify-depth uplift).
 *
 *   1. Open-todo gate: open TodoWrite items block the clear; the model
 *      is told to finish / re-status them and re-call.
 *   2. Diagnostics advisory: outstanding error-severity diagnostics are
 *      surfaced (non-blocking); silent when the hub is unavailable —
 *      prose / document workspaces see no code-centric noise.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { verifyPlanExecutionTool } from './VerifyPlanExecutionTool'
import { resetTodos, setTodos } from './TodoWriteTool'
import {
  __resetPendingPlanVerificationForTests,
  getPendingPlanVerification,
  markPendingPlanVerification,
} from '../planning/planVerificationState'

const getAgentContextMock = vi.fn()
const getAllAuthoritativeMock = vi.fn()

vi.mock('../agents/agentContext', () => ({
  getAgentContext: () => getAgentContextMock(),
}))
vi.mock('../diagnostics/DiagnosticsHub', () => ({
  getDiagnosticsHub: () => ({
    getAllAuthoritative: () => getAllAuthoritativeMock(),
  }),
}))

const CONV = 'conv-verify'

beforeEach(() => {
  vi.clearAllMocks()
  getAgentContextMock.mockReturnValue({
    agentId: 'main',
    streamConversationId: CONV,
  })
  // Default: hub unavailable (the prose-workspace / headless shape).
  getAllAuthoritativeMock.mockImplementation(() => {
    throw new Error('hub not init')
  })
  __resetPendingPlanVerificationForTests()
  resetTodos('main')
})

afterEach(() => {
  __resetPendingPlanVerificationForTests()
  resetTodos('main')
})

function markPending(planId = 'plan-1') {
  markPendingPlanVerification(CONV, {
    planId,
    planText: '# plan',
    exitedAt: Date.now(),
  })
}

async function callTool(input: Record<string, unknown> = {}) {
  return verifyPlanExecutionTool.execute(
    { verificationReport: 'all steps done', ...input },
    undefined,
  )
}

describe('VerifyPlanExecution — open-todo gate (blocking)', () => {
  it('refuses to clear while open todos remain and lists them', async () => {
    markPending()
    setTodos('main', [
      { content: 'implement parser', status: 'in_progress', activeForm: 'implementing parser' },
      { content: 'write tests', status: 'pending', activeForm: 'writing tests' },
      { content: 'done thing', status: 'completed', activeForm: 'doing done thing' },
    ])
    const result = await callTool()
    expect(result.success).toBe(true)
    expect(result.output).toContain('NOT accepted')
    expect(result.output).toContain('2 open item(s)')
    expect(result.output).toContain('implement parser')
    expect(result.output).toContain('write tests')
    expect(result.output).not.toContain('done thing')
    // Pending entry survives — the reminder keeps firing.
    expect(getPendingPlanVerification(CONV)).toBeDefined()
  })

  it('clears once every todo is completed', async () => {
    markPending()
    setTodos('main', [
      { content: 'implement parser', status: 'completed', activeForm: 'implementing parser' },
    ])
    const result = await callTool()
    expect(result.success).toBe(true)
    expect(result.output).toContain('Verification acknowledged')
    expect(getPendingPlanVerification(CONV)).toBeUndefined()
  })

  it('clears when no todo list exists at all', async () => {
    markPending()
    const result = await callTool()
    expect(result.output).toContain('Verification acknowledged')
    expect(getPendingPlanVerification(CONV)).toBeUndefined()
  })

  // Audit fix (self-review): the gate must NOT fire when no pending
  // entry exists — there is nothing to protect, and the blocking
  // message ("entry was NOT cleared") would be false.
  it('does not block on open todos when no pending-verification entry exists', async () => {
    setTodos('main', [
      { content: 'unrelated chore', status: 'pending', activeForm: 'doing unrelated chore' },
    ])
    const result = await callTool()
    expect(result.success).toBe(true)
    expect(result.output).not.toContain('NOT accepted')
    expect(result.output).toContain('No matching pending-verification entry')
  })
})

describe('VerifyPlanExecution — diagnostics advisory (non-blocking)', () => {
  it('surfaces outstanding error-severity diagnostics but still clears', async () => {
    markPending()
    getAllAuthoritativeMock.mockReturnValue([
      {
        uri: 'file:///a.ts',
        diagnostics: [
          { severity: 1, message: 'boom', range: {} },
          { severity: 2, message: 'meh', range: {} },
        ],
      },
      { uri: 'file:///b.ts', diagnostics: [{ severity: 1, message: 'boom2', range: {} }] },
    ])
    const result = await callTool()
    expect(result.output).toContain('Advisory: 2 error-severity diagnostic(s) across 2 file(s)')
    expect(getPendingPlanVerification(CONV)).toBeUndefined()
  })

  it('stays silent when the hub is unavailable (prose / document workspaces)', async () => {
    markPending()
    const result = await callTool()
    expect(result.output).not.toContain('Advisory:')
  })

  it('stays silent when only warnings exist', async () => {
    markPending()
    getAllAuthoritativeMock.mockReturnValue([
      { uri: 'file:///a.ts', diagnostics: [{ severity: 2, message: 'meh', range: {} }] },
    ])
    const result = await callTool()
    expect(result.output).not.toContain('Advisory:')
  })
})

describe('VerifyPlanExecution — existing v1 semantics preserved', () => {
  it('reports a planId mismatch but still clears', async () => {
    markPending('plan-A')
    const result = await callTool({ planId: 'plan-B' })
    expect(result.output).toContain('does not match')
    expect(getPendingPlanVerification(CONV)).toBeUndefined()
  })

  it('accepts the report without conversation context', async () => {
    getAgentContextMock.mockReturnValue(undefined)
    const result = await callTool()
    expect(result.success).toBe(true)
    expect(result.output).toContain('no conversation context')
  })
})
