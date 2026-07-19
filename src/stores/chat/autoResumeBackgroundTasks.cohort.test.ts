/**
 * Cohort-gate + dedup unit tests for the background-task auto-resume
 * controller (2026-06 fix: staggered sub-agents must NOT trigger a premature
 * resume while siblings are still working, and the same cohort terminating
 * after shutdown must NOT trigger a redundant second resume).
 *
 * Tests the pure decision (`decideCohortResume`) — the rest of the controller
 * (Zustand idle / draft / pending / cap guards) is unchanged.
 */

import { describe, it, expect } from 'vitest'
import { decideCohortResume, isWakeTriggerEvent } from './autoResumeBackgroundTasks'

describe('isWakeTriggerEvent', () => {
  it('accepts the two wake channels, rejects everything else', () => {
    expect(isWakeTriggerEvent('background-task-completed')).toBe(true)
    expect(isWakeTriggerEvent('subagent-terminal-wake')).toBe(true)
    expect(isWakeTriggerEvent('text')).toBe(false)
    expect(isWakeTriggerEvent(undefined)).toBe(false)
  })
})

describe('decideCohortResume', () => {
  const empty = new Set<string>()

  it('shell-task completions bypass the cohort gate entirely', () => {
    expect(
      decideCohortResume({
        isSubAgentWake: false,
        outstandingActiveAgents: 3, // ignored for shell wakes
        pendingAgentIds: empty,
        surfacedAgentIds: empty,
      }),
    ).toBe('resume')
  })

  it('waits while the cohort still has actively-working agents', () => {
    expect(
      decideCohortResume({
        isSubAgentWake: true,
        outstandingActiveAgents: 2,
        pendingAgentIds: new Set(['m1']),
        surfacedAgentIds: empty,
      }),
    ).toBe('wait')
  })

  it('resumes once the cohort settled and there is a new (un-surfaced) agent', () => {
    expect(
      decideCohortResume({
        isSubAgentWake: true,
        outstandingActiveAgents: 0,
        pendingAgentIds: new Set(['m1', 'm2', 'm3']),
        surfacedAgentIds: empty,
      }),
    ).toBe('resume')
  })

  it('suppresses when settled but every pending agent was already surfaced', () => {
    expect(
      decideCohortResume({
        isSubAgentWake: true,
        outstandingActiveAgents: 0,
        pendingAgentIds: new Set(['m1', 'm2', 'm3']),
        surfacedAgentIds: new Set(['m1', 'm2', 'm3']),
      }),
    ).toBe('suppress')
  })

  it('resumes when a genuinely new agent appears alongside surfaced ones', () => {
    expect(
      decideCohortResume({
        isSubAgentWake: true,
        outstandingActiveAgents: 0,
        pendingAgentIds: new Set(['m1', 'm4']),
        surfacedAgentIds: new Set(['m1', 'm2', 'm3']),
      }),
    ).toBe('resume')
  })

  /**
   * Reproduces the reported bug end-to-end at the decision layer: a 5-member
   * analysis team finishing at staggered times, then terminating after the
   * lead's shutdown. Expected: exactly ONE resume (when the last member goes
   * idle), and NO resume on the post-shutdown terminal wakes.
   */
  it('5-member staggered cohort → single resume, no redundant resume', () => {
    const surfaced = new Set<string>()
    const decisions: string[] = []

    // Members go idle one by one. `outstanding` is the count STILL working
    // (excludes the just-idled member): 4,3,2,1,0.
    const idleSequence: Array<{ id: string; outstanding: number }> = [
      { id: 'm1', outstanding: 4 },
      { id: 'm2', outstanding: 3 },
      { id: 'm3', outstanding: 2 },
      { id: 'm4', outstanding: 1 },
      { id: 'm5', outstanding: 0 },
    ]
    const pending = new Set<string>()
    for (const { id, outstanding } of idleSequence) {
      pending.add(id)
      const d = decideCohortResume({
        isSubAgentWake: true,
        outstandingActiveAgents: outstanding,
        pendingAgentIds: pending,
        surfacedAgentIds: surfaced,
      })
      decisions.push(d)
      if (d === 'resume') {
        for (const p of pending) surfaced.add(p)
        pending.clear()
      } else if (d === 'suppress') {
        pending.clear()
      }
    }

    // Only the LAST idle (cohort settled) resumes; the prior four waited.
    expect(decisions).toEqual(['wait', 'wait', 'wait', 'wait', 'resume'])
    expect([...surfaced].sort()).toEqual(['m1', 'm2', 'm3', 'm4', 'm5'])

    // After the lead reads results + shuts the team down, the same members
    // terminate. These wakes carry outstanding 0 but bring no NEW agent →
    // suppressed (the redundant second resume the user observed).
    const termPending = new Set<string>()
    const termDecisions: string[] = []
    for (const id of ['m1', 'm2', 'm3', 'm4', 'm5']) {
      termPending.add(id)
      const d = decideCohortResume({
        isSubAgentWake: true,
        outstandingActiveAgents: 0,
        pendingAgentIds: termPending,
        surfacedAgentIds: surfaced,
      })
      termDecisions.push(d)
      if (d === 'suppress') termPending.clear()
    }
    expect(termDecisions.every((d) => d === 'suppress')).toBe(true)
  })
})
