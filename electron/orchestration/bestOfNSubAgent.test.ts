import { describe, expect, it, vi, beforeEach } from 'vitest'

const runSubAgent = vi.fn()
const findAgentDefinition = vi.fn()
const getAgentContext = vi.fn()
const register = vi.fn()
const unregister = vi.fn()

vi.mock('../agents/subAgentRunner', () => ({
  runSubAgent: (args: unknown) => runSubAgent(args),
  findAgentDefinition: (type: string, all: unknown) => findAgentDefinition(type, all),
}))
vi.mock('../agents/agentContext', () => ({
  getAgentContext: () => getAgentContext(),
}))
vi.mock('../agents/builtInAgents', () => ({
  getBuiltInAgents: () => [],
}))
vi.mock('../agents/resolveAgentModelAlias', () => ({
  resolveAgentModelAlias: (_declared: unknown, parentModel: string) => parentModel,
}))
vi.mock('../agents/multiAgentOrchestratorSingleton', () => ({
  getMultiAgentOrchestrator: () => ({ register, unregister }),
  abortControllerToKernelShim: (ac: AbortController) => ({
    interrupt: () => ac.abort(),
    pause: () => false,
    resume: () => false,
  }),
}))

import { createSubAgentRunAttempt } from './bestOfNSubAgent'

beforeEach(() => {
  runSubAgent.mockReset()
  findAgentDefinition.mockReset()
  getAgentContext.mockReset()
  register.mockReset()
  unregister.mockReset()
  getAgentContext.mockReturnValue({ config: { id: 'anthropic' }, model: 'parent-model' })
  findAgentDefinition.mockImplementation((type: string) => ({
    agentType: type,
    model: undefined,
  }))
})

const ctx = {
  attemptIndex: 0,
  worktreePath: '/wt/0',
  task: 'fix the bug',
  signal: new AbortController().signal,
}

describe('createSubAgentRunAttempt', () => {
  it('runs the worker with worktree isolation + workspaceOverride and parses the Verification verdict', async () => {
    runSubAgent.mockImplementation(async (args: { agentDef: { agentType: string } }) => {
      if (args.agentDef.agentType === 'Verification') {
        return { success: true, output: 'ran tests\nVERDICT: PASS' }
      }
      return { success: true, output: 'implemented the fix' }
    })

    const runAttempt = createSubAgentRunAttempt()
    const result = await runAttempt(ctx)

    expect(result.finalText).toBe('implemented the fix')
    expect(result.verification?.verdict).toBe('PASS')

    // Worker call carries worktree isolation + the override path.
    const workerCall = runSubAgent.mock.calls.find(
      (c) => (c[0] as { agentDef: { agentType: string } }).agentDef.agentType === 'general-purpose',
    )!
    const workerArgs = workerCall[0] as { agentDef: { isolation?: string }; workspaceOverride?: string }
    expect(workerArgs.agentDef.isolation).toBe('worktree')
    expect(workerArgs.workspaceOverride).toBe('/wt/0')
  })

  it('registers the attempt in the orchestrator tree and unregisters on completion (L4)', async () => {
    runSubAgent.mockResolvedValue({ success: true, output: 'done' })
    const runAttempt = createSubAgentRunAttempt({ verify: false })
    await runAttempt(ctx)
    expect(register).toHaveBeenCalledTimes(1)
    expect(unregister).toHaveBeenCalledTimes(1)
    const meta = register.mock.calls[0][2] as { agentType: string; parentKernelId: string }
    expect(meta.agentType).toBe('best-of-n')
  })

  it('skips verification when verify:false (only one sub-agent run)', async () => {
    runSubAgent.mockResolvedValue({ success: true, output: 'done' })
    const runAttempt = createSubAgentRunAttempt({ verify: false })
    const result = await runAttempt(ctx)
    expect(result.verification).toBeUndefined()
    expect(runSubAgent).toHaveBeenCalledTimes(1)
  })

  it('returns an error artifact when the attempt fails with no output', async () => {
    runSubAgent.mockResolvedValue({ success: false, output: '', error: 'boom' })
    const runAttempt = createSubAgentRunAttempt({ verify: false })
    const result = await runAttempt(ctx)
    expect(result.error).toBe('boom')
  })

  it('errors when there is no active agent context', async () => {
    getAgentContext.mockReturnValue(null)
    const runAttempt = createSubAgentRunAttempt()
    const result = await runAttempt(ctx)
    expect(result.error).toContain('no active agent context')
  })

  it('tolerates a thrown Verification run (attempt still returns its output)', async () => {
    runSubAgent.mockImplementation(async (args: { agentDef: { agentType: string } }) => {
      if (args.agentDef.agentType === 'Verification') throw new Error('verify crashed')
      return { success: true, output: 'impl' }
    })
    const runAttempt = createSubAgentRunAttempt()
    const result = await runAttempt(ctx)
    expect(result.finalText).toBe('impl')
    expect(result.verification).toBeUndefined()
  })
})
