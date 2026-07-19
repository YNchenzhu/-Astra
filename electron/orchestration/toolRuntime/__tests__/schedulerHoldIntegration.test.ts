/**
 * Cross-agent holding — integration of the REAL predicate
 * (`ToolScheduler.shouldHoldForHigherPriority`) + the REAL wait loop
 * (`waitForSchedulerHoldRelease`) + real `ToolRuntimeState`. No mocks.
 *
 * Covers the plan's "re-plan 唤醒" + starvation-bound items end to end:
 *   - a LOW sub-agent tool holds while a HIGH main node is ready AND the
 *     system is contended (running count >= threshold);
 *   - completing the HIGH node releases the hold (predicate flips) — the wait
 *     resolves well before the deadline;
 *   - if the HIGH node never completes, the wait still proceeds at the
 *     deadline (anti-starvation).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { waitForSchedulerHoldRelease } from '../backpressure'
import { getToolScheduler, resetToolSchedulerForTests, ToolPriority } from '../scheduler'
import {
  clearToolRuntimeStateForTests,
  registerToolInvocation,
  markToolRunning,
  getToolEntry,
} from '../state'
import { asAgentId } from '../../../tools/ids'

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

/** Push global running count to `n` so the hold soft-threshold is met. */
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

beforeEach(() => {
  resetToolSchedulerForTests()
  clearToolRuntimeStateForTests()
  vi.stubEnv('POLE_TOOL_SCHEDULER_HOLD_THRESHOLD', '1')
})
afterEach(() => {
  resetToolSchedulerForTests()
  clearToolRuntimeStateForTests()
  vi.unstubAllEnvs()
})

describe('cross-agent holding (integration: real predicate + wait loop + state)', () => {
  it('completing the higher-priority node releases the hold before the deadline', async () => {
    enqueueHighMain('main_hi')
    makeRunning(1) // contended: running >= threshold(1)
    registerToolInvocation({
      toolUseId: 'sub_tu',
      toolName: 'Read',
      agentId: asAgentId('sub-1'),
      input: {},
      isReadOnly: true,
      priority: ToolPriority.NORMAL,
    })

    // Sanity: predicate holds the LOW sub tool while HIGH main is ready + contended.
    expect(
      getToolScheduler().shouldHoldForHigherPriority(asAgentId('sub-1'), ToolPriority.NORMAL).held,
    ).toBe(true)

    // Release the hold shortly after the wait starts.
    setTimeout(() => getToolScheduler().markCompleted('main_hi'), 40)

    const start = Date.now()
    await waitForSchedulerHoldRelease({
      scheduler: getToolScheduler(),
      agentId: asAgentId('sub-1'),
      selfPriority: ToolPriority.NORMAL,
      toolUseId: 'sub_tu',
      toolName: 'Read',
      phaseDeadline: Date.now() + 5_000,
      signal: new AbortController().signal,
      logTag: 'test',
    })
    const elapsed = Date.now() - start
    // Released by completion, not by the 5s deadline.
    expect(elapsed).toBeLessThan(2_000)
    // Tool flipped back to a non-blocked state after the hold released.
    expect(getToolEntry('sub_tu')?.status).not.toBe('blocked')
  })

  it('proceeds at the deadline when the higher-priority node never completes (anti-starvation)', async () => {
    enqueueHighMain('main_hi2')
    makeRunning(1)
    registerToolInvocation({
      toolUseId: 'sub_tu2',
      toolName: 'Read',
      agentId: asAgentId('sub-1'),
      input: {},
      isReadOnly: true,
      priority: ToolPriority.NORMAL,
    })

    const start = Date.now()
    await waitForSchedulerHoldRelease({
      scheduler: getToolScheduler(),
      agentId: asAgentId('sub-1'),
      selfPriority: ToolPriority.NORMAL,
      toolUseId: 'sub_tu2',
      toolName: 'Read',
      phaseDeadline: Date.now() + 150,
      signal: new AbortController().signal,
      logTag: 'test',
    })
    const elapsed = Date.now() - start
    // Did not hang; proceeded at (roughly) the deadline.
    expect(elapsed).toBeGreaterThanOrEqual(100)
    expect(elapsed).toBeLessThan(2_000)
  })

  it('idle system (running below threshold) does not hold even with HIGH main ready', () => {
    vi.stubEnv('POLE_TOOL_SCHEDULER_HOLD_THRESHOLD', '5')
    enqueueHighMain('main_hi3')
    makeRunning(1) // 1 < 5 → spare capacity
    expect(
      getToolScheduler().shouldHoldForHigherPriority(asAgentId('sub-1'), ToolPriority.NORMAL).held,
    ).toBe(false)
  })
})
