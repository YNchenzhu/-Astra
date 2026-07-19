import { afterEach, describe, expect, it } from 'vitest'
import {
  abortControllerToKernelShim,
  getMultiAgentOrchestrator,
  resetMultiAgentOrchestratorForTests,
} from './multiAgentOrchestratorSingleton'

describe('multiAgentOrchestratorSingleton', () => {
  afterEach(() => {
    resetMultiAgentOrchestratorForTests()
  })

  it('returns the same instance across calls', () => {
    const a = getMultiAgentOrchestrator()
    const b = getMultiAgentOrchestrator()
    expect(a).toBe(b)
  })

  it('reset wipes registrations and yields a fresh instance', () => {
    const first = getMultiAgentOrchestrator()
    first.register('k1', abortControllerToKernelShim(new AbortController()), {
      agentType: 'Explore',
      affinity: 'main_process',
    })
    expect(first.get('k1')).toBeDefined()
    resetMultiAgentOrchestratorForTests()
    const second = getMultiAgentOrchestrator()
    expect(second).not.toBe(first)
    expect(second.get('k1')).toBeUndefined()
  })

  it('abortControllerToKernelShim.interrupt forwards to abort()', () => {
    const ac = new AbortController()
    const shim = abortControllerToKernelShim(ac)
    expect(ac.signal.aborted).toBe(false)
    shim.interrupt('user')
    expect(ac.signal.aborted).toBe(true)
  })

  it('shim.interrupt is idempotent (already-aborted controllers are safe)', () => {
    const ac = new AbortController()
    ac.abort()
    const shim = abortControllerToKernelShim(ac)
    expect(() => shim.interrupt('user')).not.toThrow()
  })

  it('shim.pause / shim.resume are no-ops for legacy abort-controller agents', () => {
    const shim = abortControllerToKernelShim(new AbortController())
    expect(() => shim.pause()).not.toThrow()
    expect(() => shim.resume()).not.toThrow()
  })

  it('interruptTree cascades through registered shims', () => {
    const orch = getMultiAgentOrchestrator()
    const parentAc = new AbortController()
    const childAc = new AbortController()
    const grandchildAc = new AbortController()

    orch.register('parent', abortControllerToKernelShim(parentAc), {
      agentType: 'Explore',
      affinity: 'main_process',
    })
    orch.register('child', abortControllerToKernelShim(childAc), {
      agentType: 'Explore',
      affinity: 'main_process',
      parentKernelId: 'parent',
    })
    orch.register('grandchild', abortControllerToKernelShim(grandchildAc), {
      agentType: 'Explore',
      affinity: 'main_process',
      parentKernelId: 'child',
    })

    const cascadedCount = orch.interruptTree('parent', 'user')
    expect(cascadedCount).toBe(3)
    expect(parentAc.signal.aborted).toBe(true)
    expect(childAc.signal.aborted).toBe(true)
    expect(grandchildAc.signal.aborted).toBe(true)
  })
})
