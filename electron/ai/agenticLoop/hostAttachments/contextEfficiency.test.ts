/**
 * Unit tests for the `context_efficiency` collector.
 *
 * Tracker math is covered by `snipNudgeTracker.test.ts`; these
 * tests pin the collector's gating + message format.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { contextEfficiencyCollector } from './contextEfficiency'
import {
  expectPushMessageAction,
  makeAttachmentFixture,
} from './testFixtures'

const ORIGINAL_ENV = process.env.POLE_CONTEXT_EFFICIENCY_NUDGE

const getAgentContextMock = vi.fn()
const shouldEmitMock = vi.fn()

vi.mock('../../../agents/agentContext', () => ({
  getAgentContext: () => getAgentContextMock(),
}))
vi.mock('../../../context/snipNudgeTracker', () => ({
  shouldEmitContextEfficiencyNudge: (args: unknown) => shouldEmitMock(args),
}))

beforeEach(() => {
  vi.clearAllMocks()
  process.env.POLE_CONTEXT_EFFICIENCY_NUDGE = '1'
  getAgentContextMock.mockReturnValue({
    agentId: 'main',
    streamConversationId: 'conv-1',
  })
})

afterEach(() => {
  if (ORIGINAL_ENV === undefined)
    delete process.env.POLE_CONTEXT_EFFICIENCY_NUDGE
  else process.env.POLE_CONTEXT_EFFICIENCY_NUDGE = ORIGINAL_ENV
})

describe('contextEfficiencyCollector — gating', () => {
  it('runs at post_tool only', () => {
    expect(contextEfficiencyCollector.callSites).toEqual(['post_tool'])
  })

  it('is enabled when env flag is unset (default-on); empty growth ⇒ no emit', async () => {
    delete process.env.POLE_CONTEXT_EFFICIENCY_NUDGE
    shouldEmitMock.mockReturnValue(null)
    const ctx = makeAttachmentFixture({
      ctxManagerState: { estimatedTokens: 100_000 },
    })
    expect(await contextEfficiencyCollector.run(ctx)).toBeNull()
    expect(shouldEmitMock).toHaveBeenCalled()
  })

  it('returns null when env flag is explicitly disabled (POLE_X=0)', async () => {
    process.env.POLE_CONTEXT_EFFICIENCY_NUDGE = '0'
    expect(
      await contextEfficiencyCollector.run(makeAttachmentFixture({})),
    ).toBeNull()
    expect(shouldEmitMock).not.toHaveBeenCalled()
  })

  it('returns null for sub-agents', async () => {
    getAgentContextMock.mockReturnValue({
      agentId: 'sub-1',
      streamConversationId: 'conv',
    })
    expect(
      await contextEfficiencyCollector.run(makeAttachmentFixture({})),
    ).toBeNull()
  })

  it('returns null when no streamConversationId', async () => {
    getAgentContextMock.mockReturnValue({ agentId: 'main' })
    expect(
      await contextEfficiencyCollector.run(makeAttachmentFixture({})),
    ).toBeNull()
  })

  it('returns null when estimatedTokens is 0', async () => {
    const ctx = makeAttachmentFixture({
      ctxManagerState: { estimatedTokens: 0 },
    })
    expect(await contextEfficiencyCollector.run(ctx)).toBeNull()
  })

  it('returns null when tracker says no (below growth threshold)', async () => {
    shouldEmitMock.mockReturnValue(null)
    const ctx = makeAttachmentFixture({
      ctxManagerState: { estimatedTokens: 100_000 },
    })
    expect(await contextEfficiencyCollector.run(ctx)).toBeNull()
    expect(shouldEmitMock).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      currentTokenEstimate: 100_000,
    })
  })
})

describe('contextEfficiencyCollector — emission', () => {
  it('emits informational (not action-demanding) body when tracker permits', async () => {
    shouldEmitMock.mockReturnValue({
      grownTokens: 15_000,
      currentTokens: 80_000,
      lastSnipFreedTokens: 0,
      nudgeIndex: 1,
    })
    const action = await contextEfficiencyCollector.run(
      makeAttachmentFixture({ ctxManagerState: { estimatedTokens: 80_000 } }),
    )
    const body = String(expectPushMessageAction(action).message.content)
    expect(body).toContain('grown ~15000 tokens')
    expect(body).toContain('Current estimate: 80000')
    // CRUCIAL: must NOT instruct the model to take action — the divergence
    // from upstream's action-demanding SnipTool nudge is the whole point.
    expect(body).toContain('no action required')
    expect(body).toContain('normal pace')
    expect(body).not.toContain('SnipTool')
  })

  it('mentions last snip freed when > 0', async () => {
    shouldEmitMock.mockReturnValue({
      grownTokens: 15_000,
      currentTokens: 60_000,
      lastSnipFreedTokens: 25_000,
      nudgeIndex: 2,
    })
    const body = String(
      expectPushMessageAction(
        await contextEfficiencyCollector.run(
          makeAttachmentFixture({
            ctxManagerState: { estimatedTokens: 60_000 },
          }),
        ),
      ).message.content,
    )
    expect(body).toContain('most recent host-side snip freed ~25000')
  })

  it('omits snip-freed clause when 0', async () => {
    shouldEmitMock.mockReturnValue({
      grownTokens: 15_000,
      currentTokens: 80_000,
      lastSnipFreedTokens: 0,
      nudgeIndex: 1,
    })
    const body = String(
      expectPushMessageAction(
        await contextEfficiencyCollector.run(
          makeAttachmentFixture({
            ctxManagerState: { estimatedTokens: 80_000 },
          }),
        ),
      ).message.content,
    )
    expect(body).not.toContain('most recent host-side snip freed')
  })
})
