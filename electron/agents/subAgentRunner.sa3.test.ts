/**
 * Audit batch SA-3 — behavioural regression tests for `runSubAgent`.
 *
 * Fix 2 — worker failure fallback must NOT re-run the sub-agent in-process
 *         once the worker has already executed (or started executing) any
 *         tool, because that would duplicate tool side effects.
 * Fix 3 — spawns that hit the ephemeral-register branch (fork / skill /
 *         REPL / disk recovery) now get a MultiAgentOrchestrator lineage
 *         edge so `interruptTree(parent)` cascades into them; the edge is
 *         torn down when the run ends, and caller-owned edges
 *         (teamAutoLauncher pattern) are left untouched.
 * Fix 4(a) — `session-memory-internal` is hard-pinned to the in-process
 *         path even under `POLE_AGENT_WORKER=1` (sandbox invariant: its
 *         tool gate only exists in the main process).
 *
 * The model stream and the worker client are both mocked, mirroring the
 * style of `electron/integration/subAgentRunner.integration.test.ts`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { streamText } from '../ai/client'
import {
  runSubAgentInWorker,
  subAgentWorkerAvailable,
} from './subAgentWorkerClient'
import { runSubAgent } from './subAgentRunner'
import { SESSION_MEMORY_INTERNAL_AGENT } from './builtInAgents'
import { runWithAgentContextAsync, type AgentContext } from './agentContext'
import {
  getMultiAgentOrchestrator,
  resetMultiAgentOrchestratorForTests,
} from './multiAgentOrchestratorSingleton'
import { resetToolOrchestratorForTests } from '../orchestration/toolRuntime/orchestrator'
import {
  trackAgentInOrchestrator,
  unspawnAndUntrackAgent,
} from './agentLifecycle'
import {
  SESSION_MEMORY_INTERNAL_AGENT_TYPE,
  isSessionMemoryInternalAgentType,
} from './sessionMemorySandboxInvariant'
import { asAgentId } from '../tools/ids'
import type { BuiltInAgentDefinition, SubAgentResult } from './types'
import type { ProviderConfig } from '../ai/client'

vi.mock('../ai/client', () => ({
  streamText: vi.fn(async (_config, _params, callbacks) => {
    callbacks.onTextDelta?.('## Summary\nSA-3 in-process OK.')
    callbacks.onMessageEnd?.({ inputTokens: 1, outputTokens: 2, stopReason: 'end_turn' })
  }),
}))

vi.mock('./subAgentWorkerClient', () => ({
  runSubAgentInWorker: vi.fn(),
  subAgentWorkerAvailable: vi.fn(() => true),
}))

const config: ProviderConfig = { id: 'anthropic', name: 'anthropic', apiKey: 'test-key' }
const model = 'claude-sonnet-4-20250514'

/** Generic non-readonly agent — only routes to the worker via POLE_AGENT_WORKER=1. */
const genericDef: BuiltInAgentDefinition = {
  source: 'built-in',
  agentType: 'sa3-generic',
  whenToUse: '',
  tools: ['read_file'],
  getSystemPrompt: () => 'You are a test agent.',
}

function makeParentCtx(parentId: string): AgentContext {
  return {
    config,
    model,
    systemPrompt: '',
    messages: [],
    signal: new AbortController().signal,
    agentId: asAgentId(parentId),
  }
}

const savedEnv = process.env.POLE_AGENT_WORKER

beforeEach(() => {
  delete process.env.POLE_AGENT_WORKER
  resetMultiAgentOrchestratorForTests()
  resetToolOrchestratorForTests()
  vi.clearAllMocks()
  vi.mocked(subAgentWorkerAvailable).mockReturnValue(true)
  // Default in-process model stream — individual tests override as needed.
  vi.mocked(streamText).mockImplementation(async (_c, _p, cb) => {
    cb.onTextDelta?.('## Summary\nSA-3 in-process OK.')
    cb.onMessageEnd?.({ inputTokens: 1, outputTokens: 2, stopReason: 'end_turn' })
  })
})

afterEach(() => {
  if (savedEnv === undefined) delete process.env.POLE_AGENT_WORKER
  else process.env.POLE_AGENT_WORKER = savedEnv
  resetMultiAgentOrchestratorForTests()
  resetToolOrchestratorForTests()
})

describe('sessionMemorySandboxInvariant (pure predicate)', () => {
  it('recognises only the session-memory-internal agent type', () => {
    expect(isSessionMemoryInternalAgentType(SESSION_MEMORY_INTERNAL_AGENT_TYPE)).toBe(true)
    expect(isSessionMemoryInternalAgentType('session-memory-internal')).toBe(true)
    expect(isSessionMemoryInternalAgentType('Explore')).toBe(false)
    expect(isSessionMemoryInternalAgentType('')).toBe(false)
    expect(isSessionMemoryInternalAgentType(null)).toBe(false)
    expect(isSessionMemoryInternalAgentType(undefined)).toBe(false)
  })

  it('matches the built-in agent definition (drift guard)', () => {
    expect(SESSION_MEMORY_INTERNAL_AGENT.agentType).toBe(SESSION_MEMORY_INTERNAL_AGENT_TYPE)
  })
})

describe('SA-3 fix 4(a) — session-memory-internal never routes to the worker', () => {
  it('stays in-process even under POLE_AGENT_WORKER=1 with a worker available', async () => {
    process.env.POLE_AGENT_WORKER = '1'
    const ac = new AbortController()
    const result = await runSubAgent({
      config,
      model,
      agentDef: SESSION_MEMORY_INTERNAL_AGENT,
      prompt: 'Update the session notes file.',
      signal: ac.signal,
      onEvent: () => {},
    })

    // The sandbox invariant: the worker client must never be consulted.
    expect(vi.mocked(runSubAgentInWorker)).not.toHaveBeenCalled()
    // …and the run really executed in-process via the mocked model stream.
    expect(vi.mocked(streamText)).toHaveBeenCalled()
    expect(result.agentType).toBe('session-memory-internal')
    expect(result.success).toBe(true)
  })

  it('sanity: the same env flag DOES route a generic agent through the worker', async () => {
    process.env.POLE_AGENT_WORKER = '1'
    const workerResult: SubAgentResult = {
      success: true,
      agentId: asAgentId('agent-sa3-worker'),
      agentType: genericDef.agentType,
      output: 'from worker',
      totalTokens: 3,
      totalDurationMs: 5,
      totalToolUses: 0,
    }
    vi.mocked(runSubAgentInWorker).mockResolvedValue(workerResult)

    const ac = new AbortController()
    const result = await runSubAgent({
      config,
      model,
      agentDef: genericDef,
      prompt: 'ok',
      signal: ac.signal,
      onEvent: () => {},
    })

    expect(vi.mocked(runSubAgentInWorker)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(streamText)).not.toHaveBeenCalled()
    expect(result.output).toBe('from worker')
  })
})

describe('SA-3 fix 2 — worker failure fallback is gated on tool activity', () => {
  it('does NOT re-run in-process when the worker failed after tool activity', async () => {
    process.env.POLE_AGENT_WORKER = '1'
    vi.mocked(runSubAgentInWorker).mockImplementation(async (params) => {
      // Simulate: the worker executed (at least started) a tool, then died.
      params.onToolActivity?.()
      throw new Error('worker exploded mid-run')
    })

    const events: string[] = []
    const ac = new AbortController()
    const result = await runSubAgent({
      config,
      model,
      agentDef: genericDef,
      prompt: 'ok',
      signal: ac.signal,
      onEvent: (e) => {
        events.push(e.type)
      },
    })

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/already executed tool calls/)
    expect(result.error).toMatch(/worker exploded mid-run/)
    expect(result.output).toMatch(/fallback was skipped/i)
    // The critical assertion: the in-process loop must never have started,
    // otherwise the worker's tool side effects would have been duplicated.
    expect(vi.mocked(streamText)).not.toHaveBeenCalled()
    // Renderer contract: terminal events still fire so the AgentBlock
    // flips from running → completed.
    expect(events).toContain('subagent_error')
    expect(events).toContain('subagent_complete')
  })

  it('still falls back in-process for a pure startup failure (no tool ever started)', async () => {
    process.env.POLE_AGENT_WORKER = '1'
    vi.mocked(runSubAgentInWorker).mockRejectedValue(new Error('worker spawn failed'))

    const ac = new AbortController()
    const result = await runSubAgent({
      config,
      model,
      agentDef: genericDef,
      prompt: 'ok',
      signal: ac.signal,
      onEvent: () => {},
    })

    // Startup failure means zero side effects — the legacy fallback is safe
    // and the run completes via the in-process mocked stream.
    expect(vi.mocked(streamText)).toHaveBeenCalled()
    expect(result.success).toBe(true)
    expect(result.output).toMatch(/SA-3 in-process OK/)
  })
})

describe('SA-3 fix 3 — ephemeral spawns get an orchestrator lineage edge', () => {
  it('registers the parent→child edge during the run and drops it afterwards', async () => {
    const parentCtx = makeParentCtx('sa3-parent-1')
    let edgeDuringRun: ReturnType<ReturnType<typeof getMultiAgentOrchestrator>['get']>
    vi.mocked(streamText).mockImplementation(async (_c, _p, cb) => {
      edgeDuringRun = getMultiAgentOrchestrator().get('sa3-child-1')
      cb.onTextDelta?.('## Done')
      cb.onMessageEnd?.({ inputTokens: 1, outputTokens: 1, stopReason: 'end_turn' })
    })

    const ac = new AbortController()
    const result = await runWithAgentContextAsync(parentCtx, () =>
      runSubAgent({
        config,
        model,
        agentDef: genericDef,
        prompt: 'ok',
        agentIdOverride: 'sa3-child-1',
        signal: ac.signal,
        onEvent: () => {},
      }),
    )

    expect(result.success).toBe(true)
    // Mid-run: the lineage edge existed under the spawning parent.
    expect(edgeDuringRun).toBeDefined()
    expect(edgeDuringRun!.meta.parentKernelId).toBe('sa3-parent-1')
    expect(edgeDuringRun!.meta.agentType).toBe(genericDef.agentType)
    // Post-run: the runner tore its own edge down (no leak under parent).
    expect(getMultiAgentOrchestrator().get('sa3-child-1')).toBeUndefined()
    expect(getMultiAgentOrchestrator().listChildren('sa3-parent-1')).toHaveLength(0)
  })

  it('interruptTree(parent) cascades an abort into the ephemeral child', async () => {
    const parentCtx = makeParentCtx('sa3-parent-2')
    // `interruptTree(root)` only walks kernels that are registered, so the
    // parent itself must be in the orchestrator — exactly what production
    // spawn paths (agentTool / kernel) guarantee for the spawning agent.
    const parentAc = new AbortController()
    expect(
      trackAgentInOrchestrator({
        agentId: asAgentId('sa3-parent-2'),
        agentType: 'general-purpose',
        abortController: parentAc,
      }).ok,
    ).toBe(true)
    vi.mocked(streamText).mockImplementation(async (_c, _p, cb) => {
      // Simulate a user interrupt on the whole parent tree while the
      // child's model stream is in flight.
      getMultiAgentOrchestrator().interruptTree('sa3-parent-2', 'user')
      cb.onTextDelta?.('partial')
      cb.onMessageEnd?.({ inputTokens: 1, outputTokens: 1, stopReason: 'end_turn' })
    })

    const ac = new AbortController()
    const result = await runWithAgentContextAsync(parentCtx, () =>
      runSubAgent({
        config,
        model,
        agentDef: genericDef,
        prompt: 'ok',
        agentIdOverride: 'sa3-child-2',
        signal: ac.signal,
        onEvent: () => {},
      }),
    )

    // Before fix 3, the child had no orchestrator edge, interruptTree
    // never reached it, and this run would have completed successfully.
    expect(result.success).toBe(false)
    expect(result.aborted).toBe(true)

    unspawnAndUntrackAgent(asAgentId('sa3-parent-2'))
  })

  it('does not clobber or tear down a caller-owned edge (teamAutoLauncher pattern)', async () => {
    const parentCtx = makeParentCtx('sa3-parent-3')
    // Caller registers its own edge BEFORE runSubAgent (under a different
    // parent), exactly like teamAutoLauncher.
    const callerAc = new AbortController()
    const tracked = trackAgentInOrchestrator({
      agentId: asAgentId('sa3-child-3'),
      agentType: genericDef.agentType,
      abortController: callerAc,
      parentAgentId: 'sa3-team-parent',
    })
    expect(tracked.ok).toBe(true)

    const ac = new AbortController()
    const result = await runWithAgentContextAsync(parentCtx, () =>
      runSubAgent({
        config,
        model,
        agentDef: genericDef,
        prompt: 'ok',
        agentIdOverride: 'sa3-child-3',
        signal: ac.signal,
        onEvent: () => {},
      }),
    )
    expect(result.success).toBe(true)

    // The caller-owned edge survives the run un-clobbered: same parent,
    // still present (the runner only tears down edges it created itself).
    const edge = getMultiAgentOrchestrator().get('sa3-child-3')
    expect(edge).toBeDefined()
    expect(edge!.meta.parentKernelId).toBe('sa3-team-parent')

    unspawnAndUntrackAgent(asAgentId('sa3-child-3'))
  })

  it('root spawn registers a parentless kernel edge during the run and drops it afterwards', async () => {
    let edgeDuringRun: ReturnType<ReturnType<typeof getMultiAgentOrchestrator>['get']>
    vi.mocked(streamText).mockImplementation(async (_c, _p, cb) => {
      edgeDuringRun = getMultiAgentOrchestrator().get('sa3-child-4')
      cb.onTextDelta?.('## Done')
      cb.onMessageEnd?.({ inputTokens: 1, outputTokens: 1, stopReason: 'end_turn' })
    })

    const ac = new AbortController()
    const result = await runSubAgent({
      config,
      model,
      agentDef: genericDef,
      prompt: 'ok',
      agentIdOverride: 'sa3-child-4',
      signal: ac.signal,
      onEvent: () => {},
    })

    expect(result.success).toBe(true)
    // 阶段 2 contract (kernel path): `runOrchestratedSubAgent` upgrades EVERY
    // run to a real kernel edge in the orchestrator — including root spawns —
    // so `interrupt`/`pause` by agentId reach it. A root spawn carries no
    // parent lineage, and the upgrade edge is torn down with the run.
    expect(edgeDuringRun).toBeDefined()
    expect(edgeDuringRun!.meta.parentKernelId).toBeUndefined()
    expect(getMultiAgentOrchestrator().get('sa3-child-4')).toBeUndefined()
  })
})
