/**
 * Unit tests for the `buddy_state_change` collector.
 *
 * Surfaces mid-conversation changes to the user's buddy / companion
 * state. Per-conversation last-seen revision snapshot avoids re-emit
 * when nothing changed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetBuddyStateChangeSnapshotsForTests,
  buddyStateChangeCollector,
} from './buddyStateChange'
import {
  expectPushMessageAction,
  makeAttachmentFixture,
} from './testFixtures'

const ORIGINAL_ENV = process.env.POLE_BUDDY_STATE_CHANGE

const getAgentContextMock = vi.fn()
const getBuddyStateMock = vi.fn()
const getBuddyStateRevisionMock = vi.fn()

vi.mock('../../../agents/agentContext', () => ({
  getAgentContext: () => getAgentContextMock(),
}))
vi.mock('../../../buddy/service', () => ({
  getBuddyState: () => getBuddyStateMock(),
}))
vi.mock('../../../buddy/stateRevision', () => ({
  getBuddyStateRevision: () => getBuddyStateRevisionMock(),
}))

beforeEach(() => {
  vi.clearAllMocks()
  __resetBuddyStateChangeSnapshotsForTests()
  process.env.POLE_BUDDY_STATE_CHANGE = '1'
  getAgentContextMock.mockReturnValue({ streamConversationId: 'conv-1' })
  getBuddyStateRevisionMock.mockReturnValue(1)
  getBuddyStateMock.mockReturnValue({
    enabled: true,
    name: 'Pip',
    species: 'capybara',
    rarity: 'common',
    mood: 'happy',
    persona: 'curious helper',
  })
})

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.POLE_BUDDY_STATE_CHANGE
  else process.env.POLE_BUDDY_STATE_CHANGE = ORIGINAL_ENV
})

describe('buddyStateChangeCollector — gating', () => {
  it('runs at post_tool only', () => {
    expect(buddyStateChangeCollector.callSites).toEqual(['post_tool'])
  })

  it('is enabled when env flag is unset (default-on)', async () => {
    delete process.env.POLE_BUDDY_STATE_CHANGE
    // Audit fix R4-L6 (2026-05): the first observation per
    // conversation no longer emits (system prompt already declares
    // the buddy via buildBuddySystemPrompt; emitting an "intro" here
    // duplicated identity content). The gate is still proven open —
    // `getBuddyStateMock` was consulted — but the result is null.
    const action = await buddyStateChangeCollector.run(
      makeAttachmentFixture({}),
    )
    expect(action).toBeNull()
    expect(getBuddyStateMock).toHaveBeenCalled()
  })

  it('returns null when env flag is explicitly disabled (POLE_X=0)', async () => {
    process.env.POLE_BUDDY_STATE_CHANGE = '0'
    expect(
      await buddyStateChangeCollector.run(makeAttachmentFixture({})),
    ).toBeNull()
    expect(getBuddyStateMock).not.toHaveBeenCalled()
  })

  it('returns null when no conversation id', async () => {
    getAgentContextMock.mockReturnValue(null)
    expect(
      await buddyStateChangeCollector.run(makeAttachmentFixture({})),
    ).toBeNull()
  })

  it('returns null when buddy is disabled', async () => {
    getBuddyStateMock.mockReturnValue({ enabled: false, name: 'Pip' })
    expect(
      await buddyStateChangeCollector.run(makeAttachmentFixture({})),
    ).toBeNull()
  })

  it('returns null when getBuddyState throws', async () => {
    getBuddyStateMock.mockImplementation(() => {
      throw new Error('buddy not initialised')
    })
    expect(
      await buddyStateChangeCollector.run(makeAttachmentFixture({})),
    ).toBeNull()
  })

  it('returns null when revision matches last snapshot (fast path)', async () => {
    await buddyStateChangeCollector.run(makeAttachmentFixture({}))
    expect(
      await buddyStateChangeCollector.run(makeAttachmentFixture({})),
    ).toBeNull()
  })
})

describe('buddyStateChangeCollector — emission', () => {
  it('R4-L6: first observation per conversation does NOT emit (system prompt already declares the buddy)', async () => {
    const action = await buddyStateChangeCollector.run(
      makeAttachmentFixture({}),
    )
    expect(action).toBeNull()
  })

  it('subsequent emission (revision bumped) uses the "state has changed" headline', async () => {
    // Initial silent snapshot.
    await buddyStateChangeCollector.run(makeAttachmentFixture({}))
    getBuddyStateRevisionMock.mockReturnValue(2)
    getBuddyStateMock.mockReturnValue({
      enabled: true,
      name: 'Pip the Bold',
      species: 'capybara',
      rarity: 'common',
      mood: 'excited',
    })
    const body = String(
      expectPushMessageAction(
        await buddyStateChangeCollector.run(makeAttachmentFixture({})),
      ).message.content,
    )
    expect(body).toContain('Buddy state has changed')
    expect(body).toContain('Pip the Bold')
  })

  it('handles missing optional fields gracefully on a real change', async () => {
    // First snapshot is silent.
    await buddyStateChangeCollector.run(makeAttachmentFixture({}))
    // Real change with minimal fields.
    getBuddyStateRevisionMock.mockReturnValue(2)
    getBuddyStateMock.mockReturnValue({ enabled: true, species: 'blob' })
    const body = String(
      expectPushMessageAction(
        await buddyStateChangeCollector.run(makeAttachmentFixture({})),
      ).message.content,
    )
    expect(body).toContain('(unnamed)')
    expect(body).toContain('blob')
  })

  it('appendixReport NOT called on the silent first observation', async () => {
    const ctx = makeAttachmentFixture({})
    await buddyStateChangeCollector.run(ctx)
    expect(ctx.state.appendixReport).not.toHaveBeenCalledWith(
      'P2_Q_compaction_reminder',
      expect.objectContaining({ kind: 'buddy_state_change' }),
    )
  })

  it('appendixReport fires on a real change with isInitialObservation:false', async () => {
    const ctx1 = makeAttachmentFixture({})
    await buddyStateChangeCollector.run(ctx1)
    getBuddyStateRevisionMock.mockReturnValue(2)
    const ctx2 = makeAttachmentFixture({})
    await buddyStateChangeCollector.run(ctx2)
    expect(ctx2.state.appendixReport).toHaveBeenCalledWith(
      'P2_Q_compaction_reminder',
      expect.objectContaining({
        kind: 'buddy_state_change',
        isInitialObservation: false,
      }),
    )
  })
})
