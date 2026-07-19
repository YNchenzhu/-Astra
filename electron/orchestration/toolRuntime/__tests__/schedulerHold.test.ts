/**
 * Cross-agent holding predicate — `ToolScheduler.shouldHoldForHigherPriority`
 * + `isSchedulerDriveEnabled` flag (POLE_TOOL_SCHEDULER_DRIVE).
 *
 * Contract:
 *   - hold=true ONLY when SOME OTHER agent has a ready/scheduled node whose
 *     priority is strictly higher than the caller's;
 *   - the caller's own nodes never trigger a hold;
 *   - equal / lower priority other-agent work does NOT hold;
 *   - terminal (completed/failed) higher-priority nodes do NOT hold.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getToolScheduler,
  resetToolSchedulerForTests,
  isSchedulerDriveEnabled,
  getSchedulerHoldThreshold,
  ToolPriority,
} from '../scheduler'
import { MAX_PARALLEL_TOOL_CALLS } from '../../../constants/toolLimits'
import { asAgentId } from '../../../tools/ids'

function enqueue(
  toolUseId: string,
  agentId: string,
  priority: number,
  readOnly = true,
): void {
  getToolScheduler().enqueueBatch([
    {
      toolUseId,
      toolName: readOnly ? 'Read' : 'Write',
      agentId: asAgentId(agentId),
      input: {},
      readOnly,
      priority,
    },
  ])
}

beforeEach(() => {
  resetToolSchedulerForTests()
})
afterEach(() => {
  resetToolSchedulerForTests()
  vi.unstubAllEnvs()
})

describe('ToolScheduler.shouldHoldForHigherPriority', () => {
  it('no other-agent work → not held', () => {
    enqueue('a1', 'agent-A', ToolPriority.NORMAL)
    const r = getToolScheduler().shouldHoldForHigherPriority(asAgentId('agent-A'), ToolPriority.NORMAL)
    expect(r.held).toBe(false)
  })

  it('higher-priority OTHER agent ready + contended → held', () => {
    enqueue('hi', 'main', ToolPriority.HIGH)
    const r = getToolScheduler().shouldHoldForHigherPriority(
      asAgentId('sub-1'),
      ToolPriority.NORMAL,
      { runningCount: 99, holdThreshold: 10 },
    )
    expect(r.held).toBe(true)
    expect(r.reason).toContain('higher_priority_agent')
    expect(r.reason).toContain('main')
  })

  it('higher-priority OTHER agent ready but system idle (below threshold) → NOT held', () => {
    enqueue('hi', 'main', ToolPriority.HIGH)
    const r = getToolScheduler().shouldHoldForHigherPriority(
      asAgentId('sub-1'),
      ToolPriority.NORMAL,
      { runningCount: 0, holdThreshold: 10 },
    )
    expect(r.held).toBe(false)
  })

  it("caller's OWN higher-priority node never triggers a hold", () => {
    enqueue('mine', 'agent-A', ToolPriority.CRITICAL)
    const r = getToolScheduler().shouldHoldForHigherPriority(asAgentId('agent-A'), ToolPriority.NORMAL)
    expect(r.held).toBe(false)
  })

  it('equal-priority other agent does NOT hold', () => {
    enqueue('peer', 'agent-B', ToolPriority.NORMAL)
    const r = getToolScheduler().shouldHoldForHigherPriority(asAgentId('agent-A'), ToolPriority.NORMAL)
    expect(r.held).toBe(false)
  })

  it('lower-priority other agent does NOT hold', () => {
    enqueue('bg', 'agent-bg', ToolPriority.BACKGROUND)
    const r = getToolScheduler().shouldHoldForHigherPriority(asAgentId('agent-A'), ToolPriority.NORMAL)
    expect(r.held).toBe(false)
  })

  it('terminal higher-priority node does NOT hold (only ready/scheduled count)', () => {
    enqueue('done', 'main', ToolPriority.HIGH)
    getToolScheduler().markCompleted('done')
    const r = getToolScheduler().shouldHoldForHigherPriority(asAgentId('sub-1'), ToolPriority.NORMAL)
    expect(r.held).toBe(false)
  })
})

describe('isSchedulerDriveEnabled', () => {
  it('defaults OFF', () => {
    vi.stubEnv('POLE_TOOL_SCHEDULER_DRIVE', '')
    expect(isSchedulerDriveEnabled()).toBe(false)
  })
  it('on when POLE_TOOL_SCHEDULER_DRIVE=1', () => {
    vi.stubEnv('POLE_TOOL_SCHEDULER_DRIVE', '1')
    expect(isSchedulerDriveEnabled()).toBe(true)
  })
})

describe('getSchedulerHoldThreshold', () => {
  it('defaults to MAX_PARALLEL_TOOL_CALLS', () => {
    vi.stubEnv('POLE_TOOL_SCHEDULER_HOLD_THRESHOLD', '')
    expect(getSchedulerHoldThreshold()).toBe(MAX_PARALLEL_TOOL_CALLS)
  })
  it('honors a valid positive override', () => {
    vi.stubEnv('POLE_TOOL_SCHEDULER_HOLD_THRESHOLD', '3')
    expect(getSchedulerHoldThreshold()).toBe(3)
  })
  it('falls back to default on invalid / non-positive', () => {
    vi.stubEnv('POLE_TOOL_SCHEDULER_HOLD_THRESHOLD', '0')
    expect(getSchedulerHoldThreshold()).toBe(MAX_PARALLEL_TOOL_CALLS)
    vi.stubEnv('POLE_TOOL_SCHEDULER_HOLD_THRESHOLD', 'abc')
    expect(getSchedulerHoldThreshold()).toBe(MAX_PARALLEL_TOOL_CALLS)
  })
})
