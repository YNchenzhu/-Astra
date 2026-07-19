/**
 * Unit tests for the `date_change` collector.
 *
 * Module-local per-conversation Map tracks the last-emitted date.
 * Tests use the `__resetDateChangeStateForTests` seam + a fake clock
 * to advance "today" deterministically.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetDateChangeStateForTests,
  dateChangeCollector,
} from './dateChange'
import {
  expectPushMessageAction,
  makeAttachmentFixture,
} from './testFixtures'

const getAgentContextMock = vi.fn()
vi.mock('../../../agents/agentContext', () => ({
  getAgentContext: () => getAgentContextMock(),
}))

beforeEach(() => {
  vi.clearAllMocks()
  __resetDateChangeStateForTests()
  getAgentContextMock.mockReturnValue({ streamConversationId: 'conv-1' })
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('dateChangeCollector — callSite', () => {
  // Audit fix R4-L5 (2026-05) — registered on BOTH iteration_top and
  // post_tool so a non-agentic turn (no tool calls) that spans
  // midnight still triggers the date-change notice before the next
  // iteration's model call.
  it('runs at iteration_top AND post_tool', () => {
    expect(dateChangeCollector.callSites).toEqual(['iteration_top', 'post_tool'])
  })
})

describe('dateChangeCollector — first observation', () => {
  it('returns null on the very first call (prime baseline without emitting)', async () => {
    vi.setSystemTime(new Date('2026-01-15T12:00:00'))
    expect(await dateChangeCollector.run(makeAttachmentFixture({}))).toBeNull()
  })

  it('returns null on a second call within the same day', async () => {
    vi.setSystemTime(new Date('2026-01-15T08:00:00'))
    await dateChangeCollector.run(makeAttachmentFixture({}))
    vi.setSystemTime(new Date('2026-01-15T22:30:00'))
    expect(await dateChangeCollector.run(makeAttachmentFixture({}))).toBeNull()
  })
})

describe('dateChangeCollector — emits on date roll', () => {
  it('emits when the date advances by one day', async () => {
    vi.setSystemTime(new Date('2026-01-15T23:30:00'))
    await dateChangeCollector.run(makeAttachmentFixture({}))
    vi.setSystemTime(new Date('2026-01-16T00:30:00'))
    const action = await dateChangeCollector.run(makeAttachmentFixture({}))
    const body = String(expectPushMessageAction(action).message.content)
    expect(body).toContain("Today's date is now 2026-01-16")
    expect(body).toContain("DO NOT mention this to the user")
  })

  it('emits with multi-day skip too', async () => {
    vi.setSystemTime(new Date('2026-01-15T00:00:00'))
    await dateChangeCollector.run(makeAttachmentFixture({}))
    vi.setSystemTime(new Date('2026-02-01T00:00:00'))
    const action = await dateChangeCollector.run(makeAttachmentFixture({}))
    const body = String(expectPushMessageAction(action).message.content)
    expect(body).toContain('2026-02-01')
  })

  it('does NOT re-emit if called twice on the same new day', async () => {
    vi.setSystemTime(new Date('2026-01-15T00:00:00'))
    await dateChangeCollector.run(makeAttachmentFixture({}))
    vi.setSystemTime(new Date('2026-01-16T00:00:00'))
    expect(
      await dateChangeCollector.run(makeAttachmentFixture({})),
    ).not.toBeNull()
    // Same day, second call — no second emit.
    vi.setSystemTime(new Date('2026-01-16T12:00:00'))
    expect(
      await dateChangeCollector.run(makeAttachmentFixture({})),
    ).toBeNull()
  })

  it('reports appendixReport with new/previous date', async () => {
    vi.setSystemTime(new Date('2026-01-15T00:00:00'))
    await dateChangeCollector.run(makeAttachmentFixture({}))
    vi.setSystemTime(new Date('2026-01-16T00:00:00'))
    const ctx = makeAttachmentFixture({})
    await dateChangeCollector.run(ctx)
    expect(ctx.state.appendixReport).toHaveBeenCalledWith(
      'P2_Q_compaction_reminder',
      expect.objectContaining({
        kind: 'date_change',
        newDate: '2026-01-16',
        previousDate: '2026-01-15',
      }),
    )
  })
})

describe('dateChangeCollector — per-conversation isolation', () => {
  it('isolates per-conversation tracking (separate baselines)', async () => {
    vi.setSystemTime(new Date('2026-01-15T00:00:00'))
    getAgentContextMock.mockReturnValue({ streamConversationId: 'conv-A' })
    await dateChangeCollector.run(makeAttachmentFixture({}))
    vi.setSystemTime(new Date('2026-01-16T00:00:00'))
    // conv-A roll — emits
    expect(
      await dateChangeCollector.run(makeAttachmentFixture({})),
    ).not.toBeNull()
    // conv-B never observed — primes baseline, no emit
    getAgentContextMock.mockReturnValue({ streamConversationId: 'conv-B' })
    expect(
      await dateChangeCollector.run(makeAttachmentFixture({})),
    ).toBeNull()
  })

  it('falls back to global key when no streamConversationId', async () => {
    vi.setSystemTime(new Date('2026-01-15T00:00:00'))
    getAgentContextMock.mockReturnValue(null)
    await dateChangeCollector.run(makeAttachmentFixture({}))
    vi.setSystemTime(new Date('2026-01-16T00:00:00'))
    const action = await dateChangeCollector.run(makeAttachmentFixture({}))
    expect(action).not.toBeNull()
  })
})
