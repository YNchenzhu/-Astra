/**
 * Unit tests for the `inter_agent_queue` collector.
 *
 * The collector delegates to `injectPendingInterAgentQueue` which
 * mutates `state.apiMessages` directly and returns true/false. The
 * collector returns an explicit sync signal and relies on the helper's
 * side effect — this test asserts the gating contract
 * and the appendixReport tag.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { interAgentQueueCollector } from './interAgentQueue'
import { makeAttachmentFixture } from './testFixtures'

const getAgentContextMock = vi.fn()
const getActiveAgentMock = vi.fn()
const injectMock = vi.fn()

vi.mock('../../../agents/agentContext', () => ({
  getAgentContext: () => getAgentContextMock(),
}))
vi.mock('../../../agents/activeAgentRegistry', () => ({
  getActiveAgent: (id: string) => getActiveAgentMock(id),
}))
vi.mock('../../agenticLoopHelpers', () => ({
  injectPendingInterAgentQueue: (msgs: unknown) => injectMock(msgs),
}))

beforeEach(() => {
  vi.clearAllMocks()
})

describe('interAgentQueueCollector — callSite', () => {
  it('runs at post_tool only', () => {
    expect(interAgentQueueCollector.callSites).toEqual(['post_tool'])
  })
})

describe('interAgentQueueCollector — gating', () => {
  it('returns null for main chat (no per-agent inbox)', async () => {
    getAgentContextMock.mockReturnValue({ agentId: 'main' })
    const ctx = makeAttachmentFixture({})
    expect(await interAgentQueueCollector.run(ctx)).toBeNull()
    expect(injectMock).not.toHaveBeenCalled()
  })

  it('returns null when agentId is missing', async () => {
    getAgentContextMock.mockReturnValue(null)
    expect(
      await interAgentQueueCollector.run(makeAttachmentFixture({})),
    ).toBeNull()
  })

  it('returns null when the registry has no active agent for the id', async () => {
    getAgentContextMock.mockReturnValue({ agentId: 'sub-x' })
    getActiveAgentMock.mockReturnValue(undefined)
    expect(
      await interAgentQueueCollector.run(makeAttachmentFixture({})),
    ).toBeNull()
    expect(injectMock).not.toHaveBeenCalled()
  })

  it('returns null when the active agent has no pending messages', async () => {
    getAgentContextMock.mockReturnValue({ agentId: 'sub-x' })
    getActiveAgentMock.mockReturnValue({ pendingMessages: [] })
    expect(
      await interAgentQueueCollector.run(makeAttachmentFixture({})),
    ).toBeNull()
    expect(injectMock).not.toHaveBeenCalled()
  })

  it('returns null when the helper reports no injection occurred', async () => {
    getAgentContextMock.mockReturnValue({ agentId: 'sub-x' })
    getActiveAgentMock.mockReturnValue({ pendingMessages: ['msg-1'] })
    injectMock.mockReturnValue(false)
    expect(
      await interAgentQueueCollector.run(makeAttachmentFixture({})),
    ).toBeNull()
  })
})

describe('interAgentQueueCollector — emission side effects', () => {
  it('invokes inject helper with apiMessages and reports the appendix tag', async () => {
    getAgentContextMock.mockReturnValue({ agentId: 'sub-x' })
    getActiveAgentMock.mockReturnValue({ pendingMessages: ['msg-1'] })
    injectMock.mockReturnValue(true)
    const ctx = makeAttachmentFixture({ iteration: 3 })
    const result = await interAgentQueueCollector.run(ctx)

    expect(result).toEqual({ requiresConversationSync: true })
    expect(injectMock).toHaveBeenCalledWith(ctx.state.apiMessages)
    expect(ctx.state.appendixReport).toHaveBeenCalledWith(
      'P2_Q_inter_agent_inject',
      expect.objectContaining({
        iteration: 3,
        source: 'collector_post_tool',
      }),
    )
  })
})
