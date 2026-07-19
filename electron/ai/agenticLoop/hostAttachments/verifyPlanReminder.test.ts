/**
 * Unit tests for the `verify_plan_reminder` collector.
 *
 * Reminds the model to call `VerifyPlanExecution` ≥5 iterations after
 * the conversation exited plan mode. Per-conversation tracking +
 * throttle + cap on total nudges per pending entry.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetVerifyPlanReminderTrackingForTests,
  verifyPlanReminderCollector,
} from './verifyPlanReminder'
import {
  expectPushMessageAction,
  makeAttachmentFixture,
} from './testFixtures'

const ORIGINAL_ENV = process.env.POLE_VERIFY_PLAN_REMINDER

const getAgentContextMock = vi.fn()
const getPendingMock = vi.fn()

vi.mock('../../../agents/agentContext', () => ({
  getAgentContext: () => getAgentContextMock(),
}))
vi.mock('../../../planning/planVerificationState', () => ({
  getPendingPlanVerification: (cid: string) => getPendingMock(cid),
}))

beforeEach(() => {
  vi.clearAllMocks()
  __resetVerifyPlanReminderTrackingForTests()
  process.env.POLE_VERIFY_PLAN_REMINDER = '1'
  getAgentContextMock.mockReturnValue({
    agentId: 'main',
    streamConversationId: 'conv-1',
  })
})

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.POLE_VERIFY_PLAN_REMINDER
  else process.env.POLE_VERIFY_PLAN_REMINDER = ORIGINAL_ENV
})

function pendingEntry(planId = 'p-1') {
  return {
    planId,
    planText: 'plan body',
    exitedAt: Date.now(),
  }
}

describe('verifyPlanReminderCollector — gating', () => {
  it('runs at post_tool only', () => {
    expect(verifyPlanReminderCollector.callSites).toEqual(['post_tool'])
  })

  it('is enabled when env flag is unset (default-on); no pending entry ⇒ null', async () => {
    delete process.env.POLE_VERIFY_PLAN_REMINDER
    getPendingMock.mockReturnValue(undefined)
    expect(
      await verifyPlanReminderCollector.run(makeAttachmentFixture({})),
    ).toBeNull()
    // The pending-state store was consulted (gate did not close).
    expect(getPendingMock).toHaveBeenCalled()
  })

  it('returns null when env flag is explicitly disabled (POLE_X=0)', async () => {
    process.env.POLE_VERIFY_PLAN_REMINDER = '0'
    expect(
      await verifyPlanReminderCollector.run(makeAttachmentFixture({})),
    ).toBeNull()
    expect(getPendingMock).not.toHaveBeenCalled()
  })

  it('returns null for sub-agents', async () => {
    getAgentContextMock.mockReturnValue({
      agentId: 'sub-1',
      streamConversationId: 'conv',
    })
    expect(
      await verifyPlanReminderCollector.run(makeAttachmentFixture({})),
    ).toBeNull()
  })

  it('returns null when no streamConversationId', async () => {
    getAgentContextMock.mockReturnValue({ agentId: 'main' })
    expect(
      await verifyPlanReminderCollector.run(makeAttachmentFixture({})),
    ).toBeNull()
  })

  it('returns null when there is no pending entry', async () => {
    getPendingMock.mockReturnValue(undefined)
    expect(
      await verifyPlanReminderCollector.run(makeAttachmentFixture({})),
    ).toBeNull()
  })
})

describe('verifyPlanReminderCollector — first-observation grace period', () => {
  it('does NOT emit on first observation (records tracking only)', async () => {
    getPendingMock.mockReturnValue(pendingEntry())
    expect(
      await verifyPlanReminderCollector.run(
        makeAttachmentFixture({ iteration: 10 }),
      ),
    ).toBeNull()
  })

  it('does NOT emit before MIN_ITERATIONS_BEFORE_NUDGE (5) elapsed', async () => {
    getPendingMock.mockReturnValue(pendingEntry())
    await verifyPlanReminderCollector.run(
      makeAttachmentFixture({ iteration: 10 }),
    )
    // Only 3 iterations later — below threshold.
    expect(
      await verifyPlanReminderCollector.run(
        makeAttachmentFixture({ iteration: 13 }),
      ),
    ).toBeNull()
  })
})

describe('verifyPlanReminderCollector — emission', () => {
  it('emits at the MIN_ITERATIONS_BEFORE_NUDGE boundary', async () => {
    getPendingMock.mockReturnValue(pendingEntry('p-abc'))
    await verifyPlanReminderCollector.run(
      makeAttachmentFixture({ iteration: 10 }),
    ) // observation
    const action = await verifyPlanReminderCollector.run(
      makeAttachmentFixture({ iteration: 15 }),
    )
    const body = String(expectPushMessageAction(action).message.content)
    expect(body).toContain('p-abc')
    expect(body).toContain('5 iterations ago')
    expect(body).toContain('VerifyPlanExecution')
  })

  it('throttles second nudge by REPEAT_NUDGE_EVERY_N_ITERATIONS (10)', async () => {
    getPendingMock.mockReturnValue(pendingEntry())
    await verifyPlanReminderCollector.run(
      makeAttachmentFixture({ iteration: 10 }),
    ) // observation
    await verifyPlanReminderCollector.run(
      makeAttachmentFixture({ iteration: 15 }),
    ) // 1st nudge
    // 5 iterations later — below repeat cadence.
    expect(
      await verifyPlanReminderCollector.run(
        makeAttachmentFixture({ iteration: 20 }),
      ),
    ).toBeNull()
    // 10 iterations later — 2nd nudge fires.
    expect(
      await verifyPlanReminderCollector.run(
        makeAttachmentFixture({ iteration: 25 }),
      ),
    ).not.toBeNull()
  })

  it('caps total nudges per pending entry at MAX_NUDGES (3)', async () => {
    getPendingMock.mockReturnValue(pendingEntry())
    await verifyPlanReminderCollector.run(
      makeAttachmentFixture({ iteration: 10 }),
    ) // observation
    await verifyPlanReminderCollector.run(
      makeAttachmentFixture({ iteration: 15 }),
    ) // nudge 1
    await verifyPlanReminderCollector.run(
      makeAttachmentFixture({ iteration: 25 }),
    ) // nudge 2
    await verifyPlanReminderCollector.run(
      makeAttachmentFixture({ iteration: 35 }),
    ) // nudge 3
    // 4th would-be nudge — capped.
    expect(
      await verifyPlanReminderCollector.run(
        makeAttachmentFixture({ iteration: 45 }),
      ),
    ).toBeNull()
  })

  it('resets tracking when a new pending entry supersedes the old one', async () => {
    getPendingMock.mockReturnValue(pendingEntry('p-1'))
    await verifyPlanReminderCollector.run(
      makeAttachmentFixture({ iteration: 10 }),
    )
    await verifyPlanReminderCollector.run(
      makeAttachmentFixture({ iteration: 15 }),
    ) // 1 nudge for p-1
    // New plan exits — p-2 supersedes p-1.
    getPendingMock.mockReturnValue(pendingEntry('p-2'))
    // First observation for p-2 — no emit (records tracking).
    expect(
      await verifyPlanReminderCollector.run(
        makeAttachmentFixture({ iteration: 20 }),
      ),
    ).toBeNull()
    // 5 iterations later — emits for p-2 (independent counter).
    const action = await verifyPlanReminderCollector.run(
      makeAttachmentFixture({ iteration: 25 }),
    )
    expect(String(expectPushMessageAction(action).message.content)).toContain(
      'p-2',
    )
  })

  it('drops tracking when pending entry is cleared (VerifyPlanExecution called)', async () => {
    getPendingMock.mockReturnValue(pendingEntry())
    await verifyPlanReminderCollector.run(
      makeAttachmentFixture({ iteration: 10 }),
    )
    // Tool clears state.
    getPendingMock.mockReturnValue(undefined)
    expect(
      await verifyPlanReminderCollector.run(
        makeAttachmentFixture({ iteration: 15 }),
      ),
    ).toBeNull()
    // New pending entry — should re-prime, not inherit old tracking.
    getPendingMock.mockReturnValue(pendingEntry('p-fresh'))
    expect(
      await verifyPlanReminderCollector.run(
        makeAttachmentFixture({ iteration: 16 }),
      ),
    ).toBeNull() // first observation
    expect(
      await verifyPlanReminderCollector.run(
        makeAttachmentFixture({ iteration: 21 }),
      ),
    ).not.toBeNull() // 5 iterations later → emit
  })
})
