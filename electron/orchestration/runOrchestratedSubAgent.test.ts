/**
 * 阶段 2 — unit tests for `runOrchestratedSubAgent`.
 *
 * Coverage:
 *   1. wiring — constructs the kernel seeded with the sub-agent messages +
 *      conversation id, registers the REAL kernel into the orchestrator under
 *      the agentId (upgrading the shim), runs `runDriveMainChat` with the
 *      forwarded params, and disposes the kernel.
 *   2. dispose-on-throw — a runDriveMainChat rejection still disposes the kernel
 *      and propagates.
 *   3. pause cascade real-effect — after the upgrade, `pauseTree(parent)` counts
 *      the child (a real kernel-like whose `pause()` is not a no-op), whereas the
 *      pre-upgrade abort-shim was not counted. This is the core Phase 2 win.
 *
 * `./kernel` is mocked so `createKernelForLegacyMainChat` returns a controllable
 * fake kernel; the REAL `MultiAgentOrchestrator` singleton is used so the
 * registration + pause-cascade semantics are exercised end-to-end.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./kernel', () => ({
  createKernelForLegacyMainChat: vi.fn(),
}))

import { runOrchestratedSubAgent } from './runOrchestratedSubAgent'
import { createKernelForLegacyMainChat } from './kernel'
import {
  getMultiAgentOrchestrator,
  resetMultiAgentOrchestratorForTests,
  abortControllerToKernelShim,
} from '../agents/multiAgentOrchestratorSingleton'

function makeFakeKernel() {
  return {
    runDriveMainChat: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
    // CancellableKernelLike surface — `pause()` returns undefined (NOT false),
    // so `MultiAgentOrchestrator.pauseTree` counts it as a real pause target.
    interrupt: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
  }
}

let fakeKernel: ReturnType<typeof makeFakeKernel>

beforeEach(() => {
  resetMultiAgentOrchestratorForTests()
  fakeKernel = makeFakeKernel()
  vi.mocked(createKernelForLegacyMainChat).mockReset()
  vi.mocked(createKernelForLegacyMainChat).mockReturnValue(fakeKernel as never)
})

describe('runOrchestratedSubAgent — wiring', () => {
  it('seeds the kernel with the sub-agent messages + conv id, registers the real kernel DURING the run, runs, disposes', async () => {
    const messages = [{ role: 'user', content: 'do the thing' }]
    const params = { messages, model: 'm', maxTokens: 1 } as never
    const callbacks = { onMessageEnd: vi.fn() } as never
    const onTerminate = vi.fn()

    // Capture the live orchestrator edge AT RUN TIME — the real kernel is only
    // registered for the duration of the run (no pre-existing owner → removed in
    // finally).
    let spawnedDuringRun: ReturnType<ReturnType<typeof getMultiAgentOrchestrator>['get']>
    fakeKernel.runDriveMainChat.mockImplementation(async () => {
      spawnedDuringRun = getMultiAgentOrchestrator().get('agent-1')
    })

    await runOrchestratedSubAgent(params, callbacks, {
      agentId: 'agent-1',
      agentType: 'general-purpose',
      parentAgentId: 'main-chat',
      conversationId: 'conv-1',
      onTerminate,
    })

    // kernel constructed with the sub-agent messages as transcript seed +
    // the conversation id.
    const call = vi.mocked(createKernelForLegacyMainChat).mock.calls[0]!
    expect(call[2]).toBe(messages) // rendererMessages seed
    expect(call[3]).toMatchObject({ streamConversationId: 'conv-1' })

    // run forwarded the params, callbacks, seed transcript, and onTerminate.
    expect(fakeKernel.runDriveMainChat).toHaveBeenCalledTimes(1)
    expect(fakeKernel.runDriveMainChat).toHaveBeenCalledWith(
      expect.objectContaining({
        agenticParams: params,
        agenticCallbacks: callbacks,
        rendererMessages: messages,
        onTerminate,
      }),
    )

    // The real kernel WAS the live edge during the run, as a child of the parent.
    expect(spawnedDuringRun?.kernel).toBe(fakeKernel)
    expect(spawnedDuringRun?.meta.parentKernelId).toBe('main-chat')
    expect(spawnedDuringRun?.meta.conversationId).toBe('conv-1')

    // No pre-existing owner → the edge we created is removed afterwards (no leak).
    expect(getMultiAgentOrchestrator().get('agent-1')).toBeUndefined()

    // disposed in finally.
    expect(fakeKernel.dispose).toHaveBeenCalledTimes(1)
  })

  it('derives a conversation id when none is supplied', async () => {
    const params = { messages: [], model: 'm' } as never
    await runOrchestratedSubAgent(params, {} as never, {
      agentId: 'agent-x',
      agentType: 't',
    })
    const call = vi.mocked(createKernelForLegacyMainChat).mock.calls[0]!
    expect(call[3]).toMatchObject({ streamConversationId: 'subagent:agent-x' })
  })

  it('disposes the kernel even when runDriveMainChat throws, and propagates', async () => {
    fakeKernel.runDriveMainChat.mockRejectedValueOnce(new Error('loop boom'))
    const params = { messages: [], model: 'm' } as never

    await expect(
      runOrchestratedSubAgent(params, {} as never, {
        agentId: 'agent-2',
        agentType: 't',
      }),
    ).rejects.toThrow('loop boom')

    expect(fakeKernel.dispose).toHaveBeenCalledTimes(1)
  })
})

describe('runOrchestratedSubAgent — pause cascade real-effect (核心收益)', () => {
  it('upgrades the abort-shim to a real kernel so pauseTree(parent) reaches the child during the run, then restores the shim', async () => {
    const orch = getMultiAgentOrchestrator()

    // Parent kernel (real-like; pause() returns undefined → counted).
    orch.register('parent', makeFakeKernel(), {
      agentType: 'Coordinator',
      affinity: 'main_process',
    })

    // Child registered FIRST as the legacy abort-shim (pause() === false).
    const ac = new AbortController()
    orch.register('child', abortControllerToKernelShim(ac), {
      parentKernelId: 'parent',
      agentType: 'general-purpose',
      affinity: 'main_process',
    })

    // Before the upgrade: only the parent is a real pause target; the shim
    // child is NOT counted (pause() returns false).
    expect(orch.pauseTree('parent')).toBe(1)

    // Capture the cascade DURING the run (the upgrade is only live for the run).
    let duringRun: number | undefined
    fakeKernel.runDriveMainChat.mockImplementation(async () => {
      duringRun = orch.pauseTree('parent')
    })

    await runOrchestratedSubAgent({ messages: [] } as never, {} as never, {
      agentId: 'child',
      agentType: 'general-purpose',
      parentAgentId: 'parent',
    })

    // During the run: the child was a real pause target → cascade counts BOTH.
    expect(duringRun).toBe(2)
    // After the run: the pre-existing shim was restored (we must not clobber a
    // caller-owned edge), so the cascade counts only the parent again.
    expect(orch.pauseTree('parent')).toBe(1)
    // Lineage preserved by the restore — child still under the parent.
    expect(orch.get('child')?.meta.parentKernelId).toBe('parent')
  })
})
