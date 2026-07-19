/**
 * `waitForSchedulerHoldRelease` — cross-agent hold wait loop.
 *
 * Contract:
 *   - not held → returns immediately, no blocked/unblocked bookkeeping;
 *   - held then released → marks 'blocked' once, re-evaluates, unblocks on release;
 *   - held until deadline → proceeds anyway (anti-starvation), unblocks;
 *   - pre-aborted signal → returns immediately without marking blocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const markToolBlocked = vi.fn()
const markToolUnblocked = vi.fn()
vi.mock('../state', () => ({
  markToolBlocked: (...a: unknown[]) => markToolBlocked(...a),
  markToolUnblocked: (...a: unknown[]) => markToolUnblocked(...a),
}))

import { waitForSchedulerHoldRelease, type SchedulerHoldGate } from '../backpressure'
import { asAgentId } from '../../../tools/ids'

function gateHeldTimes(n: number): SchedulerHoldGate {
  let calls = 0
  return {
    shouldHoldForHigherPriority: () => {
      calls += 1
      return calls <= n ? { held: true, reason: 'higher_priority_agent:main:p70' } : { held: false }
    },
  }
}

const gateAlwaysHeld: SchedulerHoldGate = {
  shouldHoldForHigherPriority: () => ({ held: true, reason: 'always' }),
}
const gateNeverHeld: SchedulerHoldGate = {
  shouldHoldForHigherPriority: () => ({ held: false }),
}

beforeEach(() => {
  markToolBlocked.mockReset()
  markToolUnblocked.mockReset()
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('waitForSchedulerHoldRelease', () => {
  it('not held → returns immediately, no bookkeeping', async () => {
    await waitForSchedulerHoldRelease({
      scheduler: gateNeverHeld,
      agentId: asAgentId('sub-1'),
      selfPriority: 50,
      toolUseId: 'tu',
      toolName: 'Read',
      phaseDeadline: Date.now() + 5_000,
      signal: new AbortController().signal,
      logTag: 'test',
    })
    expect(markToolBlocked).not.toHaveBeenCalled()
    expect(markToolUnblocked).not.toHaveBeenCalled()
  })

  it('held then released → marks blocked once, unblocks on release', async () => {
    await waitForSchedulerHoldRelease({
      scheduler: gateHeldTimes(1),
      agentId: asAgentId('sub-1'),
      selfPriority: 50,
      toolUseId: 'tu',
      toolName: 'Read',
      phaseDeadline: Date.now() + 5_000,
      signal: new AbortController().signal,
      logTag: 'test',
    })
    expect(markToolBlocked).toHaveBeenCalledTimes(1)
    expect(markToolBlocked).toHaveBeenCalledWith('tu', 'scheduler_hold')
    expect(markToolUnblocked).toHaveBeenCalledWith('tu')
  })

  it('held until deadline → proceeds anyway (anti-starvation)', async () => {
    const start = Date.now()
    await waitForSchedulerHoldRelease({
      scheduler: gateAlwaysHeld,
      agentId: asAgentId('sub-1'),
      selfPriority: 50,
      toolUseId: 'tu',
      toolName: 'Read',
      phaseDeadline: Date.now() + 120,
      signal: new AbortController().signal,
      logTag: 'test',
    })
    // It returned (did not hang) and respected the deadline bound.
    expect(Date.now() - start).toBeLessThan(2_000)
    expect(markToolBlocked).toHaveBeenCalledTimes(1)
    expect(markToolUnblocked).toHaveBeenCalledWith('tu')
  })

  it('pre-aborted signal → returns immediately without marking blocked', async () => {
    const ac = new AbortController()
    ac.abort()
    await waitForSchedulerHoldRelease({
      scheduler: gateAlwaysHeld,
      agentId: asAgentId('sub-1'),
      selfPriority: 50,
      toolUseId: 'tu',
      toolName: 'Read',
      phaseDeadline: Date.now() + 5_000,
      signal: ac.signal,
      logTag: 'test',
    })
    expect(markToolBlocked).not.toHaveBeenCalled()
  })
})
