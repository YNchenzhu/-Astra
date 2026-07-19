/**
 * Unit tests for the `compaction_reminder` collector.
 *
 * Higher-level iteration tests in
 * `electron/orchestration/phases/__tests__/iteration.test.ts` cover
 * the end-to-end "wires through runCollectors at post_tool" path;
 * these tests pin the collector's own gating logic in isolation:
 *
 *   - iteration > 1 gate
 *   - usagePercentOfWindow ≥ 50 gate
 *   - main-chat-only gate
 *   - one-shot per session (`_compactionReminderInjected`)
 *   - action shape (push_message, sideChannelKind, body text)
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  compactionReminderCollector,
  COMPACTION_REMINDER_USAGE_THRESHOLD,
} from './compactionReminder'
import {
  expectPushMessageAction,
  makeAttachmentFixture,
} from './testFixtures'
import { SIDE_CHANNEL_KIND } from '../../../constants/sideChannelKinds'

const getAgentContextMock = vi.fn()
vi.mock('../../../agents/agentContext', () => ({
  getAgentContext: () => getAgentContextMock(),
}))

beforeEach(() => {
  getAgentContextMock.mockReturnValue({ agentId: 'main' })
})

describe('compactionReminderCollector — callSite registration', () => {
  it('runs at post_tool only', () => {
    expect(compactionReminderCollector.callSites).toEqual(['post_tool'])
  })
})

describe('compactionReminderCollector — gating', () => {
  it('returns null on iteration 1 even when usage is high', async () => {
    const ctx = makeAttachmentFixture({
      iteration: 1,
      ctxManagerState: { usagePercentOfWindow: 80 },
    })
    expect(await compactionReminderCollector.run(ctx)).toBeNull()
  })

  it('returns null below the usage threshold', async () => {
    const ctx = makeAttachmentFixture({
      iteration: 5,
      ctxManagerState: {
        usagePercentOfWindow: COMPACTION_REMINDER_USAGE_THRESHOLD - 1,
      },
    })
    expect(await compactionReminderCollector.run(ctx)).toBeNull()
  })

  it('returns null for sub-agents', async () => {
    getAgentContextMock.mockReturnValue({ agentId: 'sub-1' })
    const ctx = makeAttachmentFixture({
      iteration: 10,
      ctxManagerState: { usagePercentOfWindow: 80 },
    })
    expect(await compactionReminderCollector.run(ctx)).toBeNull()
  })

  it('returns null when usagePercentOfWindow is undefined', async () => {
    const ctx = makeAttachmentFixture({
      iteration: 5,
      ctxManagerState: {}, // no usagePercentOfWindow
    })
    expect(await compactionReminderCollector.run(ctx)).toBeNull()
  })

  it('returns null when already injected (one-shot)', async () => {
    const ctx = makeAttachmentFixture({
      iteration: 5,
      ctxManagerState: { usagePercentOfWindow: 70 },
      stateOverrides: { _compactionReminderInjected: true },
    })
    expect(await compactionReminderCollector.run(ctx)).toBeNull()
  })
})

describe('compactionReminderCollector — emission', () => {
  it('emits push_message at threshold + iteration>1 on main chat', async () => {
    const ctx = makeAttachmentFixture({
      iteration: 3,
      ctxManagerState: {
        usagePercentOfWindow: COMPACTION_REMINDER_USAGE_THRESHOLD,
      },
    })
    const action = await compactionReminderCollector.run(ctx)
    const pushed = expectPushMessageAction(action)
    expect(pushed.message.role).toBe('user')
    expect(pushed.message._sideChannelKind).toBe(
      SIDE_CHANNEL_KIND.compactionReminder,
    )
    expect(String(pushed.message.content)).toContain(
      'Automatic context management is active',
    )
    expect(String(pushed.message.content)).toContain('no need to stop, rush')
  })

  it('marks the state flag so subsequent runs no-op', async () => {
    const ctx = makeAttachmentFixture({
      iteration: 5,
      ctxManagerState: { usagePercentOfWindow: 70 },
    })
    await compactionReminderCollector.run(ctx)
    expect(ctx.state._compactionReminderInjected).toBe(true)
    expect(await compactionReminderCollector.run(ctx)).toBeNull()
  })

  it('treats missing agentContext as main-chat (defensive)', async () => {
    getAgentContextMock.mockReturnValue(null)
    const ctx = makeAttachmentFixture({
      iteration: 5,
      ctxManagerState: { usagePercentOfWindow: 70 },
    })
    const action = await compactionReminderCollector.run(ctx)
    expect(action).not.toBeNull()
  })

  it('reports to appendixReport with the usage percent', async () => {
    const ctx = makeAttachmentFixture({
      iteration: 5,
      ctxManagerState: { usagePercentOfWindow: 70 },
    })
    await compactionReminderCollector.run(ctx)
    expect(ctx.state.appendixReport).toHaveBeenCalledWith(
      'P2_Q_compaction_reminder',
      expect.objectContaining({ usagePercentOfWindow: 70 }),
    )
  })
})
