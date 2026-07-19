/**
 * Worker sub-agent scheduler admission helper.
 *
 * Uses the REAL scheduler / quota / state singletons (reset between cases),
 * mirroring how production wires them. Covers:
 *   - acquire registers the tool (cross-agent visibility) + marks it running;
 *   - acquire holds when contended + a higher-priority agent is ready, then
 *     proceeds at the (shortened) deadline (anti-starvation);
 *   - idle system (running below threshold) does NOT hold even with a
 *     higher-priority agent ready;
 *   - release marks the slot terminal (completed / failed);
 *   - worker-rpc and worker-local ids are independent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  acquireSchedulerAdmission,
  createWorkerToolUseId,
  releaseSchedulerAdmission,
  releaseOutstandingLocalAdmissions,
} from './subAgentWorkerScheduler'
import {
  getToolScheduler,
  resetToolSchedulerForTests,
  ToolPriority,
} from '../orchestration/toolRuntime/scheduler'
import {
  getResourceQuotaManager,
  resetResourceQuotaManagerForTests,
} from '../orchestration/toolRuntime/quota'
import {
  clearToolRuntimeStateForTests,
  registerToolInvocation,
  markToolRunning,
  getToolEntry,
} from '../orchestration/toolRuntime/state'
import { asAgentId } from '../tools/ids'
import { runWithToolAdmissionPort } from '../orchestration/toolRuntime/admission'

function enqueueHighMain(id: string): void {
  getToolScheduler().enqueueBatch([
    {
      toolUseId: id,
      toolName: 'Read',
      agentId: asAgentId('main'),
      input: {},
      readOnly: true,
      priority: ToolPriority.HIGH,
    },
  ])
}

function makeRunning(n: number): void {
  for (let i = 0; i < n; i++) {
    const id = `run_${i}`
    registerToolInvocation({
      toolUseId: id,
      toolName: 'Read',
      agentId: asAgentId('other'),
      input: {},
      isReadOnly: true,
      priority: ToolPriority.NORMAL,
    })
    markToolRunning(id)
  }
}

function acquireArgs(
  toolUseId: string,
  over?: { toolName?: string; isReadOnly?: boolean; priority?: number },
) {
  return {
    toolUseId,
    toolName: over?.toolName ?? 'grep',
    agentId: asAgentId('sub-1'),
    input: {} as Record<string, unknown>,
    isReadOnly: over?.isReadOnly ?? true,
    priority: over?.priority ?? ToolPriority.NORMAL,
    signal: new AbortController().signal,
    logTag: 'test',
  }
}

beforeEach(() => {
  resetToolSchedulerForTests()
  resetResourceQuotaManagerForTests()
  clearToolRuntimeStateForTests()
})
afterEach(() => {
  resetToolSchedulerForTests()
  resetResourceQuotaManagerForTests()
  clearToolRuntimeStateForTests()
  vi.unstubAllEnvs()
})

describe('acquireSchedulerAdmission', () => {
  it('scopes worker tool ids by route, session, agent, and request generation', () => {
    const first = createWorkerToolUseId('local', 'session-a', asAgentId('agent-a'), 1)
    expect(first).not.toBe(
      createWorkerToolUseId('local', 'session-b', asAgentId('agent-a'), 1),
    )
    expect(first).not.toBe(
      createWorkerToolUseId('local', 'session-a', asAgentId('agent-b'), 1),
    )
    expect(first).not.toBe(
      createWorkerToolUseId('rpc', 'session-a', asAgentId('agent-a'), 1),
    )
  })

  it('registers the tool (visibility) and marks it running (idle, no hold)', async () => {
    const r = await acquireSchedulerAdmission(acquireArgs('worker-local-1'))
    expect(r.admitted).toBe(true)
    const entry = getToolEntry('worker-local-1')
    expect(entry).toBeDefined()
    expect(entry?.agentId).toBe(asAgentId('sub-1'))
    expect(entry?.status).toBe('running')
    // Visible to the scheduler DAG too.
    expect(getToolScheduler().getNodeStatus('worker-local-1')).toBeDefined()
  })

  it('quota deny: returns not-admitted (after backpressure) and marks the slot failed', async () => {
    // Zero mutation slots + no preemption → any mutating tool is denied.
    getResourceQuotaManager({ maxGlobalMutationParallel: 0, enablePreemption: false })
    getResourceQuotaManager().updateConfig({ backpressureMaxWaitMs: 60 })

    const r = await acquireSchedulerAdmission(
      acquireArgs('worker-local-deny', { toolName: 'write_file', isReadOnly: false }),
    )
    expect(r.admitted).toBe(false)
    expect(r.reason).toMatch(/Resource quota exceeded/)
    expect(getToolEntry('worker-local-deny')?.status).toBe('failed')
  })

  it('idle system does NOT hold even with a higher-priority agent ready', async () => {
    enqueueHighMain('main_hi')
    // running (0) below default threshold → spare capacity → no hold
    const start = Date.now()
    await acquireSchedulerAdmission(acquireArgs('worker-local-2'))
    expect(Date.now() - start).toBeLessThan(1_000)
    expect(getToolEntry('worker-local-2')?.status).toBe('running')
  })

  it('holds when contended + higher-priority ready, then proceeds at the deadline', async () => {
    vi.stubEnv('POLE_TOOL_SCHEDULER_MODE', 'hold')
    vi.stubEnv('POLE_TOOL_SCHEDULER_HOLD_THRESHOLD', '1')
    getResourceQuotaManager().updateConfig({ backpressureMaxWaitMs: 120 })
    enqueueHighMain('main_hi')
    makeRunning(1) // running(1) >= threshold(1) → contended

    const start = Date.now()
    await acquireSchedulerAdmission(acquireArgs('worker-local-3'))
    const elapsed = Date.now() - start
    // Held for ~deadline then proceeded (anti-starvation), and did not hang.
    expect(elapsed).toBeGreaterThanOrEqual(80)
    expect(elapsed).toBeLessThan(2_000)
    expect(getToolEntry('worker-local-3')?.status).toBe('running')
  })

  it('finishes a lease when authoritative grant waiting is aborted', async () => {
    const finish = vi.fn()
    const waiting = runWithToolAdmissionPort(
      {
        acquire: async () => ({
          admitted: true as const,
          lease: {
            toolUseId: 'worker-waiting',
            priority: ToolPriority.NORMAL,
            effectiveSignal: new AbortController().signal,
            waitUntilGranted: async () => {
              throw new Error('worker stopped')
            },
            start: vi.fn(),
            finish,
          },
        }),
      },
      () => acquireSchedulerAdmission(acquireArgs('worker-waiting')),
    )

    await expect(waiting).resolves.toMatchObject({
      admitted: false,
      reason: 'worker stopped',
    })
    expect(finish).toHaveBeenCalledWith('failed', 'worker stopped')
  })
})

describe('releaseSchedulerAdmission', () => {
  it('marks the slot completed on success', async () => {
    await acquireSchedulerAdmission(acquireArgs('worker-rpc-9'))
    releaseSchedulerAdmission('worker-rpc-9', true, { logTag: 'test' })
    expect(getToolEntry('worker-rpc-9')?.status).toBe('completed')
  })

  it('marks the slot failed on failure', async () => {
    await acquireSchedulerAdmission(acquireArgs('worker-rpc-10'))
    releaseSchedulerAdmission('worker-rpc-10', false, { reason: 'boom', logTag: 'test' })
    const entry = getToolEntry('worker-rpc-10')
    expect(entry?.status).toBe('failed')
    expect(entry?.errorMessage).toBe('boom')
  })

  it('worker-rpc and worker-local ids are independent slots', async () => {
    await acquireSchedulerAdmission(acquireArgs('worker-rpc-11'))
    await acquireSchedulerAdmission(acquireArgs('worker-local-11'))
    releaseSchedulerAdmission('worker-rpc-11', true, { logTag: 'test' })
    expect(getToolEntry('worker-rpc-11')?.status).toBe('completed')
    expect(getToolEntry('worker-local-11')?.status).toBe('running')
  })
})

describe('releaseOutstandingLocalAdmissions', () => {
  it('marks every still-running (never-done) slot failed (worker exited mid-tool)', async () => {
    await acquireSchedulerAdmission(acquireArgs('worker-local-a'))
    await acquireSchedulerAdmission(acquireArgs('worker-local-b'))
    expect(getToolEntry('worker-local-a')?.status).toBe('running')
    expect(getToolEntry('worker-local-b')?.status).toBe('running')

    releaseOutstandingLocalAdmissions(['worker-local-a', 'worker-local-b'])

    expect(getToolEntry('worker-local-a')?.status).toBe('aborted')
    expect(getToolEntry('worker-local-a')?.errorMessage).toMatch(/worker session ended/)
    expect(getToolEntry('worker-local-b')?.status).toBe('aborted')
  })

  it('empty set is a no-op', () => {
    expect(() => releaseOutstandingLocalAdmissions([])).not.toThrow()
  })
})
