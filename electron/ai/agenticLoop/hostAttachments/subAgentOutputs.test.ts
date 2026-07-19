/**
 * Unit tests for the `sub_agent_outputs` collector.
 *
 * The collector wraps `injectPendingSubAgentOutputsForMainTurn` which
 * returns a NEW array on splice (or the input array unchanged when
 * nothing to splice). The collector swaps `state.apiMessages` when
 * the helper returns a different reference / different length.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { subAgentOutputsCollector } from './subAgentOutputs'
import { makeAttachmentFixture } from './testFixtures'
import { runCollectorsWith } from '../hostAttachments'

const getAgentContextMock = vi.fn()
const injectMock = vi.fn()

vi.mock('../../../agents/agentContext', () => ({
  getAgentContext: () => getAgentContextMock(),
}))
vi.mock('../../../agents/mainSubAgentContextInjection', () => ({
  injectPendingSubAgentOutputsForMainTurn: (msgs: unknown) => injectMock(msgs),
}))

beforeEach(() => {
  vi.clearAllMocks()
})

describe('subAgentOutputsCollector — callSite', () => {
  it('runs at post_tool and no_tools_continue', () => {
    expect(subAgentOutputsCollector.callSites).toEqual(['post_tool', 'no_tools_continue'])
  })
})

describe('subAgentOutputsCollector — gating', () => {
  it('returns null for sub-agents (only main chat splices sub-agent output)', async () => {
    getAgentContextMock.mockReturnValue({ agentId: 'sub-1' })
    expect(
      await subAgentOutputsCollector.run(makeAttachmentFixture({})),
    ).toBeNull()
    expect(injectMock).not.toHaveBeenCalled()
  })

  it('returns null when helper returns the SAME array reference (no splice)', async () => {
    getAgentContextMock.mockReturnValue({ agentId: 'main' })
    const ctx = makeAttachmentFixture({
      apiMessages: [{ role: 'user', content: 'hi' }],
    })
    injectMock.mockReturnValue(ctx.state.apiMessages)
    expect(await subAgentOutputsCollector.run(ctx)).toBeNull()
  })

  it('returns null when helper returns a different array of the same length', async () => {
    // No new content — same length means no actual splice happened.
    getAgentContextMock.mockReturnValue({ agentId: 'main' })
    const ctx = makeAttachmentFixture({
      apiMessages: [{ role: 'user', content: 'hi' }],
    })
    injectMock.mockReturnValue([{ role: 'user', content: 'hi' }])
    expect(await subAgentOutputsCollector.run(ctx)).toBeNull()
  })
})

describe('subAgentOutputsCollector — emission side effects', () => {
  it('replaces state.apiMessages when helper spliced new content (length increased)', async () => {
    getAgentContextMock.mockReturnValue({ agentId: 'main' })
    const ctx = makeAttachmentFixture({
      iteration: 4,
      apiMessages: [{ role: 'user', content: 'hi' }],
    })
    const spliced = [
      { role: 'user', content: 'hi' },
      { role: 'user', content: '<sub-agent-update>...</sub-agent-update>' },
    ]
    injectMock.mockReturnValue(spliced)
    const result = await runCollectorsWith([subAgentOutputsCollector], ctx)
    expect(result.appliedActions).toBe(0)
    expect(result.requiresConversationSync).toBe(true)
    expect(ctx.state.apiMessages).toBe(spliced)
    expect(ctx.state.appendixReport).toHaveBeenCalledWith(
      'P2_Q_inter_agent_inject',
      expect.objectContaining({
        iteration: 4,
        source: 'sub_agent_outputs',
      }),
    )
  })

  it('treats missing agentContext as main-chat', async () => {
    getAgentContextMock.mockReturnValue(null)
    const ctx = makeAttachmentFixture({
      apiMessages: [{ role: 'user', content: 'hi' }],
    })
    injectMock.mockReturnValue([
      { role: 'user', content: 'hi' },
      { role: 'user', content: 'note' },
    ])
    await subAgentOutputsCollector.run(ctx)
    expect(injectMock).toHaveBeenCalled()
  })
})
